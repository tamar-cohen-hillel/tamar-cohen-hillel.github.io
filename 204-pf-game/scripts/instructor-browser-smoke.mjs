import { writeFile } from "node:fs/promises";

const endpoint = process.argv[2];
const outputDirectory = process.argv[3];
if (!endpoint || !outputDirectory) {
  throw new Error("Usage: node scripts/instructor-browser-smoke.mjs <devtools-websocket-url> <output-directory>");
}

const socket = new WebSocket(endpoint);
const pending = new Map();
const exceptions = [];
let nextId = 1;

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  } else if (message.method === "Runtime.exceptionThrown") {
    exceptions.push(message.params.exceptionDetails.text);
  }
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(expression, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function screenshot(filename, width, height) {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });
  const captured = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });
  await writeFile(`${outputDirectory}/${filename}`, Buffer.from(captured.data, "base64"));
}

await send("Page.enable");
await send("Runtime.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    globalThis.__courseRecordRequests = [];
    const browserFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
      if (String(input).includes("docs.google.com/forms/")) {
        globalThis.__courseRecordRequests.push({ url: String(input), body: String(init?.body ?? "") });
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return browserFetch(input, init);
    };
  `,
});
await send("Page.navigate", { url: "http://127.0.0.1:8765/instructor.html" });
await waitFor('document.readyState === "complete"');

await evaluate(`
  document.querySelector("#instructor-game-code").value = " qa-instructor ";
  document.querySelector("#planned-rounds").value = "2";
  document.querySelector("#instructor-entry-form").requestSubmit();
`);
await waitFor('document.querySelector("#instructor-dialog").open');
await evaluate('document.querySelector("#instructor-dialog-confirm").click()');
await waitFor('!document.querySelector("#instructor-display").hidden');

await evaluate('document.querySelector("#start-timer").click()');
await waitFor('document.querySelector("#instructor-dialog").open');
await evaluate('document.querySelector("#instructor-dialog-confirm").click()');
await waitFor('document.querySelector("#timer-state-label").textContent === "Period in progress"');
await evaluate('document.querySelector("#pause-resume").click()');
await waitFor('document.querySelector("#timer-state-label").textContent === "Paused"');
const pausedClock = await evaluate('document.querySelector("#timer-heading").textContent');
await new Promise((resolve) => setTimeout(resolve, 600));
if (await evaluate('document.querySelector("#timer-heading").textContent') !== pausedClock) {
  throw new Error("Paused instructor clock continued counting down.");
}

await evaluate('document.querySelector("#add-period").click()');
await waitFor('document.querySelector("#planned-round-count").textContent === "3"');
await evaluate('document.querySelector("#remove-period").click()');
await waitFor('document.querySelector("#planned-round-count").textContent === "2"');
await evaluate('document.querySelector("#pause-resume").click()');
await waitFor('document.querySelector("#timer-state-label").textContent === "Period in progress"');
await screenshot("instructor-running-desktop.png", 1440, 1000);
await screenshot("instructor-running-mobile.png", 390, 844);

await evaluate('document.querySelector("#end-simulation").click()');
await waitFor('document.querySelector("#instructor-dialog").open');
await evaluate('document.querySelector("#instructor-dialog-confirm").click()');
await waitFor('document.querySelector("#timer-state-label").textContent === "Simulation ended"');
await waitFor('globalThis.__courseRecordRequests.length === 1');

const ended = await evaluate(`({
  code: document.querySelector("#instructor-game-identity").textContent,
  clock: document.querySelector("#timer-heading").textContent,
  round: document.querySelector("#current-round").textContent,
  planned: document.querySelector("#planned-round-count").textContent,
  cutoffStatus: document.querySelector("#cutoff-status").textContent,
  recordStatus: document.querySelector("#instructor-record-status").textContent,
  requests: globalThis.__courseRecordRequests,
})`);
if (ended.code !== "QA-INSTRUCTOR" || ended.clock !== "00:00") {
  throw new Error("Instructor identity or ended clock rendered incorrectly.");
}
if (!ended.requests[0].body.includes("GAME_END")) {
  throw new Error("End Simulation did not submit a GAME_END record.");
}

await send("Page.navigate", { url: "http://127.0.0.1:8765/instructor.html" });
await waitFor('document.readyState === "complete"');
await evaluate(`
  document.querySelector("#instructor-game-code").value = "QA-INSTRUCTOR";
  document.querySelector("#planned-rounds").value = "99";
  document.querySelector("#instructor-entry-form").requestSubmit();
`);
await waitFor('document.querySelector("#instructor-dialog").open');
await evaluate('document.querySelector("#instructor-dialog-confirm").click()');
await waitFor('document.querySelector("#timer-state-label").textContent === "Simulation ended"');
const recovery = await evaluate(`({
  round: document.querySelector("#current-round").textContent,
  planned: document.querySelector("#planned-round-count").textContent,
  requests: globalThis.__courseRecordRequests.length,
})`);
if (recovery.round !== "1" || recovery.planned !== "2" || recovery.requests !== 0) {
  throw new Error("Instructor recovery changed state or submitted a duplicate GAME_END.");
}
if (exceptions.length) throw new Error(`Browser exceptions: ${exceptions.join("; ")}`);

process.stdout.write(`${JSON.stringify({ pausedClock, ended, recovery, exceptions }, null, 2)}\n`);
socket.close();

