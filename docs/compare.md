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
- The folder gets two files: `compare.json` (every number) and `compare.txt` (the same numbers as tables, with lists and fixed wording under them).
- The files hold no clock, no path and no file name. The same command on the same Node major version writes the same bytes.
- Exit 0 on success. Exit 2 with one line on stderr for a refusal; nothing is written then.

Two more flags work with rule arms only:

```bash
npm run compare -- --seed 1 --seeds 20 --days 30 --baseline rule=news2_total_ge_5 --change rule=news2_chart_trigger --out trials/compare-seeds
```

- `--seeds K`: run K seeds, from `--seed` upward. K is 2 to 50. The report pools them and gives the spread across seeds. Each seed is run twice for the pairing check, so the run time grows with K and `--days`; 20 seeds of 30 days take many minutes.

```bash
npm run compare -- --seed 1 --seeds 20 --days 30 --baseline rule=news2_total_ge_5 --change rule=news2_chart_trigger --outcome-model --out trials/compare-outcome
```

- `--outcome-model`: add a modelled outcome, printed as a MODEL ASSUMPTION. It is off by default. It needs `--seeds` 20 or more, 20 or more of those seeds with an evaluated episode, and 30 or more evaluated episodes in all. Read "Outcome model" below before quoting any number from it.

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

This works because of a deliberate limit of the ward: a staff review does not change a patient's vitals, and the rule under test is never fed back into the run. So a rule can change only when alerts fire and how many there are. **Nothing in the run responds to a warning, and by default the report gives no outcome figure.** It says what an earlier warning changes in timing and in alarm counts. It does not say that any patient did better. "Why compare shows no outcome by default", under Limits, gives the reasons. `--outcome-model` adds a modelled figure as a labelled assumption; it still changes nothing in the run.

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
| `lead_minutes` (single-seed report only) | One value per episode with a new alert: the fully-in minute minus the minute of the first new alert in the window. Positive means the alert came before the episode was fully in. Negative means it came after. |
| `lead_median_minutes` | The median of `lead_minutes`. Empty when there is none. |
| `delay_minutes` (single-seed report only), `delay_median_minutes` | One value per episode with a new alert: the minute of the first new alert in the window minus `episode_start`. This is when the rule first flags the episode, not when anyone acts. An episode with no new alert has no delay; it is counted in `episodes_no_new_alert` and never filled in. |
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
- Six episodes is a small number. One seed and 30 days show how the comparison works. They do not rank the two rules. Use `--seeds` before saying which rule is earlier in this model.

## Many seeds (`--seeds K`)

One seed is one simulated run of one ward (30 days in the example below). `--seeds K` runs K of them and reports four things.

- **Pooled arms** (`pooled.*`): counts added over all seeds; the new-alert share and the alert load per 12-hour shift computed from those sums; lead and delay medians over every episode of every seed (not the median of the seeds' medians).
- **Per-seed arms** (`seed_N.*`): a short list of figures for each seed, so a reader can see how much the seeds disagree.
- **Spread** (`spread`): for four figures, the per-seed difference (change minus baseline) summarised as min, median, max, mean and sample sd. A seed where either arm has no value is left out; `seeds_with_value` says how many are in. With fewer than 2 seeds in, only the count has a value; the other columns are `-` (null in the JSON). A difference whose min and max have opposite signs is not a finding. One whose signs agree is still only what this model does.
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
- Of the 40 episodes with a new alert under both rules, the chart trigger was earlier in 9 and in the same 15-minute bin in 31. It was never later. The chart trigger is true wherever the total is 5 or more, so it can be later only when an earlier alert has left it un-armed; "never later" follows mostly from how the two rules are built.
- The medians of lead and delay come from few episodes per seed (0 to 5 with a new alert), and 3 of the 20 seeds have no value on one side or both. Read `seeds_with_value` before the min and max.
- All of this is the simulator's behaviour. It is not a measurement of either rule on patients.

## Outcome model (`--outcome-model`)

**Read this section before quoting any number from the outcome block. Every number in it is a MODEL ASSUMPTION, not evidence about patients.**

The simulator cannot find out what an earlier warning would have changed: nothing in it responds to a warning. What the flag does is this: it takes how much earlier a rule recognises an episode, applies one published association between delay and outcome, and shows how the answer moves when that association is switched off, halved or doubled.

Nothing in the run changes. Nobody dies on W4, no vital sign is altered and no recovery is drawn. The outcome is arithmetic on the report. Without the flag, every report is byte for byte what it was before the flag existed; a test pins that.

### How it is computed

1. **Recognition.** For each evaluated episode, each arm gets a recognition minute: the earliest of
   - the first 15-minute bin in the episode window where the rule is true (a new alert is not needed);
   - the next scheduled observation round;
   - the patient leaving, or the run ending.
2. **Rounds.** Rounds start at the patient's admission. After each round the next one is due after the interval NEWS2 prescribes for the score at that round:

   | Score at the round | Next round | Tag |
   |---|---|---|
   | 0 | 12 h | cited: NEWS2 Chart 4 (RCP 2017), "minimum 12 hourly" |
   | 1 to 4 | 4 h | cited: the same chart, "minimum 4-6 hourly"; 4 h taken |
   | 5 or more, or a 3 in one parameter | 1 h | cited: the same chart, "minimum 1 hourly" |
   | 7 or more | 15 min | judgement: "continuous monitoring" read as the next bin |
   | NOT RANKED, or no reading yet | 4 h | judgement |

   A round is taken to recognise the episode, whatever the score at that round shows. That is a perfect round, a judgement; it shortens delays in both arms.
3. **Delay.** Recognition minute minus `episode_start`, in hours.
4. **Relation.** The odds of a bad outcome are multiplied by 1.02 for each hour of delay:
   `risk(d) = 1 / (1 + exp(-(a + b*d)))`, `b = s * ln(1.02)`, `a = ln(0.274 / 0.726) - b * 6.3`, and `excess(d) = risk(d) - risk(0)`.
   The reported figure is the mean excess over episodes, times 100: modelled excess bad outcomes per 100 episodes.
5. **Sensitivity.** `s` is 0, 0.5, 1 and 2 for the rows zero, half, central and double. At zero the odds ratio is 1 and every figure is exactly 0.

### The one cited number, and what is judgement

- **Cited:** Whebell SF et al., *Critical Care* 2021;25:226, doi:10.1186/s13054-021-03650-1. In 632 ward patients admitted to critical care in one London trust, the time from a first sustained NEWS of 7 or more to critical care admission had an adjusted odds ratio of 1.02 (95% CI 1.0 to 1.04) for hospital mortality. Hospital mortality was 27.4%; the median time was 6.3 hours. The paper measures the time in hours; it does not print the words "per hour" beside the odds ratio.
- **The authors' own limits:** a small, single-centre, retrospective study; it "does not prove causality"; "the effect size is small".
- **Judgement, ours:** applying that odds ratio to the time from a true onset to recognition (the paper timed a high score to critical care arrival); anchoring the 27.4% at the 6.3-hour median and applying it to every W4 episode; treating a round as recognising the episode whatever the score shows; the 15-minute and NOT RANKED round intervals; the minimums of 20 seeds and 30 evaluated episodes.
- Every per-100 figure scales with the 27.4%. That is hospital mortality in patients sick enough for critical care. A lower-risk ward would give smaller figures. The sensitivity table varies only the odds ratio.
- The interval 1.0 to 1.04 runs from the zero row to just under the double row (1.0404) of the sensitivity table.

### Worked example

Real output of the fourth command above: the outcome block, in full.

```
MODEL ASSUMPTION, not evidence about patients
parameter: 1.02, the odds ratio the cited paper gives for score-to-door time measured in hours, applied here to each hour of recognition delay (that transfer is judgement) [cited: Whebell SF et al., Crit Care 2021;25:226, doi:10.1186/s13054-021-03650-1: adjusted odds ratio 1.02 (95% CI 1.0-1.04) for the time from a first sustained NEWS of 7 or more (not falling below 5 before admission) to critical care admission, which the paper measures in hours (it does not print the words "per hour"); secondary outcome hospital mortality (adjusted OR 1.02, 95% CI 1.0-1.04, p = 0.026; the primary outcome, critical care mortality, gave the same OR), 27.4% of 632 patients, median time 6.3 h]
under the assumption that each hour from the true start of an episode to its recognition multiplies the odds of a bad outcome by 1.02, and that an episode recognised after 6.3 h carries the cited cohort's 27.4% hospital mortality (that anchoring is judgement), which sets the size of every per-100 figure; the 1.02 is the association between the time from a high NEWS to critical care and hospital mortality in one London cohort, an association in other patients, not a measured effect of earlier recognition
recognition = the first 15-minute bin in the episode window where the rule is true, or the next scheduled NEWS2 round, whichever comes first (or the patient leaving, or the run ending); a round is taken to recognise the episode whatever the score at that round shows (a perfect round, judgement), which shortens delays in both arms; modelled excess = the modelled risk at the recognition delay minus the modelled risk at zero delay, per 100 episodes

MODEL ASSUMPTION, not evidence about patients: outcome model: pooled over all seeds
metric                                                              baseline        change    difference
episodes_evaluated                                                       100           100             0
recognised_by_rule                                                        42            51             9
recognised_by_rule_without_new_alert                                      15            23             8
recognised_by_round                                                       51            44            -7
unrecognised_at_leave_or_run_end                                           7             5            -2
recognition_delay_mean_hours                                          2.1979        1.9438       -0.2541
recognition_delay_median_hours                                        1.3112        1.0727       -0.2385
modelled_excess_bad_outcomes_per_100_episodes                         0.8352        0.7382        -0.097
alerts                                                                  5334          6307           973
bins_alerting                                                          86955        115012         28057

MODEL ASSUMPTION, not evidence about patients: outcome model: spread of the per-seed difference (change minus baseline)
metric                                                          seeds_with_value               min            median               max              mean                sd
modelled_excess_bad_outcomes_per_100_episodes                                 20           -0.4054           -0.0146                 0           -0.0742            0.1163
recognition_delay_mean_hours                                                  20           -1.0566           -0.0387                 0           -0.1947            0.3037

MODEL ASSUMPTION, not evidence about patients: outcome model: same episode under both rules, delay and modelled excess of the change rule minus the baseline rule's (negative: the change rule recognised earlier)
episodes_paired                                                          100
change_earlier                                                            20
same_minute                                                               80
change_later                                                               0
delay_difference_hours.min                                             -5.85
delay_difference_hours.median                                              0
delay_difference_hours.max                                                 0
delay_difference_hours.mean                                          -0.2542
delay_difference_hours.sd                                             0.8963
excess_difference_per_100.min                                        -2.2572
excess_difference_per_100.median                                           0
excess_difference_per_100.max                                              0
excess_difference_per_100.mean                                        -0.097
excess_difference_per_100.sd                                          0.3436

MODEL ASSUMPTION, not evidence about patients: sensitivity to the odds ratio per hour (modelled excess per 100 episodes)
assumption   odds_ratio_per_hour            baseline              change          difference
zero                           1                   0                   0                   0
half                        1.01              0.4253               0.376             -0.0493
central                     1.02              0.8352              0.7382              -0.097
double                    1.0404              1.6071              1.4196             -0.1875
note: in the hospital model W4 counts as monitored and is outside its late-recognition rule (a deterioration on W4 is one of W4's own episodes, with no notice event); this model instead assumes recognition at the next NEWS2 round when no rule bin comes first
note: no patient changes: nobody dies on W4, no vital sign is altered and no recovery is drawn; each figure is a computed expectation per episode, in this report only
note: recognition here needs only a bin where the rule is true, not a new alert, and costs nothing. These two rules are nested: the change rule is true in every bin the other is. So the change rule is never recognised later, its modelled excess is never higher, and the spread of the difference cannot cross zero: that is the construction, not a finding. The alerts and bins_alerting, change minus baseline, are 973 and 28057 (the change rule alerts more); this block does not weigh them
note: only modelled_excess_bad_outcomes_per_100_episodes is the modelled outcome; the recognition delays and the counts by rule, by round and at leaving are timing figures and do not depend on the odds ratio, and alerts and bins_alerting are the same counts as the main table
note: an episode the patient left, or the run ended, before recognition is scored at that shorter delay, which understates it
note: W4 episodes are vital-sign offsets fitted from ICU records (eICU), not illnesses with a known risk of a bad outcome
note: the odds ratio is an observational association in another population (sustained NEWS 7 or more, admitted to critical care, London 2017-2021), timed from a high score to critical care arrival, not from a true onset to recognition
note: recognised by a round: 51 of 100 episodes (baseline) and 44 of 100 (change); left or run ended first: 7 and 5
note: round frequency from NEWS2 Chart 4 (RCP 2017): 12 h at 0, 4 h at 1-4 (band start), 1 h at 5 or more or a 3 in one parameter; "continuous" at 7 or more is taken as the next 15-minute bin and NOT RANKED as 4 h (both judgement)
note: the 27.4% at 6.3 h is the cited cohort's own hospital mortality, in patients admitted to critical care; anchoring it at that median and applying it to every W4 episode are judgement, and every per-100 figure scales with it (about p(1 - p)), so a lower-risk ward would give smaller figures; the sensitivity table varies only the odds ratio
note: the cited 95% CI 1.0-1.04 runs from the zero row (1) to just under the double row (1.0404) of the sensitivity table; a difference whose spread crosses zero is not a finding, and at an odds ratio of 1 the difference is exactly zero
note: the minimums of 20 seeds (derived from the lead difference in 30-day runs) and 30 evaluated episodes are judgement; a seed with no evaluated episode has no value in the spread (see seeds_with_value)
```

How to read it:

- Under the assumption, the chart trigger recognises episodes about a quarter of an hour earlier on average (a mean delay of 1.94 hours against 2.20), and its modelled excess is 0.74 per 100 episodes against 0.84. The difference is about 0.1 per 100 episodes: one in a thousand.
- The same table shows the price: 973 more alerts and 28,057 more alerting bins. The block does not weigh one against the other.
- For these two rules the difference can only be zero or negative, and its spread cannot cross zero. The chart trigger is true wherever the other rule is, and being true costs nothing in this model. The block says so: that is the construction, not a finding. The same episode was recognised earlier in 20 of 100 and never later, for the same reason.
- About half of the episodes are recognised by an assumed round, not by either rule (51 and 44 of 100).
- At an odds ratio of 1 the difference is exactly 0. At 1.0404 it is about 0.19 per 100. The whole result is the assumption.

### Limits of the outcome model

The first design review of this feature advised against building it. Its reasons are kept here as limits:

1. "The hospital model itself says W4 is monitored and notices at once. Applying its round-delay death rule to W4 contradicts the model's own design, and that design says the two measures are never subtracted."
2. "W4 has no death, no outcome hook and no course. The only bridge is one judgement number (0.02/h, uncapped, whole delay) whose source was read as a search excerpt only. The README says the demo shows no outcome benefit."
3. "Half the episodes have no alert in the window, so a fallback would have to be invented. The effect (about 1 per 100 episodes) sits under a per-seed spread of 0 to 4 per 100 with sign flips. A judge would read a precise-looking number that the model cannot support."

(On the first point, a later reading of the hospital model found the wording loose: W4 counts as monitored and is outside the late-recognition rule; it has no notice event at all.)

**What the owner decided.** Build it anyway, off by default, for rule arms over 20 or more seeds, with every limit printed. Two things changed from the review: the uncited judgement number was replaced by a cited one (Whebell 2021, opened and read), and the fallback for an episode with no alert is the NEWS2 round frequency (RCP Chart 4), not an invented delay.

**Why it is still only an assumption.**

- The odds ratio is an observational association in very sick patients, timed from a high score to critical care arrival. It is not a measured effect of earlier recognition, and its authors say it does not prove causality.
- W4 episodes are vital-sign changes fitted from ICU records. They are not illnesses with a known risk.
- No one dies on W4 and nothing in the run changes. The figure is a computed expectation.
- The round fallback assumes perfect rounds, exactly on time, on a ward the hospital model treats as monitored.
- A wider rule can never look worse here, because alerts cost nothing in the model. Its cost is in the alert rows of the same table.
- This contradicts the README's line that the demo "shows no recovery after review and no response-time figures", in this one place, on purpose, by the owner's decision, behind a flag and a label. The live ward and every default report still show neither.
- Every figure is the simulator's. None is evidence about patients, about a real ward, or about BioSentry.

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
- **W4 has no treatment effect.** An earlier alert does not make a simulated patient better. Compare measures warnings. With `--outcome-model` it also prints a modelled outcome, which is an assumption applied to those timings; see "Limits of the outcome model".
- **An alert delay is not a response time.** It is when a rule first flags an episode. Nobody in the run acts on it.
- **"Outside an episode window" is not "false alarm".** A simulated patient can score high for a reason that is not a generator episode: a sick baseline, atrial fibrillation, or the scripted worsening of starting patient `p-001`. Those alerts are counted as outside. The 12 starting patients count toward the alert load, and their episodes are not evaluated.
- **15-minute bins.** An alert minute is a bin minute, so a lead time, a delay or a paired difference is accurate only to within 15 minutes.
- **Blood pressure is a cuff reading.** It can be hours old, so a low-pressure episode shows only when a cuff is taken.
- **Few episodes.** About 6 in 100 admissions have an episode. A short run can have none; the shares are then empty, not zero.
- **One seed is one run.** One seed shows how the comparison works. Use `--seeds` before reading anything into a difference, and even then it is only what this model does.
- **Hospital arms are partly paired.** The minute-0 residents and the arrival minutes are the same. The person at each arrival is checked and reported. Everything after the first differing event is not paired. A difference between arms is the model's response to the change, under the judgement values listed in the report's last note.
- **Hospital effects are assumptions.** How staffing drives late rounds, late notice and deaths comes from judgement values in `src/sim/hospital/params.ts`.
- **Same Node major version.** Byte-identical files are promised for the same Node major only, because the generator uses `Math.exp`, `log` and `cos`. `compare.json` records it as `node_major`. The header of `compare.txt` does not carry the Node version.

### Why compare shows no outcome by default

The project pitch (not in this repository) says "you never know what an earlier warning would have changed. Here we can find out." Compare can find out only part of that: how early and how often each rule warns, over many seeds, with the spread. The report stops there and gives no modelled deaths or transfers, for these reasons:

1. **The hospital model treats W4 as monitored.** Its late-recognition rule is for wards without monitors, where a deterioration is noticed at the next observation round. W4 is outside that rule.
2. **There is nothing on W4 for an outcome to attach to.** No one dies on W4: a stay ends as a discharge or a move to higher care. W4 episodes are changes in vital signs fitted from ICU records, not illnesses with a known risk. `src/sim/hospital/params.ts` holds two unused judgement values for a later W4 death slice (`w4FatalGivenEpisode`, `w4DeathAfterFullH`); nothing reads them yet.
3. **The hospital model's one number for this is a judgement.** `obs.excessDeathPerHour` in `src/sim/hospital/params.ts` is tagged judgement; its source was read as a search excerpt only.
4. **About half of the episodes get no new alert in their window.** A delay for them would have to be assumed.
5. **The README rules it out for the demo:** "The demo deliberately shows no recovery after review and no response-time figures. Either would imply an outcome benefit the product does not claim."

Any outcome figure built on these timings is an assumption, not a result. The outcome model above is built that way: it is labelled as such, off by default, needs many seeds, and shows how the answer moves with the assumption.

## Refusals

Each is one line on stderr, exit 2, and nothing is written.

- A missing, unknown or repeated flag; `--change` given twice.
- A seed or a number of days out of range.
- A rule baseline with a group change, or a scenario baseline with a rule change.
- An unknown rule; the same rule in both arms.
- `--seeds` outside 2 to 50, with a hospital baseline, or `--seed` plus `--seeds` running past 2147483647.
- `--outcome-model` with a hospital baseline, without `--seeds`, or with fewer than 20 seeds. After the runs: fewer than 20 seeds with an evaluated episode, fewer than 30 evaluated episodes, or two seeds that gave the same cohort.
- An unknown group; a group that is not paired (`beds`, `startOccupancy`, `arrivals`); a group with the same values in both files.
- A scenario file that cannot be read or is refused by the scenario parser.
- An `--out` that exists, or whose parent is missing or not a folder.
- A broken pairing, found after the runs: two W4 runs of one seed that differ, a cohort row that does not re-score to its own NEWS2, arrival minutes or minute-0 residents that differ, a deterioration offset that differs, or an admit decision that is in one arm only.

## `compare.json`

```
{ "compare_format": 1, "synthetic": true, "mode": "w4" | "w4_seeds" | "hospital", "seed": int (the first seed with --seeds), "seeds": [int] (with --seeds only), "days": int, "node_major": int,
  "baseline": <rule name | the parsed baseline scenario>,
  "change": { "kind": "rule" | "group", "name": string, "fields": [{ "path", "baseline", "change" }] },
  "pairing": { "status": string, "same_person_at_each_arrival": bool, "lines": [string] },
  "arms": { "baseline": {...}, "change": {...} },
  "difference": {...},
  "spread": {...} (with --seeds only),
  "paired_episodes": {...} (W4 modes only),
  "outcome_model": { "label", "parameter", "assumption", "recognition_rule", "arms", "difference", "spread", "paired_episodes", "sensitivity", "notes" } (with --outcome-model only),
  "notes": [string] }
```

Every outcome number lives inside `outcome_model`, whose first key is the label. No other key of the report holds one.

`same_person_at_each_arrival` means only that: the same person at each arrival minute. It does not mean the two runs are the same. `status` and `lines` say how far the pairing goes.
