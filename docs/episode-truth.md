# Episode truth for a live run

Owner decision `dashboard-7`. Wire contract: contract-truth v1.1. This reverses an older rule, so it is narrow.

## What is sent
For each simulated deterioration episode: the patient id, the kind (`respiratory`, `tachycardic` or `hypotensive`), the start minute (floor of the true start) and the fully-in minute (ceil of start plus ramp). Nothing else. Atrial fibrillation is never sent.

## When
- Only after the episode has started on the run's clock. A scheduled start is never sent ahead of time.
- Only after the API has acknowledged the patient and a batch that took the whole queue at a minute at or after the start (`sync.acked`).
- At most one post every 10 s, with at most 200 episodes, oldest start first. Nothing is posted when there is none.

## By what
Only `npm run ward` (`src/headless.ts`) creates the poster. The key goes in the `X-Ingest-Key` header, to `POST /sim/runs/{run_id}/episodes`, with no redirects and a 10 s timeout. The browser page, the trial runners, the compare and lab code and `src/realism.ts` never import `src/sim/truth.ts`. A test scans `src/` for that.

## Each answer
| Status | Runner |
|---|---|
| 2xx | marks the episodes as sent |
| 403, 404, 503, network error, timeout | keeps them, tries again no sooner than 60 s later |
| 409 (run not synthetic) | stops episode posts for this run, one log line |
| 422 | drops that body, one log line, no retry |

A row that would break the wire contract is refused here before sending, with one log line. A log line holds only the run id and the status. It never holds the key, a body or a header.

## Rows that wait, and new registrations
- A row waits for its acknowledgement even after the patient has left the ward. The runner keeps it and posts it once the API knows the patient and the batch minute. At most 200 rows wait; past that the oldest start is dropped with one log line.
- The poster tells runs apart by the pair (run id, registration number from `sync.generation`). If the API hands out the same run id again after its own reset, the poster still starts clean, and a 409 stop does not carry over.

## A limit this slice does not fix
After a runner crash, the existing sync can treat a patient as known whose admission was still in flight. An episode for that patient can get a 422, and that drops its whole body.

## What the API does with it
The wire contract says the API shows it only in a patient's history, to a clinician who may see that patient, and never in a rank, a score, a model input or the open view. That promise is the API's side. This repository does not enforce it.

## If the API has no episodes route yet
Every post gets 404 and is retried once a minute. Nothing else in the runner is affected. The post is never awaited by the ward's loop, the sync does not read its answer, and a test checks that a hanging post does not block `sync.flush()` or the tick loop.
