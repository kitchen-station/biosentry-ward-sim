# Compare: the same patients, one change

In a real ward the same night cannot be run twice. Here it can. `npm run compare` runs two arms with the same seed and the same number of days. The arms differ in exactly one named thing. It writes what differs.

Everything is synthetic. Nothing here is evidence about a real ward or a real hospital.

## Run it

```bash
npm run compare -- --seed 4 --days 30 --baseline rule=news2_total_ge_5 --change rule=news2_chart_trigger --out trials/compare-w4
```

```bash
npm run compare -- --seed 101 --days 7 --baseline scenarios/hospital/typical.json --change staffing=scenarios/hospital/doh-standard.json --out trials/compare-staffing
```

- `--seed`: a whole number from 0 to 2147483647. `--days`: 1 to 60.
- `--out`: a folder that does not exist yet. Its parent must exist. `trials/` is ignored by git.
- Each flag is given once. `--change` given twice is refused: one run changes one thing.
- The folder gets two files: `compare.json` (every number) and `compare.txt` (the same numbers as a table, with lists and fixed wording under it).
- The files hold no clock, no path and no file name. The same command on the same Node major version writes the same bytes.
- Exit 0 on success. Exit 2 with one line on stderr for a refusal; nothing is written then.

One more flag works with rule arms only:

```bash
npm run compare -- --seed 1 --seeds 20 --days 30 --baseline rule=news2_total_ge_5 --change rule=news2_chart_trigger --out trials/compare-seeds
```

- `--seeds K`: run K seeds, from `--seed` upward. K is 2 to 50. The report pools them and gives the spread across seeds. Each seed is run twice for the pairing check, so 20 seeds of 30 days take about 15 to 25 minutes.

There are two modes. The baseline picks the mode.

| Mode | `--baseline` | `--change` |
|---|---|---|
| Ward W4 | `rule=NAME` | `rule=NAME` |
| Hospital | a hospital scenario file | `GROUP=FILE` |

## Ward W4: two warning rules on the same vitals

Rules:

- `news2_total_ge_K`: the NEWS2 total is K or more. K is 1 to 20. `news2_total_ge_5` is the line at which this ward's nurse calls the physician (demo design: see the README, "What is demo design, not product").
- `news2_chart_trigger`: the NEWS2 total is 5 or more, or any single parameter scores 3. This is the chart's own trigger.

The NEWS2 bands are the simulator's own (`src/sim/news2.ts`). Compare does not change them.

### What is paired

The ward is run once with the seed, through the same code as the trial runner (`docs/trial-format.md`). Both rules then read that one run. So both arms have the same patients, the same arrival minutes, the same vitals and the same true episodes. The run is done a second time and the SHA-256 of `cohort.csv` and of `episodes.csv` must match, or the command refuses. The report prints both hashes.

This works because of a deliberate limit of the ward: a staff review does not change a patient's vitals, and the rule under test is never fed back into the run. So a rule can change only when alerts fire and how many there are. **Nothing in the run responds to a warning, and the report gives no outcome figure.** It says what an earlier warning changes in timing and in alarm counts. It does not say that any patient did better. "Why compare shows no outcome", under Limits, gives the reasons.

### What each number means

The simulator knows the exact minute a patient started to get worse. It is `episode_start` in `episodes.csv`. The worsening grows over `ramp_minutes` and is fully in at `episode_start + ramp_minutes`. It then stays until the patient leaves.

The ward is read every 15 minutes (one bin).

| Number | Meaning |
|---|---|
| `alerts` | Alerts that fired. An alert fires in a bin where the rule is true and the patient is armed. After it fires, the patient is armed again only after 16 bins in a row (4 hours) where the rule is not true. So one long bad spell is one alert, not one alert per bin. |
| `alerts_per_patient` | `alerts` divided by the number of stays. |
| `alerts_per_patient_per_12h_shift` | `alerts` divided by (patient days x 2). This is the alarm load a nurse sees per patient per shift. |
| `episodes_evaluated` | True episodes that count: the patient was admitted during the run, and the episode started inside the stay and before the run ended. |
| `episodes_with_new_alert` and its share | Evaluated episodes where an alert fired inside the episode window. The window runs from `episode_start` to 120 minutes after the episode is fully in, both ends included. |
| `episodes_alerting_any_bin` and its share | Evaluated episodes where the rule was true in at least one bin of the window, whether or not a new alert fired there. |
| `alerts_outside_episode_windows` | Alerts that fired outside the patient's own episode window. See the limits: this is not the same as "false alarm". |
| `lead_minutes` | One value per episode with a new alert: the fully-in minute minus the minute of the first new alert in the window. Positive means the alert came before the episode was fully in. Negative means it came after. |
| `lead_median_minutes` | The median of `lead_minutes`. Empty when there is none. |
| `delay_minutes`, `delay_median_minutes` | One value per episode with a new alert: the minute of the first new alert in the window minus `episode_start`. This is when the rule first flags the episode, not when anyone acts. An episode with no new alert has no delay; it is counted in `episodes_no_new_alert` and never filled in. |
| `episodes_no_new_alert` | Evaluated episodes with no new alert in the window. |
| `bins`, `bins_alerting` | Rows scored, and rows where the rule was true. |
| `paired_episodes` | The same episode under both rules. For each episode with a new alert under BOTH rules: the change rule's alert minute minus the baseline rule's. It gives how many, how often the change rule was earlier, in the same bin or later, and the min, median, max, mean and sd in minutes. Negative means the change rule warned earlier. This is the paired figure. The lead and delay medians of an arm are over that arm's own alerted episodes, which can differ between arms. |

`difference` is always the change arm minus the baseline arm.

The 16-bin re-arm and the 120-minute window are judgement values. They are taken from the BioSentry-Intelligence `research/` package so both repositories count the same way. They are not clinical figures.

### Worked example

Real output of the first command above (`compare.txt`):

```
compare w4: seed 4, 30 days
baseline: news2_total_ge_5
change: rule news2_chart_trigger
  rule: news2_total_ge_5 -> news2_chart_trigger
pairing: one cohort for both arms
  one run serves both arms (the rule is applied after it), so the people, arrivals and true episodes are the same; a second run of the same seed gave the same cohort.csv sha256 74ae53f3454e7c16e8a306938daec2ce5d62bb8cf9e72fca8841522ceb634709 and episodes.csv sha256 61aae916a9271aae36343d66e86e183adc37462773a95c7d1e33b4f4f01a2103

metric                                baseline        change    difference
alerts                                     363           416            53
alerts_per_patient                      3.9457        4.5217         0.576
alerts_per_patient_per_12h_shift        0.4193        0.4805        0.0612
episodes_evaluated                           6             6             0
episodes_with_new_alert                      4             3            -1
episodes_with_new_alert_share           0.6667           0.5       -0.1667
episodes_alerting_any_bin                    5             5             0
episodes_alerting_any_bin_share         0.8333        0.8333             0
alerts_outside_episode_windows             359           413            54
lead_median_minutes                    35.3487       -1.9969      -37.3456
delay_median_minutes                  144.3573      136.7176       -7.6397
episodes_no_new_alert                        2             3             1
bins                                     41538         41538             0
bins_alerting                             5326          7274          1948
lead_minutes baseline: -76.9969 -16.3637 87.061 148.2824
lead_minutes change: -16.3637 -1.9969 163.2824
delay_minutes baseline: 32.939 136.9969 151.7176 376.3637
delay_minutes change: 61.9969 136.7176 376.3637

same episode under both rules: first new alert of the change rule minus the baseline rule's, in minutes (negative: the change rule warned earlier)
episodes_with_new_alert_under_both             3
change_earlier                               2
same_bin                                     1
change_later                                 0
min                                        -75
median                                     -15
max                                          0
mean                                       -30
sd                                     39.6863

note: the outcome of a warning is not modelled on W4: a staff review does not change vitals and the rule is never fed back into the run, so a rule changes only alerts and their timing
note: starting patients (admit minute 0) are in the alert burden; their episodes are not evaluated; p-001 has a scripted worsening that is not an episode
note: lead = fully-in minute minus the first new alert in the window; positive means the alert came before the episode was fully in
note: alerts re-arm after 16 bins (4 h) not alerting; window = episode_start to fully in + 120 min (both are judgement values taken from BioSentry-Intelligence research/)
note: alert delay = first new alert in the window minus episode start (when the rule first flags, not when anyone acts); an episode with no new alert has no delay and is counted, not filled in
note: the paired figure is the same episode under both rules, pooled over the seeds of this report (each episode counted once; its sd treats episodes as independent); episodes with a new alert under one rule only are left out (see episodes_with_new_alert); the lead and delay medians of an arm, and their difference column, are over that arm's own alerted episodes, which can differ between arms; alert minutes are 15-minute bins, so each paired difference is a multiple of 15 min
note: a rule that alerts more can show fewer new alerts in a window: an alert before the window keeps the patient un-armed until 16 quiet bins pass
note: no outcome is given: the hospital model's late-recognition death rule (obs.excessDeathPerHour, a judgement value) is for unmonitored wards; W4 is monitored, and no one dies on W4
synthetic, not validated
```

How to read it:

- The chart trigger is the wider rule. It was true in 7274 bins against 5326, and it fired 53 more alerts over the 30 days.
- It did not see more episodes. Both rules were true at some point inside 5 of the 6 episode windows.
- It fired a *new* alert inside fewer windows (3 against 4). The reason is the re-arm rule: with the wider rule a patient is more often already alerting before the episode starts, so nothing new fires when the episode begins.
- A rule that alerts more can show fewer new alerts in a window: an alert before the window keeps the patient un-armed until 16 quiet bins pass. So read `paired_episodes`: of the 3 episodes with a new alert under both rules, the chart trigger was earlier in 2 and in the same bin in 1.
- Six episodes is a small number. One seed and 30 days show how the comparison works. They do not rank the two rules. Use `--seeds` before saying which rule is earlier.

## Many seeds (`--seeds K`)

One seed is one simulated month of one ward. `--seeds K` runs K of them and reports four things.

- **Pooled arms** (`pooled.*`): counts added over all seeds; shares and the alert load computed from those sums; lead and delay medians over every episode of every seed (not the median of the seeds' medians).
- **Per-seed arms** (`seed_N.*`): a short list of figures for each seed, so a reader can see how much the seeds disagree.
- **Spread** (`spread`): for four figures, the per-seed difference (change minus baseline) summarised as min, median, max, mean and sample sd. A seed where either arm has no value is left out; `seeds_with_value` says how many are in. With fewer than 2 seeds in, nothing but the count is printed. A difference whose min and max have opposite signs is not a finding. One whose signs agree is still only what this model does.
- **Paired episodes** (`paired_episodes`): as above, pooled over all seeds. Each episode counts once; the sd treats episodes as independent.

Every seed has its own pairing check, and the report prints each seed's hashes. If any seed fails it, the whole run is refused.

### Worked example

Real output of the third command above (20 seeds, 30 days). The header and the first two seeds' pairing lines:

```
compare w4: seeds 1 to 20 (20 seeds), 30 days
baseline: news2_total_ge_5
change: rule news2_chart_trigger
  rule: news2_total_ge_5 -> news2_chart_trigger
pairing: one cohort for both arms, for each of 20 seeds
  one run per seed serves both arms (the rule is applied after it), so the people, arrivals and true episodes are the same in both arms of a seed; a second run of each seed gave the same cohort.csv and episodes.csv
  seed 1: cohort.csv sha256 ab77e0e307841e6c724ecd703823790bdca80bf3bef0168c16d221e67fe4ba15, episodes.csv sha256 0c9e87d1c88942643ffcd57a8ed22c5ba1d3d5526eac2d151287d8a12eebc177, equal on a second run
  seed 2: cohort.csv sha256 f7d4cff79d9b12c6877e07bd9c4f872c401aff3e01a11d51e249a53f195df188, episodes.csv sha256 eb3f135887b0a10c23079c6442675788882622176c105435e0a8883554ed1ebd, equal on a second run
```

The pooled rows of the table (the 140 per-seed rows are left out here):

```
metric                                        baseline        change    difference
pooled.alerts                                     5334          6307           973
pooled.alerts_per_patient_per_12h_shift         0.3483        0.4119        0.0636
pooled.episodes_evaluated                          100           100             0
pooled.episodes_with_new_alert                      47            47             0
pooled.episodes_with_new_alert_share              0.47          0.47             0
pooled.episodes_no_new_alert                        53            53             0
pooled.episodes_alerting_any_bin                    65            72             7
pooled.alerts_outside_episode_windows             5281          6253           972
pooled.lead_median_minutes                     56.5176       56.5176             0
pooled.delay_median_minutes                   186.0759      141.0759           -45
pooled.bins                                     734772        734772             0
pooled.bins_alerting                             86955        115012         28057
```

The spread and the paired block:

```
spread of the per-seed difference (change minus baseline)
metric                                    seeds_with_value               min            median               max              mean                sd
lead_median_minutes                                     17         -229.4489                 0          200.9882           13.3762           84.6536
delay_median_minutes                                    17         -354.3618                 0          197.8962          -13.4808          118.7815
alerts_per_patient_per_12h_shift                        20              0.01            0.0646            0.1075            0.0629            0.0277
episodes_with_new_alert_share                           20              -0.5                 0               0.4           -0.0094            0.2172

same episode under both rules: first new alert of the change rule minus the baseline rule's, in minutes (negative: the change rule warned earlier)
episodes_with_new_alert_under_both                  40
change_earlier                                       9
same_bin                                            31
change_later                                         0
min                                               -225
median                                               0
max                                                  0
mean                                           -16.125
sd                                             42.4791
```

How to read it:

- Over 20 simulated months there were 100 evaluated episodes. Each rule gave a new alert in 47 of them.
- The chart trigger fired 973 more alerts (0.41 against 0.35 per patient per 12-hour shift). That difference is positive in all 20 seeds.
- Of the 40 episodes with a new alert under both rules, the chart trigger was earlier in 9 and in the same 15-minute bin in 31. It was never later.
- The medians of lead and delay come from few episodes per seed, so only some seeds have a value. Read `seeds_with_value` before the min and max.
- All of this is the simulator's behaviour. It is not a measurement of either rule on patients.

## Hospital: one group of scenario settings

`--baseline` is a hospital scenario file (`docs/hospital-trial-format.md`). `--change` is `GROUP=FILE`: the change arm is the baseline with only that group's settings taken from the second file. Its other settings are ignored. This is why `typical` against `doh-standard` staffing is one change, although the two files also differ in arrivals and start occupancy.

| Group | Settings copied | Accepted |
|---|---|---|
| `staffing` | ER nurses, ER doctors day and night, nurses on every unit | yes |
| `nurses` | ER nurses, nurses on every unit | yes |
| `doctors` | ER doctors day and night | yes |
| `transferOutAfterH` | hours before a transfer out | yes |
| `beds` | ER bays, unit beds and stretchers | refused: it changes who is in the hospital at minute 0 |
| `startOccupancy` | starting occupancy | refused: same reason |
| `arrivals` | arrivals per day | refused: it changes the arrival minutes |

### What is paired, and what is not

Each person's draws come from a random stream named after that person, so a staffing change does not change who a person is or when they arrive. But staffing changes what happens next: who is seen first, when a bed is free, who is noticed late. So the two arms are **partly paired**. The report states exactly how far:

1. The arrival minutes must be the same in both arms. If not, the command refuses.
2. The people in the hospital at minute 0 must be the same. If not, it refuses.
3. The person at each arrival is compared. A returning patient takes the place of a new arrival, and whether a return happens depends on the scenario. If a person differs, the report says from which minute and how many, and `same_person_at_each_arrival` is false. It does not claim the same people.
4. A deterioration course starts a fixed time after the admit decision, drawn from the person's own stream. For every course seen in both arms whose admit decision is in the run, that time must be equal. If not, or if the admit decision is in one arm only, it refuses.
5. The report prints the minute of the first event that differs. Before that minute the two event logs are identical. After it, outcomes differ by design, and the cohorts are not identical.

Ward W4 inside the hospital uses its own fixed seed and is not paired once placements differ. The report says so.

### What each number means

Each arm shows the trial's own figures. Their definitions and limits are in `docs/hospital-trial-format.md`.

- `summary.all_days...` and `summary.after_warm_up...`: every figure of the trial's `summary.json`, leaf by leaf. `after_warm_up` leaves out the first 3 days. A run of 3 days or fewer shows null or 0 there.
- `hourly_means.UNIT.COLUMN`: the mean over all hours of one column of the trial's `hourly.csv`, for one unit. Blank cells are left out.
- `difference`: the change arm minus the baseline arm. `-` when either side has no value.

### Worked example

Real output of the second command above. The header and pairing block in full, then a few of the table rows:

```
compare hospital: seed 101, 7 days
baseline: typical
change: group staffing
  er.nurses: 2 -> 3
  er.doctorsDay: 2 -> 3
  units.ICU.nurses: 3 -> 4
  units.MED3A.nurses: 2 -> 3
  units.MED3B.nurses: 2 -> 3
  units.SURG5A.nurses: 1 -> 2
pairing: partly paired (same minute-0 residents, arrival minutes and person at each arrival; event logs differ from minute 38)
  the same person arrives at each of the 394 arrival minutes
  deterioration courses seen in both arms: 4 with an equal offset from the admit decision, 0 with no admit decision in the run (not checked); courses recorded in one arm only: 0 (where the person was at onset depends on the scenario)
  event logs identical before minute 38; the first differing event is at minute 38
  outcomes after minute 38 differ by design; cohorts are not identical after it
  W4 inside the hospital is not paired once placements differ (W4 uses its own fixed seed, drawn in placement order)

metric                                                                         baseline        change    difference
summary.after_warm_up.per_unit.MED3A.obs_late_share                               0.941             0        -0.941
summary.after_warm_up.per_unit.MED3A.care_demand_over_available                  1.6923        1.1345       -0.5578
summary.after_warm_up.admissions                                                     56            57             1
summary.after_warm_up.deaths                                                          6             6             0
summary.after_warm_up.door_to_doctor_p90_min                                         18             9            -9
summary.after_warm_up.recognition.per_unit.MED3A.delay_median_min                   102          85.5         -16.5
hourly_means.MED3A.nurses                                                             2             3             1
hourly_means.MED3A.patients_per_nurse                                           16.7649       11.2327       -5.5322
```

How to read it:

- The same person arrived at each of the 394 arrival minutes in both arms. That part is controlled. What happens after minute 38 is not paired.
- With one more nurse, ward MED3A went from about 17 patients per nurse to about 11, and the share of observation rounds done late fell from 0.94 to 0.
- `obs_late_share` is a threshold count. It jumps when demand passes a set multiple of the nurse time available, and that nurse time rests on one judgement value. Read it as "the model crossed its line", not as a measured effect.
- Deaths were 6 in both arms over these 4 counted days. That is far too few to say anything about deaths.
- The delay figure rests on 1 noticed course in one arm and 2 in the other.

## Limits

- **Synthetic.** The patients, the vitals, the staff and the hospital are generated. No number here was checked against a real ward.
- **W4 has no treatment effect.** An earlier alert does not make a simulated patient better. Compare measures warnings, not outcomes.
- **An alert delay is not a response time.** It is when a rule first flags an episode. Nobody in the run acts on it.
- **"Outside an episode window" is not "false alarm".** A simulated patient can score high for a reason that is not a generator episode: a sick baseline, atrial fibrillation, or the scripted worsening of starting patient `p-001`. Those alerts are counted as outside. The 12 starting patients count toward the alert load, and their episodes are not evaluated.
- **15-minute bins.** An alert minute is a bin minute, so a lead time is accurate only to within 15 minutes.
- **Blood pressure is a cuff reading.** It can be hours old, so a low-pressure episode shows only when a cuff is taken.
- **Few episodes.** About 6 in 100 admissions have an episode. A short run can have none; the shares are then empty, not zero.
- **One seed is one night.** Use several seeds before drawing any conclusion.
- **Hospital arms are partly paired.** The minute-0 residents and the arrival minutes are the same. The person at each arrival is checked and reported. Everything after the first differing event is not paired. A difference between arms is the model's response to the change, under the judgement values listed in the report's last note.
- **Hospital effects are assumptions.** How staffing drives late rounds, late notice and deaths comes from judgement values in `src/sim/hospital/params.ts`.
- **Same Node major version.** Byte-identical files are promised for the same Node major only, because the generator uses `Math.exp`, `log` and `cos`. `compare.json` records it as `node_major`. The header of `compare.txt` does not carry the Node version.

### Why compare shows no outcome

The pitch says "you never know what an earlier warning would have changed. Here we can find out." What can be found out here is how early and how often each rule warns, over many seeds, with the spread. The report stops there and gives no modelled deaths or transfers, for these reasons:

1. **The hospital model treats W4 as monitored.** Its late-recognition rule is for wards without monitors, where a deterioration is noticed at the next observation round. W4 is outside that rule.
2. **There is nothing on W4 for an outcome to attach to.** No one dies on W4: a stay ends as a discharge or a move to higher care. W4 episodes are changes in vital signs fitted from ICU records, not illnesses with a known risk.
3. **The hospital model's one number for this is a judgement.** `obs.excessDeathPerHour` in `src/sim/hospital/params.ts` is tagged judgement; its source was read as a search excerpt only.
4. **About half of the episodes get no new alert in their window.** A delay for them would have to be assumed.
5. **The README rules it out for the demo:** "The demo deliberately shows no recovery after review and no response-time figures. Either would imply an outcome benefit the product does not claim."

Any outcome figure built on these timings would be an assumption, not a result. If one is added later it must be labelled as such, be off by default, use many seeds, and show how the answer moves with the assumption.

## Refusals

Each is one line on stderr, exit 2, and nothing is written.

- A missing, unknown or repeated flag; `--change` given twice.
- A seed or a number of days out of range.
- A rule baseline with a group change, or a scenario baseline with a rule change.
- An unknown rule; the same rule in both arms.
- `--seeds` outside 2 to 50, with a hospital baseline, or running past the largest seed.
- An unknown group; a group that is not paired (`beds`, `startOccupancy`, `arrivals`); a group with the same values in both files.
- A scenario file that cannot be read or is refused by the scenario parser.
- An `--out` that exists, or whose parent is missing or not a folder.
- A broken pairing, found after the runs: two W4 runs of one seed that differ, a cohort row that does not re-score to its own NEWS2, arrival minutes or minute-0 residents that differ, a deterioration offset that differs, or an admit decision that is in one arm only.

## `compare.json`

```
{ "compare_format": 1, "synthetic": true, "mode": "w4" | "w4_seeds" | "hospital", "seed": int, "seeds": [int] (with --seeds only), "days": int, "node_major": int,
  "baseline": <rule name | the parsed baseline scenario>,
  "change": { "kind": "rule" | "group", "name": string, "fields": [{ "path", "baseline", "change" }] },
  "pairing": { "status": string, "same_person_at_each_arrival": bool, "lines": [string] },
  "arms": { "baseline": {...}, "change": {...} },
  "difference": {...},
  "spread": {...} (with --seeds only),
  "paired_episodes": {...} (W4 modes only),
  "notes": [string] }
```

`same_person_at_each_arrival` means only that: the same person at each arrival minute. It does not mean the two runs are the same. `status` and `lines` say how far the pairing goes.
