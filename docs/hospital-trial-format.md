# Hospital trial results format, version 1

A hospital trial is one seed, one scenario and a number of days, run with no browser and no API. The same three inputs give byte-identical files, so scenarios can be compared seed by seed. This format is separate from the ward-only cohort trial (`docs/trial-format.md`, another branch).

## Command
`npm run hospital-trial -- --scenario scenarios/hospital/typical.json --seed 101 --days 30 --out trials/typical-101`
- `--seed`: whole number, 0 to 2147483647. `--days`: whole number, 1 to 60. All four flags are required, each once.
- `--out`: a folder that is created. An existing empty folder is accepted. An existing non-empty folder, a file, or a path under a file is refused.
- The scenario file is read with a 16 KB cap and goes through `parseScenario`, which refuses unknown keys, bad numbers and hostile text.
- Exit 0 on success. Exit 2 with one line on stderr for any refusal. Every check that can refuse runs before the trial, so a refusal writes nothing. Text echoed in an error is cut to 40 characters, with control and direction characters shown as `?`. Exit 1 means the trial itself failed (for example a full row buffer); nothing is written.
- The files are written to a temporary folder next to `--out` and renamed at the end, so a failure leaves no partial result.
- No network, no clock. The only environment variable read is `TRIAL_SIM_COMMIT`. The command works when started through a symlinked path.
- The world is stepped as the page steps it: speed 60, one step per sim second. Rows are drained every sim hour. If a row buffer is ever full at a drain, the trial fails instead of writing missing rows.
- Minute 0 is 15:00 on day 1. A trial of N days covers minutes 0 up to, not including, N x 1440. The sim also steps minute N x 1440, but its events are dropped from `events.csv` and the summary, so every file covers the same span. Hour h covers minutes h x 60 to h x 60 + 59.

## Files
All files are UTF-8 with `\n` line ends. Numbers are printed with `String(n)`. CSV has a header row and no quoting. No field contains a comma, a newline or a character outside printable ASCII (asserted). No patient or staff names appear anywhere.

### `manifest.json`
`format_version` (1), `synthetic` (true), `seed`, `days`, `speed` (60), `scenario` (the parsed scenario), `scenario_sha256` (over the scenario file's raw bytes), `sim_commit`, `node_major`, `warm_up_days` (3), `hourly_rows`, `event_rows`.
- `sim_commit` is `TRIAL_SIM_COMMIT` when it is 7 to 40 lowercase hex characters, else `"unknown"`.
- Byte-identical output is promised for the same seed, scenario and Node major only.

### `hourly.csv`
One row per unit per hour: 7 units (ER, MORGUE, ICU, MED3A, MED3B, W4, SURG5A) x days x 24 rows. Counters are for the hour just ended. Columns, in order:

| Column | Unit | Meaning |
|---|---|---|
| `hour` | hour | Sim hour, from 0. |
| `unit` | id | Unit id. |
| `census` | people | People in the unit now. ER: waiting, in consult, in work-up and boarding. MORGUE: bodies in drawers. Other units: people in a slot, plus W4 patients. |
| `beds` | beds | Authorised beds (ER: bays; MORGUE: drawers). |
| `stretchers_used` | people | People on a corridor stretcher (a slot past the beds). ER trolleys and chairs count here too. |
| `occupancy_pct` | percent | Census over beds, one decimal. It can pass 100. |
| `arrivals` | people | ER only: new arrivals this hour; 0 elsewhere. |
| `admitted_in` | people | People admitted to the unit from the ER this hour. |
| `discharged` | people | Discharges from the unit this hour. For the ER: sent home. |
| `transferred_in`, `transferred_out` | people | Moves between units (ICU step-down, W4 to ICU) and, for the ER, transfers out to another hospital. |
| `died` | people | Deaths in the unit this hour. |
| `nurses` | people | Nurses on shift, as the scenario sets them. Shown, not modelled outside W4 and the ER doctor queue. |
| `patients_per_nurse` | people | Census over nurses, one decimal; blank when no nurses. |
| `er_waiting`, `er_consult`, `er_workup`, `er_boarding` | people | ER only: people in each stage now. |
| `er_boarding_hours` | person-hours | ER only: boarding time accrued this hour, two decimals. |
| `er_lwbs` | people | ER only: left without being seen this hour. |
| `door_to_doctor_median_min` | minutes | ER only: median of arrival to doctor for people first seen this hour; blank when nobody was seen that hour. |
| `icu_indicated_not_in_icu` | people | ICU-indicated people in a bed, on a stretcher, boarding or on W4. Blank on MORGUE. |
| `morgue` | bodies | MORGUE row only: every body in the house, in drawers or awaiting the morgue. |

ER-only columns are blank on every other unit's row.

### `events.csv`
Ground truth, one row per event, in non-decreasing minute order: `minute,person,w4_id,unit,kind,detail,news2_independent`.
- `minute`: sim minute. `person`: the person's number (the digits of `h-000123`). Residents at minute 0 are numbered from 1000001, W4's first patients from 2000001. `w4_id`: the ward's patient id while the person is on W4, else blank.
- `unit`: where the event happened. `kind`: `arrive, triage, consult, decide_home, decide_admit, board, place, transfer, discharge, lwbs, transfer_out, died, to_morgue, released, turned_away, w4_higher_care`.
- `detail`: only the sim's fixed words (group, complaint wording, unit id, triage level, hours as `boarded 5 h`). Where the sim's wording holds a comma, it is written as `;`.
- `news2_independent`: `yes` when the event does not depend on NEWS2, `no` when W4's NEWS2 decided it (W4 discharge, W4 higher care and the ICU move). Use only `yes` rows as ground truth for evaluating NEWS2 or models built on it.
- `transfer` rows include a move from a stretcher to a bed inside one unit (detail `stretcher to bed`), which is not a move between units.
- `w4_higher_care` is the sim's W4-to-ICU move (written by the sim as a `transfer` with detail `W4 to ICU`, or a `board` with `W4 higher care, no ICU bed`). The trial renames the kind. These rows always carry `news2_independent` = `no`; the trial fails if one does not. A higher-care row that is a `board` is renamed too, so it is not in the boarding-hours figures.
- `turned_away` is not in the design list: an arrival the house could not hold (people cap).

### `summary.json`
`format_version`, `synthetic`, `seed`, `days`, `warm_up_days`, `scenario`, `limits`, and two blocks with the same keys: `all_days` (the whole run) and `after_warm_up` (excluding the first 3 days; every figure is null or 0 when the run is 3 days or less).
- `per_unit.<id>`: `occupancy_mean_pct`, `occupancy_max_pct` (over the hourly rows), `admissions` (admitted_in summed), `deaths`. The ER has no `admissions`: its people arrive, see `er_arrivals`.
- `admissions`: people the ER placed in any unit. `deaths`: `died` events in all units. `left_without_being_seen` and `transfers_out` (ER to another hospital) count events by their minute.
- Boarding: `er_boarding_hours_median`, `er_boarding_hours_p90` (nearest rank) are over completed boardings only: from the `board` event to the next `place`, `transfer_out` or `died`, counted by when boarding began. People still boarding at the end are in `er_still_boarding_at_end` (`count`, `median_hours_so_far`). Under heavy crowding (surge) the completed-only figure is biased down.
- Door to doctor (arrival to `consult`, in minutes, counted by arrival): `door_to_doctor_median_min`, `door_to_doctor_p90_min`, `share_seen_within_30_min`, `share_seen_in_arrival_minute`, and `door_to_doctor_median_min_by_triage`. People who left unseen are NOT in these figures; `lwbs_wait_median_min` is the median wait of those people.
- `er_arrivals`, `er_admission_share` (decide_admit over decide_admit + decide_home) and `er_death_share` (ER deaths over arrivals) count only people who ARRIVED during the run (and, for `after_warm_up`, after the warm-up). Minute-0 residents are not in them.
- `icu_access`: ICU-indicated people the ER admitted, `reached_icu`, `share`. People still waiting for the ICU at the end count as not placed; `icu_indicated_pending_at_end` says how many of them are still alive and in the house.
- `w4_admissions` (placed on W4), `w4_higher_care_transfers`.
- `limits`: "synthetic, not validated: staffing outside W4 is shown, not modelled; deaths are pre-drawn fates, so crowding does not change who dies".

## Known edges
- The 3 warm-up days are a suggestion; `all_days` is kept so an analysis can choose.
- People present at minute 0 (residents, W4's first patients) have no `arrive` event. They are left out of door-to-doctor and the ER shares, and a resident already boarding at minute 0 is not in the boarding hours.
- Boarding is right-censored: see `er_still_boarding_at_end`. ICU access counts a person not yet in the ICU as not placed.
- Medicine 3A (MED3A, floor 3) fills before Medicine 1A (unit id MED3B, floor 1; the id is kept from when both wards were on 3F) (placement order), so their occupancies differ because of the allocation, not because of demand. Read them together.
- Counts by event use the event's minute; pair figures (boarding, door-to-doctor, ICU access) use the first event of the pair.
- In hospital mode W4 occupancy under `typical` is about 61% for seed 101 and varies by seed (an earlier figure of 50% came from other seeds). W4 may show no `w4_higher_care` in 30 days (seed 101 shows none).
- Deaths are pre-drawn fates, so crowding does not change who dies.

## Not in this format
- W4 episodes (`w4_episode_start`, `w4_episode_full`) and an `episodeOf` accessor in `source.ts`: they need ward-code changes, left out.
- W4 deaths (design slice H8).
- Vitals, NEWS2 values and names. Phases inside a scenario (design item L4).

## Privacy rules
- No names, no free text: only ids, numbers and the sim's fixed words. A test scans every file for every name in the sim's name lists.
- Synthetic data only. The runner reads its four arguments, the scenario file and `TRIAL_SIM_COMMIT`, and writes only next to and inside `--out`.

## Comparing scenarios seed by seed
Same seeds under each scenario give paired runs: person n is the same person in every scenario.
```sh
for seed in $(seq 1 30); do
  for sc in doh-standard typical surge; do
    npm run hospital-trial -- --scenario scenarios/hospital/$sc.json --seed $seed --days 30 --out trials/$sc-$seed || exit 1
  done
done
```
Then read `after_warm_up` in each `trials/<scenario>-<seed>/summary.json` and subtract scenario from scenario for the same seed.
