import { writeFile } from "node:fs/promises";

const endpoint = process.argv[2];
const outputDirectory = process.argv[3];
if (!endpoint || !outputDirectory) {
  throw new Error("Usage: node scripts/browser-smoke.mjs <devtools-websocket-url> <output-directory>");
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
  const id = nextId;
  nextId += 1;
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
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text);
  }
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
await send("Page.navigate", { url: "http://127.0.0.1:8765/team.html" });
await waitFor('document.readyState === "complete"');

await evaluate(`
  document.querySelector("#game-code").value = "QA-CLASS";
  document.querySelector("#team-code").value = "TEAM-7";
  document.querySelector("#entry-form").requestSubmit();
`);
await waitFor('document.querySelector("#confirmation-dialog").open');
await evaluate('document.querySelector("#dialog-confirm").click()');
await waitFor('document.querySelector("#confirmation-dialog").open');
await evaluate('document.querySelector("#dialog-confirm").click()');
await waitFor('!document.querySelector("#game-view").hidden');

await evaluate(`
  const allocation = {
    W1: "ROUTINE",
    W2: "ASSESSMENT",
    W3: "ROUTINE",
    W4: "DIAGNOSTICS",
    W5: "REVIEW",
    W6: "ASSESSMENT",
  };
  for (const [workerId, activityId] of Object.entries(allocation)) {
    const select = document.querySelector('[data-worker-id="' + workerId + '"]');
    select.value = activityId;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
`);
await new Promise((resolve) => setTimeout(resolve, 100));
await evaluate('document.querySelector("#allocation-form").requestSubmit()');
await waitFor('document.querySelector("#periods-completed").textContent === "1"');
await waitFor('document.querySelector("#save-status").textContent.includes("cannot confirm Google")');
await screenshot("team-period-desktop.png", 1440, 1000);
await screenshot("team-period-mobile.png", 390, 844);

const periodState = await evaluate(`({
  identity: document.querySelector("#game-identity").textContent,
  heading: document.querySelector("#game-heading").textContent,
  periods: document.querySelector("#periods-completed").textContent,
  queueCards: document.querySelectorAll(".queue-card").length,
  workerControls: document.querySelectorAll(".worker-card").length,
  utilizationCards: document.querySelectorAll(".utilization-card").length,
  courseRecordRequests: globalThis.__courseRecordRequests.length,
  visibleText: document.querySelector("#game-view").innerText,
})`);

await send("Page.navigate", { url: "http://127.0.0.1:8765/team.html" });
await waitFor('document.readyState === "complete"');
await evaluate(`
  document.querySelector("#game-code").value = " qa-class ";
  document.querySelector("#team-code").value = " team-7 ";
  document.querySelector("#entry-form").requestSubmit();
`);
await waitFor('document.querySelector("#confirmation-dialog").open');
await evaluate('document.querySelector("#dialog-confirm").click()');
await waitFor('document.querySelector("#confirmation-dialog").open');
await evaluate('document.querySelector("#dialog-confirm").click()');
await waitFor('!document.querySelector("#game-view").hidden');
const recoveryState = await evaluate(`({
  periods: document.querySelector("#periods-completed").textContent,
  nextPeriod: document.querySelector("#next-period-number").textContent,
  allocation: Object.fromEntries(
    [...document.querySelectorAll("#worker-grid select")].map(
      (select) => [select.dataset.workerId, select.value],
    ),
  ),
})`);
if (recoveryState.periods !== "1" || recoveryState.nextPeriod !== "2") {
  throw new Error("Same-browser recovery advanced or lost the saved period.");
}
if (JSON.stringify(recoveryState.allocation) !== JSON.stringify({
  W1: "ROUTINE",
  W2: "ASSESSMENT",
  W3: "ROUTINE",
  W4: "DIAGNOSTICS",
  W5: "REVIEW",
  W6: "ASSESSMENT",
})) {
  throw new Error("Same-browser recovery did not restore the allocation draft.");
}

await evaluate('document.querySelector("#end-game-button").click()');
await waitFor('document.querySelector("#confirmation-dialog").open');
await evaluate('document.querySelector("#dialog-confirm").click()');
await waitFor('!document.querySelector("#final-view").hidden');
await screenshot("team-final-desktop.png", 1440, 1000);

const finalState = await evaluate(`({
  heading: document.querySelector("#final-heading").textContent,
  patientCards: document.querySelectorAll(".patient-summary-card").length,
  wipCards: document.querySelectorAll(".wip-cell").length,
  visibleText: document.querySelector("#final-view").innerText,
})`);

const prohibitedText = /future arrivals|event log|decision history|download csv|export json/i;
if (prohibitedText.test(periodState.visibleText) || prohibitedText.test(finalState.visibleText)) {
  throw new Error("A prohibited information label appeared in the rendered student interface.");
}
if (periodState.queueCards !== 5 || periodState.workerControls !== 6 || periodState.utilizationCards !== 6) {
  throw new Error("Rendered period screen is missing required cards or controls.");
}
if (periodState.courseRecordRequests !== 1) {
  throw new Error("A period did not make exactly one course-record submission attempt.");
}
if (finalState.patientCards !== 2 || finalState.wipCards !== 5) {
  throw new Error("Rendered final screen is missing required summary cards.");
}
if (exceptions.length > 0) {
  throw new Error(`Browser exceptions: ${exceptions.join("; ")}`);
}

process.stdout.write(`${JSON.stringify({ periodState, recoveryState, finalState, exceptions }, null, 2)}\n`);
socket.close();
