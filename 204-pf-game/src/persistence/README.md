# Local persistence and recovery

The game stores team and instructor sessions in IndexedDB database `comm204-process-flow-game`. Ordinary recovery never creates or reads a downloaded file.

## Team identity

Game and team codes are trimmed and normalized to uppercase for identity. Their trimmed display forms are retained. A team save is keyed by the exact normalized game/team pair, so another game or team is never substituted.

Creating a session never overwrites a matching save. `replaceTeamSession` and `replaceInstructorSession` are separate explicit operations that the future UI may call only after the required destructive-action confirmation.

## Atomic period commits

The caller calculates a period entirely in memory and passes the resulting state, period result, Form record, UUID, and initial upload status to `commitPeriod`. One IndexedDB read/write transaction stores them together. Therefore:

- a crash before the commit leaves the preceding period intact;
- a crash after the commit restores the completed period;
- the same UUID is idempotent;
- a stale or skipped period is rejected;
- upload-status changes never invoke the simulation engine.

The Google Form transport records only honest browser-observable states. A completed
cross-origin request becomes `ATTEMPTED_UNCONFIRMED`; it is never labeled received.
A request that rejects becomes `RETRY_RECOMMENDED`. Manual retry reuses the stored
record and UUID and never advances the simulation.

Instructor state stores an absolute running deadline, all cutoff/game-end UUIDs, and
their upload states. Every timer transition is saved before transmission. Recovery
reconciles elapsed wall-clock time against that deadline, so it can create missed
cutoffs exactly once without extending rounds or relying on browser tick accuracy.

## Recovery outcomes

- `START_NEW`: no exact local save exists.
- `RESUME_DECISION`: restore the active session and its draft allocation.
- `REVIEW_UPLOAD_STATUS`: restore a committed record whose upload definitely did not begin or needs attention.
- `SHOW_FINAL`: the local team session has ended.

The future UI must show the warnings exported as `RECOVERY_WARNINGS` before play.

## Testing

The repository layer accepts a persistence driver. Production uses `IndexedDbDriver`; automated logic tests use `InMemoryDriver` with the same atomic-update contract.
