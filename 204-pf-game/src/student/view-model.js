import {
  PATIENT_TYPES,
  SIMULATION_CONFIG,
  summarizeSimulation,
} from "../simulation/engine.js";

function workerAssignment(state, workerId) {
  const worker = state.workers[workerId];
  return worker.pendingActivityId ?? worker.assignedActivityId;
}

export const STAKEHOLDER_TARGETS = Object.freeze({
  scheduledWithinMinutes: 35,
  scheduledPercent: 0.95,
  unscheduledWaitMinutes: 45,
  unscheduledPercent: 0.8,
  operationsPercent: 0.94,
  workforceMinimum: 0.7,
  workforceMaximum: 0.85,
});

function percentageMeeting(patients, predicate) {
  if (patients.length === 0) {
    return null;
  }
  return patients.filter(predicate).length / patients.length;
}

function minimumRouteMinutes(patientType, config) {
  return config.patientTypes[patientType].route.reduce(
    (total, activityId) => total + config.activities[activityId].processingMinutes,
    0,
  );
}

function createStakeholderMetrics(state, config) {
  const patients = Object.values(state.patients);
  const completed = patients.filter((patient) => patient.status === "COMPLETED");
  const completedScheduled = completed.filter(
    (patient) => patient.type === PATIENT_TYPES.SCHEDULED,
  );
  const completedUnscheduled = completed.filter(
    (patient) => patient.type === PATIENT_TYPES.UNSCHEDULED,
  );

  const scheduledPercentage = percentageMeeting(
    completedScheduled,
    (patient) => patient.completionTime - patient.arrivalTime
      <= STAKEHOLDER_TARGETS.scheduledWithinMinutes,
  );
  const unscheduledPercentage = percentageMeeting(
    completedUnscheduled,
    (patient) => patient.totalWaitingMinutes
      <= STAKEHOLDER_TARGETS.unscheduledWaitMinutes,
  );

  const waitBins = [
    { label: "0–15 min", count: 0 },
    { label: ">15–30 min", count: 0 },
    { label: ">30–45 min", count: 0 },
    { label: ">45–60 min", count: 0 },
    { label: ">60 min", count: 0 },
  ];
  for (const patient of completedUnscheduled) {
    const wait = patient.totalWaitingMinutes;
    const index = wait <= 15 ? 0 : wait <= 30 ? 1 : wait <= 45 ? 2 : wait <= 60 ? 3 : 4;
    waitBins[index].count += 1;
  }

  const eligiblePatients = patients.filter((patient) => (
    state.time - patient.arrivalTime >= minimumRouteMinutes(patient.type, config)
  ));
  const eligibleCompleted = eligiblePatients.filter(
    (patient) => patient.status === "COMPLETED",
  ).length;
  const operationsPercentage = eligiblePatients.length === 0
    ? null
    : eligibleCompleted / eligiblePatients.length;

  const summary = summarizeSimulation(state, config);
  const flexibleWorkerIds = Object.keys(config.workers);
  const workforceUtilization = state.time === 0
    ? null
    : flexibleWorkerIds.reduce(
      (total, workerId) => total + summary.utilizationByWorker[workerId],
      0,
    ) / flexibleWorkerIds.length;

  return {
    patientAccess: {
      completed: completedScheduled.length,
      percentage: scheduledPercentage,
      met: scheduledPercentage === null
        ? null
        : scheduledPercentage >= STAKEHOLDER_TARGETS.scheduledPercent,
    },
    urgentCare: {
      completed: completedUnscheduled.length,
      percentage: unscheduledPercentage,
      met: unscheduledPercentage === null
        ? null
        : unscheduledPercentage >= STAKEHOLDER_TARGETS.unscheduledPercent,
      waitBins,
    },
    operations: {
      eligible: eligiblePatients.length,
      completed: eligibleCompleted,
      percentage: operationsPercentage,
      met: operationsPercentage === null
        ? null
        : operationsPercentage >= STAKEHOLDER_TARGETS.operationsPercent,
      workInProcess: patients.filter((patient) => patient.status !== "COMPLETED").length,
      queued: patients.filter((patient) => patient.status === "QUEUED").length,
    },
    workforce: {
      utilization: workforceUtilization,
      met: workforceUtilization === null
        ? null
        : workforceUtilization >= STAKEHOLDER_TARGETS.workforceMinimum
          && workforceUtilization <= STAKEHOLDER_TARGETS.workforceMaximum,
    },
  };
}

export function createStudentPeriodView(state, config = SIMULATION_CONFIG) {
  const latestResult = state.periodResults.at(-1) ?? null;
  const queues = Object.fromEntries(Object.keys(config.activities).map((activityId) => [
    activityId,
    latestResult?.queues[activityId] ?? { length: 0, oldestWaitMinutes: 0 },
  ]));
  const utilization = Object.fromEntries(Object.keys(config.workers).map((workerId) => [
    workerId,
    latestResult?.workerUtilization[workerId] ?? null,
  ]));
  const assignments = Object.fromEntries(Object.keys(config.workers).map((workerId) => [
    workerId,
    workerAssignment(state, workerId),
  ]));

  return {
    completedPeriods: state.completedPeriods,
    nextPeriod: state.completedPeriods + 1,
    queues,
    cumulativeCompletions: {
      [PATIENT_TYPES.SCHEDULED]: state.completions[PATIENT_TYPES.SCHEDULED],
      [PATIENT_TYPES.UNSCHEDULED]: state.completions[PATIENT_TYPES.UNSCHEDULED],
    },
    workerUtilization: utilization,
    stakeholderMetrics: createStakeholderMetrics(state, config),
    workInProcess: Object.values(state.patients)
      .filter((patient) => patient.status !== "COMPLETED").length,
    assignments,
  };
}

export function createStudentFinalView(state, config = SIMULATION_CONFIG) {
  const summary = summarizeSimulation(state, config);
  const patientStatistics = Object.fromEntries(
    Object.entries(summary.byPatientType).map(([patientType, metrics]) => [patientType, {
      completions: metrics.completions,
      averageFlowTimeMinutes: metrics.averageFlowTimeMinutes,
      maximumFlowTimeMinutes: metrics.maximumFlowTimeMinutes,
      averageWaitingTimeMinutes: metrics.averageWaitingTimeMinutes,
      maximumWaitingTimeMinutes: metrics.maximumWaitingTimeMinutes,
    }]),
  );
  return {
    completedPeriods: summary.completedPeriods,
    simulatedMinutes: summary.simulatedMinutes,
    stakeholderMetrics: createStakeholderMetrics(state, config),
    patientTypes: patientStatistics,
    endingWorkInProcess: structuredClone(summary.endingWorkInProcess),
    utilizationByWorker: { ...summary.utilizationByWorker },
    utilizationByActivity: { ...summary.utilizationByActivity },
  };
}
