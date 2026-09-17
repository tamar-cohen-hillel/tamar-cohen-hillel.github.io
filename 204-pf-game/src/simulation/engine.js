import {
  ACTIVITY_IDS,
  PATIENT_TYPES,
  SIMULATION_CONFIG,
  normalizeGameCode,
} from "./config.js";
import {
  createArrivalRandomState,
  nextExponentialArrival,
  serviceMinutes,
} from "./random.js";
import { checksum } from "./checksum.js";

const EPSILON = 1e-9;

function clone(value) {
  return structuredClone(value);
}

function round(value, precision = 1_000_000) {
  return Math.round(value * precision) / precision;
}

function stateChecksum(state) {
  const payload = clone(state);
  delete payload.stateChecksum;
  return checksum(payload);
}

function orderedWorkerIds(config) {
  return Object.keys(config.workers).sort();
}

function allWorkerIds(config) {
  return [
    ...Object.keys(config.fixedWorkers).sort(),
    ...orderedWorkerIds(config),
  ];
}

function makeWorker(id, activityId, isFixed) {
  return {
    id,
    isFixed,
    assignedActivityId: activityId,
    pendingActivityId: null,
    patientId: null,
    busyActivityId: null,
    busySince: null,
    busyUntil: null,
    assignmentHistory: activityId === null
      ? []
      : [{ activityId, start: 0, end: null }],
    serviceHistory: [],
  };
}

function makeEmptyQueues(config) {
  return Object.fromEntries(
    Object.keys(config.activities).map((activityId) => [activityId, []]),
  );
}

function routeFor(patientType, config) {
  const definition = config.patientTypes[patientType];
  if (!definition) {
    throw new Error(`Unknown patient type: ${patientType}`);
  }
  return definition.route;
}

function nextPatientId(state) {
  const id = `P${String(state.nextPatientSequence).padStart(6, "0")}`;
  state.nextPatientSequence += 1;
  return id;
}

function scheduleNextUnscheduledArrival(state, config) {
  const ratePerMinute = config.unscheduledArrivalsPerHour / 60;
  const generated = nextExponentialArrival(
    state.randomState,
    ratePerMinute,
    config.arrivalTimePrecision,
  );
  state.randomState = generated.randomState;
  const baseTime = state.nextUnscheduledArrivalTime ?? 0;
  state.nextUnscheduledArrivalTime = round(
    baseTime + generated.interval,
    config.arrivalTimePrecision,
  );
}

function enqueuePatient(state, patient, activityId, time) {
  patient.status = "QUEUED";
  patient.activityId = activityId;
  patient.queueEnteredAt = time;
  patient.queueSequence = state.nextQueueSequence;
  state.nextQueueSequence += 1;
  state.queues[activityId].push(patient.id);
}

function addPatient(state, patientType, time, source, config, periodEvents) {
  const route = routeFor(patientType, config);
  const patient = {
    id: nextPatientId(state),
    type: patientType,
    source,
    arrivalTime: time,
    routeIndex: 0,
    status: "ARRIVED",
    activityId: route[0],
    queueEnteredAt: time,
    queueSequence: null,
    totalWaitingMinutes: 0,
    serviceHistory: [],
    completionTime: null,
  };
  state.patients[patient.id] = patient;
  enqueuePatient(state, patient, route[0], time);
  const event = {
    type: "ARRIVAL",
    time,
    patientId: patient.id,
    patientType,
    source,
  };
  state.eventLog.push(event);
  periodEvents.push(event);
}

function closeAssignment(worker, time) {
  const current = worker.assignmentHistory.at(-1);
  if (current && current.end === null) {
    current.end = time;
  }
}

function setWorkerAssignment(worker, activityId, time) {
  if (worker.assignedActivityId === activityId) {
    worker.pendingActivityId = null;
    return;
  }
  closeAssignment(worker, time);
  worker.assignedActivityId = activityId;
  worker.pendingActivityId = null;
  worker.assignmentHistory.push({ activityId, start: time, end: null });
}

function applyAllocation(state, allocation, config) {
  const boundaryTime = state.time;
  for (const workerId of orderedWorkerIds(config)) {
    const worker = state.workers[workerId];
    const targetActivityId = allocation[workerId];
    if (worker.patientId === null) {
      setWorkerAssignment(worker, targetActivityId, boundaryTime);
    } else if (worker.assignedActivityId === targetActivityId) {
      worker.pendingActivityId = null;
    } else {
      worker.pendingActivityId = targetActivityId;
    }
  }
}

function availableWorkers(state, activityId) {
  return Object.values(state.workers)
    .filter((worker) => (
      worker.patientId === null
      && worker.assignedActivityId === activityId
    ))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function startService(state, worker, patient, activityId, time, config, periodEvents) {
  const waitingMinutes = round(time - patient.queueEnteredAt);
  patient.totalWaitingMinutes = round(patient.totalWaitingMinutes + waitingMinutes);
  patient.status = "IN_SERVICE";
  patient.activityId = activityId;
  patient.queueEnteredAt = null;
  patient.queueSequence = null;

  const end = round(time + serviceMinutes(state.gameCode, patient.id, activityId, config));
  const service = {
    activityId,
    workerId: worker.id,
    start: time,
    end,
  };
  patient.serviceHistory.push(service);
  worker.serviceHistory.push({
    patientId: patient.id,
    activityId,
    start: time,
    end,
  });
  worker.patientId = patient.id;
  worker.busyActivityId = activityId;
  worker.busySince = time;
  worker.busyUntil = end;

  const event = {
    type: "SERVICE_START",
    time,
    patientId: patient.id,
    patientType: patient.type,
    workerId: worker.id,
    activityId,
    waitingMinutes,
    scheduledEnd: end,
  };
  state.eventLog.push(event);
  periodEvents.push(event);
}

function dispatchAll(state, time, config, periodEvents) {
  let dispatched;
  do {
    dispatched = false;
    for (const activityId of Object.keys(config.activities)) {
      const queue = state.queues[activityId];
      while (queue.length > 0) {
        const worker = availableWorkers(state, activityId)[0];
        if (!worker) {
          break;
        }
        const patientId = queue.shift();
        startService(
          state,
          worker,
          state.patients[patientId],
          activityId,
          time,
          config,
          periodEvents,
        );
        dispatched = true;
      }
    }
  } while (dispatched);
}

function completeService(state, worker, time, config, periodEvents) {
  const patient = state.patients[worker.patientId];
  const activityId = worker.busyActivityId;
  worker.patientId = null;
  worker.busyActivityId = null;
  worker.busySince = null;
  worker.busyUntil = null;

  const completionEvent = {
    type: "SERVICE_COMPLETE",
    time,
    patientId: patient.id,
    patientType: patient.type,
    workerId: worker.id,
    activityId,
  };
  state.eventLog.push(completionEvent);
  periodEvents.push(completionEvent);

  if (worker.pendingActivityId !== null) {
    setWorkerAssignment(worker, worker.pendingActivityId, time);
  }

  patient.routeIndex += 1;
  const route = routeFor(patient.type, config);
  if (patient.routeIndex >= route.length) {
    patient.status = "COMPLETED";
    patient.activityId = null;
    patient.completionTime = time;
    state.completions[patient.type] += 1;
    const exitEvent = {
      type: "PATIENT_COMPLETE",
      time,
      patientId: patient.id,
      patientType: patient.type,
      flowTimeMinutes: round(time - patient.arrivalTime),
      totalWaitingMinutes: patient.totalWaitingMinutes,
    };
    state.eventLog.push(exitEvent);
    periodEvents.push(exitEvent);
  } else {
    enqueuePatient(state, patient, route[patient.routeIndex], time);
  }
}

function completionWorkersAt(state, time) {
  return Object.values(state.workers)
    .filter((worker) => (
      worker.patientId !== null
      && Math.abs(worker.busyUntil - time) <= EPSILON
    ))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function nextCompletionTime(state) {
  let next = Infinity;
  for (const worker of Object.values(state.workers)) {
    if (worker.patientId !== null && worker.busyUntil < next) {
      next = worker.busyUntil;
    }
  }
  return next;
}

function scheduledArrivalsForPeriod(periodStart, config) {
  return config.scheduledArrivalOffsets.map((offset) => round(periodStart + offset));
}

function overlap(startA, endA, startB, endB) {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function intervalMinutes(entries, periodStart, periodEnd, activityId = null) {
  return round(entries.reduce((total, entry) => {
    if (activityId !== null && entry.activityId !== activityId) {
      return total;
    }
    const entryEnd = entry.end ?? periodEnd;
    return total + overlap(entry.start, entryEnd, periodStart, periodEnd);
  }, 0));
}

function queueMetrics(state, periodEnd) {
  return Object.fromEntries(Object.entries(state.queues).map(([activityId, ids]) => {
    const oldestWait = ids.length === 0
      ? 0
      : Math.max(...ids.map((id) => periodEnd - state.patients[id].queueEnteredAt));
    return [activityId, {
      length: ids.length,
      oldestWaitMinutes: round(oldestWait),
    }];
  }));
}

function periodMetrics(state, periodStart, periodEnd, allocation, config, periodEvents) {
  const workerUtilization = {};
  for (const workerId of allWorkerIds(config)) {
    const busyMinutes = intervalMinutes(
      state.workers[workerId].serviceHistory,
      periodStart,
      periodEnd,
    );
    workerUtilization[workerId] = {
      busyMinutes,
      utilization: round(busyMinutes / (periodEnd - periodStart)),
    };
  }

  const activityUtilization = {};
  for (const activityId of Object.keys(config.activities)) {
    let busyMinutes = 0;
    let staffedMinutes = 0;
    for (const worker of Object.values(state.workers)) {
      busyMinutes += intervalMinutes(
        worker.serviceHistory,
        periodStart,
        periodEnd,
        activityId,
      );
      staffedMinutes += intervalMinutes(
        worker.assignmentHistory,
        periodStart,
        periodEnd,
        activityId,
      );
    }
    activityUtilization[activityId] = {
      busyMinutes: round(busyMinutes),
      staffedMinutes: round(staffedMinutes),
      utilization: staffedMinutes === 0 ? 0 : round(busyMinutes / staffedMinutes),
    };
  }

  const completedThisPeriod = {
    [PATIENT_TYPES.SCHEDULED]: 0,
    [PATIENT_TYPES.UNSCHEDULED]: 0,
  };
  for (const event of periodEvents) {
    if (event.type === "PATIENT_COMPLETE") {
      completedThisPeriod[event.patientType] += 1;
    }
  }

  return {
    period: state.completedPeriods + 1,
    startTime: periodStart,
    endTime: periodEnd,
    allocation: clone(allocation),
    arrivals: periodEvents.filter((event) => event.type === "ARRIVAL"),
    events: clone(periodEvents),
    queues: queueMetrics(state, periodEnd),
    completedThisPeriod,
    cumulativeCompletions: clone(state.completions),
    workerUtilization,
    activityUtilization,
    workInProcess: Object.values(state.patients)
      .filter((patient) => patient.status !== "COMPLETED").length,
  };
}

export function validateAllocation(allocation, config = SIMULATION_CONFIG) {
  const errors = [];
  const workerIds = orderedWorkerIds(config);
  if (!allocation || typeof allocation !== "object" || Array.isArray(allocation)) {
    return { valid: false, errors: ["Allocation must be an object keyed by worker ID."] };
  }

  for (const workerId of workerIds) {
    const activityId = allocation[workerId];
    if (!activityId) {
      errors.push(`${workerId} must be assigned.`);
      continue;
    }
    if (!config.flexibleActivityIds.includes(activityId)) {
      errors.push(`${workerId} has an unknown flexible activity assignment: ${activityId}.`);
      continue;
    }
    if (!config.workers[workerId].qualifiedActivityIds.includes(activityId)) {
      errors.push(`${workerId} is not qualified for ${activityId}.`);
    }
  }

  for (const suppliedWorkerId of Object.keys(allocation)) {
    if (!config.workers[suppliedWorkerId]) {
      errors.push(`Unknown worker in allocation: ${suppliedWorkerId}.`);
    }
  }

  for (const activityId of config.flexibleActivityIds) {
    if (!workerIds.some((workerId) => allocation[workerId] === activityId)) {
      errors.push(`${activityId} must receive at least one qualified worker.`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function createSimulation(gameCode, config = SIMULATION_CONFIG) {
  const normalizedGameCode = normalizeGameCode(gameCode);
  const randomState = createArrivalRandomState(normalizedGameCode, config);
  const workers = {};
  for (const [workerId, definition] of Object.entries(config.fixedWorkers)) {
    workers[workerId] = makeWorker(workerId, definition.activityId, true);
  }
  for (const workerId of orderedWorkerIds(config)) {
    workers[workerId] = makeWorker(workerId, null, false);
  }

  const state = {
    schemaVersion: config.schemaVersion,
    configurationVersion: config.configurationVersion,
    seedVersion: config.seedVersion,
    gameCode: normalizedGameCode,
    time: 0,
    completedPeriods: 0,
    randomState,
    nextUnscheduledArrivalTime: null,
    nextPatientSequence: 1,
    nextQueueSequence: 1,
    patients: {},
    queues: makeEmptyQueues(config),
    workers,
    completions: {
      [PATIENT_TYPES.SCHEDULED]: 0,
      [PATIENT_TYPES.UNSCHEDULED]: 0,
    },
    appliedAllocations: [],
    periodResults: [],
    eventLog: [],
  };
  scheduleNextUnscheduledArrival(state, config);
  state.stateChecksum = stateChecksum(state);
  return state;
}

export function simulatePeriod(previousState, allocation, config = SIMULATION_CONFIG) {
  const validation = validateAllocation(allocation, config);
  if (!validation.valid) {
    throw new Error(`Invalid allocation: ${validation.errors.join(" ")}`);
  }
  if (previousState.configurationVersion !== config.configurationVersion) {
    throw new Error("Simulation state configuration version does not match the engine configuration.");
  }

  const state = clone(previousState);
  delete state.stateChecksum;
  const periodStart = state.time;
  const periodEnd = round(periodStart + config.periodMinutes);
  const periodEvents = [];
  const scheduledArrivals = scheduledArrivalsForPeriod(periodStart, config);
  let scheduledIndex = 0;

  applyAllocation(state, allocation, config);
  dispatchAll(state, periodStart, config, periodEvents);

  while (true) {
    const completionTime = nextCompletionTime(state);
    const scheduledTime = scheduledIndex < scheduledArrivals.length
      ? scheduledArrivals[scheduledIndex]
      : Infinity;
    const unscheduledTime = state.nextUnscheduledArrivalTime ?? Infinity;
    const nextTime = Math.min(completionTime, scheduledTime, unscheduledTime);
    if (nextTime > periodEnd + EPSILON || nextTime === Infinity) {
      break;
    }

    for (const worker of completionWorkersAt(state, nextTime)) {
      completeService(state, worker, nextTime, config, periodEvents);
    }

    while (
      scheduledIndex < scheduledArrivals.length
      && Math.abs(scheduledArrivals[scheduledIndex] - nextTime) <= EPSILON
    ) {
      addPatient(
        state,
        PATIENT_TYPES.SCHEDULED,
        nextTime,
        "SCHEDULED",
        config,
        periodEvents,
      );
      scheduledIndex += 1;
    }

    if (Math.abs((state.nextUnscheduledArrivalTime ?? Infinity) - nextTime) <= EPSILON) {
      addPatient(
        state,
        PATIENT_TYPES.UNSCHEDULED,
        nextTime,
        "POISSON",
        config,
        periodEvents,
      );
      scheduleNextUnscheduledArrival(state, config);
    }

    if (nextTime < periodEnd - EPSILON) {
      dispatchAll(state, nextTime, config, periodEvents);
    }
  }

  const result = periodMetrics(
    state,
    periodStart,
    periodEnd,
    allocation,
    config,
    periodEvents,
  );
  state.time = periodEnd;
  state.completedPeriods += 1;
  state.appliedAllocations.push(clone(allocation));
  state.periodResults.push(result);
  state.stateChecksum = stateChecksum(state);

  return { state, result };
}

export function replaySimulation(gameCode, allocations, config = SIMULATION_CONFIG) {
  let state = createSimulation(gameCode, config);
  for (const allocation of allocations) {
    state = simulatePeriod(state, allocation, config).state;
  }
  return state;
}

export function summarizeSimulation(state, config = SIMULATION_CONFIG) {
  const completed = Object.values(state.patients).filter(
    (patient) => patient.status === "COMPLETED",
  );
  const byType = {};
  for (const patientType of Object.keys(config.patientTypes)) {
    const completedPatients = completed.filter((patient) => patient.type === patientType);
    const arrivedPatients = Object.values(state.patients).filter(
      (patient) => patient.type === patientType,
    );
    const flowTimes = completedPatients.map(
      (patient) => patient.completionTime - patient.arrivalTime,
    );
    const waitingTimes = arrivedPatients.map((patient) => round(
      patient.totalWaitingMinutes
      + (patient.status === "QUEUED" ? state.time - patient.queueEnteredAt : 0),
    ));
    byType[patientType] = {
      arrivals: arrivedPatients.length,
      completions: completedPatients.length,
      averageFlowTimeMinutes: flowTimes.length === 0
        ? null
        : round(flowTimes.reduce((sum, value) => sum + value, 0) / flowTimes.length),
      maximumFlowTimeMinutes: flowTimes.length === 0 ? null : Math.max(...flowTimes),
      averageWaitingTimeMinutes: waitingTimes.length === 0
        ? null
        : round(waitingTimes.reduce((sum, value) => sum + value, 0) / waitingTimes.length),
      maximumWaitingTimeMinutes: waitingTimes.length === 0 ? null : Math.max(...waitingTimes),
    };
  }

  const endingWorkInProcess = Object.fromEntries(
    Object.keys(config.activities).map((activityId) => [activityId, { queued: 0, inService: 0 }]),
  );
  for (const patient of Object.values(state.patients)) {
    if (patient.status === "QUEUED") {
      endingWorkInProcess[patient.activityId].queued += 1;
    } else if (patient.status === "IN_SERVICE") {
      endingWorkInProcess[patient.activityId].inService += 1;
    }
  }

  const utilizationByWorker = {};
  for (const workerId of allWorkerIds(config)) {
    const busyMinutes = intervalMinutes(state.workers[workerId].serviceHistory, 0, state.time);
    utilizationByWorker[workerId] = state.time === 0 ? 0 : round(busyMinutes / state.time);
  }

  const utilizationByActivity = {};
  for (const activityId of Object.keys(config.activities)) {
    let busyMinutes = 0;
    let staffedMinutes = 0;
    for (const worker of Object.values(state.workers)) {
      busyMinutes += intervalMinutes(worker.serviceHistory, 0, state.time, activityId);
      staffedMinutes += intervalMinutes(worker.assignmentHistory, 0, state.time, activityId);
    }
    utilizationByActivity[activityId] = staffedMinutes === 0
      ? 0
      : round(busyMinutes / staffedMinutes);
  }

  return {
    completedPeriods: state.completedPeriods,
    simulatedMinutes: state.time,
    byPatientType: byType,
    endingWorkInProcess,
    utilizationByWorker,
    utilizationByActivity,
    stateChecksum: state.stateChecksum,
  };
}

export { ACTIVITY_IDS, PATIENT_TYPES, SIMULATION_CONFIG };
