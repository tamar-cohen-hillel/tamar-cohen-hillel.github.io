# COMM 204 Hospital Process-Flow Game

## Full Behavioral and Implementation Specification for Codex

**Status:** Revised Version 3 specification for final review before implementation  
**Course:** COMM 204 - Logistics and Operations Management  
**Instructor:** Dr. Tamar Cohen-Hillel  
**Term:** 2026W1  
**Primary objective:** Deliver a free, dependable classroom game in time for the 2026W1 term.

---

## 1. Authority, scope, and stop condition

This file is the governing specification for the browser-based COMM 204 hospital process-flow game. It replaces Version 1 and supersedes all earlier concepts involving a synchronized backend, server-created games or teams, remotely controlled team browsers, team clocks, live scoreboards, practice mode, multiple revisions of one period, or offline-first submission.

This revision includes the recovered hospital process model and the final decentralized classroom behavior. Do not invent additional business parameters. Stakeholder thresholds and the official initial-state snapshot remain configurable and intentionally deferred until playtesting.

If older notes, mockups, or code conflict with this file, this file governs.

## 2. Pedagogical purpose

Teams of four repeatedly allocate workers across hospital activities while serving scheduled and unscheduled patients. The game is intended to make students experience and analyze capacity and bottlenecks, utilization, queues and waiting, throughput and work-in-process, flow time, heterogeneous flow units, variability, transient effects, a limited operating horizon, and trade-offs among patient-service and workforce objectives.

One team uses one laptop and submits one collective allocation per simulated period. Four stakeholder roles are assigned offline using printed cards; the website does not assign or track individual roles.

## 3. Non-negotiable Version 2 architecture

### 3.1 Static GitHub Pages application

- The application is a static site deployed in a subfolder of Tamar's existing GitHub Pages homepage.
- All source code is maintained in Git.
- No paid infrastructure, student accounts, university Google account, application database, or server process is required.
- The site must not contain private credentials, Google access tokens, GitHub write tokens, instructor private encryption keys, or private Sheet access.
- The site must never write to the GitHub repository.

### 3.2 Independent local simulations

- Each team runs an independent deterministic simulation in its browser.
- Team browsers are not synchronized with one another or with the instructor page.
- Team screens have no clocks and receive no commands from the instructor page.
- The instructor communicates starts, pauses, extensions, cutoffs, catch-up expectations, and ending verbally.

### 3.3 Google Forms as a write-only instructor record

- Team and instructor pages invisibly submit structured records to the same instructor-owned Google Form.
- Students interact only with the game website and never open or complete a separate Google Form.
- Google Forms/Sheets supplies the authoritative receipt timestamp.
- The linked response Sheet remains private to Tamar and authorized TAs.
- The student application never reads the Form responses or private Sheet.
- Direct Form-post field mappings must be isolated in one documented configuration file because Google may change its internal Form submission interface in the future.

### 3.4 Official play requires internet

- Official period submission requires an internet connection.
- If the browser is clearly offline, block submission before simulation advancement and show a prominent warning.
- Do not accept an official decision offline for later automatic upload.
- Do not implement an offline-first queue that silently advances periods while disconnected.
- Browser-local state still protects periods already completed and the allocation currently being prepared.

## 4. Explicitly prohibited features

Do not implement backend authentication, secure instructor-password claims on a public static site, central game creation, server-stored game definitions, live synchronization, remote control of team browsers, team-visible clocks, automatic instructor discovery of teams, live scores/rankings/scoreboards, server folders, one-active-device enforcement, cross-device recovery, student reads of the private Sheet, student-readable exports, secure/tamper-proof client claims, practice mode, multiple submissions for one period, a separate run/continue action, or invented hospital parameters.

## 5. Landing page and modes

The landing page has two choices: **Instructor** and **Team**. The modes share Form field configuration and game-code normalization rules but keep separate browser-local state.

## 6. Game identity

### 6.1 Team entry

The team enters the instructor-provided game code (for example, `2026W1-101`) and its assigned team number/code. Before creating a new local state, require confirmation such as:

> You are joining game 2026W1-101 as Team 7. Is this correct?

Normalize both game and team codes case-insensitively, trim surrounding whitespace, and retain the entered display form.

### 6.2 Instructor game-code setup

The instructor page must:

1. ask for the same game code used by teams;
2. display normalized and display forms for confirmation;
3. save the confirmed code in instructor browser-local state;
4. include that code and round in every instructor record;
5. lock the code when the first round timer starts;
6. permit replacement only through confirmed **Start New Simulation**.

### 6.3 Safeguards

- Show the locked game code prominently on the projected display.
- Before Round 1, require confirmation that it matches the code given to teams.
- **Start New Simulation** warns that it ends the current instructor-local session, resets round/timer/cutoff state, creates a new local session, and does not affect team browsers.
- A new simulation requires re-entry and confirmation of a game code.
- Use a unique game code for every section, test, and official run. The static site cannot enforce global uniqueness.
- Normal timer reset cannot change the game code or instructor session.
- Save instructor state locally so refresh or accidental closure does not silently create another cutoff identity.

This is sound for a static application if unique game codes are an operational requirement rather than a claimed server-enforced rule.

## 7. Browser-local state and ordinary recovery

### 7.1 Storage

Use IndexedDB, or `localStorage` only if the state is demonstrably small and atomic recovery is safe. Cookies are not the primary mechanism.

Persist after each material transition: game/team identity, immutable completed-period transactions, deterministic simulation state, allocation currently being prepared, current period, transaction/upload status, and finalization/backup eligibility.

### 7.2 Recovery flow

When a team enters game and team codes:

- find an exact local match;
- show **Saved progress found. Resume this game?**;
- restore the last atomically committed state and allocation being prepared;
- if a period is committed but upload status is unresolved, restore that status rather than advancing or recalculating;
- never substitute another game/team save;
- if no save exists, offer a new local game.

Ordinary recovery means browser-local saved state, not a recovery file. It works only on the same laptop, browser, profile, and retained storage. Warn teams not to use private browsing, clear data, switch browsers, or switch laptops.

### 7.3 Downloaded backup distinction

The only downloadable file is the encrypted decision-only game-verification backup created when the team clicks **End Game**. It is separate from ordinary recovery and governed by Section 16.

## 8. How a team advances

### 8.1 One irreversible action

A team advances by clicking **Submit**. Each activation commits exactly one simulated period locally.

The application must treat that click as one local transaction:

1. validate the displayed allocation and confirm the browser is not clearly offline;
2. lock against double-clicks;
3. capture the pre-period state and allocation in memory;
4. create the transaction UUID in memory;
5. apply the allocation and deterministically calculate the full period in memory;
6. construct the combined record in Section 13;
7. atomically save the completed period, ending state, UUID, record, and upload status as one committed state transition;
8. attempt the invisible Form submission;
9. update the student display to the next decision state.

The local period commit is irreversible. It does not imply confirmed Google receipt. Students cannot revise or resubmit a committed period. They may edit the displayed allocation before clicking **Submit**, but unsubmitted edits are neither decisions nor Form records.

### 8.2 Unchanged allocation

Initialize the next displayed allocation to the allocation just applied. If students do not change it before the next **Submit**, apply it again. No special carried-forward interaction or record is required.

### 8.3 Preventing accidental extra periods

- Disable **Submit** immediately on activation.
- Calculate the new period and transaction record in memory, then save the UUID and completed state atomically.
- If the browser closes before the atomic save completes, the period has not advanced and may be submitted again.
- If the browser closes after the atomic save completes, recovery recognizes the committed period and must not calculate it again.
- Double-click, key repeat, refresh, or restored pages must not commit another period accidentally.
- Increment the committed local period exactly once.
- **Retry Upload** retransmits the already-computed record with the same UUID and never invokes simulation.
- After refresh, show existing transaction status before permitting the next period's **Submit**.

## 9. Classroom rounds and late teams

- Team simulations do not have a fixed local period limit.
- Each local period represents 30 simulated minutes.
- Default instructor Round 1 window: 10 real minutes; later windows: 5 real minutes.
- The instructor chooses the planned number of classroom rounds before starting and may add or remove future rounds while the game is underway.
- Adding or removing instructor rounds affects only the projected timer schedule. It does not communicate with or alter team browsers.
- Only the instructor page has a clock.
- Students may submit after cutoff; Google receipt timestamps show lateness, which attracts only a small penalty.
- Late teams begin at local Period 1 and are not automatically advanced.
- They catch up by making/submitting decisions more quickly when instructed.
- Teams may continue committing local periods until Tamar verbally announces that the game has ended.
- Records received after the authoritative `GAME_END` timestamp remain in the audit trail but are outside the graded simulation.

## 10. Instructor display and timing

### 10.1 Display and controls

Show the locked game code, large countdown, current/total round, connection indication, cutoff status, and last instructor-record status. Do not show team decisions, measures, or live scores.

Required controls:

- **Start**;
- **Pause / Resume**;
- **Add 30 Seconds**;
- **Remove 30 Seconds**;
- **Add Period**;
- **Remove Period**;
- **Reset Current Timer** with confirmation;
- **End Simulation** with confirmation;
- **Retry Cutoff Submission** when relevant;
- **Start New Simulation** with confirmation.

### 10.2 Timer rules

- **Start** begins Round 1. After that, normal rounds advance automatically so the instructor can remain with the teams rather than operate the display.
- Add/remove may be repeated; removal cannot reduce time below zero.
- Removing to exactly zero triggers normal zero/cutoff behavior.
- **Add Period** increases the planned total by one.
- **Remove Period** removes only a future round. It cannot remove the current round, reduce the total below the current round, or reopen an ended simulation.
- Pause freezes only the display, not team browsers.
- Reset restores the configured duration for that round and retains game/round identity.
- If a cutoff already exists, reset cannot erase or replace it because that round has already ended and the next round has begun automatically.

### 10.3 Automatic cutoff

When the timer first reaches zero for a non-final instructor round:

1. create one cutoff UUID;
2. persist the cutoff locally before transmission;
3. lock the round against a second cutoff UUID;
4. attempt the invisible `CUTOFF` submission;
5. increment the round, load its configured duration, and start its timer immediately.

When the timer first reaches zero for the final planned round:

1. create one `GAME_END` UUID;
2. persist the `GAME_END` record locally before transmission;
3. lock the instructor session against another logical end record;
4. attempt the invisible `GAME_END` submission;
5. remain stopped at zero.

The final `GAME_END` timestamp is also the deadline for the final round; a separate final-round `CUTOFF` is not required.

### 10.4 Cutoff fallback recommendation

Provide **Retry Cutoff Submission**, not general **Submit Cutoff Now**.

A manual early cutoff would make the deadline ambiguous; transmission recovery is the real need. Retry must retransmit the identical cutoff record and UUID without changing its stored expiry time. Same-UUID Sheet rows are one logical cutoff and are deduplicated later.

To close a round early, use **Remove 30 Seconds** until zero. To stop the whole exercise, use **End Simulation**.

## 11. End Simulation

### 11.1 Instructor page

**End Simulation** requires confirmation and:

- stops/locks the timer;
- submits one `GAME_END` record with its own UUID, game code, round, and diagnostic time if that instructor session does not already have a `GAME_END`;
- prevents any later instructor round from starting;
- does not alter, finalize, or communicate with team browsers.

If final-round expiry already created `GAME_END`, do not create another logical end record; show that the simulation has already ended and permit only same-UUID transmission retry if needed.

### 11.2 Team behavior after the recorded end

Nothing happens automatically on team browsers. The instructor's `GAME_END` Google receipt timestamp is the authoritative end of the graded simulation. Tamar verbally tells teams that the game has ended and that later information will not be graded.

Each team then clicks **End Game**. This action:

- runs no additional simulated period;
- permanently ends that local team session after confirmation;
- creates and attempts one `TEAM_END` Form record;
- opens the final-statistics screen using the periods that team completed;
- generates the encrypted decision-only game-verification file;
- starts the browser's normal download flow.

The site cannot guarantee that every browser displays a folder chooser; browser settings may save the file directly to Downloads. The final screen must tell students to retain the file and send it to Tamar if requested. Any `PERIOD_COMMIT` received after `GAME_END` is retained but excluded from the graded game record.

Do not add **End Team Session**, remote locking, or any special team-finalization workflow.

## 12. Google record design recommendation

### 12.1 One combined record per period

One **Submit** click should produce one logical `PERIOD_COMMIT` record containing the allocation, pre-period state, realized events, calculated results, ending state/checksum, UUID, and metadata. Do not split it into `DECISION` and `PERIOD_RESULT` rows.

### 12.2 Trade-off

One combined record means one browser action, one local transaction, fewer requests, no orphaned decision/result pair, simple deduplication, simpler AI grading, and one receipt timestamp for the committed period. The disadvantage is that the receipt time follows local calculation rather than the precise click. Calculation should be effectively immediate relative to multi-minute windows, and lateness has a small penalty. Reliability therefore outweighs the negligible difference. Store local click time only for diagnostics.

## 13. Google Form schema

### 13.1 Common fields

- schema and application versions;
- event type and UUID;
- normalized/display game code;
- team code or `INSTRUCTOR`;
- round/local period where applicable;
- local diagnostic time;
- configuration/seed version;
- payload checksum;
- Google response timestamp in the private Sheet.

### 13.2 `PERIOD_COMMIT`

Include transaction UUID, period, applied allocation, pre-period state, pre-decision visible measures, realized arrivals/events, patient/service details sufficient for replay, queues/oldest waits, completions, utilization, WIP, period/cumulative flow and wait measures, ending state/checksum, and original-versus-retry flag.

These data remain instructor-only.

### 13.3 `CUTOFF`

Include instructor session, game code, round, cutoff UUID, timer-expiry diagnostic time, and retry indicator. Deduplicate by UUID and use the earliest Google timestamp among same-UUID rows as the authoritative cutoff receipt.

### 13.4 `GAME_END`

Include instructor session, game code, current round, cutoff status, game-end UUID, and diagnostic time.

### 13.5 `TEAM_END`

Include game/team identity, local completed-period count, team-end UUID, configuration version, diagnostic time, and encrypted-backup checksum. It does not contain the encrypted file itself and is not authoritative evidence of timeliness.

### 13.6 Optional audit events

`GAME_START`, `PAUSE`, `RESUME`, `ADD_30_SECONDS`, `REMOVE_30_SECONDS`, and `RESET_TIMER` may be recorded for context but never control teams.

## 14. Submission failure and truthful status

### 14.1 Advancement rule

Once calculation and atomic local commit succeed, the period remains completed locally even if Form transmission fails or is ambiguous. Never roll back and rerun it merely because transmission is uncertain.

### 14.2 Statuses

Track:

1. **Saved locally - upload not started:** commit exists but transmission definitely did not initiate.
2. **Submission attempted - confirmation unavailable:** transmission initiated online, but cross-origin restrictions prevent proof of Google storage.
3. **Retry recommended:** definite evidence transmission did not initiate, or Tamar/support directs retry after Sheet inspection.
4. **Retry attempted - confirmation unavailable:** identical UUID/payload retransmitted; duplicate Sheet rows may exist.

Never say **Received**, **Confirmed**, or otherwise imply Google acceptance.

### 14.3 Honest UI language

Normal online attempt:

> Period completed and saved on this laptop. Submission was sent to the course record, but this page cannot confirm Google's receipt.

Definite launch failure:

> Period completed and saved on this laptop, but the course-record submission could not be started. Reconnect and use Retry Upload. Retrying will not run another period.

Clearly offline before click:

> You appear to be offline. This period has not been run or submitted. Reconnect before clicking Submit.

### 14.4 Conservative retry policy

- Block before calculation when clearly offline.
- While apparently online, permit the transaction and attempt transmission.
- Connectivity indicators do not prove Google reachability.
- Do not automatically retry an ambiguous online attempt.
- Show **Retry Upload** directly for definite pre-transmission/client failure.
- For ambiguous attempts, place retry behind troubleshooting text warning that Google may already have the record.
- Retry identical stored payload/UUID, never recalculate, never create a new UUID, and never retry endlessly.
- Instructor processing deduplicates UUIDs and uses the earliest Google timestamp.

## 15. Simulation rules already confirmed

- Deterministic discrete-event simulation after model confirmation.
- One click calculates one 30-minute simulated period.
- At the end, retain patients as ending WIP; do not clear them.
- Scheduled patients: three per period at minute 0, 10, and 20.
- Unscheduled patients: Poisson process averaging 5.5 per hour.
- Same game code produces the same hidden realization; different codes normally produce different realizations.
- Future arrivals are not displayed, although public client code can technically be inspected.
- FIFO at every activity.
- Individual patient prioritization is unavailable.
- Identical qualified-worker dispatch is deterministic and automatic.
- Invalid allocations cannot be submitted.
- Optional notes may remain but are not required or expected.
- Derive the deterministic arrival stream from the normalized game code, a versioned salt, and a versioned pseudo-random algorithm.
- Generate arrivals against absolute simulated time so identical game codes produce identical arrivals regardless of browser speed, refreshes, or the real-world pace at which teams submit periods.

## 16. Encrypted decision-only backup

- Generated when the team clicks **End Game**, regardless of how many local periods it completed.
- Sole permitted student download.
- Contains only versions, game/team, completed periods, applied allocations, optional notes, local diagnostic times, transaction UUIDs/checksums, and replay configuration identity.
- Excludes arrivals, outcomes, queues, waits, utilization, completions, flow times, dashboards, targets, and full state.
- Uses browser-supported authenticated hybrid public-key encryption.
- Public key may be deployed; private key never enters GitHub/site.
- Opaque `.gamebackup` file is decrypted/replayed only by Tamar's offline utility.
- It supports recovery but is not proof of receipt, timeliness, or sophisticated-client authenticity.
- Present the file to students as an encrypted game-verification file.
- Tell students that the browser may save it directly to Downloads rather than asking them to choose a location.

## 17. Student displays

### 17.1 During play

After each period show only queue length by activity, oldest wait by activity, cumulative completions by patient type, worker utilization for the completed period, total WIP, current assignments, and local period number. Show no clock, future arrivals, or overall score.

### 17.2 Final screen

Show final statistics only: completions by patient type; average/maximum flow time by type; average/maximum waiting time by type; ending WIP by location; average utilization by worker/activity. Flow-time statistics include completed patients only. Waiting-time statistics include every patient who arrived, including patients still queued or in service when the team clicks **End Game**; ongoing queue waits accrue through that ending moment.

Do not show decision history, audit trail, arrival history, or period-by-period machine-readable results. Do not provide CSV, JSON, PDF, print, copy-all, or readable export. The encrypted backup is the only exception.

## 18. Confirmed hospital process model

### 18.1 Story and managerial problem

The setting is a hospital same-day assessment and treatment unit serving two patient streams:

- scheduled follow-up patients with predictable arrivals and a short routine-treatment route;
- unscheduled diagnostic patients with uncertain arrivals and a longer assessment/diagnostics/review route.

The managerial problem is:

> How should the unit allocate six cross-trained workers among four activities before uncertain unscheduled demand is realized, while protecting scheduled-patient service and managing queues throughout the diagnostic route?

Students control staffing capacity. They do not route, prioritize, or dispatch individual patients.

### 18.2 Patient routes

| Patient type | Route |
|---|---|
| Scheduled follow-up | Intake → Routine treatment → Exit |
| Unscheduled diagnostic | Intake → Clinical assessment → Diagnostics → Clinical review → Exit |

### 18.3 Activities and processing times

| Activity ID | Student-facing name | Patient type | Processing time |
|---|---|---|---:|
| `INTAKE` | Intake | Both | 5 minutes |
| `ROUTINE` | Routine treatment | Scheduled | 15 minutes |
| `ASSESSMENT` | Clinical assessment | Unscheduled | 10 minutes |
| `DIAGNOSTICS` | Diagnostics | Unscheduled | 15 minutes |
| `REVIEW` | Clinical review | Unscheduled | 10 minutes |

Intake has one fixed employee. Each flexible worker supplies 30 simulated minutes per period. Nominal one-worker capacities are therefore six patients at intake, two at routine treatment, three at assessment, two at diagnostics, and three at review, subject to arrival times, queues, and boundary-crossing service.

### 18.4 Workers and qualifications

| Worker | Routine | Assessment | Diagnostics | Review |
|---|:---:|:---:|:---:|:---:|
| `W1` | ✓ | ✓ |  |  |
| `W2` |  | ✓ | ✓ |  |
| `W3` | ✓ | ✓ |  | ✓ |
| `W4` |  |  | ✓ | ✓ |
| `W5` | ✓ |  |  | ✓ |
| `W6` |  | ✓ | ✓ | ✓ |

All six workers must be allocated. Every flexible activity must receive at least one qualified worker. Workers perform identically when qualified. Valid aggregate staffing patterns are `3–1–1–1` or `2–2–1–1`, subject to the qualification matrix.

### 18.5 Arrivals

- Scheduled patients arrive deterministically at simulated minutes 0, 10, and 20 of every 30-minute period.
- Unscheduled patients follow a Poisson process averaging 5.5 patients per simulated hour.
- Implement unscheduled arrivals using deterministic, versioned exponential interarrival-time generation.
- Teams using the same normalized game code receive exactly the same arrival realization.
- Future arrivals are hidden from the ordinary team interface.

### 18.6 Continuous event processing

- Activities operate concurrently.
- A patient may complete multiple consecutive activities within one period.
- After completing an activity, the patient immediately begins the next activity if a qualified assigned worker is available; otherwise the patient joins its FIFO queue.
- Students cannot prioritize individual patients.
- An activity may cross a period boundary.
- A worker already serving a patient finishes that non-preemptive service before moving to the activity selected for the new period.
- Worker reassignment between periods has no additional setup or handoff penalty.
- At `GAME_END`, do not clear the system; retain all waiting and in-service patients as ending WIP.

### 18.7 Configurable initial state

The official initial state will be selected after simulation playtesting by running the model, freezing it at a useful state, and saving that exact state as a versioned configuration snapshot.

Until that snapshot is approved:

- use an empty initial state for engine development and testing;
- label it provisional;
- keep initial patients, locations, arrival times, accumulated waits, and in-service work entirely configuration-driven;
- do not invent an official initial backlog.

There is no poor default allocation. That feature belonged to the superseded centrally synchronized late-team design and must not be implemented.

### 18.8 Deferred stakeholder thresholds

Numerical stakeholder targets remain configurable and unset until playtesting. Their absence does not block implementation or testing of the simulation engine.

## 19. Stakeholder roles

Offline cards represent scheduled-patient access/timeliness; unscheduled-patient waiting/responsiveness; overall throughput/process flow; and workforce utilization/operating efficiency. Each eventually receives a measurable target. Targets are not individual grades, combined score, ranking, or leaderboard.

## 20. AI-ready instructor record

The private exported record must support later instructor-only normalization/replay that can deduplicate UUID retries; select earliest receipt time; compare periods with cutoffs; flag late/post-end records; verify state continuity/checksums; deterministically replay; reconcile missing rows with encrypted backup; label backup timing unverified; and produce instructor-only AI-ready CSV/JSON.

It must let an AI agent check report claims about actual allocations, strategy, queues, waits, throughput, WIP, utilization, flow time, completions, patient types, timing, and claimed consequences. AI identifies evidence/discrepancies; the TA assigns the grade.

## 21. Accepted limitations

- No names, student numbers, or emails in game records.
- Local time is diagnostic; Google timestamps are authoritative for received rows.
- Cross-origin Form posts cannot be reliably confirmed.
- Same-UUID duplicate rows may follow retries.
- Browser state is not secure attestation.
- Backup is not proof of timeliness/authenticity against a sophisticated adversary.
- Public code/arrival logic can be inspected.
- Instructor end cannot force team browsers to stop.
- These are accepted free-Version-2 trade-offs.

## 22. Behavioral acceptance requirements before coding

Tests must eventually verify: one click/one period; atomic commit behavior before and after interruption; no extra advancement from double-click/refresh/retry; unchanged allocation reuse; no committed-period revisions; offline blocking before calculation; same-UUID retry without advancement; honest ambiguous status; deduplication to earliest timestamp; once-per-round cutoff; same-UUID cutoff retry; automatic next-round start; add/remove-future-period constraints; automatic final `GAME_END`; nonnegative timer; no reset of an existing cutoff; game-code lock; confirmed new simulation; late-team catch-up; same-browser recovery; student **End Game** without another simulated period; final statistics for the team's actual completed periods; encrypted backup as sole download; post-`GAME_END` exclusion from grading; identical arrivals for identical game codes; different arrivals for different game codes; continuous within-period patient movement; boundary-crossing non-preemptive service; qualification enforcement; FIFO; and deterministic replay for grading.

## 23. Remaining playtesting work

No further timing, end-of-game, recovery, submission, process-route, processing-time, qualification, or code-normalization decision is required before engine implementation.

Playtesting must later establish:

- the official versioned initial-state snapshot;
- stakeholder numerical thresholds;
- whether processing times or arrival parameters require an explicitly approved later revision.

## 24. Change log from Version 1

- Defined **Submit** as one irreversible period commit.
- Removed revisions, multiple proposals, last-valid selection, carry-forward interaction, and separate run/continue.
- Recommended one combined `PERIOD_COMMIT` instead of `DECISION` plus `PERIOD_RESULT`.
- Added same-UUID **Retry Upload** without simulation advancement.
- Removed offline-first advancement/delayed upload; clearly offline submission is blocked.
- Added truthful cross-origin status and conservative retries.
- Added automatic once-per-round cutoff and same-UUID **Retry Cutoff Submission**.
- Added remove-30-seconds and nonnegative/reset rules; confirmed that later rounds start automatically after each cutoff.
- Added instructor game-code confirmation/lock/new-simulation safeguards.
- Changed late teams to Period-1 start with catch-up.
- Removed practice mode.
- Restricted final screen to statistics and removed student decision history.
- Clarified local recovery versus encrypted downloadable backup.
- Added instructor-controlled planned rounds with add/remove-future-period controls.
- Removed the fixed five-period limit from team browsers.
- Added student **End Game**, final statistics, `TEAM_END`, and encrypted game-verification download.
- Clarified that `GAME_END` is authoritative for grading and later team records are excluded.
- Added the recovered two-stream hospital process, processing times, workers `W1`–`W6`, qualifications, arrival rules, FIFO, continuous event movement, and boundary treatment.
- Removed the obsolete poor default allocation.
- Deferred the official initial snapshot and stakeholder thresholds to playtesting without blocking engine development.
- Retained prohibitions on backend/authentication, synchronization, remote team control, team clocks, scoreboards, student-readable exports, Sheet reads, secure-client claims, and invented parameters.

## 25. Review gate

Do not implement until Tamar approves this Version 3 specification patch and separately approves the exact proposed implementation changes required by the repository instructions. Do not reopen settled design questions.
