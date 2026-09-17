import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ACTIVITY_IDS,
  PATIENT_TYPES,
  createSimulation,
  simulatePeriod,
} from "../src/simulation/engine.js";
import {
  createStudentFinalView,
  createStudentPeriodView,
} from "../src/student/view-model.js";

const ALLOCATION = Object.freeze({
  W1: ACTIVITY_IDS.ROUTINE,
  W2: ACTIVITY_IDS.ASSESSMENT,
  W3: ACTIVITY_IDS.ROUTINE,
  W4: ACTIVITY_IDS.DIAGNOSTICS,
  W5: ACTIVITY_IDS.REVIEW,
  W6: ACTIVITY_IDS.ASSESSMENT,
});

const PROHIBITED_STUDENT_KEYS = new Set([
  "arrivals",
  "events",
  "eventLog",
  "patients",
  "periodResults",
  "serviceHistory",
  "appliedAllocations",
  "randomState",
  "nextUnscheduledArrivalTime",
]);

function collectKeys(value, found = new Set()) {
  if (!value || typeof value !== "object") {
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    found.add(key);
    collectKeys(child, found);
  }
  return found;
}

test("period view exposes only approved student information", () => {
  const simulated = simulatePeriod(createSimulation("student-view"), ALLOCATION);
  const view = createStudentPeriodView(simulated.state);
  assert.deepEqual(Object.keys(view).sort(), [
    "assignments",
    "completedPeriods",
    "cumulativeCompletions",
    "nextPeriod",
    "queues",
    "stakeholderMetrics",
    "workInProcess",
    "workerUtilization",
  ]);
  assert.equal(view.completedPeriods, 1);
  assert.equal(view.nextPeriod, 2);
  assert.deepEqual(Object.keys(view.queues), [
    ACTIVITY_IDS.INTAKE,
    ACTIVITY_IDS.ROUTINE,
    ACTIVITY_IDS.ASSESSMENT,
    ACTIVITY_IDS.DIAGNOSTICS,
    ACTIVITY_IDS.REVIEW,
  ]);
  const keys = collectKeys(view);
  for (const prohibited of PROHIBITED_STUDENT_KEYS) {
    assert.equal(keys.has(prohibited), false, `Student period view exposed ${prohibited}`);
  }
});

test("initial period view contains zeroed public measures and no future arrivals", () => {
  const view = createStudentPeriodView(createSimulation("new-team"));
  assert.equal(view.completedPeriods, 0);
  assert.equal(view.nextPeriod, 1);
  assert.equal(view.workInProcess, 0);
  assert.equal(view.cumulativeCompletions[PATIENT_TYPES.SCHEDULED], 0);
  assert.equal(view.cumulativeCompletions[PATIENT_TYPES.UNSCHEDULED], 0);
  assert.equal(view.stakeholderMetrics.patientAccess.percentage, null);
  assert.equal(view.stakeholderMetrics.urgentCare.percentage, null);
  assert.equal(view.stakeholderMetrics.operations.percentage, null);
  assert.equal(view.stakeholderMetrics.workforce.utilization, null);
  for (const queue of Object.values(view.queues)) {
    assert.deepEqual(queue, { length: 0, oldestWaitMinutes: 0 });
  }
});

test("stakeholder dashboard uses completed patients and exposes no patient records", () => {
  let state = createSimulation("stakeholder-dashboard");
  for (let period = 0; period < 4; period += 1) {
    state = simulatePeriod(state, ALLOCATION).state;
  }
  const view = createStudentPeriodView(state);
  const completedScheduled = Object.values(state.patients).filter(
    (patient) => patient.type === PATIENT_TYPES.SCHEDULED
      && patient.status === "COMPLETED",
  );
  const completedUnscheduled = Object.values(state.patients).filter(
    (patient) => patient.type === PATIENT_TYPES.UNSCHEDULED
      && patient.status === "COMPLETED",
  );
  assert.equal(
    view.stakeholderMetrics.patientAccess.completed,
    completedScheduled.length,
  );
  assert.equal(
    view.stakeholderMetrics.urgentCare.completed,
    completedUnscheduled.length,
  );
  assert.equal(
    view.stakeholderMetrics.urgentCare.waitBins.reduce(
      (total, bin) => total + bin.count,
      0,
    ),
    completedUnscheduled.length,
  );
  const keys = collectKeys(view.stakeholderMetrics);
  for (const prohibited of PROHIBITED_STUDENT_KEYS) {
    assert.equal(keys.has(prohibited), false);
  }
});

test("final view contains statistics but no decision or event history", () => {
  let state = createSimulation("final-view");
  state = simulatePeriod(state, ALLOCATION).state;
  state = simulatePeriod(state, ALLOCATION).state;
  const view = createStudentFinalView(state);
  assert.deepEqual(Object.keys(view).sort(), [
    "completedPeriods",
    "endingWorkInProcess",
    "patientTypes",
    "simulatedMinutes",
    "stakeholderMetrics",
    "utilizationByActivity",
    "utilizationByWorker",
  ]);
  const keys = collectKeys(view);
  for (const prohibited of PROHIBITED_STUDENT_KEYS) {
    assert.equal(keys.has(prohibited), false, `Student final view exposed ${prohibited}`);
  }
  assert.deepEqual(view.stakeholderMetrics, createStudentPeriodView(state).stakeholderMetrics);
  const restored = JSON.parse(JSON.stringify(state));
  assert.deepEqual(createStudentFinalView(restored).stakeholderMetrics, view.stakeholderMetrics);
});

test("leadership targets include exact time boundaries and exclude unfinished patients", () => {
  const state = createSimulation("target-boundaries");
  state.time = 360;
  const waits = [0, 15, 15.001, 30, 30.001, 45, 45.001, 60, 60.001, 120];
  state.patients = {};
  for (let i = 0; i < 20; i++) {
    state.patients[`S${i}`] = {
      type: PATIENT_TYPES.SCHEDULED, status: "COMPLETED",
      arrivalTime: 0, completionTime: i < 19 ? 35 : 35.001,
      totalWaitingMinutes: 0,
    };
  }
  waits.forEach((wait, i) => {
    state.patients[`U${i}`] = {
      type: PATIENT_TYPES.UNSCHEDULED, status: "COMPLETED",
      arrivalTime: 0, completionTime: 200, totalWaitingMinutes: wait,
    };
  });
  state.patients.pending = {
    type: PATIENT_TYPES.UNSCHEDULED, status: "QUEUED",
    activityId: ACTIVITY_IDS.DIAGNOSTICS, arrivalTime: 0,
    queueEnteredAt: 0, totalWaitingMinutes: 0,
  };
  let metrics = createStudentPeriodView(state).stakeholderMetrics;
  assert.equal(metrics.patientAccess.percentage, 0.95);
  assert.equal(metrics.patientAccess.met, true);
  assert.equal(metrics.urgentCare.completed, 10);
  assert.equal(metrics.urgentCare.percentage, 0.6);
  assert.equal(metrics.urgentCare.met, false);
  assert.deepEqual(metrics.urgentCare.waitBins.map(bin => bin.count), [2, 2, 2, 2, 2]);
  state.patients.U8.totalWaitingMinutes = 45;
  state.patients.U9.totalWaitingMinutes = 45;
  metrics = createStudentPeriodView(state).stakeholderMetrics;
  assert.equal(metrics.urgentCare.percentage, 0.8);
  assert.equal(metrics.urgentCare.met, true);
});

test("student HTML has required accessibility and no readable-export controls", async () => {
  const html = await readFile(new URL("../team.html", import.meta.url), "utf8");
  assert.match(html, /<main id="main-content"/);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /role="status"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /<label for="game-code">/);
  assert.match(html, /<label for="team-code">/);
  assert.doesNotMatch(html, />\s*(?:Download CSV|Export JSON|Print report|Copy all)\s*</i);
  assert.doesNotMatch(html, /countdown|team clock/i);
  assert.doesNotMatch(html, /Google Forms is not connected/);
  assert.match(html, /id="retry-upload-button"/);
  assert.match(html, /id="stakeholder-grid"/);
  assert.doesNotMatch(html, /Google may already have this period/);
  assert.match(html, /id="download-backup-again"/);
  assert.match(html, /\.gamebackup/);
  assert.doesNotMatch(html, /connected in Step 7/);
  const downloadControls = html.match(/\bdownload(?:=|[^a-z])/gi) ?? [];
  assert.equal(downloadControls.length >= 1, true);
});
