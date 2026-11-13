# Hospital trial results format, version 4

Version 2 (slice A1, observation rounds) appends nine hourly columns after the 23 of version 1 and adds five keys to each `summary.json` `per_unit` block. Every version 1 column, event and summary key keeps its order and its value for the same seed and scenario (a test compares them with version 1's output).

Version 3 (slice A2, late recognition) appends five hourly columns (37 in all), adds three event kinds (`deteriorate`, `noticed`, `unnoticed`), a `recognition` block in `all_days` and `after_warm_up`, and new wording in `limits`. Unlike A1, A2 changes outcomes: deaths, ICU moves and everything downstream of them can differ from version 2 for the same seed. With A2's response switched off (a test-only setting) and its additions stripped, every version 1 and version 2 column, event and summary key is byte-identical to the older code's output (a test compares hashes recorded from origin/main).

Version 4 (slice A3, returning people) appends one hourly column (`returns`, 38 in all) and one event column (`visit`, 8 in all), adds three event kinds (`return_scheduled`, `return`, `return_dropped`), five summary keys, and new wording in `limits`. A person discharged alive from a ward may come back as the same person; see "Returning people (version 4)". Returns change outcomes (beds, deaths and everything after them), so version 4's results differ from version 3's for the same seed. With returns switched off (a test-only setting, which also restores the old lists: 80 surnames, 40 given names per sex) and A3's additions stripped (the `visit` column, A3's event kinds, the `returns` column, the five summary keys, `format_version`, `limits`), every version 3 column, event and summary key is byte-identical to origin/main 8616326's output (a test compares hashes recorded from that code).

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
`format_version` (4), `synthetic` (true), `seed`, `days`, `speed` (60), `scenario` (the parsed scenario), `scenario_sha256` (over the scenario file's raw bytes), `sim_commit`, `node_major`, `warm_up_days` (3), `hourly_rows`, `event_rows`.
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
| `nurses` | people | Nurses on shift, as the scenario sets them, the same on all three shifts. Modelled for observation rounds on the ER, MED3A, MED3B and SURG5A (see below); W4 has its own staff model. The counts outside W4 are our judgement (`params.ts`). |
| `patients_per_nurse` | people | Census over nurses, one decimal; blank when no nurses. |
| `er_waiting`, `er_consult`, `er_workup`, `er_boarding` | people | ER only: people in each stage now. |
| `er_boarding_hours` | person-hours | ER only: boarding time accrued this hour, two decimals. |
| `er_lwbs` | people | ER only: left without being seen this hour. |
| `door_to_doctor_median_min` | minutes | ER only: median of arrival to doctor for people first seen this hour; blank when nobody was seen that hour. |
| `icu_indicated_not_in_icu` | people | ICU-indicated people in a bed, on a stretcher, boarding or on W4. Blank on MORGUE. |
| `morgue` | bodies | MORGUE row only: every body in the house, in drawers or awaiting the morgue. |
| `obs_due` | rounds | Observation rounds that fell due this hour (a person's due minute was inside the hour while they were on the unit's rounds). |
| `obs_done` | rounds | Rounds done this hour. |
| `obs_late` | rounds | Rounds done this hour that were late (see "Late" below). |
| `obs_overdue_now` | people | People whose round is due and not yet done at the hour's last minute. |
| `obs_longest_overdue_min` | minutes | The longest of those waits now (last minute of the hour minus the due minute); 0 when nobody is overdue. |
| `care_min_demanded` | nurse-minutes | Nominal need at the hour's last minute: the sum over people on the unit's rounds of 60 x 5 (minutes a round) / their interval (60 watch, 240 routine). It does not follow the rounds done. |
| `care_min_available` | nurse-minutes | `nurses` x the share of nurse time on rounds (0.25) x 60: what the unit's nurses can give to rounds this hour. |
| `obs_longest_since_round_min` | minutes | The longest any person on the unit's rounds has gone without a round, at the hour's last minute: counted from their last round, or from joining the unit (ER: arrival; wards: placement) if that is later; 0 when the unit is empty. |
| `obs_rel_late_median` | intervals | Median relative lateness of the rounds done this hour: (minute done - minute due) / that person's interval (60 or 240), two decimals. 0 is on time, 1 is one whole interval late. Blank when no round was done. |
| `deteriorated` | people | Version 3: deteriorations that began on the unit this hour (see "Late recognition"). |
| `noticed` | people | Version 3: deteriorations a round noticed on the unit this hour. |
| `noticed_late` | people | Version 3: of those, noticed more than 60 min after onset. |
| `unnoticed_now` | people | Version 3: people on the unit's rounds at the hour's last minute whose deterioration has begun and nobody has noticed. |
| `recognition_delay_median_min` | minutes | Version 3: median of onset to notice over the notices this hour; blank when none. |
| `returns` | people | Version 4: ER only: returning people who arrived this hour (they are also in `arrivals`). Blank on every other unit. |

ER-only columns are blank on every other unit's row. The nine observation columns and the five recognition columns are blank on ICU, W4 and MORGUE rows.

#### Observation rounds (version 2)
- Who: the ER (everyone waiting, in consult, in work-up or boarding) and MED3A, MED3B, SURG5A (living people in a bed or on a corridor stretcher). The ICU and W4 are NOT in the workload model: they count as monitored (ICU bedside monitors; W4 has its own staff and NEWS2 model). The morgue has none.
- Time: each nurse gives a share of every minute (0.25, our judgement) to rounds; a unit saves at most one round per nurse. A round takes 5 min (Dall'Ora et al. 2021, England: 5 min 01 s per set; https://pmc.ncbi.nlm.nih.gov/articles/PMC8249906). These are workload values, not Philippine measurements.
- Order: the due person with the largest relative lateness (minutes overdue / own interval) goes first; ties go to "watch" (ICU-indicated and not in the ICU, or emergent in the ER) before "routine", then to the lower person number. When time is short every class runs late in proportion to its interval and nobody is left out. Rounds are never early; the next round falls due one interval after the round was done: 60 min for watch, 240 min for routine (NEWS2 Chart 4, RCP: "minimum 1 hourly" at 5 or more, "minimum 4-6 hourly" at 1-4; https://www.rcp.ac.uk/media/mrllczrj/news2-chart-4_clinical-response-to-news-trigger-thresholds_0.pdf). On arrival in a unit a round is due at once; people present at minute 0 have their first round spread by number over one interval.
- Late: a round is late when it is done MORE than the grace after it fell due: 120 min for routine (derived from NEWS2 Chart 4: due at 4 h, the 4-6 hourly band ends at 6 h) and 30 min for watch (our judgement; the chart asks review within 60 min at 5-6).
- Staffing numbers outside W4 are our judgement (the DOH 1:12 ward standard is cited, the counts it is applied to are ours); see the notes in `params.ts`. No Philippine observation-frequency standard or time per observation was found.
- In A1 late rounds changed no outcome; from version 3 they can (next section).
- A person who moves unit while overdue keeps an `obs_due` count on the unit they left with no round done there.
- `obs_rel_late_median_of_hours` (summary) is a median of hourly medians, not a median over all rounds.
- `obs_late_share` is a threshold count: it jumps from near 0 to near 1 when observation demand passes 1.5 times the nurse time available, and that time comes from one judgement value (`obs.shareOfNurseTime`, 0.25). It is a model output, not evidence of how often real rounds are late.
- Read `obs_rel_late_median` and `obs_longest_since_round_min` for how late; MED3A runs later than MED3B because of placement order, not demand.

#### Late recognition (version 3)
- Course: at the admit decision each admitted person gets a course from their own random stream (`person:<n>:course`, three draws), so no other draw moves; outcomes of others can still change through ICU beds and placement times; and who deteriorates and when relative to the decision is the same under every scenario. P(deteriorates) = 1 - exp(-rate x drawn ward stay in days); onset = decision minute + a uniform share of the drawn ward stay. Rates per patient-day (all judgement): medicine groups and stroke 0.010, cardiac 0.015, trauma 0.005, minor 0.002.
- Where: an onset on MED3A, MED3B, SURG5A or while boarding in the ER is recorded (`deteriorate`) and is unknown to the staff. In the ICU it is seen at once (`deteriorate` and `noticed` with delay 0). On W4, or after death, no course event: W4 has its own episodes.
- Notice: the first observation round at or after the onset (A1's rounds), or arrival in the ICU. `noticed` detail `delay N min`, N = notice minus onset. Late = N over 60 min (judgement, after Barwise et al. 2016's delay definition, read in a search excerpt only, and NEWS2's 60-min review).
- Response: the person joins the hourly "watch" class (the class flips before the next round's due time is set) and asks for an ICU bed: from a ward, a free ICU bed is taken before ER boarders are placed (event `transfer`, detail `<ward> to ICU after notice`); from ER boarding, the ICU is tried first, then the ward as before. Back on a ward after the ICU, they are routine again.
- Outcome: if not already fated to die, the person dies 6 h after the notice with probability 1 - exp(-0.02 x N in hours) (`died` detail ends `after late recognition`). It never overrides a pre-drawn death, and ICU care does not lower it. To keep deaths calibrated rather than added (orchestrator ruling), the pre-drawn stay-death probability of everyone admitted during the run is multiplied by 0.98, chosen from one measurement (2 excess deaths, seeds 101-103) so typical deaths stay within 5% of version 2's on those seeds; not shown in expectation. An escalated patient's excess death counts on the ICU.
- Leaving first: discharge, transfer out, a pre-drawn death or a move to W4 before anyone noticed gives `unnoticed` with detail `N min after onset`.

#### Returning people (version 4)
- Who: someone discharged alive from MED3A, MED3B, SURG5A or W4 (the ER's sent-home people and the dead never return). Each discharge draws from that person's own stream for that visit (`person:<n>:v<visit>:return`, three draws: whether, which day, which minute), so whether and when a person returns never moves anyone else's draws, and the same person and visit give the same fate under every scenario (whether the discharge happens is scenario-dependent).
- Rate: `returns.readmit30`, 0.18 for every group: one unverified number (PGH General Medicine 2019, 602 of 4,010, read in a search excerpt only) applied to all conditions by ruling. The return comes 1 to 30 days after the discharge day, at a drawn minute of that day (`return_scheduled`, detail `in N d`).
- Inside `arrivalsPerDay`: a return waits in `Hospital.returning` (at most 300, `returns.cap`; one past it is recorded as `return_dropped` and never comes back) until the next arrival slot after its time, and takes that slot's place: there are as many arrivals as before, a share of them are returners. Slot numbers are used up either way, so every new person keeps the number they would have had without returns. A return can wait up to an hour or more for a slot when arrivals are sparse, and one scheduled near the end of a run falls outside it: only about half of the scheduled returns arrive inside a 30-day run.
- Same person: id (`h-000123`, the `person` column), name, sex, age and group are kept (also for W4's first 12 patients, whose name, age and sex come from the W4 source), and so is the look (three small integers on `Person.look`: skin 0-3, hair 0-4, shirt 0-5; hair is grey or white from age 60). Triage, complaint wording, admit decision, stay, fates and course are drawn again for the visit from `person:<n>:v<visit>`. The person's earlier visit leaves the `gone` list when they return, so there is one record per person. Age is not advanced (a return is within 30 days). Returners keep their condition group, which was an admitted one, so a returner is somewhat more likely to be admitted than the newcomer they replace (about 0.41 against 0.28); at about 2% of arrivals this adds under 1% to admissions.
- The new visit logs `arrive` and `triage` as for anyone, then `return` (detail `visit N`). `person` plus `visit` is the key for one stay; `person` alone follows one person across visits. Stay-level summary figures (door to doctor, boarding, ICU access, recognition) key on person and visit.
- Person state gains `visit` and `history` (the last 5 earlier visits: `visit`, `arrivedMin`, `leftMin`, `lastUnit`, `outcome`, always `discharged`).
- Limits: one rate for everyone; real readmission varies by condition, age and the quality of the discharge, and many readmissions are to another hospital. No scheduled (elective) readmissions, no deaths after discharge, no returns to another hospital, no change of group between visits.

### `events.csv`
Ground truth, one row per event, in non-decreasing minute order: `minute,person,w4_id,unit,kind,detail,news2_independent,visit`. `visit` (version 4) is 1 for a new person and 2 and up for a return.
- `minute`: sim minute. `person`: the person's number (the digits of `h-000123`). Residents at minute 0 are numbered from 1000001, W4's first patients from 2000001. `w4_id`: the ward's patient id while the person is on W4, else blank.
- `unit`: where the event happened. `kind`: `arrive, triage, consult, decide_home, decide_admit, board, place, transfer, discharge, lwbs, transfer_out, died, to_morgue, released, turned_away, w4_higher_care`, and from version 3 `deteriorate, noticed, unnoticed` (all `news2_independent` = `yes`: no NEWS2 is computed outside W4; the page's vitals engine is display only and is not in these files), and from version 4 `return_scheduled` (at a ward discharge, on the discharging unit; `no` after a W4 discharge, whose time NEWS2 decides), `return` (the returning person's arrival, on the ER) and `return_dropped` (the waiting list was full).
- `detail`: only the sim's fixed words (group, complaint wording, unit id, triage level, hours as `boarded 5 h`). Where the sim's wording holds a comma, it is written as `;`.
- `news2_independent`: `yes` when the event does not depend on NEWS2, `no` when W4's NEWS2 decided it (W4 discharge, W4 higher care and the ICU move). Use only `yes` rows as ground truth for evaluating NEWS2 or models built on it.
- `transfer` rows include a move from a stretcher to a bed inside one unit (detail `stretcher to bed`), which is not a move between units.
- `w4_higher_care` is the sim's W4-to-ICU move (written by the sim as a `transfer` with detail `W4 to ICU`, or a `board` with `W4 higher care, no ICU bed`). The trial renames the kind. These rows always carry `news2_independent` = `no`; the trial fails if one does not. A higher-care row that is a `board` is renamed too, so it is not in the boarding-hours figures.
- `turned_away` is not in the design list: an arrival the house could not hold (people cap).

### `summary.json`
`format_version`, `synthetic`, `seed`, `days`, `warm_up_days`, `scenario`, `limits`, and two blocks with the same keys: `all_days` (the whole run) and `after_warm_up` (excluding the first 3 days; every figure is null or 0 when the run is 3 days or less).
- `per_unit.<id>`: `occupancy_mean_pct`, `occupancy_max_pct` (over the hourly rows), `admissions` (admitted_in summed), `deaths`. The ER has no `admissions`: its people arrive, see `er_arrivals`.
- Version 2 adds to `per_unit.<id>`: `obs_late_share` (sum of `obs_late` over sum of `obs_done`, four decimals), `obs_longest_overdue_max_min` (the largest `obs_longest_overdue_min`, minutes), `care_demand_over_available` (sum of `care_min_demanded` over sum of `care_min_available`, four decimals), `obs_longest_since_round_max_min` (the largest `obs_longest_since_round_min`, minutes), `obs_rel_late_median_of_hours` (median of the hourly `obs_rel_late_median` values, two decimals; null when none). All five are null on ICU, W4 and MORGUE, and a share is null when its denominator is 0 (no rounds done, or no nurses). `obs_late_share` counts watch and routine rounds together.
- `admissions`: people the ER placed in any unit. `deaths`: `died` events in all units. `left_without_being_seen` and `transfers_out` (ER to another hospital) count events by their minute.
- Boarding: `er_boarding_hours_median`, `er_boarding_hours_p90` (nearest rank) are over completed boardings only: from the `board` event to the next `place`, `transfer_out` or `died`, counted by when boarding began. People still boarding at the end are in `er_still_boarding_at_end` (`count`, `median_hours_so_far`). Under heavy crowding (surge) the completed-only figure is biased down.
- Door to doctor (arrival to `consult`, in minutes, counted by arrival): `door_to_doctor_median_min`, `door_to_doctor_p90_min`, `share_seen_within_30_min`, `share_seen_in_arrival_minute`, and `door_to_doctor_median_min_by_triage`. People who left unseen are NOT in these figures; `lwbs_wait_median_min` is the median wait of those people.
- `er_arrivals`, `er_admission_share` (decide_admit over decide_admit + decide_home) and `er_death_share` (ER deaths over arrivals) count only people who ARRIVED during the run (and, for `after_warm_up`, after the warm-up). Minute-0 residents are not in them.
- `icu_access`: ICU-indicated people the ER admitted, `reached_icu`, `share`. People still waiting for the ICU at the end count as not placed; `icu_indicated_pending_at_end` says how many of them are still alive and in the house.
- `w4_admissions` (placed on W4), `w4_higher_care_transfers`.
- Version 3 adds `recognition`, counted by the event's minute:
  - `per_unit.<id>` for ER, MED3A, MED3B, SURG5A and ICU: `deteriorated` (onsets), `count` (notices), `delay_median_min`, `delay_p90_min` (nearest rank), `late_share` (notices over 60 min, over notices, four decimals), `unnoticed` (left before a notice), `escalated_to_icu` (noticed here, later placed or moved to the ICU; null on the ICU), `patients_per_nurse_mean` (over the hourly rows), `excess_deaths` (deaths after late recognition, by the unit of death).
  - `excess_deaths_total`, `excess_deaths_share_of_deaths` (over all `died`), `excess_deaths_label` ("model output under a judgement relation, not evidence").
  - `w4`: `episodes` (W4 patients whose scheduled deterioration starts in the window, read from W4's source without changing it), `alerted` (of those, the ones whose NEWS2 total reached 5 or more on W4), `alert_lead_median_min`, `alert_lead_p90_min` (that minute minus the episode start). Not the same measure as the wards' delay: W4's includes the time vitals take to change, the wards' counts only the wait for a round. Show them side by side; never subtract them.
- Version 4 adds: `returns` (`return` events), `return_scheduled`, `return_dropped`, `return_share_of_discharges` (`return_scheduled` over ward discharges, i.e. `discharge` events outside the ER; four decimals) and `return_share_of_arrivals` (`return` over `arrive` events). A returning person is an arrival: `er_arrivals` and `arrive` count them.
- `limits`: "synthetic, not validated: staffing outside W4 drives observation rounds, and observation workload uses judgement values (share of nurse time); see params. deaths after late recognition come from one judgement number (obs.excessDeathPerHour); all other deaths are pre-drawn, scaled by one judgement number (course.stayDeathScale) so typical deaths stay at their level before slice A2. Who deteriorates and how often (course.ratePerDay) and the delay to death (course.deathAfterNoticedH) are judgement too: `recognition` is a model output, not evidence about real wards. `obs_late_share` is a threshold count: it jumps from near 0 to near 1 when observation demand passes 1.5 times the nurse time available, and that time comes from one judgement value (`obs.shareOfNurseTime`, 0.25). It is a model output, not evidence of how often real rounds are late. Read `obs_rel_late_median` and `obs_longest_since_round_min` for how late; MED3A runs later than MED3B because of placement order, not demand. Returning people: one return rate (returns.readmit30, 0.18 within 30 days) applies to every group, and only its medicine figure has a source (one hospital, search excerpt only); real readmission varies by condition. A return takes the place of a new arrival, so the count of arrivals per day does not change; that newcomer never comes, and which newcomers are skipped depends on the scenario."

## Known edges
- `obs_late_share` is a threshold count: it jumps from near 0 to near 1 when observation demand passes 1.5 times the nurse time available, and that time comes from one judgement value (`obs.shareOfNurseTime`, 0.25). It is a model output, not evidence of how often real rounds are late.
- Read `obs_rel_late_median` and `obs_longest_since_round_min` for how late; MED3A runs later than MED3B because of placement order, not demand.
- The 3 warm-up days are a suggestion; `all_days` is kept so an analysis can choose.
- People present at minute 0 (residents, W4's first patients) have no `arrive` event. They are left out of door-to-doctor and the ER shares, and a resident already boarding at minute 0 is not in the boarding hours.
- Boarding is right-censored: see `er_still_boarding_at_end`. ICU access counts a person not yet in the ICU as not placed.
- Medicine 3A (MED3A, floor 3) fills before Medicine 1A (unit id MED3B, floor 1; the id is kept from when both wards were on 3F) (placement order), so their occupancies differ because of the allocation, not because of demand. Read them together.
- Counts by event use the event's minute; pair figures (boarding, door-to-doctor, ICU access) use the first event of the pair.
- In hospital mode W4 occupancy under `typical` is about 61% for seed 101 and varies by seed (an earlier figure of 50% came from other seeds). W4 may show no `w4_higher_care` in 30 days (seed 101 shows none).
- Deaths are pre-drawn fates except deaths after late recognition (version 3).
- Known limits of the A1 calibration (seeds 101-103, 30 days, after warm-up, W4 always full): two of the design's windows miss and were not tuned. Medicine late share is 33.0% under `doh-standard` (design: at most 5%) and 97.5% under `typical` (design: 25-75%). Watch rounds are hourly with a 30 min grace and run late as soon as time is short, and the ICU-indicated people a full ICU leaves on the medicine wards add demand the design's routine-only arithmetic did not count. The windows that hold: `typical` SURG5A 89.4% late (at least 80%) and `typical` ER care demand over available 1.85 (above 1; nominal need). Nobody went more than 15 h without a round under `doh-standard` or `typical` (longest 886 min).

## Limits of late recognition (version 3)
Reading guide: Under these judgement numbers late recognition decides about 1 to 5 of roughly 280 deaths in 30 days, and the gap between scenarios is within seed noise. This does not show that staffing changes mortality: the direction is built in by the assumed relation.

This is a model with judgement numbers, not evidence about real wards. No Philippine ward deterioration rate, time from late escalation to death, or study of how a recognition delay causes death was found. Every number that turns a delay into a death is ours (`params.ts`, tagged judgement): the deterioration rates, `obs.excessDeathPerHour` (0.02, anchored only on an association: Barwise et al. 2016, 15% vs 8% hospital mortality for delayed rapid-response calls, adjusted OR 1.6), `course.deathAfterNoticedH` (6) and `course.stayDeathScale` (0.98, chosen from one measurement (2 excess deaths, seeds 101-103) so typical deaths stay within 5% of version 2's on those seeds; not shown in expectation). Deaths after late recognition, seeds 101-103, 30 days, doh-standard / typical / surge: about 1, 2 and 4 in the hospital-only harness (W4 always full, hospital.test.ts calibration), and 1, 1 and 5 in the trial runner with the real W4. Escalated patients take ICU beds, which changes ICU access and boarding for others; part of any death difference comes from that, not from the delay. ICU care does not lower a death caused by the delay. People present at minute 0 carry no course.
- Escalated ward patients are placed in the ICU before ER boarders, including boarders who are ICU-indicated, so `icu_access` can fall for that reason.
- An ICU move restarts the full ward stay afterwards, so escalation adds bed-days.
- When the ICU is full the person waits on the hourly watch class and may be discharged on schedule, which cancels a pending excess death.
- An escalated patient's excess death counts on the ICU.

## Not in this format
- W4 episode events (`w4_episode_start`, `w4_episode_full`) and an `episodeOf` accessor in `source.ts`: they need ward-code changes, left out. Version 3's `recognition.w4` reads each W4 patient's scheduled episode start through the source's existing `save` (read-only, no draw) and W4's own NEWS2, with no change to W4's code.
- W4 deaths (design slice H8).
- Vitals, NEWS2 values and names (a person's look and name are on the person record, not in these files). Phases inside a scenario (design item L4).

## Privacy rules
- No names, no free text: only ids, numbers and the sim's fixed words. A test scans every file for every name in the sim's name lists (392 surnames, 149 female and 145 male given names, 26 initials; no duplicates; the surnames of national office holders' families and a few famous people are left out; a list of real full names is blocked as pairs, the generator takes the next given name, and a test enumerates the pools to show none can be produced). The names and the look live on the person record only.
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
