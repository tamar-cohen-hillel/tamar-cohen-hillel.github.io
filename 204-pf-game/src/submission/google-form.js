import { canonicalStringify, checksum } from "../simulation/checksum.js";
import { GOOGLE_FORM_CONFIG } from "./google-form-config.js";

export const FORM_SCHEMA_VERSION = "comm204-form-record-v1";
export const APPLICATION_VERSION = "comm204-game-v1";

function requireValue(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required for course-record submission.`);
  }
}

export function createAuditStateSnapshot(state) {
  const patientsInSystem = Object.fromEntries(
    Object.entries(state.patients)
      .filter(([, patient]) => patient.status !== "COMPLETED")
      .map(([id, patient]) => [id, structuredClone(patient)]),
  );
  const workers = Object.fromEntries(
    Object.entries(state.workers).map(([id, worker]) => [id, {
      id: worker.id,
      isFixed: worker.isFixed,
      assignedActivityId: worker.assignedActivityId,
      pendingActivityId: worker.pendingActivityId,
      patientId: worker.patientId,
      busyActivityId: worker.busyActivityId,
      busySince: worker.busySince,
      busyUntil: worker.busyUntil,
    }]),
  );

  return {
    schemaVersion: state.schemaVersion,
    configurationVersion: state.configurationVersion,
    seedVersion: state.seedVersion,
    gameCode: state.gameCode,
    time: state.time,
    completedPeriods: state.completedPeriods,
    randomState: state.randomState,
    nextUnscheduledArrivalTime: state.nextUnscheduledArrivalTime,
    nextPatientSequence: state.nextPatientSequence,
    nextQueueSequence: state.nextQueueSequence,
    patientsInSystem,
    queues: structuredClone(state.queues),
    workers,
    completions: structuredClone(state.completions),
    stateChecksum: state.stateChecksum,
  };
}

export function createPeriodCommitRecord({
  uuid,
  gameCode,
  teamCode,
  allocation,
  prePeriodState,
  preDecisionVisibleMeasures,
  periodResult,
  endingState,
  localDiagnosticTime = new Date().toISOString(),
}) {
  requireValue(uuid, "Event UUID");
  const payload = {
    transactionUuid: uuid,
    period: periodResult.period,
    localClickTime: localDiagnosticTime,
    allocation,
    prePeriodState: createAuditStateSnapshot(prePeriodState),
    preDecisionVisibleMeasures,
    periodResult,
    endingState: createAuditStateSnapshot(endingState),
    endingStateChecksum: endingState.stateChecksum,
  };

  return {
    schemaVersion: FORM_SCHEMA_VERSION,
    applicationVersion: APPLICATION_VERSION,
    eventType: "PERIOD_COMMIT",
    uuid,
    gameCode,
    actorCode: teamCode,
    instructorSessionId: "",
    roundOrPeriod: periodResult.period,
    localDiagnosticTime,
    configurationVersion: endingState.configurationVersion,
    seedVersion: endingState.seedVersion,
    payloadChecksum: checksum(payload),
    payload,
  };
}

export function createInstructorEventRecord({
  instructorEvent,
  instructorState,
}) {
  if (!["CUTOFF", "GAME_END"].includes(instructorEvent.type)) {
    throw new Error(`Unsupported instructor event type: ${instructorEvent.type}`);
  }
  requireValue(instructorEvent.uuid, "Event UUID");
  const payload = instructorEvent.type === "CUTOFF"
    ? {
      instructorSessionId: instructorState.sessionId,
      cutoffUuid: instructorEvent.uuid,
      round: instructorEvent.round,
      timerExpiryDiagnosticTime: instructorEvent.diagnosticTime,
      reason: instructorEvent.reason,
    }
    : {
      instructorSessionId: instructorState.sessionId,
      gameEndUuid: instructorEvent.uuid,
      currentRound: instructorEvent.round,
      cutoffStatus: instructorEvent.reason === "FINAL_ROUND_EXPIRED"
        ? "FINAL_ROUND_DEADLINE"
        : "INSTRUCTOR_ENDED",
      diagnosticTime: instructorEvent.diagnosticTime,
      reason: instructorEvent.reason,
    };

  return {
    schemaVersion: FORM_SCHEMA_VERSION,
    applicationVersion: APPLICATION_VERSION,
    eventType: instructorEvent.type,
    uuid: instructorEvent.uuid,
    gameCode: instructorState.gameCode,
    actorCode: "INSTRUCTOR",
    instructorSessionId: instructorState.sessionId,
    roundOrPeriod: instructorEvent.round,
    localDiagnosticTime: instructorEvent.diagnosticTime,
    configurationVersion: "comm204-instructor-timer-v1",
    seedVersion: "",
    payloadChecksum: checksum(payload),
    payload,
  };
}

export function createTeamEndRecord({
  uuid,
  gameCode,
  teamCode,
  completedPeriods,
  configurationVersion,
  seedVersion,
  localDiagnosticTime,
  encryptedBackupChecksum,
}) {
  requireValue(uuid, "Event UUID");
  requireValue(encryptedBackupChecksum, "Encrypted backup checksum");
  const payload = {
    teamEndUuid: uuid,
    completedPeriods,
    configurationVersion,
    encryptedBackupChecksum,
    diagnosticTime: localDiagnosticTime,
  };
  return {
    schemaVersion: FORM_SCHEMA_VERSION,
    applicationVersion: APPLICATION_VERSION,
    eventType: "TEAM_END",
    uuid,
    gameCode,
    actorCode: teamCode,
    instructorSessionId: "",
    roundOrPeriod: completedPeriods,
    localDiagnosticTime,
    configurationVersion,
    seedVersion,
    payloadChecksum: checksum(payload),
    payload,
  };
}

export function encodeGoogleFormRecord(record, { isRetry = false } = {}) {
  const fields = GOOGLE_FORM_CONFIG.fields;
  const values = new URLSearchParams();
  values.set(fields.schemaVersion, record.schemaVersion);
  values.set(fields.applicationVersion, record.applicationVersion);
  values.set(fields.eventType, record.eventType);
  values.set(fields.eventUuid, record.uuid);
  values.set(fields.gameCodeNormalized, record.gameCode.normalized);
  values.set(fields.gameCodeDisplay, record.gameCode.display);
  values.set(fields.actorCode, record.actorCode.normalized ?? record.actorCode);
  values.set(fields.instructorSessionId, record.instructorSessionId ?? "");
  values.set(fields.roundOrPeriod, String(record.roundOrPeriod ?? ""));
  values.set(fields.localDiagnosticTime, record.localDiagnosticTime);
  values.set(fields.configurationVersion, record.configurationVersion ?? "");
  values.set(fields.seedVersion, record.seedVersion ?? "");
  values.set(fields.payloadChecksum, record.payloadChecksum);
  values.set(fields.isRetry, isRetry ? "TRUE" : "FALSE");
  values.set(fields.payloadJson, canonicalStringify(record.payload));
  return values;
}

export async function submitGoogleFormRecord(
  record,
  {
    isRetry = false,
    fetchImpl = globalThis.fetch,
    timeoutMilliseconds = 12_000,
  } = {},
) {
  if (typeof fetchImpl !== "function") {
    throw new Error("This browser cannot start the course-record submission.");
  }
  const body = encodeGoogleFormRecord(record, { isRetry });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
  let request;
  try {
    request = fetchImpl(GOOGLE_FORM_CONFIG.submissionUrl, {
      method: "POST",
      mode: "no-cors",
      cache: "no-store",
      credentials: "omit",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }

  try {
    await request;
    return { attempted: true, confirmationAvailable: false };
  } catch (error) {
    return {
      attempted: true,
      confirmationAvailable: false,
      transportEndedWithError: true,
      diagnosticErrorName: error?.name ?? "Error",
    };
  } finally {
    clearTimeout(timeout);
  }
}
