# Google Form submission

`google-form-config.js` is the only file containing Google Form URLs and `entry.*` mappings. If the instructor replaces or edits the Form, update that file and retest the mapping.

The browser submits with `fetch(..., { mode: "no-cors" })`. A resolved request means transmission was attempted, not that Google stored the row. The request is abandoned locally after 12 seconds so a slow Google response cannot hold the interface indefinitely. Once `fetch` has returned a promise, resolution, rejection, and timeout are all attempted-but-unconfirmed outcomes; only a synchronous client launch failure is definite non-initiation. The UI must therefore say **confirmation unavailable**, never **received** or **confirmed**.

Every retry serializes the already-saved record, reuses its UUID and payload checksum, and changes only the separate `Is Retry` Form field. Submission code never invokes the simulation engine.

Period payloads contain compact pre-period and ending operational snapshots rather
than the engine's recursively growing historical arrays. Each payload still includes
the full current-period event/result record and ending checksum. Together with the
game code and allocation sequence, this supports deterministic replay and continuity
checks while keeping `Payload JSON` below Google Sheets' per-cell size limit.

The same transport also accepts instructor `CUTOFF` and `GAME_END` records. Their
diagnostic times come from the persisted timer deadline (or the confirmed manual-end
instant), and retries retain the original UUID and diagnostic time.
