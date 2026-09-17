export const ACTIVITY_IDS = Object.freeze({
  INTAKE: "INTAKE",
  ROUTINE: "ROUTINE",
  ASSESSMENT: "ASSESSMENT",
  DIAGNOSTICS: "DIAGNOSTICS",
  REVIEW: "REVIEW",
});

export const PATIENT_TYPES = Object.freeze({
  SCHEDULED: "SCHEDULED",
  UNSCHEDULED: "UNSCHEDULED",
});

export const SIMULATION_CONFIG = Object.freeze({
  schemaVersion: "comm204-simulation-state-v1",
  configurationVersion: "comm204-process-v3-hourly-random-diagnostics",
  seedVersion: "comm204-arrivals-v1",
  seedSalt: "COMM204_PROCESS_FLOW_2026W1",
  periodMinutes: 60,
  arrivalTimePrecision: 1_000_000,
  scheduledArrivalOffsets: Object.freeze([0, 10, 20, 30, 40, 50]),
  unscheduledArrivalsPerHour: 5,
  patientTypes: Object.freeze({
    [PATIENT_TYPES.SCHEDULED]: Object.freeze({
      label: "Scheduled follow-up",
      route: Object.freeze([
        ACTIVITY_IDS.INTAKE,
        ACTIVITY_IDS.ROUTINE,
      ]),
    }),
    [PATIENT_TYPES.UNSCHEDULED]: Object.freeze({
      label: "Unscheduled diagnostic",
      route: Object.freeze([
        ACTIVITY_IDS.INTAKE,
        ACTIVITY_IDS.ASSESSMENT,
        ACTIVITY_IDS.DIAGNOSTICS,
        ACTIVITY_IDS.REVIEW,
      ]),
    }),
  }),
  activities: Object.freeze({
    [ACTIVITY_IDS.INTAKE]: Object.freeze({
      label: "Intake",
      processingMinutes: 5,
      fixedWorkerIds: Object.freeze(["INTAKE_WORKER"]),
    }),
    [ACTIVITY_IDS.ROUTINE]: Object.freeze({
      label: "Routine treatment",
      processingMinutes: 15,
      fixedWorkerIds: Object.freeze([]),
    }),
    [ACTIVITY_IDS.ASSESSMENT]: Object.freeze({
      label: "Clinical assessment",
      processingMinutes: 10,
      fixedWorkerIds: Object.freeze([]),
    }),
    [ACTIVITY_IDS.DIAGNOSTICS]: Object.freeze({
      label: "Diagnostics",
      processingMinutes: 20,
      serviceDistribution: "EXPONENTIAL",
      fixedWorkerIds: Object.freeze([]),
    }),
    [ACTIVITY_IDS.REVIEW]: Object.freeze({
      label: "Clinical review",
      processingMinutes: 10,
      fixedWorkerIds: Object.freeze([]),
    }),
  }),
  flexibleActivityIds: Object.freeze([
    ACTIVITY_IDS.ROUTINE,
    ACTIVITY_IDS.ASSESSMENT,
    ACTIVITY_IDS.DIAGNOSTICS,
    ACTIVITY_IDS.REVIEW,
  ]),
  workers: Object.freeze({
    W1: Object.freeze({ qualifiedActivityIds: Object.freeze([ACTIVITY_IDS.ROUTINE, ACTIVITY_IDS.ASSESSMENT]) }),
    W2: Object.freeze({ qualifiedActivityIds: Object.freeze([ACTIVITY_IDS.ASSESSMENT, ACTIVITY_IDS.DIAGNOSTICS]) }),
    W3: Object.freeze({ qualifiedActivityIds: Object.freeze([ACTIVITY_IDS.ROUTINE, ACTIVITY_IDS.ASSESSMENT, ACTIVITY_IDS.REVIEW]) }),
    W4: Object.freeze({ qualifiedActivityIds: Object.freeze([ACTIVITY_IDS.DIAGNOSTICS, ACTIVITY_IDS.REVIEW]) }),
    W5: Object.freeze({ qualifiedActivityIds: Object.freeze([ACTIVITY_IDS.ROUTINE, ACTIVITY_IDS.REVIEW]) }),
    W6: Object.freeze({ qualifiedActivityIds: Object.freeze([ACTIVITY_IDS.ASSESSMENT, ACTIVITY_IDS.DIAGNOSTICS, ACTIVITY_IDS.REVIEW]) }),
  }),
  fixedWorkers: Object.freeze({
    INTAKE_WORKER: Object.freeze({ activityId: ACTIVITY_IDS.INTAKE }),
  }),
  initialState: Object.freeze({
    status: "PROVISIONAL_EMPTY_START",
    patients: Object.freeze([]),
  }),
});

export function normalizeGameCode(gameCode) {
  if (typeof gameCode !== "string") {
    throw new TypeError("Game code must be a string.");
  }

  const normalized = gameCode.trim().toUpperCase();
  if (!normalized) {
    throw new Error("Game code cannot be empty.");
  }
  return normalized;
}
