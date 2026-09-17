import { createSimulation, simulatePeriod } from '../src/simulation/engine.js';
import { createStudentPeriodView } from '../src/student/view-model.js';

// Headless playtests: the real engine and dashboard, without browser storage or uploads.
const naive = { W1: 'ASSESSMENT', W2: 'DIAGNOSTICS', W3: 'ROUTINE', W4: 'REVIEW', W5: 'REVIEW', W6: 'ASSESSMENT' };
const partial = { W1: 'ROUTINE', W2: 'ASSESSMENT', W3: 'ROUTINE', W4: 'DIAGNOSTICS', W5: 'REVIEW', W6: 'REVIEW' };
const good = { ...partial, W6: 'DIAGNOSTICS' };
const policies = {
  naive: () => naive,
  partial: () => partial,
  good: () => good,
  improveAfterThree: round => round < 3 ? naive : good,
};
const count = 100;
const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const rounded = value => Math.round(value * 100) / 100;
for (const [name, policy] of Object.entries(policies)) {
  const runs = [];
  for (let seed = 0; seed < count; seed++) {
    let state = createSimulation(`SIX-HOUR-CHECK-${seed}`);
    const queues = [];
    for (let round = 0; round < 6; round++) {
      state = simulatePeriod(state, policy(round)).state;
      queues.push(Object.values(state.queues).reduce((sum, queue) => sum + queue.length, 0));
    }
    const metrics = createStudentPeriodView(state).stakeholderMetrics;
    runs.push({ queues, metrics });
  }
  const endings = runs.map(run => run.queues[5]).sort((a, b) => a - b);
  console.log(JSON.stringify({
    policy: name,
    runs: count,
    meanQueueByRound: Array.from({ length: 6 }, (_, round) => rounded(average(runs.map(run => run.queues[round])))),
    endingQueueMedian: endings[49],
    endingQueue90thPercentile: endings[89],
    endingQueueMaximum: endings[99],
    endingsAtLeast10: runs.filter(run => run.queues[5] >= 10).length,
    endingsBelowRoundThree: runs.filter(run => run.queues[5] < run.queues[2]).length,
    targetPassCounts: Object.fromEntries(['patientAccess', 'urgentCare', 'operations', 'workforce'].map(role =>
      [role, runs.filter(run => run.metrics[role].met === true).length])),
  }));
}
