export const INSTRUCTOR_STATE_VERSION = "comm204-instructor-state-v1";

export const TIMER_STATUS = Object.freeze({
  READY: "READY",
  RUNNING: "RUNNING",
  PAUSED: "PAUSED",
  ENDED: "ENDED",
});

export const INSTRUCTOR_EVENT_TYPE = Object.freeze({
  CUTOFF: "CUTOFF",
  GAME_END: "GAME_END",
});

export const ROUND_ONE_SECONDS = 10 * 60;
export const LATER_ROUND_SECONDS = 5 * 60;
export const TIMER_ADJUSTMENT_SECONDS = 30;

function copy(state) {
  return structuredClone(state);
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive whole number.`);
  }
}

function configuredSeconds(round) {
  return round === 1 ? ROUND_ONE_SECONDS : LATER_ROUND_SECONDS;
}

function makeEvent(type, state, uuid, diagnosticTime, reason) {
  return {
    type,
    uuid,
    round: state.currentRound,
    diagnosticTime,
    reason,
    uploadStatus: "NOT_STARTED",
    uploadAttempts: 0,
    lastUploadAttemptAt: null,
  };
}

export function createInstructorState({ sessionId, gameCode, plannedRounds }) {
  requirePositiveInteger(plannedRounds, "Planned periods");
  return {
    schemaVersion: INSTRUCTOR_STATE_VERSION,
    sessionId,
    gameCode: structuredClone(gameCode),
    plannedRounds,
    currentRound: 1,
    timerStatus: TIMER_STATUS.READY,
    remainingMilliseconds: ROUND_ONE_SECONDS * 1_000,
    deadlineTime: null,
    codeLocked: false,
    abandoned: false,
    records: [],
  };
}

export function abandonSimulation(state) {
  const next = copy(state);
  next.timerStatus = TIMER_STATUS.ENDED;
  next.remainingMilliseconds = 0;
  next.deadlineTime = null;
  next.codeLocked = true;
  next.abandoned = true;
  return next;
}

export function remainingMilliseconds(state, nowMilliseconds) {
  if (state.timerStatus === TIMER_STATUS.RUNNING) {
    return Math.max(0, state.deadlineTime - nowMilliseconds);
  }
  return Math.max(0, state.remainingMilliseconds);
}

export function startTimer(state, nowMilliseconds) {
  if (state.timerStatus !== TIMER_STATUS.READY) {
    throw new Error("Only a ready simulation can be started.");
  }
  const next = copy(state);
  next.timerStatus = TIMER_STATUS.RUNNING;
  next.codeLocked = true;
  next.deadlineTime = nowMilliseconds + next.remainingMilliseconds;
  return next;
}

export function pauseTimer(state, nowMilliseconds) {
  if (state.timerStatus !== TIMER_STATUS.RUNNING) {
    throw new Error("Only a running timer can be paused.");
  }
  const next = copy(state);
  next.remainingMilliseconds = remainingMilliseconds(next, nowMilliseconds);
  next.deadlineTime = null;
  next.timerStatus = TIMER_STATUS.PAUSED;
  return next;
}

export function resumeTimer(state, nowMilliseconds) {
  if (state.timerStatus !== TIMER_STATUS.PAUSED) {
    throw new Error("Only a paused timer can be resumed.");
  }
  const next = copy(state);
  next.deadlineTime = nowMilliseconds + next.remainingMilliseconds;
  next.timerStatus = TIMER_STATUS.RUNNING;
  return next;
}

export function adjustTimer(state, seconds, nowMilliseconds) {
  if (![TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED].includes(state.timerStatus)) {
    throw new Error("Start the simulation before adjusting its timer.");
  }
  const next = copy(state);
  if (next.timerStatus === TIMER_STATUS.RUNNING) {
    next.deadlineTime = Math.max(nowMilliseconds, next.deadlineTime + seconds * 1_000);
  } else {
    next.remainingMilliseconds = Math.max(0, next.remainingMilliseconds + seconds * 1_000);
    if (next.remainingMilliseconds === 0) {
      next.timerStatus = TIMER_STATUS.RUNNING;
      next.deadlineTime = nowMilliseconds;
    }
  }
  return next;
}

export function resetCurrentTimer(state, nowMilliseconds) {
  if (![TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED].includes(state.timerStatus)) {
    throw new Error("Start the simulation before resetting its timer.");
  }
  const next = copy(state);
  const duration = configuredSeconds(next.currentRound) * 1_000;
  next.remainingMilliseconds = duration;
  if (next.timerStatus === TIMER_STATUS.RUNNING) {
    next.deadlineTime = nowMilliseconds + duration;
  }
  return next;
}

export function addPeriod(state) {
  if (state.timerStatus === TIMER_STATUS.ENDED) {
    throw new Error("An ended simulation cannot be extended.");
  }
  const next = copy(state);
  next.plannedRounds += 1;
  return next;
}

export function removePeriod(state) {
  if (state.timerStatus === TIMER_STATUS.ENDED) {
    throw new Error("An ended simulation cannot be changed.");
  }
  if (state.plannedRounds <= state.currentRound) {
    throw new Error("There is no future period to remove.");
  }
  const next = copy(state);
  next.plannedRounds -= 1;
  return next;
}

export function advanceExpiredRounds(state, nowMilliseconds, uuidFactory) {
  let next = copy(state);
  const createdRecords = [];
  while (
    next.timerStatus === TIMER_STATUS.RUNNING &&
    next.deadlineTime <= nowMilliseconds
  ) {
    const expiredAt = next.deadlineTime;
    if (next.currentRound >= next.plannedRounds) {
      const record = makeEvent(
        INSTRUCTOR_EVENT_TYPE.GAME_END,
        next,
        uuidFactory(),
        new Date(expiredAt).toISOString(),
        "FINAL_ROUND_EXPIRED",
      );
      next.records.push(record);
      createdRecords.push(record);
      next.timerStatus = TIMER_STATUS.ENDED;
      next.remainingMilliseconds = 0;
      next.deadlineTime = null;
      break;
    }

    const cutoff = makeEvent(
      INSTRUCTOR_EVENT_TYPE.CUTOFF,
      next,
      uuidFactory(),
      new Date(expiredAt).toISOString(),
      "ROUND_EXPIRED",
    );
    next.records.push(cutoff);
    createdRecords.push(cutoff);
    next.currentRound += 1;
    next.remainingMilliseconds = configuredSeconds(next.currentRound) * 1_000;
    next.deadlineTime = expiredAt + next.remainingMilliseconds;
  }
  return { state: next, createdRecords };
}

export function endSimulation(state, nowMilliseconds, uuidFactory) {
  const existing = state.records.find(({ type }) => type === INSTRUCTOR_EVENT_TYPE.GAME_END);
  if (existing) {
    return { state: copy(state), createdRecord: null };
  }
  const next = copy(state);
  const record = makeEvent(
    INSTRUCTOR_EVENT_TYPE.GAME_END,
    next,
    uuidFactory(),
    new Date(nowMilliseconds).toISOString(),
    "INSTRUCTOR_ENDED",
  );
  next.records.push(record);
  next.timerStatus = TIMER_STATUS.ENDED;
  next.remainingMilliseconds = 0;
  next.deadlineTime = null;
  next.codeLocked = true;
  return { state: next, createdRecord: record };
}

export function updateRecordUpload(state, uuid, uploadStatus, attemptedAt) {
  const next = copy(state);
  const record = next.records.find((item) => item.uuid === uuid);
  if (!record) {
    throw new Error(`No instructor record has UUID ${uuid}.`);
  }
  record.uploadStatus = uploadStatus;
  record.uploadAttempts += 1;
  record.lastUploadAttemptAt = attemptedAt;
  return next;
}
