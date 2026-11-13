# Trial results format, version 1 (contract between the sim's trial runner and the research package)

A trial is one seed plus one scenario, run headless with no API and no wall clock. The same seed and scenario give byte-identical files. Written by slice B1 (sim repo), read by slice B2 (dashboard repo `research/`). Both sides refuse a `format_version` they do not know.

## Command
`node dist/trial/trial.js --scenario <file.json> --seed <int> --days <int> --out <folder>`
- `--seed`: integer 0 to 2^31-1. `--days`: integer 1 to 60. `--out`: a folder that is created; an existing non-empty folder is refused.
- Exit 0 on success. Exit 2 with one line on stderr for bad arguments, a refused or unreadable scenario, or an output folder that cannot be used. Every check that can refuse runs BEFORE the trial, so a refusal is immediate and writes nothing. Text echoed in an error is capped at 40 characters with control and direction characters replaced by `?`.
- The runner works when started through a symlinked path.
- Speed is fixed inside the runner and recorded in the manifest (outcomes depend on speed).

## Scenario file (JSON, at most 16 KB, unknown keys refused)
```
{ "format_version": 1, "name": "default",
  "staffing": { "staff_nurses": 2, "charge_nurses": 1, "physicians": 2 },
  "beds": 20,
  "arrivals": { "occupancy_target": 0.75 },
  "case_mix": "w4-default" }
```
Version 1 accepts only the values of today's ward W4 (they are cited constants in the sim). A value that differs is refused with an error that names the key; it is never ignored silently. If a key is written twice, JSON keeps the last value and that value is the one checked. `name` matches `^[a-z0-9][a-z0-9_-]{0,31}$`. `scenarios/default.json` holds exactly today's values.

## Output folder
All files are UTF-8, `\n` line ends, no trailing spaces, numbers printed with `String(n)`; CSV has a header row and no quoting (no field contains a comma).

### `manifest.json`
`{ "format_version": 1, "synthetic": true, "seed": int, "days": int, "speed": int, "scenario": <the scenario object>, "scenario_sha256": hex, "sim_commit": string, "node_major": int, "bin_minutes": 15, "patients": int, "episodes": int }`
- `sim_commit`: the environment variable `TRIAL_SIM_COMMIT` when it is 7 to 40 lowercase hex characters, otherwise `"unknown"`. This is the only environment variable read. Never the clock or the network.
- `node_major`: the major version of Node that ran the trial. Byte-identical output is promised for the same seed, scenario and Node major only (the generator uses `Math.exp`, `log` and `cos`).
- `scenario_sha256` is over the scenario file's raw bytes. `patients` is the number of rows in `episodes.csv`.

### `cohort.csv` — one row per patient per 15-minute bin while the patient is in the ward
Columns, in this order:
`patient,minute,heart_rate,respiratory_rate,spo2,temperature,systolic,diastolic,bp_minute,consciousness,on_oxygen,spo2_scale,coverage,ranked,news2`
- `patient`: the sim's patient id (`p-001`, `n-0001`). No names anywhere.
- `minute`: sim minute at the end of the bin (a multiple of 15).
- The four device vitals: the value the sim holds at that minute, at the precision it sends to the API (whole numbers; temperature one decimal); empty when the sim treats it as missing.
- `systolic`, `diastolic`: the last recorded blood pressure; empty when none. `bp_minute`: the sim minute it was recorded at (it can be negative for a patient present at the start); empty when none. A blood pressure is a nurse's cuff reading, so it can be hours old: a hypotensive episode shows in the cohort only once a cuff is taken.
- `consciousness`: A, C, V, P or U. `on_oxygen`: 0 or 1. `spo2_scale`: 1 or 2.
- `coverage`: the sim's signal quality for the patient, 0 to 100; empty when it has none.
- `ranked`: 1 when the sim's arbiter ranked the patient at that minute, 0 when NOT RANKED.
- `news2`: the sim's NEWS2 total when ranked; empty when not ranked.
These are the inputs the sim's own scorer used at that minute, so re-scoring a row with the backend's NEWS2 must give `news2`.
Known edges, all intended:
- Bins run from minute 15 to the last multiple of 15 below `days * 1440`; the bin at exactly `days * 1440` is not written, because its samples land after the clock stops.
- A row exists only for a bin the sim actually scored. A stay admitted in the last 15 minutes of a trial, or shorter than one bin, has a row in `episodes.csv` and none here. A patient who leaves in the minute after a bin boundary can lack that last bin.
- Numbers are printed with `String(n)`, so a temperature of 37.0 prints as `37`.

### `episodes.csv` — ground truth, one row per patient stay
`patient,admit_minute,leave_minute,outcome,episode_kind,episode_start,ramp_minutes,af_start,af_end,persistent_af`
- `admit_minute`: 0 for the patients present at the start (their true arrival is unknown).
- `leave_minute`, `outcome` (`discharged` or `higher_care`): empty while still in the ward at the end of the trial.
- `episode_kind` (`respiratory`, `tachycardic`, `hypotensive`), `episode_start`, `ramp_minutes`: the generator's true deterioration episode for the stay, read from the vitals source's saved state at admission (and after, if it changes); empty when the patient has none. An episode whose start is after the patient left is still written; the reader decides.
- `episode_start`, `af_start` and `af_end` are sim minutes and may be fractional.
- One starting patient (`p-001`) has a scripted worsening built into the fixture; it is not a generator episode and is not listed here. An evaluation should say so or leave the starting patients out.
- `af_start`, `af_end`: a new-onset AF episode in sim minutes, empty when none. `persistent_af`: 1 when the patient is in AF for the whole stay.
- `outcome` is decided by NEWS2 inside the sim. It is recorded for flow statistics only and must never be used as the event to evaluate NEWS2 or anything built on it.

### `summary.json`
`{ "admitted": int, "discharged": int, "higher_care": int, "turned_away": int, "patient_days": number, "episodes_per_admission": number }`

## Security and privacy rules of the format
- No patient names, no clinician names, no free text. Only ids, numbers and the fixed words above.
- Ground truth (`episodes.csv`) is written only here. One exception, owner decision `dashboard-7`: for a live run marked synthetic, the headless ward runner (`npm run ward`) posts each started deterioration episode to the API with the ingest key (patient id, kind, start minute, fully-in minute), only after it has started and after the batch that covers it is acknowledged. The API shows it only in a patient's history to a clinician who may see that patient, never in a rank, a score, a model input or the open ward view. The browser and the trial runners never send it.
- The runner reads only its arguments and the scenario file, writes only inside `--out`, and makes no network call.

## Tests each side must have
- Runner: same seed and scenario twice gives the same SHA-256 for every file; another seed differs; a malformed, oversized, unknown-key or non-default scenario is refused and writes nothing; `--out` outside-the-folder writes do not happen; a 30-day trial finishes; over a long run `episodes_per_admission` is near the cited 0.061; no header or value contains a name from the sim's name lists.
- Reader: an unknown `format_version` is refused; every bin re-scored with the backend's NEWS2 equals `news2`.
