# Simulation engine

This directory contains the dependency-free deterministic engine for the COMM 204 process-flow game. It has no UI, persistence, Google Forms, timer, or encryption responsibilities.

## Modules

- `config.js` is the human-readable process configuration: routes, activity times, workers, qualifications, arrival parameters, and the provisional initial state.
- `random.js` contains the versioned FNV-1a seed derivation, Mulberry32 generator, and exponential interarrival calculation.
- `checksum.js` produces canonical deterministic state checksums for replay verification.
- `engine.js` validates allocations, advances continuous simulated time, reports period results, replays allocation histories, and calculates final summaries.

## Public engine functions

- `createSimulation(gameCode, config)` creates an empty, deterministic state for a normalized game code.
- `validateAllocation(allocation, config)` checks complete worker coverage, qualifications, and minimum staffing.
- `simulatePeriod(state, allocation, config)` returns a new state and one 30-minute period result without mutating the supplied state.
- `replaySimulation(gameCode, allocations, config)` reconstructs a game solely from its game code and applied allocations.
- `summarizeSimulation(state, config)` calculates the final statistics at the team's End Game moment.

## Timing conventions

- Service completions at a timestamp are handled before arrivals at that timestamp.
- Same-time patients retain deterministic FIFO order.
- A worker cannot start a new service under an expiring allocation at the exact period endpoint.
- Non-preemptive service crossing a boundary finishes before the worker moves to the new assignment.
- Unscheduled arrival times are rounded to one millionth of a simulated minute so the versioned sequence is stable across browsers.

## Metric conventions

- Flow time is reported for patients who completed the full route.
- Waiting time is cumulative across all queues.
- Final waiting statistics include every arrived patient. A patient still queued at End Game accumulates waiting through that ending moment.
- Worker utilization is busy time divided by simulated elapsed time.
- Activity utilization is processing time divided by the time workers were actually assigned to that activity, including delayed boundary reassignments.
- Ending work-in-process distinguishes queued and in-service patients at each activity.

Run the tests from `204-pf-game` with:

```powershell
node --test
```
