# The lab worker

The dashboard's Simulation lab lets a physician or charge nurse ask for one paired compare run. The BioSentry API only stores the request and the result. It never runs anything. The lab worker is the process that runs it.

The worker claims a request from the API, runs this repository's own `compare` once, and posts the two files compare wrote. Then it claims again. Everything it runs is synthetic.

The wire contract between the API and the worker is `contract-d7` (version 3). It is kept by the two teams outside this repository. This page says what the worker does; where the two differ, the contract wins.

## Run it

```bash
BIOSENTRY_API_URL=http://127.0.0.1:8000 BIOSENTRY_INGEST_KEY=dev-local npm run lab-worker
```

`npm run lab-worker` builds the compare bundle and the worker bundle, then starts the worker. In the container image the bundles are already built:

```bash
node dist/lab/lab-worker.js
```

The image's default command is still the ward runner. A compose service for the worker overrides the command with the line above. That service lives in the BioSentry-Intelligence repository, not here.

| Variable | Meaning |
|---|---|
| `BIOSENTRY_API_URL` | The API's address. `http` or `https` only. No user name, password, query or fragment |
| `BIOSENTRY_INGEST_KEY` | The same ingest key the ward runner uses |

The worker stops with exit 2 and one line when a variable is missing, when the address is not acceptable, when the key holds a character that cannot go in a header, when the compare bundle or a scenario file is missing, or when a proxy variable is set (see below).

## What it calls

Two routes, and no other:

- `POST /sim/lab/claim`, no body. `200` with a job, or `204` when there is nothing to do.
- `POST /sim/lab/runs/{id}/report`, with one of three bodies: `done` (the text of `compare.json` and `compare.txt`), `refused` (one reason line), or `failed` (one fixed reason line).

Every call carries the header `X-Ingest-Key`.

## What it accepts

A job has `id`, `kind`, `mode`, `seed`, `days`, `baseline` and `change`. The worker checks every value against its own fixed tables before it runs anything:

- `kind`: `compare` only.
- `mode`: `w4` or `hospital`.
- `seed`: a whole number from 0 to 2147483647. `days`: a whole number from 1 to 30.
- W4: `baseline` and `change` are two different names out of `news2_total_ge_1` to `news2_total_ge_20` and `news2_chart_trigger`.
- Hospital: `baseline` is `typical`, `surge` or `doh-standard`. `change` is `staffing=`, `nurses=` or `doctors=` followed by `doh-standard` (for `typical` and `surge`) or `typical` (for `doh-standard`). Nine pairs in all.

Anything else is refused before running, with the reason `the worker does not accept this job: <field>`. A field the worker does not know is ignored and never read.

It then runs, with an argument list and never through a shell:

```
node dist/compare/compare.js --seed N --days N --baseline B --change C --out <a fresh temp folder>/out
```

This is the single-seed compare of `docs/compare.md`. The worker never passes `--seeds` or `--outcome-model`.

## What it reports

| What happened | Report |
|---|---|
| compare exited 0 and both files are there | `done`, with the two files' text unchanged |
| compare exited 2 (a refusal) | `refused`, with compare's own one-line reason, cut to 300 characters |
| compare exited with another code | `failed`: `compare exited with code N` |
| compare could not be started | `failed`: `compare did not start` |
| compare ran longer than 15 minutes | the worker kills it; `failed`: `compare did not finish within 15 minutes` |
| a file is missing | `failed`: `the compare output is missing` |
| a file is over its size cap | `failed`: `the compare output is over the size cap` |

The caps are 524288 characters for `compare.json` and 131072 for `compare.txt`.

## Timing

- Idle: one claim every 30 seconds. After a report: the next claim at once.
- One job at a time. No claim while compare runs.
- API unreachable, or a 5xx answer: wait 30 seconds, then double, up to 5 minutes.
- `403` or `503` (the key is wrong or not configured): one log line, then one try every 5 minutes.
- A report that fails on the network is tried up to 5 times within 10 minutes, then dropped. A `204`, `404`, `409` or `422` answer is final: the report is never sent again and the job is never run again.
- Nothing is resumed after a restart. The worker keeps no state file.
- When the worker is stopped (SIGTERM or SIGINT) during a run, it kills compare, deletes its temp folder, reports nothing and exits 0. The API marks that run failed after 20 minutes.

## Safety rules it follows

- **The key goes to one address only.** Every request is built from the one configured address. Redirects are refused. The worker refuses to start when `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (or their lowercase forms) or `NODE_USE_ENV_PROXY` is set, or when Node is started with `--use-env-proxy` (in its arguments or in `NODE_OPTIONS`): it does not send the ingest key through a proxy.
- **The key is never written down.** Not in a log line, not in the command line, not in compare's environment, not in a file.
- **No text from a job reaches a shell or a path.** Compare's arguments come from the fixed tables above. Seed and days are checked as whole numbers.
- **It reads little from the API.** A claim answer over 64 KiB is treated as not a job. Other answers are judged by their status and their body is not read.
- **It writes only in its own temp folder,** and deletes it after reporting, whatever happened.
- **It never touches the live ward run.** Compare runs its own seed in memory.

## Limits

- Synthetic only. A lab run is a simulator result, not evidence about a real ward.
- The 15-minute limit, the 30-day cap on `days` and the polling times are judgement values from the wire contract. Compare's run time has not been measured on the target machine.
- The container image is not built or run by this repository's tests. One test builds the two bundles into the image's folder layout and runs a real one-day job through them against a local test server.
- A worker that crashes (not one that is stopped) can leave a small temp folder behind.
