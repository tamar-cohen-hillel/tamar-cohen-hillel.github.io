import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("landing page exposes the instructor display", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /href="\.\/instructor\.html"/);
  assert.doesNotMatch(html, /Added in Step 6/);
});

test("instructor display contains every required control", async () => {
  const html = await readFile(new URL("../instructor.html", import.meta.url), "utf8");
  for (const id of [
    "start-timer",
    "pause-resume",
    "add-time",
    "remove-time",
    "add-period",
    "remove-period",
    "reset-timer",
    "end-simulation",
    "retry-instructor-upload",
    "start-new-simulation",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `Missing instructor control ${id}`);
  }
  assert.match(html, /id="timer-heading"/);
  assert.match(html, /id="instructor-game-identity"/);
  assert.match(html, /role="status"/);
  assert.match(html, /role="alert"/);
});

test("instructor display contains no team decisions, measures, or score controls", async () => {
  const html = await readFile(new URL("../instructor.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /worker utilization|patient results|allocation summary|live score/i);
});

