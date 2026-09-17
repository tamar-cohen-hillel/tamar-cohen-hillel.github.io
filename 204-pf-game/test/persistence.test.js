import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVITY_IDS,
  createSimulation,
  simulatePeriod,
} from "../src/simulation/engine.js";
import { InMemoryDriver } from "../src/persistence/drivers.js";
import {
  GamePersistence,
  RECOVERY_ACTION,
  RECOVERY_WARNINGS,
  TEAM_SESSION_STATUS,
  UPLOAD_STATUS,
} from "../src/persistence/game-persistence.js";
import {
  normalizeTeamIdentity,
  teamSessionKey,
} from "../src/persistence/identity.js";

const ALLOCATION = Object.freeze({
  W1: ACTIVITY_IDS.ROUTINE,
  W2: ACTIVITY_IDS.ASSESSMENT,
  W3: ACTIVITY_IDS.ROUTINE,
  W4: ACTIVITY_IDS.DIAGNOSTICS,
  W5: ACTIVITY_IDS.REVIEW,
  W6: ACTIVITY_IDS.ASSESSMENT,
});

function makePersistence() {
  let tick = 0;
  return new GamePersistence({
    driver: new InMemoryDriver(),
    now: () => `2026-09-02T00:00:${String(tick++).padStart(2, "0")}.000Z`,
  });
}

function periodTransaction(previousState, uuid, uploadStatus = UPLOAD_STATUS.NOT_STARTED) {
  const simulated = simulatePeriod(previousState, ALLOCATION);
  return {
    uuid,
    simulationState: simulated.state,
    periodResult: simulated.result,
    nextAllocationDraft: ALLOCATION,
    formRecord: {
      eventType: "PERIOD_COMMIT",
      uuid,
      period: simulated.result.period,
      endingStateChecksum: simulated.state.stateChecksum,
    },
    uploadStatus,
  };
}

test("normalizes exact game/team identity without conflating different saves", async () => {
  const persistence = makePersistence();
  const identity = normalizeTeamIdentity(" 2026w1-101 ", " team7 ");
  assert.deepEqual(identity, {
    game: { display: "2026w1-101", normalized: "2026W1-101" },
    team: { display: "team7", normalized: "TEAM7" },
  });
  assert.equal(
    teamSessionKey(identity.game.normalized, identity.team.normalized),
    '["2026W1-101","TEAM7"]',
  );

  await persistence.createTeamSession({
    gameCode: "2026w1-101",
    teamCode: "Team7",
    simulationState: createSimulation("2026w1-101"),
  });
  assert.ok(await persistence.findTeamSession(" 2026W1-101 ", " team7 "));
  assert.equal(await persistence.findTeamSession("2026W1-101", "TEAM8"), undefined);
  assert.equal(await persistence.findTeamSession("2026W1-102", "TEAM7"), undefined);
});

test("does not overwrite an existing team session during entry", async () => {
  const persistence = makePersistence();
  const first = await persistence.createTeamSession({
    gameCode: "game",
    teamCode: "team",
    simulationState: createSimulation("game"),
    allocationDraft: ALLOCATION,
  });
  const second = await persistence.createTeamSession({
    gameCode: " GAME ",
    teamCode: " TEAM ",
    simulationState: createSimulation("different-seed"),
    allocationDraft: null,
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.session.simulationState.gameCode, "GAME");
  assert.deepEqual(second.session.allocationDraft, ALLOCATION);
});

test("explicit replacement starts a fresh team session after UI confirmation", async () => {
  const persistence = makePersistence();
  const initial = createSimulation("replacement");
  await persistence.createTeamSession({
    gameCode: "replacement",
    teamCode: "team",
    simulationState: initial,
  });
  await persistence.commitPeriod(
    "replacement",
    "team",
    periodTransaction(initial, "old-period"),
  );

  const replaced = await persistence.replaceTeamSession({
    gameCode: "REPLACEMENT",
    teamCode: "TEAM",
    simulationState: createSimulation("replacement"),
    allocationDraft: ALLOCATION,
  });
  assert.equal(replaced.simulationState.completedPeriods, 0);
  assert.equal(replaced.periodTransactions.length, 0);
  assert.deepEqual(replaced.allocationDraft, ALLOCATION);
});

test("recovers the allocation currently being prepared", async () => {
  const persistence = makePersistence();
  await persistence.createTeamSession({
    gameCode: "draft-game",
    teamCode: "team-1",
    simulationState: createSimulation("draft-game"),
  });
  await persistence.saveAllocationDraft("draft-game", "team-1", ALLOCATION);
  const recovery = await persistence.getTeamRecovery("DRAFT-GAME", "TEAM-1");
  assert.equal(recovery.found, true);
  assert.equal(recovery.action, RECOVERY_ACTION.RESUME_DECISION);
  assert.deepEqual(recovery.session.allocationDraft, ALLOCATION);
});

test("atomically commits one period and leaves the supplied state untouched", async () => {
  const persistence = makePersistence();
  const initial = createSimulation("atomic");
  const initialSnapshot = structuredClone(initial);
  await persistence.createTeamSession({
    gameCode: "atomic",
    teamCode: "team",
    simulationState: initial,
  });
  const transaction = periodTransaction(initial, "period-1");
  const committed = await persistence.commitPeriod("atomic", "team", transaction);

  assert.deepEqual(initial, initialSnapshot);
  assert.equal(committed.simulationState.completedPeriods, 1);
  assert.equal(committed.periodTransactions.length, 1);
  assert.equal(committed.periodTransactions[0].uuid, "period-1");
  assert.deepEqual(committed.allocationDraft, ALLOCATION);
});

test("a duplicate transaction UUID is idempotent and never advances again", async () => {
  const persistence = makePersistence();
  const initial = createSimulation("duplicate");
  await persistence.createTeamSession({
    gameCode: "duplicate",
    teamCode: "team",
    simulationState: initial,
  });
  const transaction = periodTransaction(initial, "same-uuid");
  await persistence.commitPeriod("duplicate", "team", transaction);
  const duplicate = await persistence.commitPeriod("duplicate", "team", transaction);
  assert.equal(duplicate.simulationState.completedPeriods, 1);
  assert.equal(duplicate.periodTransactions.length, 1);
});

test("rejects skipped/stale period commits without changing saved progress", async () => {
  const persistence = makePersistence();
  const initial = createSimulation("stale");
  await persistence.createTeamSession({
    gameCode: "stale",
    teamCode: "team",
    simulationState: initial,
  });
  const first = periodTransaction(initial, "period-1");
  await persistence.commitPeriod("stale", "team", first);

  const stale = periodTransaction(initial, "different-period-1");
  await assert.rejects(
    persistence.commitPeriod("stale", "team", stale),
    /expected period 2, received 1/,
  );
  const saved = await persistence.findTeamSession("stale", "team");
  assert.equal(saved.simulationState.completedPeriods, 1);
  assert.equal(saved.periodTransactions.length, 1);
});

test("restores unresolved upload status and updates attempts without simulation", async () => {
  const persistence = makePersistence();
  const initial = createSimulation("upload");
  await persistence.createTeamSession({
    gameCode: "upload",
    teamCode: "team",
    simulationState: initial,
  });
  await persistence.commitPeriod(
    "upload",
    "team",
    periodTransaction(initial, "upload-uuid", UPLOAD_STATUS.NOT_STARTED),
  );
  const recovery = await persistence.getTeamRecovery("upload", "team");
  assert.equal(recovery.action, RECOVERY_ACTION.REVIEW_UPLOAD_STATUS);

  const updated = await persistence.markPeriodUpload(
    "upload",
    "team",
    "upload-uuid",
    UPLOAD_STATUS.ATTEMPTED_UNCONFIRMED,
  );
  assert.equal(updated.simulationState.completedPeriods, 1);
  assert.equal(updated.periodTransactions[0].uploadAttempts, 1);
  assert.equal(
    updated.periodTransactions[0].uploadStatus,
    UPLOAD_STATUS.ATTEMPTED_UNCONFIRMED,
  );
  assert.equal(
    (await persistence.getTeamRecovery("upload", "team")).action,
    RECOVERY_ACTION.RESUME_DECISION,
  );
});

test("ended sessions recover to the final screen and cannot be changed", async () => {
  const persistence = makePersistence();
  await persistence.createTeamSession({
    gameCode: "ended",
    teamCode: "team",
    simulationState: createSimulation("ended"),
    allocationDraft: ALLOCATION,
  });
  const ended = await persistence.endTeamSession("ended", "team", {
    uuid: "team-end-uuid",
    backupChecksum: "abc123",
    encryptedBackup: {
      filename: "verification.gamebackup",
      fileText: "opaque-ciphertext",
      checksumSha256: "abc123",
    },
    formRecord: { eventType: "TEAM_END", uuid: "team-end-uuid" },
    uploadStatus: UPLOAD_STATUS.NOT_STARTED,
  });
  assert.equal(ended.status, TEAM_SESSION_STATUS.ENDED);
  assert.equal(ended.teamEnd.completedPeriods, 0);
  assert.equal(
    (await persistence.getTeamRecovery("ended", "team")).action,
    RECOVERY_ACTION.SHOW_FINAL,
  );
  const uploaded = await persistence.markTeamEndUpload(
    "ended",
    "team",
    "team-end-uuid",
    UPLOAD_STATUS.ATTEMPTED_UNCONFIRMED,
  );
  assert.equal(uploaded.teamEnd.uploadAttempts, 1);
  assert.equal(uploaded.teamEnd.uploadStatus, UPLOAD_STATUS.ATTEMPTED_UNCONFIRMED);
  await assert.rejects(
    persistence.saveAllocationDraft("ended", "team", null),
    /has ended/,
  );
});

test("team finalization rejects a missing or mismatched encrypted backup", async () => {
  const persistence = makePersistence();
  await persistence.createTeamSession({
    gameCode: "finalize",
    teamCode: "team",
    simulationState: createSimulation("finalize"),
  });
  await assert.rejects(persistence.endTeamSession("finalize", "team", {
    uuid: "team-end",
    backupChecksum: "expected",
    encryptedBackup: {
      filename: "verification.gamebackup",
      fileText: "ciphertext",
      checksumSha256: "different",
    },
    uploadStatus: UPLOAD_STATUS.NOT_STARTED,
  }), /checksum does not match/);
  const session = await persistence.findTeamSession("finalize", "team");
  assert.equal(session.status, TEAM_SESSION_STATUS.ACTIVE);
  assert.equal(session.teamEnd, null);
});

test("persists and restores instructor state by normalized game code", async () => {
  const persistence = makePersistence();
  const created = await persistence.createInstructorSession({
    gameCode: " section-a ",
    instructorState: { round: 1, plannedRounds: 5, timerStatus: "READY" },
  });
  assert.equal(created.created, true);
  await persistence.saveInstructorState("SECTION-A", {
    round: 2,
    plannedRounds: 6,
    timerStatus: "RUNNING",
  });
  const restored = await persistence.findInstructorSession("section-a");
  assert.deepEqual(restored.instructorState, {
    round: 2,
    plannedRounds: 6,
    timerStatus: "RUNNING",
  });
});

test("explicit replacement starts a new instructor-local simulation", async () => {
  const persistence = makePersistence();
  await persistence.createInstructorSession({
    gameCode: "new-run",
    instructorState: { round: 4, plannedRounds: 5, timerStatus: "ENDED" },
  });
  await persistence.replaceInstructorSession({
    gameCode: "NEW-RUN",
    instructorState: { round: 1, plannedRounds: 3, timerStatus: "READY" },
  });
  const restored = await persistence.findInstructorSession("new-run");
  assert.deepEqual(restored.instructorState, {
    round: 1,
    plannedRounds: 3,
    timerStatus: "READY",
  });
});

test("exposes the required same-browser recovery warnings", () => {
  assert.deepEqual(RECOVERY_WARNINGS, [
    "Progress is saved only in this laptop, browser, and browser profile.",
    "Do not use private or incognito browsing.",
    "Do not clear browser data, change browsers, or change laptops during the game.",
  ]);
});
