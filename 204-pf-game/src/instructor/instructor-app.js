import { normalizeCode } from "../persistence/identity.js";
import {
  GamePersistence,
  UPLOAD_STATUS,
} from "../persistence/game-persistence.js";
import {
  INSTRUCTOR_EVENT_TYPE,
  TIMER_ADJUSTMENT_SECONDS,
  TIMER_STATUS,
  abandonSimulation,
  addPeriod,
  adjustTimer,
  advanceExpiredRounds,
  createInstructorState,
  endSimulation,
  pauseTimer,
  remainingMilliseconds,
  removePeriod,
  resetCurrentTimer,
  resumeTimer,
  startTimer,
  updateRecordUpload,
} from "./timer-model.js";
import {
  createInstructorEventRecord,
  submitGoogleFormRecord,
} from "../submission/google-form.js";

const persistence = new GamePersistence();
let activeSession = null;
let transitionLocked = false;
let tickHandle = null;
let replacementGameCode = null;

const elements = {
  connectionStatus: document.querySelector("#connection-status"),
  setup: document.querySelector("#instructor-setup"),
  display: document.querySelector("#instructor-display"),
  entryForm: document.querySelector("#instructor-entry-form"),
  gameCodeInput: document.querySelector("#instructor-game-code"),
  plannedRoundsInput: document.querySelector("#planned-rounds"),
  entryError: document.querySelector("#instructor-entry-error"),
  gameIdentity: document.querySelector("#instructor-game-identity"),
  currentRound: document.querySelector("#current-round"),
  plannedRounds: document.querySelector("#planned-round-count"),
  timerState: document.querySelector("#timer-state-label"),
  clock: document.querySelector("#timer-heading"),
  cutoffStatus: document.querySelector("#cutoff-status"),
  recordStatus: document.querySelector("#instructor-record-status"),
  uploadActions: document.querySelector("#instructor-upload-actions"),
  retryUpload: document.querySelector("#retry-instructor-upload"),
  start: document.querySelector("#start-timer"),
  pauseResume: document.querySelector("#pause-resume"),
  addTime: document.querySelector("#add-time"),
  removeTime: document.querySelector("#remove-time"),
  addPeriod: document.querySelector("#add-period"),
  removePeriod: document.querySelector("#remove-period"),
  resetTimer: document.querySelector("#reset-timer"),
  endSimulation: document.querySelector("#end-simulation"),
  startNew: document.querySelector("#start-new-simulation"),
  dialog: document.querySelector("#instructor-dialog"),
  dialogKicker: document.querySelector("#instructor-dialog-kicker"),
  dialogTitle: document.querySelector("#instructor-dialog-title"),
  dialogMessage: document.querySelector("#instructor-dialog-message"),
  dialogConfirm: document.querySelector("#instructor-dialog-confirm"),
};

function state() {
  return activeSession?.instructorState;
}

function showEntryError(message) {
  elements.entryError.textContent = message;
  elements.entryError.hidden = !message;
}

function showRecordStatus(message, danger = false) {
  elements.recordStatus.textContent = message;
  elements.recordStatus.className = `status-banner${danger ? " status-banner--danger" : ""}`;
  elements.recordStatus.hidden = false;
}

function confirmAction({ kicker = "Please confirm", title, message, confirmLabel }) {
  elements.dialogKicker.textContent = kicker;
  elements.dialogTitle.textContent = title;
  elements.dialogMessage.textContent = message;
  elements.dialogConfirm.textContent = confirmLabel;
  elements.dialog.showModal();
  return new Promise((resolve) => {
    elements.dialog.addEventListener("close", () => {
      resolve(elements.dialog.returnValue === "confirm");
    }, { once: true });
  });
}

function formatClock(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function setConnectionStatus() {
  const online = navigator.onLine;
  elements.connectionStatus.dataset.online = String(online);
  elements.connectionStatus.querySelector("span:last-child").textContent = online
    ? "Internet connection detected"
    : "Offline — records remain saved locally";
}

function actionableRecord() {
  const definitelyPending = state().records.find(({ uploadStatus }) =>
    uploadStatus === UPLOAD_STATUS.NOT_STARTED ||
    uploadStatus === UPLOAD_STATUS.RETRY_RECOMMENDED);
  return definitelyPending ?? state().records.at(-1);
}

function renderRecordStatus() {
  elements.uploadActions.hidden = true;
  const record = actionableRecord();
  if (!record) {
    elements.recordStatus.hidden = true;
    return;
  }
  const label = record.type === INSTRUCTOR_EVENT_TYPE.CUTOFF
    ? `Period ${record.round} cutoff`
    : "Game end";
  elements.retryUpload.textContent = record.type === INSTRUCTOR_EVENT_TYPE.CUTOFF
    ? "Retry Cutoff Submission"
    : "Retry Game-End Submission";

  if (record.uploadStatus === UPLOAD_STATUS.ATTEMPTED_UNCONFIRMED) {
    elements.recordStatus.hidden = true;
  } else if (record.uploadStatus === UPLOAD_STATUS.RETRY_ATTEMPTED_UNCONFIRMED) {
    elements.recordStatus.hidden = true;
  } else {
    showRecordStatus(`${label} is saved locally, but its course-record submission could not be started. Reconnect and retry.`, true);
    elements.uploadActions.hidden = false;
  }
}

function render() {
  const current = state();
  if (!current) return;
  const now = Date.now();
  elements.setup.hidden = true;
  elements.display.hidden = false;
  elements.gameIdentity.textContent = current.gameCode.normalized;
  elements.currentRound.textContent = current.currentRound;
  elements.plannedRounds.textContent = current.plannedRounds;
  elements.clock.textContent = formatClock(remainingMilliseconds(current, now));
  elements.timerState.textContent = {
    [TIMER_STATUS.READY]: "Ready to begin",
    [TIMER_STATUS.RUNNING]: "Period in progress",
    [TIMER_STATUS.PAUSED]: "Paused",
    [TIMER_STATUS.ENDED]: "Simulation ended",
  }[current.timerStatus];

  const lastCutoff = [...current.records].reverse().find(({ type }) => type === INSTRUCTOR_EVENT_TYPE.CUTOFF);
  const gameEnd = current.records.find(({ type }) => type === INSTRUCTOR_EVENT_TYPE.GAME_END);
  elements.cutoffStatus.textContent = current.abandoned
    ? "This instructor-local session was replaced. No GAME_END record was sent."
    : gameEnd
    ? `Game ended in Period ${gameEnd.round}. No later information will be graded.`
    : lastCutoff
      ? `Period ${lastCutoff.round} cutoff recorded. Period ${current.currentRound} is active.`
      : "No cutoff recorded yet.";

  const active = [TIMER_STATUS.RUNNING, TIMER_STATUS.PAUSED].includes(current.timerStatus);
  elements.start.hidden = current.timerStatus !== TIMER_STATUS.READY;
  elements.pauseResume.disabled = !active;
  elements.pauseResume.textContent = current.timerStatus === TIMER_STATUS.PAUSED ? "Resume" : "Pause";
  elements.addTime.disabled = !active;
  elements.removeTime.disabled = !active;
  elements.resetTimer.disabled = !active;
  elements.addPeriod.disabled = current.timerStatus === TIMER_STATUS.ENDED;
  elements.removePeriod.disabled = current.timerStatus === TIMER_STATUS.ENDED || current.plannedRounds <= current.currentRound;
  elements.endSimulation.disabled = current.timerStatus === TIMER_STATUS.ENDED;
  renderRecordStatus();
  document.title = `${formatClock(remainingMilliseconds(current, now))} · Period ${current.currentRound} · ${current.gameCode.normalized}`;
}

async function saveState(nextState) {
  activeSession = await persistence.saveInstructorState(
    activeSession.gameCode.normalized,
    nextState,
  );
  render();
}

async function attemptRecordUpload(record, isRetry = false) {
  let status = isRetry
    ? UPLOAD_STATUS.RETRY_ATTEMPTED_UNCONFIRMED
    : UPLOAD_STATUS.ATTEMPTED_UNCONFIRMED;
  if (!navigator.onLine) {
    status = UPLOAD_STATUS.RETRY_RECOMMENDED;
  } else {
    try {
      await submitGoogleFormRecord(createInstructorEventRecord({
        instructorEvent: record,
        instructorState: state(),
      }), { isRetry });
    } catch {
      status = UPLOAD_STATUS.RETRY_RECOMMENDED;
    }
  }
  await saveState(updateRecordUpload(state(), record.uuid, status, new Date().toISOString()));
}

async function processExpirations() {
  if (transitionLocked || state()?.timerStatus !== TIMER_STATUS.RUNNING) return;
  transitionLocked = true;
  try {
    const result = advanceExpiredRounds(state(), Date.now(), () => crypto.randomUUID());
    if (result.createdRecords.length === 0) {
      render();
      return;
    }
    await saveState(result.state);
    for (const record of result.createdRecords) {
      await attemptRecordUpload(record);
    }
  } catch (error) {
    showRecordStatus(`The instructor state could not be updated safely: ${error.message}`, true);
  } finally {
    transitionLocked = false;
  }
}

async function mutate(mutator) {
  if (transitionLocked) return;
  transitionLocked = true;
  try {
    await saveState(mutator(state(), Date.now()));
  } catch (error) {
    showRecordStatus(error.message, true);
  } finally {
    transitionLocked = false;
  }
}

async function handleEntry(event) {
  event.preventDefault();
  showEntryError("");
  try {
    const gameCode = normalizeCode(elements.gameCodeInput.value, "Game code");
    const plannedRounds = Number(elements.plannedRoundsInput.value);
    if (!Number.isInteger(plannedRounds) || plannedRounds < 1) {
      throw new Error("Number of periods must be a positive whole number.");
    }
    const existing = await persistence.findInstructorSession(gameCode.normalized);
    const replacingAuthorizedSession = replacementGameCode === gameCode.normalized;
    if (replacingAuthorizedSession) {
      const accepted = await confirmAction({
        kicker: "Confirm replacement simulation",
        title: `Replace game ${gameCode.display}?`,
        message: `Normalized game code: ${gameCode.normalized}. Planned periods: ${plannedRounds}. This permanently replaces the saved instructor clock for this code. Confirm that the code and period count are correct.`,
        confirmLabel: "Replace and create",
      });
      if (!accepted) return;
      const instructorState = createInstructorState({
        sessionId: crypto.randomUUID(),
        gameCode,
        plannedRounds,
      });
      activeSession = await persistence.replaceInstructorSession({
        gameCode: gameCode.display,
        instructorState,
      });
      replacementGameCode = null;
      render();
      return;
    }
    if (existing) {
      const resume = await confirmAction({
        kicker: "Saved instructor display found",
        title: `Resume ${existing.gameCode.display}?`,
        message: `Resume the saved clock at Period ${existing.instructorState.currentRound} of ${existing.instructorState.plannedRounds}. The newly entered period count will not replace saved state.`,
        confirmLabel: "Resume display",
      });
      if (resume) {
        activeSession = existing;
        render();
        await processExpirations();
      }
      return;
    }

    const accepted = await confirmAction({
      kicker: "Confirm classroom identity",
      title: `Create game ${gameCode.display}?`,
      message: `Normalized game code: ${gameCode.normalized}. Planned periods: ${plannedRounds}. Confirm that this is the same unique code you will give to teams.`,
      confirmLabel: "Create display",
    });
    if (!accepted) return;
    const instructorState = createInstructorState({
      sessionId: crypto.randomUUID(),
      gameCode,
      plannedRounds,
    });
    activeSession = (await persistence.createInstructorSession({
      gameCode: gameCode.display,
      instructorState,
    })).session;
    replacementGameCode = null;
    render();
  } catch (error) {
    showEntryError(error.message);
  }
}

async function handleStart() {
  const accepted = await confirmAction({
    kicker: "Start Period 1",
    title: `Start game ${state().gameCode.normalized}?`,
    message: "Confirm that this locked game code exactly matches the code given to every team. The timer will start immediately.",
    confirmLabel: "Start timer",
  });
  if (accepted) await mutate((current, now) => startTimer(current, now));
}

async function handlePauseResume() {
  await mutate((current, now) => current.timerStatus === TIMER_STATUS.PAUSED
    ? resumeTimer(current, now)
    : pauseTimer(current, now));
}

async function handleReset() {
  const accepted = await confirmAction({
    title: `Reset Period ${state().currentRound} timer?`,
    message: "This restores the configured duration for the current period. It does not change the game code, period number, or any recorded cutoff.",
    confirmLabel: "Reset timer",
  });
  if (accepted) await mutate((current, now) => resetCurrentTimer(current, now));
}

async function handleEnd() {
  const accepted = await confirmAction({
    kicker: "Authoritative game end",
    title: "End the simulation now?",
    message: "The timer will stop, one GAME_END record will be saved and sent, and no later team information will be graded. This does not control team browsers; announce the end to the class.",
    confirmLabel: "End Simulation",
  });
  if (!accepted) return;
  transitionLocked = true;
  try {
    const result = endSimulation(state(), Date.now(), () => crypto.randomUUID());
    if (!result.createdRecord) {
      render();
      return;
    }
    await saveState(result.state);
    await attemptRecordUpload(result.createdRecord);
  } catch (error) {
    showRecordStatus(`The game end could not be saved safely: ${error.message}`, true);
  } finally {
    transitionLocked = false;
  }
}

async function handleRetry() {
  if (transitionLocked) return;
  const record = actionableRecord();
  if (!record) return;
  transitionLocked = true;
  elements.retryUpload.disabled = true;
  try {
    await attemptRecordUpload(record, true);
  } catch (error) {
    showRecordStatus(`The retry status could not be saved: ${error.message}`, true);
  } finally {
    transitionLocked = false;
    elements.retryUpload.disabled = false;
  }
}

async function handleStartNew() {
  const accepted = await confirmAction({
    kicker: "Replace instructor display",
    title: "Start a new simulation?",
    message: "This abandons the current instructor-local clock and returns to setup. It resets period, timer, and cutoff state and does not affect team browsers. No GAME_END is sent by this action.",
    confirmLabel: "Return to setup",
  });
  if (!accepted) return;
  transitionLocked = true;
  try {
    const replacedCode = state().gameCode.normalized;
    await saveState(abandonSimulation(state()));
    replacementGameCode = replacedCode;
    activeSession = null;
    elements.display.hidden = true;
    elements.setup.hidden = false;
    elements.entryForm.reset();
    elements.gameCodeInput.focus();
    document.title = "Instructor Display · COMM 204 Process Flow";
  } catch (error) {
    showRecordStatus(`The current instructor session could not be closed locally: ${error.message}`, true);
  } finally {
    transitionLocked = false;
  }
}

function initialize() {
  elements.entryForm.addEventListener("submit", handleEntry);
  elements.start.addEventListener("click", handleStart);
  elements.pauseResume.addEventListener("click", handlePauseResume);
  elements.addTime.addEventListener("click", () => mutate((current, now) => adjustTimer(current, TIMER_ADJUSTMENT_SECONDS, now)));
  elements.removeTime.addEventListener("click", async () => {
    await mutate((current, now) => adjustTimer(current, -TIMER_ADJUSTMENT_SECONDS, now));
    await processExpirations();
  });
  elements.addPeriod.addEventListener("click", () => mutate(addPeriod));
  elements.removePeriod.addEventListener("click", () => mutate(removePeriod));
  elements.resetTimer.addEventListener("click", handleReset);
  elements.endSimulation.addEventListener("click", handleEnd);
  elements.retryUpload.addEventListener("click", handleRetry);
  elements.startNew.addEventListener("click", handleStartNew);
  window.addEventListener("online", setConnectionStatus);
  window.addEventListener("offline", setConnectionStatus);
  setConnectionStatus();
  tickHandle = window.setInterval(processExpirations, 250);
  window.addEventListener("pagehide", () => window.clearInterval(tickHandle), { once: true });
}

initialize();
