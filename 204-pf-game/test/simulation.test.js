import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVITY_IDS,
  PATIENT_TYPES,
  SIMULATION_CONFIG,
  createSimulation,
  replaySimulation,
  simulatePeriod,
  summarizeSimulation,
  validateAllocation,
} from "../src/simulation/engine.js";
import { nextMulberry32, serviceMinutes } from "../src/simulation/random.js";

const BALANCED_ALLOCATION = Object.freeze({
  W1: ACTIVITY_IDS.ROUTINE,
  W2: ACTIVITY_IDS.ASSESSMENT,
  W3: ACTIVITY_IDS.ROUTINE,
  W4: ACTIVITY_IDS.DIAGNOSTICS,
  W5: ACTIVITY_IDS.REVIEW,
  W6: ACTIVITY_IDS.ASSESSMENT,
});

const ONE_ROUTINE_ALLOCATION = Object.freeze({
  W1: ACTIVITY_IDS.ASSESSMENT,
  W2: ACTIVITY_IDS.DIAGNOSTICS,
  W3: ACTIVITY_IDS.ROUTINE,
  W4: ACTIVITY_IDS.REVIEW,
  W5: ACTIVITY_IDS.REVIEW,
  W6: ACTIVITY_IDS.DIAGNOSTICS,
});

const MOVE_BUSY_WORKER_ALLOCATION = Object.freeze({
  W1: ACTIVITY_IDS.ROUTINE,
  W2: ACTIVITY_IDS.ASSESSMENT,
  W3: ACTIVITY_IDS.REVIEW,
  W4: ACTIVITY_IDS.DIAGNOSTICS,
  W5: ACTIVITY_IDS.REVIEW,
  W6: ACTIVITY_IDS.DIAGNOSTICS,
});

function runPeriods(gameCode, allocation, count) {
  let state = createSimulation(gameCode);
  const results = [];
  for (let index = 0; index < count; index += 1) {
    const simulated = simulatePeriod(state, allocation);
    state = simulated.state;
    results.push(simulated.result);
  }
  return { state, results };
}

function arrivalSignature(results, patientType = PATIENT_TYPES.UNSCHEDULED) {
  return results
    .flatMap((result) => result.arrivals)
    .filter((arrival) => arrival.patientType === patientType)
    .map((arrival) => arrival.time);
}

test("normalizes game identity and produces a stable PRNG vector", () => {
  const lower = createSimulation(" 2026w1-101 ");
  const upper = createSimulation("2026W1-101");
  assert.equal(lower.gameCode, "2026W1-101");
  assert.equal(lower.stateChecksum, upper.stateChecksum);

  let state = 123456789;
  const values = [];
  for (let index = 0; index < 4; index += 1) {
    const generated = nextMulberry32(state);
    state = generated.state;
    values.push(generated.value);
  }
  assert.deepEqual(values, [
    0.2577907438389957,
    0.9707721115555614,
    0.7853280142880976,
    0.20616457983851433,
  ]);
});

test("rejects missing, unqualified, unknown, and uncovered assignments", () => {
  assert.equal(validateAllocation(BALANCED_ALLOCATION).valid, true);

  const missing = { ...BALANCED_ALLOCATION };
  delete missing.W1;
  assert.equal(validateAllocation(missing).valid, false);

  const unqualified = { ...BALANCED_ALLOCATION, W1: ACTIVITY_IDS.DIAGNOSTICS };
  assert.match(validateAllocation(unqualified).errors.join(" "), /not qualified/);

  const unknown = { ...BALANCED_ALLOCATION, W7: ACTIVITY_IDS.REVIEW };
  assert.match(validateAllocation(unknown).errors.join(" "), /Unknown worker/);

  const uncovered = {
    W1: ACTIVITY_IDS.ROUTINE,
    W2: ACTIVITY_IDS.ASSESSMENT,
    W3: ACTIVITY_IDS.ROUTINE,
    W4: ACTIVITY_IDS.DIAGNOSTICS,
    W5: ACTIVITY_IDS.ROUTINE,
    W6: ACTIVITY_IDS.DIAGNOSTICS,
  };
  assert.match(validateAllocation(uncovered).errors.join(" "), /REVIEW must receive/);
});

test("the qualification matrix supports all ten approved staffing patterns", () => {
  const activityIds = SIMULATION_CONFIG.flexibleActivityIds;
  const workerIds = Object.keys(SIMULATION_CONFIG.workers);
  const supportedPatterns = new Set();

  function visit(workerIndex, allocation) {
    if (workerIndex === workerIds.length) {
      if (!validateAllocation(allocation).valid) {
        return;
      }
      const counts = activityIds.map((activityId) => (
        Object.values(allocation).filter((assigned) => assigned === activityId).length
      ));
      supportedPatterns.add(counts.join("-"));
      return;
    }

    const workerId = workerIds[workerIndex];
    for (const activityId of SIMULATION_CONFIG.workers[workerId].qualifiedActivityIds) {
      visit(workerIndex + 1, { ...allocation, [workerId]: activityId });
    }
  }

  visit(0, {});
  assert.deepEqual([...supportedPatterns].sort(), [
    "1-1-1-3",
    "1-1-2-2",
    "1-1-3-1",
    "1-2-1-2",
    "1-2-2-1",
    "1-3-1-1",
    "2-1-1-2",
    "2-1-2-1",
    "2-2-1-1",
    "3-1-1-1",
  ]);
});

test("identical game codes and allocations reproduce arrivals and outcomes", () => {
  const first = runPeriods("same-class", BALANCED_ALLOCATION, 8);
  const second = runPeriods(" SAME-CLASS ", BALANCED_ALLOCATION, 8);
  assert.deepEqual(first.results, second.results);
  assert.equal(first.state.stateChecksum, second.state.stateChecksum);
});

test("different game codes normally produce different Poisson realizations", () => {
  const first = runPeriods("section-a", BALANCED_ALLOCATION, 8);
  const second = runPeriods("section-b", BALANCED_ALLOCATION, 8);
  assert.notDeepEqual(arrivalSignature(first.results), arrivalSignature(second.results));
});

test("scheduled patients arrive every ten minutes throughout hourly periods", () => {
  const { results } = runPeriods("scheduled-arrivals", BALANCED_ALLOCATION, 3);
  assert.deepEqual(arrivalSignature(results, PATIENT_TYPES.SCHEDULED), [
    0, 10, 20,
    30, 40, 50,
    60, 70, 80,
    90, 100, 110, 120, 130, 140, 150, 160, 170,
  ]);
});

test("a patient can move through consecutive activities during one period", () => {
  const initial = createSimulation("continuous-flow");
  initial.nextUnscheduledArrivalTime = 0;
  const { state, result } = simulatePeriod(initial, BALANCED_ALLOCATION);
  const unscheduledArrival = result.arrivals.find(
    (arrival) => arrival.patientType === PATIENT_TYPES.UNSCHEDULED,
  );
  const patient = state.patients[unscheduledArrival.patientId];
  assert.deepEqual(
    patient.serviceHistory.slice(0, 3).map((service) => service.activityId),
    [ACTIVITY_IDS.INTAKE, ACTIVITY_IDS.ASSESSMENT, ACTIVITY_IDS.DIAGNOSTICS],
  );
  assert.equal(patient.serviceHistory[0].start, 5);
  assert.equal(patient.serviceHistory[0].end, 10);
  assert.equal(patient.serviceHistory[1].end, 20);
  assert.equal(patient.serviceHistory[2].end,
    20 + serviceMinutes(state.gameCode, patient.id, ACTIVITY_IDS.DIAGNOSTICS, SIMULATION_CONFIG));
});

test("FIFO preserves arrival order at a constrained activity", () => {
  const { state } = runPeriods("fifo", ONE_ROUTINE_ALLOCATION, 2);
  const routineStarts = state.eventLog.filter((event) => (
    event.type === "SERVICE_START"
    && event.activityId === ACTIVITY_IDS.ROUTINE
  ));
  const arrivalOrder = Object.values(state.patients)
    .filter((patient) => patient.type === PATIENT_TYPES.SCHEDULED)
    .sort((left, right) => left.arrivalTime - right.arrivalTime || left.id.localeCompare(right.id))
    .map((patient) => patient.id);
  assert.deepEqual(
    routineStarts.map((event) => event.patientId),
    arrivalOrder.slice(0, routineStarts.length),
  );
});

test("service crossing a boundary finishes before a worker changes activity", () => {
  const first = simulatePeriod(
    createSimulation("boundary-crossing"),
    ONE_ROUTINE_ALLOCATION,
  ).state;
  assert.equal(first.workers.W3.busyActivityId, ACTIVITY_IDS.ROUTINE);
  assert.equal(first.workers.W3.busyUntil, 65);

  const second = simulatePeriod(first, MOVE_BUSY_WORKER_ALLOCATION).state;
  const reviewAssignment = second.workers.W3.assignmentHistory.find(
    (entry) => entry.activityId === ACTIVITY_IDS.REVIEW,
  );
  assert.equal(reviewAssignment.start, 65);
  assert.equal(second.workers.W3.serviceHistory[3].activityId, ACTIVITY_IDS.ROUTINE);
  assert.equal(second.workers.W3.serviceHistory[3].end, 65);
});

test("period metrics include in-service work in utilization and preserve ending WIP", () => {
  const { state, result } = simulatePeriod(
    createSimulation("wip-utilization"),
    ONE_ROUTINE_ALLOCATION,
  );
  assert.equal(result.workerUtilization.W3.busyMinutes, 55);
  assert.equal(result.workerUtilization.W3.utilization, 0.916667);
  assert.ok(result.workInProcess > 0);
  assert.equal(
    Object.values(state.patients).filter((patient) => patient.status !== "COMPLETED").length,
    result.workInProcess,
  );
});

test("no patient is dropped and cumulative completions reconcile", () => {
  const { state, results } = runPeriods("reconciliation", BALANCED_ALLOCATION, 10);
  const arrivalCount = results.flatMap((result) => result.arrivals).length;
  const completedCount = Object.values(state.completions).reduce((sum, value) => sum + value, 0);
  const wipCount = Object.values(state.patients)
    .filter((patient) => patient.status !== "COMPLETED").length;
  assert.equal(Object.keys(state.patients).length, arrivalCount);
  assert.equal(completedCount + wipCount, arrivalCount);
});

test("simulation is immutable and unchanged allocations can be reused", () => {
  const initial = createSimulation("immutable");
  const initialSnapshot = structuredClone(initial);
  const first = simulatePeriod(initial, BALANCED_ALLOCATION);
  assert.deepEqual(initial, initialSnapshot);
  const second = simulatePeriod(first.state, BALANCED_ALLOCATION);
  assert.deepEqual(second.state.appliedAllocations, [
    BALANCED_ALLOCATION,
    BALANCED_ALLOCATION,
  ]);
});

test("replay from allocations reproduces the ending checksum", () => {
  const allocations = [
    BALANCED_ALLOCATION,
    ONE_ROUTINE_ALLOCATION,
    MOVE_BUSY_WORKER_ALLOCATION,
    BALANCED_ALLOCATION,
  ];
  let state = createSimulation("replay");
  for (const allocation of allocations) {
    state = simulatePeriod(state, allocation).state;
  }
  const replayed = replaySimulation("replay", allocations);
  assert.equal(replayed.stateChecksum, state.stateChecksum);
  assert.deepEqual(replayed.periodResults, state.periodResults);
});

test("final summary reports actual completed periods and current WIP", () => {
  const { state } = runPeriods("summary", BALANCED_ALLOCATION, 3);
  const summary = summarizeSimulation(state);
  assert.equal(summary.completedPeriods, 3);
  assert.equal(summary.simulatedMinutes, 180);
  assert.equal(summary.stateChecksum, state.stateChecksum);
  assert.equal(
    Object.values(summary.byPatientType).reduce((sum, item) => sum + item.completions, 0),
    Object.values(state.completions).reduce((sum, value) => sum + value, 0),
  );
  const summarizedWip = Object.values(summary.endingWorkInProcess)
    .reduce((sum, location) => sum + location.queued + location.inService, 0);
  assert.equal(
    summarizedWip,
    Object.values(state.patients).filter((patient) => patient.status !== "COMPLETED").length,
  );
});

test("final waiting statistics include completed and unfinished patients", () => {
  const { state } = runPeriods("all-patient-waits", ONE_ROUTINE_ALLOCATION, 2);
  const summary = summarizeSimulation(state);
  const scheduledPatients = Object.values(state.patients).filter(
    (patient) => patient.type === PATIENT_TYPES.SCHEDULED,
  );
  const expectedWaits = scheduledPatients.map((patient) => (
    patient.totalWaitingMinutes
    + (patient.status === "QUEUED" ? state.time - patient.queueEnteredAt : 0)
  ));
  const completedScheduled = scheduledPatients.filter(
    (patient) => patient.status === "COMPLETED",
  );

  assert.ok(scheduledPatients.some((patient) => patient.status !== "COMPLETED"));
  assert.equal(summary.byPatientType.SCHEDULED.arrivals, scheduledPatients.length);
  assert.equal(summary.byPatientType.SCHEDULED.completions, completedScheduled.length);
  assert.equal(
    summary.byPatientType.SCHEDULED.averageWaitingTimeMinutes,
    Math.round(
      (expectedWaits.reduce((sum, value) => sum + value, 0) / expectedWaits.length)
      * 1_000_000,
    ) / 1_000_000,
  );
  assert.equal(
    summary.byPatientType.SCHEDULED.maximumWaitingTimeMinutes,
    Math.max(...expectedWaits),
  );
});

test("the default configuration remains the approved provisional model", () => {
  assert.equal(SIMULATION_CONFIG.periodMinutes, 60);
  assert.equal(SIMULATION_CONFIG.unscheduledArrivalsPerHour, 5);
  assert.deepEqual(SIMULATION_CONFIG.scheduledArrivalOffsets, [0, 10, 20, 30, 40, 50]);
  assert.equal(SIMULATION_CONFIG.initialState.status, "PROVISIONAL_EMPTY_START");
  assert.deepEqual(SIMULATION_CONFIG.initialState.patients, []);
});

test("diagnostic draws have exponential mean and tail; other activities stay fixed", () => {
  const draws = Array.from({ length: 20000 }, (_, i) =>
    serviceMinutes("distribution-check", `P${i}`, ACTIVITY_IDS.DIAGNOSTICS, SIMULATION_CONFIG));
  const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
  assert.ok(Math.abs(mean - 20) < 0.6);
  const tail = draws.filter(value => value > 40).length / draws.length;
  assert.ok(Math.abs(tail - Math.exp(-2)) < 0.015);
  assert.ok(draws.every(value => value > 0));
  for (const id of ["INTAKE", "ROUTINE", "ASSESSMENT", "REVIEW"]) {
    assert.equal(serviceMinutes("distribution-check", "P1", id, SIMULATION_CONFIG),
      SIMULATION_CONFIG.activities[id].processingMinutes);
  }
});

test("allocations do not change arrivals or patient-specific diagnostic requirements", () => {
  const first = runPeriods("fair-service", BALANCED_ALLOCATION, 6);
  const second = runPeriods("fair-service", ONE_ROUTINE_ALLOCATION, 6);
  assert.deepEqual(arrivalSignature(first.results), arrivalSignature(second.results));
  let compared = 0;
  for (const patient of Object.values(first.state.patients)) {
    const a = patient.serviceHistory.find(s => s.activityId === "DIAGNOSTICS");
    const b = second.state.patients[patient.id].serviceHistory.find(s => s.activityId === "DIAGNOSTICS");
    if (a && b) {
      assert.ok(Math.abs((a.end - a.start) - (b.end - b.start)) < 0.000002);
      compared++;
    }
  }
  assert.ok(compared >= 5);
  const recovered = JSON.parse(JSON.stringify(first.state));
  assert.deepEqual(simulatePeriod(recovered, BALANCED_ALLOCATION),
    simulatePeriod(first.state, BALANCED_ALLOCATION));
});
