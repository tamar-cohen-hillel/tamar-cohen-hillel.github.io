import assert from "node:assert/strict";
import test from "node:test";

import {
  INSTRUCTOR_EVENT_TYPE,
  LATER_ROUND_SECONDS,
  ROUND_ONE_SECONDS,
  TIMER_STATUS,
  abandonSimulation,
  addPeriod,
  adjustTimer,
  advanceExpiredRounds,
  createInstructorState,
  endSimulation,
  pauseTimer,
  removePeriod,
  resetCurrentTimer,
  resumeTimer,
  startTimer,
  updateRecordUpload,
} from "../src/instructor/timer-model.js";

function initial(plannedRounds = 3) {
  return createInstructorState({
    sessionId: "instructor-session",
    gameCode: { display: "section-a", normalized: "SECTION-A" },
    plannedRounds,
  });
}

function uuidFactory() {
  let value = 0;
  return () => `uuid-${++value}`;
}

test("Round 1 starts at ten minutes and locks the game code", () => {
  const state = startTimer(initial(), 1_000);
  assert.equal(state.timerStatus, TIMER_STATUS.RUNNING);
  assert.equal(state.deadlineTime, 1_000 + ROUND_ONE_SECONDS * 1_000);
  assert.equal(state.codeLocked, true);
});

test("pause and resume preserve the exact remaining duration", () => {
  let state = startTimer(initial(), 0);
  state = pauseTimer(state, 12_345);
  assert.equal(state.remainingMilliseconds, ROUND_ONE_SECONDS * 1_000 - 12_345);
  assert.equal(state.deadlineTime, null);
  state = resumeTimer(state, 50_000);
  assert.equal(state.deadlineTime, 50_000 + ROUND_ONE_SECONDS * 1_000 - 12_345);
});

test("time adjustments are repeatable, nonnegative, and reset to configured duration", () => {
  let state = startTimer(initial(), 0);
  state = adjustTimer(state, 30, 1_000);
  assert.equal(state.deadlineTime, 630_000);
  state = adjustTimer(state, -900, 2_000);
  assert.equal(state.deadlineTime, 2_000);
  state = resetCurrentTimer(state, 5_000);
  assert.equal(state.deadlineTime, 5_000 + ROUND_ONE_SECONDS * 1_000);
});

test("removing paused time to zero triggers normal expiry", () => {
  let state = pauseTimer(startTimer(initial(2), 0), 599_000);
  state = adjustTimer(state, -30, 600_000);
  const expired = advanceExpiredRounds(state, 600_000, uuidFactory());
  assert.equal(expired.createdRecords[0].type, INSTRUCTOR_EVENT_TYPE.CUTOFF);
  assert.equal(expired.state.currentRound, 2);
  assert.equal(expired.state.timerStatus, TIMER_STATUS.RUNNING);
});

test("non-final expiry creates one cutoff and immediately starts the next round", () => {
  const started = startTimer(initial(3), 0);
  const advanced = advanceExpiredRounds(started, 600_000, uuidFactory());
  assert.equal(advanced.createdRecords.length, 1);
  assert.equal(advanced.createdRecords[0].type, INSTRUCTOR_EVENT_TYPE.CUTOFF);
  assert.equal(advanced.state.currentRound, 2);
  assert.equal(advanced.state.deadlineTime, 600_000 + LATER_ROUND_SECONDS * 1_000);
  assert.equal(advanced.state.timerStatus, TIMER_STATUS.RUNNING);
  assert.equal(advanceExpiredRounds(advanced.state, 600_000, uuidFactory()).createdRecords.length, 0);
});

test("recovery catches up across closed-browser deadlines exactly once", () => {
  const started = startTimer(initial(3), 0);
  const recovered = advanceExpiredRounds(started, 1_200_000, uuidFactory());
  assert.deepEqual(recovered.createdRecords.map(({ type }) => type), [
    INSTRUCTOR_EVENT_TYPE.CUTOFF,
    INSTRUCTOR_EVENT_TYPE.CUTOFF,
    INSTRUCTOR_EVENT_TYPE.GAME_END,
  ]);
  assert.equal(recovered.state.timerStatus, TIMER_STATUS.ENDED);
  assert.equal(recovered.state.records.length, 3);
  assert.equal(advanceExpiredRounds(recovered.state, 2_000_000, uuidFactory()).createdRecords.length, 0);
});

test("final expiry creates GAME_END without a duplicate final cutoff", () => {
  const started = startTimer(initial(1), 0);
  const result = advanceExpiredRounds(started, 600_000, uuidFactory());
  assert.deepEqual(result.createdRecords.map(({ type }) => type), [INSTRUCTOR_EVENT_TYPE.GAME_END]);
  assert.equal(result.state.remainingMilliseconds, 0);
});

test("period controls change only future periods", () => {
  let state = initial(2);
  state = addPeriod(state);
  assert.equal(state.plannedRounds, 3);
  state = removePeriod(state);
  assert.equal(state.plannedRounds, 2);
  state = removePeriod(state);
  assert.equal(state.plannedRounds, 1);
  assert.throws(() => removePeriod(state), /no future period/);
});

test("manual end creates one logical GAME_END and never another", () => {
  let result = endSimulation(startTimer(initial(), 0), 25_000, uuidFactory());
  assert.equal(result.createdRecord.reason, "INSTRUCTOR_ENDED");
  assert.equal(result.state.timerStatus, TIMER_STATUS.ENDED);
  result = endSimulation(result.state, 30_000, uuidFactory());
  assert.equal(result.createdRecord, null);
  assert.equal(result.state.records.length, 1);
});

test("replacement abandons and stops the local clock without creating GAME_END", () => {
  const abandoned = abandonSimulation(startTimer(initial(), 0));
  assert.equal(abandoned.timerStatus, TIMER_STATUS.ENDED);
  assert.equal(abandoned.abandoned, true);
  assert.equal(abandoned.deadlineTime, null);
  assert.equal(abandoned.records.length, 0);
});

test("upload updates retain the same UUID and do not change round state", () => {
  const ended = endSimulation(initial(), 0, uuidFactory()).state;
  const updated = updateRecordUpload(ended, "uuid-1", "ATTEMPTED_UNCONFIRMED", "later");
  assert.equal(updated.records[0].uuid, "uuid-1");
  assert.equal(updated.records[0].uploadAttempts, 1);
  assert.equal(updated.currentRound, ended.currentRound);
});
