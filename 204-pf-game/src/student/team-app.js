import {
  ACTIVITY_IDS,
  PATIENT_TYPES,
  SIMULATION_CONFIG,
  createSimulation,
  simulatePeriod,
  validateAllocation,
} from "../simulation/engine.js";
import {
  GamePersistence,
  RECOVERY_ACTION,
  RECOVERY_WARNINGS,
  UPLOAD_STATUS,
} from "../persistence/game-persistence.js";
import { normalizeTeamIdentity } from "../persistence/identity.js";
import {
  STAKEHOLDER_TARGETS,
  createStudentFinalView,
  createStudentPeriodView,
} from "./view-model.js";
import {
  createPeriodCommitRecord,
  createTeamEndRecord,
  submitGoogleFormRecord,
} from "../submission/google-form.js";
import {
  backupFilename,
  createDecisionBackupPayload,
  downloadEncryptedBackup,
  encryptDecisionBackup,
} from "../backup/game-backup.js";

const persistence = new GamePersistence();
const WORKER_NAMES = Object.freeze({
  W1: "Alex", W2: "Sam", W3: "Jordan",
  W4: "Morgan", W5: "Taylor", W6: "Casey",
});

function workerLabel(workerId) {
  return WORKER_NAMES[workerId] ?? workerId;
}

let activeSession = null;
let submitLocked = false;

const elements = {
  connectionStatus: document.querySelector("#connection-status"),
  entryView: document.querySelector("#entry-view"),
  entryForm: document.querySelector("#entry-form"),
  gameCode: document.querySelector("#game-code"),
  teamCode: document.querySelector("#team-code"),
  entryError: document.querySelector("#entry-error"),
  recoveryWarnings: document.querySelector("#recovery-warnings"),
  gameView: document.querySelector("#game-view"),
  gameIdentity: document.querySelector("#game-identity"),
  nextPeriodNumber: document.querySelector("#next-period-number"),
  submitPeriodNumber: document.querySelector("#submit-period-number"),
  offlineBanner: document.querySelector("#offline-banner"),
  saveStatus: document.querySelector("#save-status"),
  uploadActions: document.querySelector("#upload-actions"),
  retryUploadButton: document.querySelector("#retry-upload-button"),
  queueGrid: document.querySelector("#queue-grid"),
  wipTotal: document.querySelector("#wip-total"),
  scheduledCompleted: document.querySelector("#scheduled-completed"),
  unscheduledCompleted: document.querySelector("#unscheduled-completed"),
  periodsCompleted: document.querySelector("#periods-completed"),
  stakeholderGrid: document.querySelector("#stakeholder-grid"),
  finalStakeholderGrid: document.querySelector("#final-stakeholder-grid"),
  allocationForm: document.querySelector("#allocation-form"),
  workerGrid: document.querySelector("#worker-grid"),
  allocationErrors: document.querySelector("#allocation-errors"),
  allocationSummary: document.querySelector("#allocation-summary"),
  submitPeriodButton: document.querySelector("#submit-period-button"),
  utilizationEmpty: document.querySelector("#utilization-empty"),
  utilizationGrid: document.querySelector("#utilization-grid"),
  endGameButton: document.querySelector("#end-game-button"),
  finalView: document.querySelector("#final-view"),
  finalIdentity: document.querySelector("#final-identity"),
  finalIntro: document.querySelector(".final-intro"),
  downloadBackupAgain: document.querySelector("#download-backup-again"),
  teamEndStatus: document.querySelector("#team-end-status"),
  teamEndUploadActions: document.querySelector("#team-end-upload-actions"),
  retryTeamEndUpload: document.querySelector("#retry-team-end-upload"),
  patientSummaryGrid: document.querySelector("#patient-summary-grid"),
  endingWipGrid: document.querySelector("#ending-wip-grid"),
  finalWorkerUtilization: document.querySelector("#final-worker-utilization"),
  finalActivityUtilization: document.querySelector("#final-activity-utilization"),
  dialog: document.querySelector("#confirmation-dialog"),
  dialogKicker: document.querySelector("#dialog-kicker"),
  dialogTitle: document.querySelector("#dialog-title"),
  dialogMessage: document.querySelector("#dialog-message"),
  dialogCancel: document.querySelector("#dialog-cancel"),
  dialogConfirm: document.querySelector("#dialog-confirm"),
};

function makeElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function activityLabel(activityId) {
  return SIMULATION_CONFIG.activities[activityId].label;
}

function formatMinutes(value) {
  if (value === null || value === undefined) {
    return "—";
  }
  return `${Number(value.toFixed(1))} min`;
}

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

function showStatus(message, kind = "info") {
  elements.saveStatus.textContent = message;
  elements.saveStatus.className = `status-banner${kind === "danger" ? " status-banner--danger" : ""}`;
  elements.saveStatus.hidden = false;
}

function renderLatestUploadStatus() {
  elements.uploadActions.hidden = true;
  elements.retryUploadButton.hidden = true;

  const transaction = activeSession?.periodTransactions.at(-1);
  if (!transaction) {
    elements.saveStatus.hidden = true;
    return;
  }

  if (transaction.uploadStatus === UPLOAD_STATUS.ATTEMPTED_UNCONFIRMED) {
    elements.saveStatus.hidden = true;
    return;
  }

  if (transaction.uploadStatus === UPLOAD_STATUS.RETRY_ATTEMPTED_UNCONFIRMED) {
    elements.saveStatus.hidden = true;
    return;
  }

  showStatus(
    `Period ${transaction.period} completed and saved on this laptop, but the course-record submission could not be started. Reconnect and use Retry Upload. Retrying will not run another period.`,
    "danger",
  );
  elements.uploadActions.hidden = false;
  elements.retryUploadButton.hidden = false;
}

function showEntryError(message) {
  elements.entryError.textContent = message;
  elements.entryError.hidden = !message;
}

function setConnectionStatus() {
  const online = navigator.onLine;
  elements.connectionStatus.dataset.online = String(online);
  elements.connectionStatus.querySelector("span:last-child").textContent = online
    ? "Internet connection detected"
    : "Offline";
  elements.offlineBanner.hidden = online;
  if (activeSession) {
    elements.submitPeriodButton.disabled = !online || submitLocked;
  }
}

function confirmAction({ kicker = "Please confirm", title, message, confirmLabel = "Confirm" }) {
  elements.dialogKicker.textContent = kicker;
  elements.dialogTitle.textContent = title;
  elements.dialogMessage.replaceChildren();
  if (Array.isArray(message)) {
    const list = makeElement("ul");
    for (const item of message) {
      list.append(makeElement("li", null, item));
    }
    elements.dialogMessage.append(list);
  } else {
    elements.dialogMessage.textContent = message;
  }
  elements.dialogConfirm.textContent = confirmLabel;
  elements.dialog.showModal();
  return new Promise((resolve) => {
    elements.dialog.addEventListener("close", () => {
      resolve(elements.dialog.returnValue === "confirm");
    }, { once: true });
  });
}

function currentAllocation() {
  return Object.fromEntries(
    [...elements.workerGrid.querySelectorAll("select")]
      .filter((select) => select.value)
      .map((select) => [select.dataset.workerId, select.value]),
  );
}

function showAllocationErrors(errors) {
  elements.allocationErrors.replaceChildren();
  if (errors.length === 0) {
    elements.allocationErrors.hidden = true;
    return;
  }
  const list = makeElement("ul");
  for (const error of errors) {
    list.append(makeElement("li", null, error.replace(/\bW[1-6]\b/g, workerLabel)));
  }
  elements.allocationErrors.append(list);
  elements.allocationErrors.hidden = false;
}

function renderAllocationSummary(allocation) {
  elements.allocationSummary.replaceChildren();
  for (const activityId of SIMULATION_CONFIG.flexibleActivityIds) {
    const workers = Object.entries(allocation)
      .filter(([, assigned]) => assigned === activityId)
      .map(([workerId]) => workerLabel(workerId));
    const text = `${activityLabel(activityId)}: ${workers.length ? workers.join(", ") : "none"}`;
    elements.allocationSummary.append(makeElement("span", "allocation-chip", text));
  }
}

function renderWorkerControls(draft) {
  elements.workerGrid.replaceChildren();
  for (const [workerId, worker] of Object.entries(SIMULATION_CONFIG.workers)) {
    const card = makeElement("div", "worker-card");
    const label = makeElement("label", null, workerLabel(workerId));
    const select = makeElement("select");
    const selectId = `assignment-${workerId.toLowerCase()}`;
    label.htmlFor = selectId;
    select.id = selectId;
    select.dataset.workerId = workerId;
    select.append(new Option("Unassigned", ""));
    for (const activityId of worker.qualifiedActivityIds) {
      select.append(new Option(activityLabel(activityId), activityId));
    }
    select.value = draft?.[workerId] ?? "";
    const skills = makeElement(
      "p",
      "worker-card__skills",
      `Qualified: ${worker.qualifiedActivityIds.map(activityLabel).join(" · ")}`,
    );
    card.append(label, select, skills);
    elements.workerGrid.append(card);
  }
  renderAllocationSummary(currentAllocation());
}

function renderQueues(view) {
  elements.queueGrid.replaceChildren();
  for (const activityId of Object.keys(SIMULATION_CONFIG.activities)) {
    const queue = view.queues[activityId];
    const card = makeElement("article", "queue-card");
    card.append(makeElement("h3", null, activityLabel(activityId)));
    const values = makeElement("div", "queue-card__values");
    const length = makeElement("div", "queue-card__metric");
    length.append(makeElement("span", null, "Queue"), makeElement("strong", null, String(queue.length)));
    const oldest = makeElement("div", "queue-card__metric");
    oldest.append(
      makeElement("span", null, "Oldest wait"),
      makeElement("strong", null, formatMinutes(queue.oldestWaitMinutes)),
    );
    values.append(length, oldest);
    card.append(values);
    elements.queueGrid.append(card);
  }
}

function renderUtilization(view) {
  elements.utilizationGrid.replaceChildren();
  const hasResult = view.completedPeriods > 0;
  elements.utilizationEmpty.hidden = hasResult;
  if (!hasResult) {
    return;
  }
  for (const [workerId, metric] of Object.entries(view.workerUtilization)) {
    const card = makeElement("div", "utilization-card");
    const top = makeElement("div", "utilization-card__top");
    top.append(makeElement("span", null, workerLabel(workerId)), makeElement("strong", null, formatPercent(metric.utilization)));
    const track = makeElement("div", "utilization-track");
    const fill = makeElement("span");
    fill.style.width = `${Math.min(100, metric.utilization * 100)}%`;
    track.append(fill);
    card.append(top, track);
    elements.utilizationGrid.append(card);
  }
}

function targetStatus(metric) {
  if (metric.met === null) {
    return { label: "Waiting for completed patients", className: "target-status--pending" };
  }
  return metric.met
    ? { label: "Within target", className: "target-status--met" }
    : { label: "Outside target", className: "target-status--missed" };
}

function addTargetStatus(card, metric) {
  const status = targetStatus(metric);
  card.classList.add(status.className);
  card.append(makeElement("p", `target-status ${status.className}`, status.label));
}

function metricValue(value) {
  return value === null ? "—" : formatPercent(value);
}

function renderStakeholderDashboard(view, container = elements.stakeholderGrid) {
  const metrics = view.stakeholderMetrics;
  container.replaceChildren();

  const access = makeElement("article", "stakeholder-card");
  access.append(
    makeElement("p", "stakeholder-role", "Director of Patient Access"),
    makeElement("h3", null, `Scheduled visits completed within ${STAKEHOLDER_TARGETS.scheduledWithinMinutes} minutes`),
    makeElement("strong", "stakeholder-result", metricValue(metrics.patientAccess.percentage)),
    makeElement(
      "p",
      "stakeholder-detail",
      `${metrics.patientAccess.completed} completed scheduled patient${metrics.patientAccess.completed === 1 ? "" : "s"} · Target: ${formatPercent(STAKEHOLDER_TARGETS.scheduledPercent)}`,
    ),
  );
  addTargetStatus(access, metrics.patientAccess);

  const urgent = makeElement("article", "stakeholder-card stakeholder-card--wide");
  urgent.append(
    makeElement("p", "stakeholder-role", "Urgent Care Manager"),
    makeElement("h3", null, `Unscheduled patients waiting ${STAKEHOLDER_TARGETS.unscheduledWaitMinutes} minutes or less in total`),
    makeElement("strong", "stakeholder-result", metricValue(metrics.urgentCare.percentage)),
    makeElement(
      "p",
      "stakeholder-detail",
      `${metrics.urgentCare.completed} completed unscheduled patient${metrics.urgentCare.completed === 1 ? "" : "s"} · Target: ${formatPercent(STAKEHOLDER_TARGETS.unscheduledPercent)}`,
    ),
  );
  const gauge = makeElement("div", "target-gauge");
  const gaugeFill = makeElement("span", "target-gauge__fill");
  gaugeFill.style.width = `${(metrics.urgentCare.percentage ?? 0) * 100}%`;
  const marker = makeElement("span", "target-gauge__marker");
  marker.style.left = `${STAKEHOLDER_TARGETS.unscheduledPercent * 100}%`;
  marker.setAttribute("aria-label", "80 percent target");
  gauge.append(gaugeFill, marker);
  urgent.append(gauge);

  const histogram = makeElement("div", "wait-histogram");
  const largestBin = Math.max(1, ...metrics.urgentCare.waitBins.map((bin) => bin.count));
  for (const bin of metrics.urgentCare.waitBins) {
    const row = makeElement("div", "wait-histogram__row");
    row.append(makeElement("span", null, bin.label));
    const track = makeElement("div", "wait-histogram__track");
    const fill = makeElement("span");
    fill.style.width = `${(bin.count / largestBin) * 100}%`;
    track.append(fill);
    row.append(track, makeElement("strong", null, String(bin.count)));
    histogram.append(row);
  }
  urgent.append(histogram);
  addTargetStatus(urgent, metrics.urgentCare);

  const operations = makeElement("article", "stakeholder-card");
  operations.append(
    makeElement("p", "stakeholder-role", "Hospital Operations Manager"),
    makeElement("h3", null, "Eligible patients completing their care"),
    makeElement("strong", "stakeholder-result", metricValue(metrics.operations.percentage)),
    makeElement(
      "p",
      "stakeholder-detail",
      `${metrics.operations.completed} of ${metrics.operations.eligible} eligible patients · Target: ${formatPercent(STAKEHOLDER_TARGETS.operationsPercent)}`,
    ),
    makeElement(
      "p",
      "stakeholder-detail",
      `${metrics.operations.workInProcess} patients in system · ${metrics.operations.queued} currently queued`,
    ),
  );
  addTargetStatus(operations, metrics.operations);
  operations.append(makeElement("p", "stakeholder-detail",
    "Eligible: scheduled patients who arrived at least 20 minutes ago and unscheduled patients who arrived at least 45 minutes ago."));

  const workforce = makeElement("article", "stakeholder-card");
  workforce.append(
    makeElement("p", "stakeholder-role", "Director of Clinical Workforce"),
    makeElement("h3", null, "Overall flexible-worker utilization"),
    makeElement("strong", "stakeholder-result", metricValue(metrics.workforce.utilization)),
    makeElement("p", "stakeholder-detail", `Target range: ${formatPercent(STAKEHOLDER_TARGETS.workforceMinimum)}–${formatPercent(STAKEHOLDER_TARGETS.workforceMaximum)}`),
  );
  addTargetStatus(workforce, metrics.workforce);

  container.append(access, urgent, operations, workforce);
}

function renderGame() {
  const view = createStudentPeriodView(activeSession.simulationState);
  elements.entryView.hidden = true;
  elements.finalView.hidden = true;
  elements.gameView.hidden = false;
  elements.gameIdentity.textContent = `Game ${activeSession.gameCode.display} · Team ${activeSession.teamCode.display}`;
  elements.nextPeriodNumber.textContent = view.nextPeriod;
  elements.submitPeriodNumber.textContent = view.nextPeriod;
  elements.wipTotal.textContent = view.workInProcess;
  elements.scheduledCompleted.textContent = view.cumulativeCompletions[PATIENT_TYPES.SCHEDULED];
  elements.unscheduledCompleted.textContent = view.cumulativeCompletions[PATIENT_TYPES.UNSCHEDULED];
  elements.periodsCompleted.textContent = view.completedPeriods;
  renderQueues(view);
  renderStakeholderDashboard(view);
  renderWorkerControls(activeSession.allocationDraft ?? view.assignments);
  renderUtilization(view);
  renderLatestUploadStatus();
  setConnectionStatus();
  document.title = `Period ${view.nextPeriod} · Team ${activeSession.teamCode.display}`;
}

async function attemptPeriodUpload(transaction, isRetry) {
  let nextStatus = isRetry
    ? UPLOAD_STATUS.RETRY_ATTEMPTED_UNCONFIRMED
    : UPLOAD_STATUS.ATTEMPTED_UNCONFIRMED;
  try {
    await submitGoogleFormRecord(transaction.formRecord, { isRetry });
  } catch {
    nextStatus = UPLOAD_STATUS.RETRY_RECOMMENDED;
  }

  activeSession = await persistence.markPeriodUpload(
    activeSession.gameCode.normalized,
    activeSession.teamCode.normalized,
    transaction.uuid,
    nextStatus,
  );
  renderLatestUploadStatus();
}

async function retryLatestUpload() {
  if (submitLocked || !activeSession) {
    return;
  }
  const transaction = activeSession.periodTransactions.at(-1);
  if (!transaction) {
    return;
  }
  if (!navigator.onLine) {
    setConnectionStatus();
    showStatus("You appear to be offline. Reconnect before retrying the saved upload.", "danger");
    return;
  }

  submitLocked = true;
  elements.submitPeriodButton.disabled = true;
  elements.endGameButton.disabled = true;
  elements.retryUploadButton.disabled = true;
  try {
    await attemptPeriodUpload(transaction, true);
  } catch (error) {
    showStatus(`The retry status could not be saved locally: ${error.message}`, "danger");
  } finally {
    submitLocked = false;
    elements.endGameButton.disabled = false;
    elements.retryUploadButton.disabled = false;
    setConnectionStatus();
  }
}

function statisticRow(label, value) {
  const row = makeElement("div", "stat-row");
  row.append(makeElement("span", null, label), makeElement("strong", null, value));
  return row;
}

function renderTeamEndStatus() {
  const teamEnd = activeSession.teamEnd;
  elements.teamEndUploadActions.hidden = true;
  if (!teamEnd) {
    elements.teamEndStatus.hidden = true;
    elements.downloadBackupAgain.disabled = true;
    return;
  }
  elements.downloadBackupAgain.disabled = !teamEnd.encryptedBackup?.fileText;
  elements.teamEndStatus.hidden = false;
  elements.teamEndStatus.className = "status-banner";
  if (teamEnd.uploadStatus === UPLOAD_STATUS.ATTEMPTED_UNCONFIRMED) {
    elements.teamEndStatus.hidden = true;
  } else if (teamEnd.uploadStatus === UPLOAD_STATUS.RETRY_ATTEMPTED_UNCONFIRMED) {
    elements.teamEndStatus.hidden = true;
  } else {
    elements.teamEndStatus.textContent = "The team-end record is saved on this laptop, but its course-record submission could not be started. Reconnect and retry.";
    elements.teamEndStatus.className = "status-banner status-banner--danger";
    elements.teamEndUploadActions.hidden = false;
  }
}

function renderFinal() {
  const view = createStudentFinalView(activeSession.simulationState);
  elements.entryView.hidden = true;
  elements.gameView.hidden = true;
  elements.finalView.hidden = false;
  elements.finalIdentity.textContent = `Game ${activeSession.gameCode.display} · Team ${activeSession.teamCode.display}`;
  elements.finalIntro.textContent = `${view.completedPeriods} period${view.completedPeriods === 1 ? "" : "s"} completed · ${view.simulatedMinutes} simulated minutes`;
  renderTeamEndStatus();

  renderStakeholderDashboard(view, elements.finalStakeholderGrid);
  elements.patientSummaryGrid.replaceChildren();
  for (const patientType of [PATIENT_TYPES.SCHEDULED, PATIENT_TYPES.UNSCHEDULED]) {
    const metric = view.patientTypes[patientType];
    const card = makeElement("article", "patient-summary-card");
    card.append(makeElement("h3", null, SIMULATION_CONFIG.patientTypes[patientType].label));
    const list = makeElement("div", "stat-list");
    list.append(
      statisticRow("Patients completed", String(metric.completions)),
      statisticRow("Average visit duration (completed patients)", formatMinutes(metric.averageFlowTimeMinutes)),
      statisticRow("Maximum visit duration (completed patients)", formatMinutes(metric.maximumFlowTimeMinutes)),
      statisticRow("Average waiting time (all arrivals)", formatMinutes(metric.averageWaitingTimeMinutes)),
      statisticRow("Maximum waiting time (all arrivals)", formatMinutes(metric.maximumWaitingTimeMinutes)),
    );
    card.append(list);
    elements.patientSummaryGrid.append(card);
  }

  elements.endingWipGrid.replaceChildren();
  for (const [activityId, metric] of Object.entries(view.endingWorkInProcess)) {
    const cell = makeElement("div", "wip-cell");
    cell.append(
      makeElement("h3", null, activityLabel(activityId)),
      makeElement("span", null, "Queued / in service"),
      makeElement("strong", null, `${metric.queued} / ${metric.inService}`),
    );
    elements.endingWipGrid.append(cell);
  }

  elements.finalWorkerUtilization.replaceChildren();
  for (const workerId of Object.keys(SIMULATION_CONFIG.workers)) {
    elements.finalWorkerUtilization.append(
      statisticRow(workerLabel(workerId), formatPercent(view.utilizationByWorker[workerId])),
    );
  }
  elements.finalActivityUtilization.replaceChildren();
  for (const activityId of Object.keys(SIMULATION_CONFIG.activities)) {
    elements.finalActivityUtilization.append(
      statisticRow(activityLabel(activityId), formatPercent(view.utilizationByActivity[activityId])),
    );
  }
  document.title = `Game complete · Team ${activeSession.teamCode.display}`;
}

function downloadSavedBackup() {
  const backup = activeSession?.teamEnd?.encryptedBackup;
  if (!backup?.fileText) {
    elements.teamEndStatus.textContent = "This saved session does not contain an encrypted verification file.";
    elements.teamEndStatus.className = "status-banner status-banner--danger";
    elements.teamEndStatus.hidden = false;
    return;
  }
  downloadEncryptedBackup(backup.fileText, backup.filename);
}

async function attemptTeamEndUpload(isRetry = false) {
  const teamEnd = activeSession.teamEnd;
  let status = isRetry
    ? UPLOAD_STATUS.RETRY_ATTEMPTED_UNCONFIRMED
    : UPLOAD_STATUS.ATTEMPTED_UNCONFIRMED;
  if (!navigator.onLine) {
    status = UPLOAD_STATUS.RETRY_RECOMMENDED;
  } else {
    try {
      await submitGoogleFormRecord(teamEnd.formRecord, { isRetry });
    } catch {
      status = UPLOAD_STATUS.RETRY_RECOMMENDED;
    }
  }
  activeSession = await persistence.markTeamEndUpload(
    activeSession.gameCode.normalized,
    activeSession.teamCode.normalized,
    teamEnd.uuid,
    status,
  );
  renderTeamEndStatus();
}

async function retryTeamEndUpload() {
  if (submitLocked || !activeSession?.teamEnd) return;
  submitLocked = true;
  elements.retryTeamEndUpload.disabled = true;
  try {
    await attemptTeamEndUpload(true);
  } catch (error) {
    elements.teamEndStatus.textContent = `The retry status could not be saved locally: ${error.message}`;
    elements.teamEndStatus.className = "status-banner status-banner--danger";
  } finally {
    submitLocked = false;
    elements.retryTeamEndUpload.disabled = false;
  }
}

async function startNewSession(identity, replace = false) {
  const accepted = await confirmAction({
    kicker: "Local recovery warning",
    title: replace ? "Replace saved progress?" : "Start this team game?",
    message: replace
      ? ["The existing local game will be permanently replaced.", ...RECOVERY_WARNINGS]
      : RECOVERY_WARNINGS,
    confirmLabel: replace ? "Replace and start" : "Start game",
  });
  if (!accepted) {
    return;
  }
  const input = {
    gameCode: identity.game.display,
    teamCode: identity.team.display,
    simulationState: createSimulation(identity.game.normalized),
  };
  activeSession = replace
    ? await persistence.replaceTeamSession(input)
    : (await persistence.createTeamSession(input)).session;
  renderGame();
}

async function handleEntry(event) {
  event.preventDefault();
  showEntryError("");
  try {
    const identity = normalizeTeamIdentity(elements.gameCode.value, elements.teamCode.value);
    const identityConfirmed = await confirmAction({
      title: `Join as Team ${identity.team.display}?`,
      message: `You are joining game ${identity.game.display} as Team ${identity.team.display}. Is this correct?`,
      confirmLabel: "Yes, continue",
    });
    if (!identityConfirmed) {
      return;
    }

    const recovery = await persistence.getTeamRecovery(
      identity.game.normalized,
      identity.team.normalized,
    );
    if (!recovery.found) {
      await startNewSession(identity);
      return;
    }

    const resume = await confirmAction({
      kicker: "Saved progress found",
      title: `Resume Team ${recovery.session.teamCode.display}?`,
      message: recovery.action === RECOVERY_ACTION.SHOW_FINAL
        ? "This team ended its local game. Resume to view the final statistics."
        : `Resume at the next unfinished action after Period ${recovery.session.simulationState.completedPeriods}?`,
      confirmLabel: recovery.action === RECOVERY_ACTION.SHOW_FINAL ? "View final results" : "Resume game",
    });
    if (resume) {
      activeSession = recovery.session;
      if (recovery.action === RECOVERY_ACTION.SHOW_FINAL) {
        renderFinal();
      } else {
        renderGame();
      }
      return;
    }

    await startNewSession(identity, true);
  } catch (error) {
    showEntryError(error.message);
  }
}

async function handleAllocationChange() {
  const allocation = currentAllocation();
  renderAllocationSummary(allocation);
  showAllocationErrors([]);
  if (!activeSession) {
    return;
  }
  try {
    activeSession = await persistence.saveAllocationDraft(
      activeSession.gameCode.normalized,
      activeSession.teamCode.normalized,
      allocation,
    );
  } catch (error) {
    showStatus(`The allocation could not be saved locally: ${error.message}`, "danger");
  }
}

async function handlePeriodSubmit(event) {
  event.preventDefault();
  if (submitLocked) {
    return;
  }
  if (!navigator.onLine) {
    setConnectionStatus();
    elements.offlineBanner.focus?.();
    return;
  }

  const allocation = currentAllocation();
  const validation = validateAllocation(allocation);
  showAllocationErrors(validation.errors);
  if (!validation.valid) {
    elements.allocationErrors.focus?.();
    return;
  }

  submitLocked = true;
  elements.submitPeriodButton.disabled = true;
  elements.endGameButton.disabled = true;
  try {
    const simulated = simulatePeriod(activeSession.simulationState, allocation);
    const uuid = crypto.randomUUID();
    const localDiagnosticTime = new Date().toISOString();
    const formRecord = createPeriodCommitRecord({
      uuid,
      gameCode: activeSession.gameCode,
      teamCode: activeSession.teamCode,
      allocation,
      prePeriodState: activeSession.simulationState,
      preDecisionVisibleMeasures: createStudentPeriodView(activeSession.simulationState),
      periodResult: simulated.result,
      endingState: simulated.state,
      localDiagnosticTime,
    });
    activeSession = await persistence.commitPeriod(
      activeSession.gameCode.normalized,
      activeSession.teamCode.normalized,
      {
        uuid,
        simulationState: simulated.state,
        periodResult: simulated.result,
        nextAllocationDraft: allocation,
        formRecord,
        uploadStatus: UPLOAD_STATUS.NOT_STARTED,
      },
    );
    renderGame();
    const committedTransaction = activeSession.periodTransactions.at(-1);
    try {
      await attemptPeriodUpload(committedTransaction, false);
    } catch (uploadStatusError) {
      showStatus(
        `Period ${simulated.result.period} is saved locally, but its upload status could not be saved: ${uploadStatusError.message}`,
        "danger",
      );
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    showStatus(`The period was not committed: ${error.message}`, "danger");
  } finally {
    submitLocked = false;
    elements.submitPeriodButton.disabled = !navigator.onLine;
    elements.endGameButton.disabled = false;
  }
}

async function handleEndGame() {
  const accepted = await confirmAction({
    kicker: "End local team game",
    title: "Show final statistics?",
    message: "Only do this after your instructor announces that the game has ended. You will not be able to submit another period from this saved session.",
    confirmLabel: "End Game",
  });
  if (!accepted) {
    return;
  }
  submitLocked = true;
  elements.endGameButton.disabled = true;
  elements.submitPeriodButton.disabled = true;
  try {
    const uuid = crypto.randomUUID();
    const localDiagnosticTime = new Date().toISOString();
    const payload = createDecisionBackupPayload(activeSession, {
      teamEndUuid: uuid,
      createdAt: localDiagnosticTime,
    });
    const encrypted = await encryptDecisionBackup(payload);
    const filename = backupFilename(uuid);
    const formRecord = createTeamEndRecord({
      uuid,
      gameCode: activeSession.gameCode,
      teamCode: activeSession.teamCode,
      completedPeriods: activeSession.simulationState.completedPeriods,
      configurationVersion: activeSession.simulationState.configurationVersion,
      seedVersion: activeSession.simulationState.seedVersion,
      localDiagnosticTime,
      encryptedBackupChecksum: encrypted.checksumSha256,
    });
    activeSession = await persistence.endTeamSession(
      activeSession.gameCode.normalized,
      activeSession.teamCode.normalized,
      {
        uuid,
        backupChecksum: encrypted.checksumSha256,
        encryptedBackup: {
          filename,
          fileText: encrypted.fileText,
          checksumSha256: encrypted.checksumSha256,
        },
        formRecord,
        uploadStatus: UPLOAD_STATUS.NOT_STARTED,
      },
    );
    renderFinal();
    try {
      downloadSavedBackup();
    } catch (downloadError) {
      elements.teamEndStatus.textContent = `The game ended safely, but the file download could not start: ${downloadError.message}. Use Download verification file again.`;
      elements.teamEndStatus.className = "status-banner status-banner--danger";
    }
    try {
      await attemptTeamEndUpload(false);
    } catch (uploadError) {
      elements.teamEndStatus.textContent = `The game ended safely, but its submission status could not be saved: ${uploadError.message}`;
      elements.teamEndStatus.className = "status-banner status-banner--danger";
    }
  } catch (error) {
    showStatus(`The game could not be ended safely: ${error.message}`, "danger");
  } finally {
    submitLocked = false;
    elements.endGameButton.disabled = false;
    elements.submitPeriodButton.disabled = !navigator.onLine;
  }
}

function initialize() {
  for (const warning of RECOVERY_WARNINGS) {
    elements.recoveryWarnings.append(makeElement("li", null, warning));
  }
  elements.entryForm.addEventListener("submit", handleEntry);
  elements.workerGrid.addEventListener("change", handleAllocationChange);
  elements.allocationForm.addEventListener("submit", handlePeriodSubmit);
  elements.endGameButton.addEventListener("click", handleEndGame);
  elements.retryUploadButton.addEventListener("click", retryLatestUpload);
  elements.downloadBackupAgain.addEventListener("click", downloadSavedBackup);
  elements.retryTeamEndUpload.addEventListener("click", retryTeamEndUpload);
  window.addEventListener("online", setConnectionStatus);
  window.addEventListener("offline", setConnectionStatus);
  setConnectionStatus();
}

initialize();
