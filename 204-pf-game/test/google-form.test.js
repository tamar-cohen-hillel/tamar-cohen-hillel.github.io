import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVITY_IDS,
  createSimulation,
  simulatePeriod,
} from "../src/simulation/engine.js";
import { GOOGLE_FORM_CONFIG } from "../src/submission/google-form-config.js";
import {
  APPLICATION_VERSION,
  FORM_SCHEMA_VERSION,
  createAuditStateSnapshot,
  createInstructorEventRecord,
  createPeriodCommitRecord,
  createTeamEndRecord,
  encodeGoogleFormRecord,
  submitGoogleFormRecord,
} from "../src/submission/google-form.js";

const ALLOCATION = Object.freeze({
  W1: ACTIVITY_IDS.ROUTINE,
  W2: ACTIVITY_IDS.ASSESSMENT,
  W3: ACTIVITY_IDS.ROUTINE,
  W4: ACTIVITY_IDS.DIAGNOSTICS,
  W5: ACTIVITY_IDS.REVIEW,
  W6: ACTIVITY_IDS.ASSESSMENT,
});

function makeRecord() {
  const before = createSimulation("form-test");
  const simulated = simulatePeriod(before, ALLOCATION);
  return createPeriodCommitRecord({
    uuid: "fixed-period-uuid",
    gameCode: { normalized: "FORM-TEST", display: "form-test" },
    teamCode: { normalized: "TEAM-7", display: "Team-7" },
    allocation: ALLOCATION,
    prePeriodState: before,
    preDecisionVisibleMeasures: { completedPeriods: 0, workInProcess: 0 },
    periodResult: simulated.result,
    endingState: simulated.state,
    localDiagnosticTime: "2026-09-03T12:00:00.000Z",
  });
}

test("period record contains complete replay states and stable metadata", () => {
  const record = makeRecord();
  assert.equal(record.schemaVersion, FORM_SCHEMA_VERSION);
  assert.equal(record.applicationVersion, APPLICATION_VERSION);
  assert.equal(record.eventType, "PERIOD_COMMIT");
  assert.equal(record.uuid, "fixed-period-uuid");
  assert.equal(record.roundOrPeriod, 1);
  assert.deepEqual(record.payload.allocation, ALLOCATION);
  assert.equal(record.payload.prePeriodState.completedPeriods, 0);
  assert.deepEqual(record.payload.preDecisionVisibleMeasures, {
    completedPeriods: 0,
    workInProcess: 0,
  });
  assert.equal(record.payload.periodResult.period, 1);
  assert.equal(record.payload.endingState.completedPeriods, 1);
  assert.equal(record.payload.endingStateChecksum, record.payload.endingState.stateChecksum);
  assert.equal("eventLog" in record.payload.prePeriodState, false);
  assert.equal("periodResults" in record.payload.endingState, false);
  assert.match(record.payloadChecksum, /^[0-9a-f]{8}$/);
});

test("audit snapshots retain operational continuity without cumulative history", () => {
  const state = makeRecord().payload.endingState;
  assert.ok(state.randomState);
  assert.ok(state.nextUnscheduledArrivalTime > 0);
  assert.ok(state.nextPatientSequence > 1);
  assert.ok(state.queues);
  assert.ok(state.workers);
  assert.ok(state.stateChecksum);
  assert.equal("serviceHistory" in state.workers.W1, false);
  assert.deepEqual(createAuditStateSnapshot(createSimulation("empty")).patientsInSystem, {});
});

test("Google encoding uses every verified entry mapping", () => {
  const record = makeRecord();
  const encoded = encodeGoogleFormRecord(record);
  assert.deepEqual([...encoded.keys()].sort(), Object.values(GOOGLE_FORM_CONFIG.fields).sort());
  assert.equal(encoded.get(GOOGLE_FORM_CONFIG.fields.eventUuid), record.uuid);
  assert.equal(encoded.get(GOOGLE_FORM_CONFIG.fields.actorCode), "TEAM-7");
  assert.equal(encoded.get(GOOGLE_FORM_CONFIG.fields.isRetry), "FALSE");
  assert.equal(JSON.parse(encoded.get(GOOGLE_FORM_CONFIG.fields.payloadJson)).period, 1);
});

test("retry changes only the retry field and preserves UUID, payload, and checksum", () => {
  const record = makeRecord();
  const original = encodeGoogleFormRecord(record);
  const retry = encodeGoogleFormRecord(record, { isRetry: true });
  assert.equal(retry.get(GOOGLE_FORM_CONFIG.fields.isRetry), "TRUE");
  for (const field of Object.values(GOOGLE_FORM_CONFIG.fields)) {
    if (field !== GOOGLE_FORM_CONFIG.fields.isRetry) {
      assert.equal(retry.get(field), original.get(field));
    }
  }
});

test("transport makes one opaque-compatible POST and never claims confirmation", async () => {
  const calls = [];
  const result = await submitGoogleFormRecord(makeRecord(), {
    fetchImpl: async (...args) => {
      calls.push(args);
      return { type: "opaque", status: 0 };
    },
  });
  assert.deepEqual(result, { attempted: true, confirmationAvailable: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], GOOGLE_FORM_CONFIG.submissionUrl);
  assert.equal(calls[0][1].method, "POST");
  assert.equal(calls[0][1].mode, "no-cors");
  assert.equal(calls[0][1].credentials, "omit");
  assert.equal("keepalive" in calls[0][1], false);
});

test("an asynchronous transport error remains an ambiguous attempted submission", async () => {
  const result = await submitGoogleFormRecord(makeRecord(), {
    fetchImpl: async () => {
      throw new TypeError("network unavailable");
    },
  });
  assert.deepEqual(result, {
    attempted: true,
    confirmationAvailable: false,
    transportEndedWithError: true,
    diagnosticErrorName: "TypeError",
  });
});

test("a synchronous client failure is reported as not launched", async () => {
  await assert.rejects(submitGoogleFormRecord(makeRecord(), {
    fetchImpl: () => {
      throw new Error("client could not launch request");
    },
  }), /could not launch/);
});

test("instructor cutoff and game-end records use the shared Form schema", () => {
  const state = {
    sessionId: "instructor-1",
    gameCode: { normalized: "SECTION-A", display: "section-a" },
  };
  const cutoff = createInstructorEventRecord({
    instructorState: state,
    instructorEvent: {
      type: "CUTOFF",
      uuid: "cutoff-1",
      round: 2,
      diagnosticTime: "2026-09-03T12:00:00.000Z",
      reason: "ROUND_EXPIRED",
    },
  });
  assert.equal(cutoff.eventType, "CUTOFF");
  assert.equal(cutoff.actorCode, "INSTRUCTOR");
  assert.equal(cutoff.payload.cutoffUuid, "cutoff-1");
  assert.equal(cutoff.payload.timerExpiryDiagnosticTime, cutoff.localDiagnosticTime);

  const gameEnd = createInstructorEventRecord({
    instructorState: state,
    instructorEvent: {
      type: "GAME_END",
      uuid: "end-1",
      round: 3,
      diagnosticTime: "2026-09-03T12:05:00.000Z",
      reason: "FINAL_ROUND_EXPIRED",
    },
  });
  assert.equal(gameEnd.payload.cutoffStatus, "FINAL_ROUND_DEADLINE");
});

test("TEAM_END records bind the completed periods to the encrypted backup checksum", () => {
  const record = createTeamEndRecord({
    uuid: "team-end-1",
    gameCode: { normalized: "GAME", display: "game" },
    teamCode: { normalized: "TEAM-1", display: "Team-1" },
    completedPeriods: 4,
    configurationVersion: "configuration-v1",
    seedVersion: "seed-v1",
    localDiagnosticTime: "2026-09-04T12:00:00.000Z",
    encryptedBackupChecksum: "a".repeat(64),
  });
  assert.equal(record.eventType, "TEAM_END");
  assert.equal(record.roundOrPeriod, 4);
  assert.equal(record.payload.teamEndUuid, "team-end-1");
  assert.equal(record.payload.encryptedBackupChecksum, "a".repeat(64));
  assert.equal(encodeGoogleFormRecord(record).get(GOOGLE_FORM_CONFIG.fields.actorCode), "TEAM-1");
});
