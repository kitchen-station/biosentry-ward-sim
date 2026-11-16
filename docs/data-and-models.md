# Data and models: what BioSentry used, and how

This page records everything the BioSentry project did with data and models, for both repositories:

- `biosentry-ward-sim` (this repository): the synthetic ward and hospital simulator.
- [`BioSentry-Intelligence`](https://github.com/kitchen-station/BioSentry-Intelligence): the dashboard, the API and the research code.

Every statement names the file it comes from. Links to this repository are relative. Links to the Intelligence repository are full URLs to its `main` branch. "Team note, not committed" means a research note kept outside git; it is cited only where no committed file holds the fact. Where a note and the code disagreed, the code is reported and the disagreement is listed in [section 9](#9-where-notes-and-code-disagreed).

Simulator code was read at `origin/main` `b804a3d` (2026-11-16). Intelligence was read at `origin/main` `5903e58`. The first draft read `881fb13` and `427952c`. Since then the files that the fit, the realism checks and the generator depend on did not change, as `git diff` shows: `scripts/`, `src/sim/source.ts`, `fitted.json`, `calibration.json`, the three realism test files, `src/realism.ts`, `docs/realism.md`, `hospital/vitals.ts`, `hospital/params.ts` and `NOTICE.md`. Line numbers into those files are unchanged. Line numbers into the simulator `README.md` are from `881fb13` and may have moved a little.

## 1. What is real and what is synthetic

**Synthetic:** every patient, every vital sign, every ward and hospital event, every deterioration episode, and every trial the models were trained and scored on. No patient's values are in either repository.

**Real:** the summary statistics that shape the generator. They were computed from five open PhysioNet databases and written to two small files, [`src/sim/fitted.json`](../src/sim/fitted.json) and [`src/sim/calibration.json`](../src/sim/calibration.json). Published papers set a few more values. One open ICU dataset was also used once, in the Intelligence repository, to measure NEWS2 and one rule on real records. No model was trained on real data.

**None of it is ward data, and none is from the Philippines.** [`NOTICE.md`](../NOTICE.md): "These are mostly ICU, Holter and AF-referred recordings. None is ward data and none is from the Philippines."

**The rule on results.** The repositories say it in their own words:

- [`README.md`](../README.md) (line 288): "That checks realism only. It says nothing about how well BioSentry predicts, and no model result may be reported from this synthetic data."
- [`docs/realism.md`](realism.md): "Everything the simulator produces is synthetic. No patient's values are in this repository. The simulator is not validated."
- Intelligence [`README.md`](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/README.md): "**These are not clinical results:** the same simulator makes the data and judges the alerts." and "This repository makes no claim about clinical performance. The scores are a published rule applied to made-up patients."

The two repositories are not worded the same way. The simulator's README says no model result may be reported from synthetic data. The Intelligence repository does report model results on simulator trials, each labelled synthetic and not validated. This page repeats those numbers in [section 6](#6-models) with the same label. None of them is a claim about patients.

## 2. Datasets

### 2.1 All datasets, by status

"In use" means it sets a value on `main` today. Licences are as recorded in [`NOTICE.md`](../NOTICE.md), the dataset cards in Intelligence, or the team notes; they were not re-read on the publishers' pages for this document.

| Dataset and version | Publisher and link | What it holds | Licence and access | Status |
|---|---|---|---|---|
| eICU-CRD Demo 2.0.1 | Philips eICU programme and MIT LCP, on PhysioNet. [Link](https://physionet.org/content/eicu-crd-demo/2.0.1/) | US ICU stays, 2014 to 2015: 2,520 unit stays, 186 hospitals | ODbL v1.0. Open, no account | **In use** (simulator fit; test set for NEWS2 in Intelligence). Its replay of real stays was **removed** |
| BIDMC PPG and Respiration 1.0.0 | Pimentel et al., on PhysioNet. [Link](https://physionet.org/content/bidmc/1.0.0/) | Bedside-monitor recordings from ICU patients, with 1 Hz numerics | ODC-By v1.0. Open | **In use** |
| MIT-BIH Arrhythmia 1.0.0 | MIT and Beth Israel Hospital, on PhysioNet. [Link](https://physionet.org/content/mitdb/1.0.0/) | Annotated Holter ECG. Only beat labels are read | ODC-By v1.0. Open | **In use** (100-series records only) |
| MIT-BIH Atrial Fibrillation (AFDB) 1.0.0 | MIT and Beth Israel Hospital, on PhysioNet. [Link](https://physionet.org/content/afdb/1.0.0/) | Long ECG records with AF, rhythm and beat labels | ODC-By v1.0. Open | **In use** |
| Long Term AF (LTAFDB) 1.0.0 | Petrutiu et al., on PhysioNet. [Link](https://physionet.org/content/ltafdb/1.0.0/) | Day-long ECG records with AF | ODC-By v1.0. Open | **In use** |
| SHDB-AF 1.0.1 | PhysioNet | 24-hour Holter ECG with AF | ODC-By v1.0 | **Downloaded, not used.** Planned as a rhythm realism check |
| CPSC 2021 1.0.0 | PhysioNet | ECG recordings with paroxysmal AF | CC BY 4.0 | **Downloaded, not used** |
| eICU-CRD, full | PhysioNet. [Link](https://physionet.org/content/eicu-crd/) | Multi-hospital US ICU records | Credentialed | Approved, **never used** |
| MIMIC-IV | MIT LCP, on PhysioNet. [Link](https://physionet.org/content/mimiciv/) | ICU and hospital stays, one US centre | Credentialed | Approved, then **rejected** for the simulator. Never used |
| HiRID 1.1.1 | PhysioNet. [Link](https://physionet.org/content/hirid/1.1.1/) | High-resolution ICU vitals | Contributor-review licence | Approved, **never used** |
| PhysioNet/CinC Challenge 2011 1.0.0 | PhysioNet. [Link](https://physionet.org/content/challenge-2011/1.0.0/) | 12-lead ECGs with quality labels | ODC-By v1.0 | Approved for a signal-quality model. **Never used**; no such model exists |
| Biobeat patch set | Dryad. [Link](https://datadryad.org/dataset/doi:10.5061/dryad.69p8cz9dh) | 90 analysed post-surgery inpatients on a patch | CC0 under Dryad's terms; the dataset page names no licence | Considered, not used |
| PTB-XL 1.0.3 | PhysioNet. [Link](https://physionet.org/content/ptb-xl/1.0.3/) | 21,799 ten-second 12-lead ECGs | CC BY 4.0 | Considered, not used |
| MIT-BIH Noise Stress Test 1.0.0 | PhysioNet. [Link](https://physionet.org/content/nstdb/1.0.0/) | ECG noise records | ODC-By v1.0 (seen in a search excerpt only) | Considered, not used |
| PhysioNet/CinC Challenge 2017 1.0.0 | PhysioNet. [Link](https://physionet.org/content/challenge-2017/1.0.0/) | 8,528 handheld single-lead ECGs | ODC-By v1.0 | Considered, not used |
| Icentia11k 1.0 | PhysioNet. [Link](https://physionet.org/content/icentia11k-continuous-ecg/1.0/) | 11,000 patients, single-lead chest patch | CC BY-NC-SA 4.0 | Rejected for public output (non-commercial, share-alike) |
| INSPIRE 1.3 | PhysioNet. [Link](https://physionet.org/content/inspire/1.3/) | Korean surgical cases with a ward vitals table | Credentialed, Korea-specific licence | Rejected |
| VitalDB 1.0.0 | PhysioNet. [Link](https://physionet.org/content/vitaldb/1.0.0/) | 6,388 surgery cases, intraoperative | CC BY 4.0 | Rejected (anaesthetised patients, no ward drift) |
| MIMIC-III Waveform 1.0 | PhysioNet. [Link](https://physionet.org/content/mimic3wdb/1.0/) | ICU bedside waveforms | ODbL v1.0 | Rejected (ICU only) |
| Ward2ICU | Hospital Mater Dei, Brazil | Ward-to-ICU transitions; only a synthetic release exists | Repository names no licence | Rejected |
| MC-MED 1.0.0 | PhysioNet. [Link](https://physionet.org/content/mc-med/1.0.0/) | Emergency-department monitoring | Credentialed | Rejected (not ward) |

Sources for the table:

- Rows in use: [`NOTICE.md`](../NOTICE.md), [`scripts/fit-generator.mjs`](../scripts/fit-generator.mjs) lines 536 to 549, and the Intelligence [eICU dataset card](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/models/data/eicu-crd-demo/card.md) (stay and hospital counts).
- SHDB-AF and CPSC 2021: Intelligence [`training/REGISTRY.md`](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/training/REGISTRY.md), "Datasets". It says both were downloaded on 2026-11-14 and are "not used by any model or fit".
- MIMIC-IV not used: [`README.md`](../README.md) line 310.
- The eICU replay and its removal: commits `b55dcc3` (added) and `40f1527` (removed) in this repository, and Intelligence migration [`0002_drop_eicu_replay.sql`](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/backend/src/biosentry/db/migrations/0002_drop_eicu_replay.sql). The replay showed 12 real eICU stays on the ward as a second source. Its extract was never committed. It set no synthetic value.
- "Approved", "considered" and "rejected" rows: team notes, not committed (the dataset decision of 2026-11-08 and the survey "Ward sim real data sources"). No code in either repository reads any of these datasets. That absence was checked; the reasons for rejection come from the notes only.

Not datasets, so not in the table: the 12 starting patients come from BioSentry's own made-up fixture, [`src/sim/synthetic.json`](../src/sim/synthetic.json). The trials the models train on are written by this simulator ([section 6.1](#61-the-data-the-models-use)).

### 2.2 eICU-CRD Demo 2.0.1: the generator fit

Script: [`scripts/fit-generator.mjs`](../scripts/fit-generator.mjs), run with `npm run fit`. Output: [`src/sim/fitted.json`](../src/sim/fitted.json).

**Tables read:** `patient`, `vitalPeriodic` (heart rate, respiration, SaO2, temperature), `vitalAperiodic` (non-invasive systolic and diastolic). Lines 67 to 92.

**Held-out split:** hospital ids are sorted and every fourth one is kept out of the fit (line 71). That gives 140 fitted hospitals and 46 held-out hospitals (`fitted.json`, `provenance`). The held-out hospitals feed only the `holdout` block, which the realism tests read.

**Cleaning and filtering:**

| Step | Rule | Lines |
|---|---|---|
| Resampling | Readings are placed on a 5-minute grid, eICU's own interval. Negative offsets are dropped | 14, 75 to 76 |
| Plausible range | Heart rate 30 to 200, respiratory rate 6 to 40, SpO2 70 to 100, temperature 34.5 to 40.5 °C. A value outside is dropped | 19, 83 |
| Windows | Non-overlapping 6-hour windows (72 slots). Heart rate, respiratory rate and SpO2 must each cover 80% of the window | 15 to 16, 105 to 110 |
| Ward-like filter | The window's medians must be heart rate 50 to 110, respiratory rate 10 to 24, SpO2 92 to 100 | 21, 111 |
| Centring | Each vital is centred on its own window mean, so ICU levels are not used, only movement around them | 112 to 117 |
| Cuff readings | Systolic 60 to 240 mmHg, inside a ward-like window, pairs at least 3 minutes apart | 121, 230 to 234 |

The fit used 8,159 training windows and 2,988 held-out windows (652 and 189 with temperature), from `fitted.json` `train` and `holdout`. No unit conversion is done.

**What it set in the simulator:**

| Value in `fitted.json` | How it was fitted | Fitted value | Used at |
|---|---|---|---|
| Slow drift per vital: SD and time constant | Pooled autocovariance at lags of 5 and 10 minutes, fitted to an exponential decay (lines 153 to 157, 194 to 198) | Heart rate SD 6.112, 32.0 min; respiratory rate 2.564, 17.5 min; SpO2 1.618, 18.1 min; temperature 0.2196 °C, 67.7 min | [`source.ts`](../src/sim/source.ts) lines 309, 555 |
| How vitals move together (one shared factor) | One-factor analysis of the lag-5 cross-correlations (lines 159 to 203) | Loadings 3.583, 1.241, -0.3057, 0.04665; shared-factor time constant 24.37 min | `source.ts` lines 551, 566 |
| Patient-to-patient spread | SD of log relative window variability (lines 216 to 220) | 0.3884 | `source.ts` lines 386 to 388 |
| Blood pressure: drift SD, time constant, cuff noise | Structure function of systolic differences by gap, least squares over a grid (lines 242 to 268) | SD 11.58 mmHg, 130 min, noise 10.41 mmHg | `source.ts` lines 581 to 600 |
| Diastolic relation | Regression of diastolic change on systolic change; 1st to 99th percentile of the diastolic/systolic ratio (lines 269 to 271, 567) | Slope 0.4183, noise 8.217, ratio 0.3073 to 0.8252 | `source.ts` lines 304 to 307, 597 |
| New-patient baselines | 21-point quantile tables of window medians for heart rate, respiratory rate, SpO2, temperature, systolic and pulse pressure (lines 120 to 127, 569) | Tables | `source.ts` lines 415 to 422 |
| Deterioration size and ramp length, three kinds | The project's own rule, below (lines 277 to 403) | Table below | `source.ts` lines 296 to 299, 448 to 452, 529 to 534 |
| Hold-out figures | The same summary on the 46 held-out hospitals (lines 582 to 585) | Used by tests only | [`sim.test.ts`](../src/sim/sim.test.ts) lines 257 to 300 |

**Deterioration episodes are the project's own definition, not a dataset label** ([`README.md`](../README.md) line 303; script lines 277 to 386). Fitted hospitals only.

- *Respiratory and tachycardic:* hourly medians of heart rate, respiratory rate and SpO2 are scored with the NEWS2 bands for those three vitals. The baseline is the calmest ward-like 6 hours in the last 48 hours (score 2 or less). An event is a rise of 4 or more above that baseline held for 2 hours. It is "respiratory" when the breathing and SpO2 points are at least twice the heart-rate points, otherwise "tachycardic". At most one per 24 hours per stay.
- *Hypotensive:* a cuff reading at or below 100 mmHg and at least 20 below the stay's median of the previous 1 to 6 hours (which must be 100 to 180), confirmed by a second reading at or below 100 within 2 hours, with a calm vital-sign baseline. At most one per 24 hours.

| Kind | Episodes found | Median change: heart rate, respiratory rate, SpO2, systolic | Ramp, median (range) |
|---|---|---|---|
| Respiratory | 417 | +15.5, +7, -4.5, +7.5 | 300 min (30 to 2,580) |
| Tachycardic | 89 | +29.25, +6.5, -1, +9 | 240 min (30 to 2,160) |
| Hypotensive | 486 | -1, 0, 0, -28 | 60 min (30 to 302) |

Source: `fitted.json`, `deterioration`. The simulator draws a ramp from the table without its two end values (`source.ts` line 302).

### 2.3 eICU-CRD Demo 2.0.1: the calibration file

Script: [`scripts/fit-eicu.mjs`](../scripts/fit-eicu.mjs) with the reader [`scripts/eicu-csv.mjs`](../scripts/eicu-csv.mjs), run with `npm run fit:calibration`. Output: [`src/sim/calibration.json`](../src/sim/calibration.json).

- **Cohort:** adult (18 or over; "> 89" read as 90), discharged alive from the unit, median Glasgow coma score 14 or more, and at least 12 hours of 5-minute values for each of heart rate, respiratory rate and SpO2 (lines 49 to 90). Result: 885 stays.
- **Plausible range:** heart rate 30 to 200, respiratory rate 6 to 40, SpO2 78 to 100 (line 13).
- **Held-out split:** a fixed 1-in-5 hash of the hospital id (lines 40 to 45): 716 stays fit, 169 held out.
- **Detrending:** each series minus its 6-hour rolling median (lines 94 to 105).
- **What the simulator uses from it:** only the hour of day at which heart rate and respiratory rate peak (21.6 h and 21.2 h), at `source.ts` line 142, and the held-out change-SD bands that [`calibration.test.ts`](../src/sim/calibration.test.ts) checks against. The file's other values (coupling, wander, fast noise, circadian size) are written but not read by the simulator.

**The two eICU splits differ.** The generator fit holds out every fourth hospital; the calibration fit holds out by hash. So the calibration hold-out is not guaranteed to be outside the generator's fit. [`docs/realism.md`](realism.md) says to read those rows "as a weaker check".

### 2.4 BIDMC PPG and Respiration 1.0.0

Script: `fit-generator.mjs` lines 405 to 425.

- **Taken:** the 1 Hz numerics files (`*_Numerics.csv`): heart rate, respiratory rate and SpO2.
- **Method:** the difference between readings 60 seconds apart. Zero or negative readings are skipped. The largest 1% of jumps are cut as monitor artefact. The noise SD is the root mean square of the rest, divided by √2.
- **Set:** minute-to-minute noise: heart rate 2.005, respiratory rate 1.343, SpO2 0.4897 (`fitted.json`, `vitals.*.noise`). Used at `source.ts` lines 131 and 556.
- Temperature has no BIDMC noise value. Its noise is hand-set ([section 4.3](#43-what-is-hand-set-or-judgement)).

### 2.5 MIT-BIH Arrhythmia 1.0.0

Script: `fit-generator.mjs` lines 427 to 477. Only the annotation files (`.atr`) are read, not the signals.

- **Excluded:** paced records 102, 104, 107 and 217, and the whole 200 series, which "was chosen for rare arrhythmias" (lines 459, 466 to 467).
- **Set:** premature beats per hour, as a quantile table across records; and the PVC coupling ratio 0.6328, the median interval before a PVC over the usual interval, taken only where the eight beats before and the beat after are normal.
- **Used at:** `source.ts` lines 213 to 220 and [`src/ecg.tsx`](../src/ecg.tsx) line 58. It affects only the drawn ECG strip, which is illustrative and analysed by nothing.

### 2.6 MIT-BIH Atrial Fibrillation 1.0.0 and Long Term AF 1.0.0

Script: `fit-generator.mjs` lines 479 to 534. Rhythm labels and beat times only.

- **AFDB, taken:** beat-interval ratios in AF and in sinus rhythm (intervals of 0.25 to 3 seconds, in groups of 8); the heart-rate SD of successive 75-beat groups in AF; the ratio of AF rate to sinus rate per record; AF episode lengths of 30 seconds or more. A record's last span is kept although cut off.
- **LTAFDB, taken:** AF episode lengths of 30 seconds or more, added to the same table, because day-long records cut fewer episodes short.
- **Set:** AF minute-level heart-rate SD 3.639; AF rate ratio 1.35; AF episode length table, median 1.6 minutes (`fitted.json`, `rhythm`).
- **Used at:** `source.ts` lines 446, 556 to 558, 613.

### 2.7 eICU-CRD Demo 2.0.1 as a test set for NEWS2 (Intelligence)

Code: [`research/realdata/`](https://github.com/kitchen-station/BioSentry-Intelligence/tree/main/research/realdata). Card: [`models/data/eicu-crd-demo/card.md`](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/models/data/eicu-crd-demo/card.md). Method: [`research/README.md`](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/research/README.md), "Real data".

- **No model is trained here.** It measures NEWS2 and the own-baseline rule on real ICU records.
- **Test set:** only the 46 hospitals the generator fit held out. The ids are written in [`split.py`](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/research/realdata/split.py) and re-derived from the data on each run. The card states a limit: 38 of the 46 were used by the calibration fit, "so this is mostly, not fully, a different-site test".
- **Cohort:** adult, first unit stay, 12 hours or more, no vasopressor before hour 6, comfort-care deaths left out. Result: 375 patients, 1,065 patient-days, 24 events.
- **Event (the project's own):** first vasopressor start from hour 6, or death in the unit.
- **Rows:** 15-minute bins. Missing stays missing; nothing is imputed. Out-of-range values are dropped and counted, never converted.
- **Result:** full NEWS2 inputs were present in 5.5% of bins. The card's conclusion: "With 24 events and full NEWS2 inputs in 5.5% of bins, this run cannot rank NEWS2, the measured-components sum or the baseline rule against each other; no conclusion can be drawn."
- The per-rule numbers are printed by the command and are not committed, so they are not repeated here.
- No data and no row-derived file is committed. Only aggregates appear.

## 3. Published sources that are not datasets

| Source | What it set, or what it was only checked against | Where |
|---|---|---|
| Royal College of Physicians, NEWS2 (2017) | **Set:** the scoring bands and response thresholds, reproduced unmodified | [`src/sim/news2.ts`](../src/sim/news2.ts) lines 1 to 4; [`NOTICE.md`](../NOTICE.md) |
| RCP NEWS2 Chart 3 (observation frequency) | **Set:** the nurses' observation rounds in the API runner | [`README.md`](../README.md) line 340 |
| van Goor 2022 (COVID ward patches) | **Set:** the size of the 24-hour swing: heart rate 6.9, respiratory rate 1.0 | `source.ts` lines 132 to 138 |
| Pimentel 2019 (UK wards) | **Set:** 39% of admissions ever on oxygen. The share of stay on oxygen (0.32) was tuned so that 18 to 19% of observation sets are on oxygen | `source.ts` lines 327 to 328 |
| Churpek 2016 (US wards) | **Set:** 6.1% of admissions deteriorate | `source.ts` line 331 |
| Churpek 2012, Churpek 2015, Payvar 2013 | **Set (by removal):** temperature does not change in an episode. An earlier fixed 0.6 °C rise had no source and was removed | [`README.md`](../README.md) lines 280, 306 |
| ViSi Mobile ward pilot | **Set:** patch dropout rate and gap lengths. The 4-hour cap is judgement | `source.ts` lines 147 to 154 |
| PhilHealth claims studies (2014, 2017) | **Set:** length of stay, lognormal by condition | `source.ts` lines 316 to 322; [`README.md`](../README.md) line 321 |
| Philippine Heart Center report | **Set:** occupancy 75% | `source.ts` line 323 |
| Cardiac and ACS cohorts | **Set:** AF 8% pre-existing, 5% new onset | `source.ts` lines 329 to 330 |
| Holter cohort (published 9% with frequent PVCs) | **Set:** the 9% share of patients given frequent ectopy | `source.ts` lines 215 to 220 |
| US discharge-timing sources | **Set:** about 15% of discharges before noon | `source.ts` lines 344 to 346; [`README.md`](../README.md) line 326 |
| Welch 2015 (ten US hospitals, monitored wards) | **Checked only:** percentiles of heart rate, respiratory rate, SpO2, systolic | [`published.test.ts`](../src/sim/published.test.ts) lines 11 to 17 |
| RCP NEWS (2012) report | **Checked only:** about 20% of observation sets at 5 or more, about 10% at 7 or more | `published.test.ts` lines 96 to 101 |
| Whebell 2021 (*Critical Care* 25:226) | **Set:** the one parameter of the optional outcome model in `npm run compare` (the model applies the paper's odds ratio of 1.02 to each hour of delay). The output is labelled "MODEL ASSUMPTION, not evidence about patients" | [`docs/compare.md`](compare.md), "Outcome model" |
| Philippine hospital sources (PIDS, PGH studies, PhilHealth statistics, DOH staffing manual) | **Set:** values of the hospital layer around ward W4 ([section 4.5](#45-the-whole-hospital-layer)) | [`src/sim/hospital/params.ts`](../src/sim/hospital/params.ts) |

Three caveats on this table:

- The team's research note says the occupancy figure, the AF rates and the ectopy share were read from search excerpts only and should be re-checked before quoting. The code comments name the source but give no link for these.
- The published targets for van Goor (6.9, 1.0), Pimentel (39%, 18.7%) and occupancy (75%) are also what the tests compare with. Those tests check that the code does what it was set to do. They are not evidence of realism.
- `params.ts` names two source notes (`research-ph-hospital.md`, `hospital-design.md`) that are not in the repository. The links to the published sources are in the file itself (lines 17 to 39).

## 4. The synthetic generator

Code: [`src/sim/source.ts`](../src/sim/source.ts). It is a random generator driven by fitted summary statistics. [`docs/realism.md`](realism.md): "No model was trained to predict anything, and no recording is replayed."

### 4.1 How one patient's vitals are made

Each patient has a fixed baseline (an "anchor") for heart rate, respiratory rate, SpO2, temperature and cuff blood pressure. The 12 fixture patients take theirs from the fixture. A newly admitted patient draws each one separately from the eICU baseline tables (lines 415 to 422).

Once per simulated minute, each device vital is (lines 547 to 579):

> anchor + deterioration offset + AF rate change + 24-hour rhythm + the vital's own slow drift + its share of a slow factor shared by all four vitals + minute noise

- The slow drift and the shared factor are first-order autoregressive processes (lines 283 to 286) with the fitted SDs and time constants. Each patient's variability is scaled by a factor drawn once from the fitted patient-to-patient spread.
- The result is clamped to a plausible range (lines 123 to 128).
- A patch dropout starts at random, on average every 146 minutes, and returns no reading for its length (lines 147 to 154, 571 to 577).
- Blood pressure is not a device signal. It is produced only when a nurse takes a cuff reading, from its own random stream, so taking a reading cannot change the vitals that follow (lines 581 to 600).
- Everything is seeded. The same seed gives the same run.

At minute 0 the ward reproduces the BioSentry fixture exactly: all ten NEWS2 totals, the rank order and the NOT RANKED text. [`sim.test.ts`](../src/sim/sim.test.ts) checks this.

### 4.2 What is fitted

Everything in the tables of sections 2.2 to 2.6: drift, shared movement, patient spread, blood pressure dynamics, new-patient baselines, deterioration size and speed, minute noise for three vitals, and rhythm tables.

### 4.3 What is hand-set or judgement

Stated plainly in the code (`shortcut:` comments) and in [`README.md`](../README.md) lines 305 and 328:

| Value | Setting | Why it is judgement |
|---|---|---|
| Mix of episode kinds | 55% respiratory, 20% tachycardic, 25% hypotensive | No published split exists. Raw eICU counts are not used, because ICU cuff falls from sedation and drugs would make hypotension half of events (`source.ts` lines 292 to 294) |
| Temperature minute noise | SD 0.1 °C | No open minute-level source (line 129) |
| Temperature 24-hour swing | 0.12 °C | No ward source (lines 132 to 138) |
| Value clamps | Per vital | Kept from the original BioSentry generator (line 122) |
| Patch dropout cap | 4 hours | Published gaps reach 24 hours (line 153) |
| Case mix | 35% heart failure, 45% coronary medical, 20% coronary procedure | No published whole-ward case mix (line 317) |
| Age | 45 to 84, uniform | No ward age data fitted (line 460) |
| 48-hour hold before a move to higher care | 48 hours at NEWS2 5 or more | Judgement ([`README.md`](../README.md) line 328) |
| Share of patients with frequent ectopy | 9% | Published figure applied to a small Holter sample (lines 215 to 216) |
| Fixture gaps | A cuff reading for p-004, a baseline for p-005, a physician for both | The fixture has none (lines 163 to 167, 197) |
| Quality gate and NOT RANKED cutoff | 8 usable readings per 15 minutes; 30 stale minutes | Demo values (lines 112 to 120) |

The staff response loop (messages, walks, reassessments, physician calls) is demo design, not product ([`README.md`](../README.md), "What is demo design, not product").

### 4.4 Deterioration episodes and their ground truth

- **When:** 6.1% of admissions get one episode, at a random time in the stay (`source.ts` lines 448 to 452). A user can also start one by hand.
- **Shape:** the episode's fitted size is added to the anchor along a squared ramp, from 0 at the start to full size at the end of the drawn ramp (lines 289 to 290). The patient then stays at full size.
- **No recovery.** The generator has none. The demo "deliberately shows no recovery after review" ([`README.md`](../README.md) line 347). A staff review does not change vitals.
- **Temperature does not move** in any episode (lines 531 to 532).
- **Hypotensive episodes are seen only through a cuff reading.** The patch does not measure blood pressure, so some go unseen, as they could on a real ward ([`README.md`](../README.md) line 304).
- **Ground truth:** the simulator knows the true start minute and the "fully in" minute (start plus ramp) of every episode. Trial files record them in `episodes.csv` ([`docs/trial-format.md`](trial-format.md)), and the research code scores alerts against them. This truth exists only because the data is synthetic.
- **Live runs:** the headless runner posts each started episode to the API only after it has started ([`docs/episode-truth.md`](episode-truth.md)). The contract says the API shows it only in a patient's history, never in a rank, a score or a model input. That promise is the API's side; this repository does not enforce it.

### 4.5 The whole-hospital layer

The hospital model adds an emergency room (ER), three more wards (MED3A, MED3B, SURG5A), intensive care (ICU) and a morgue around ward W4. It ran first only in the visitor's browser (the standalone hospital page). Since sim PRs #71 to #75 the headless runner can run it too, and write it to the API (below).

**What the runner does now** (`src/headless.ts`, `src/sim/hospital/`; code at `b804a3d`):

- **Mode.** `WARD_MODE` is `ward` by default, so the runner still runs ward W4 alone unless it is told `hospital` (`headless.ts` lines 21 to 26; [`README.md`](../README.md), "Run the ward without a browser"). Whether the team server is set to `hospital` is not in the code. The owner's goal list of 2026-11-16 (a team note) shows that switch as still to do.
- **Default hospital.** In hospital mode `WARD_SCENARIO` defaults to `typical`: the typical scenario at seed 101, with W4's 12 starting patients drawn from that seed (`hospital/fresh.ts`; owner decision orch-h4, named in that file's header). `pitch` keeps the 12 hand-written patients. The browser page's own default is still "Pitch ward" ([`docs/scenarios.md`](scenarios.md)).
- **What is sent to the API.** A run lists its units ([`hospital/units.ts`](../src/sim/hospital/units.ts): W4 first, then the others, no morgue). W4's patients are sent by the ward as before. Every other unit's people are sent as that unit's patients by [`hospital/publish.ts`](../src/sim/hospital/publish.ts), with their recent 15-minute values. A move is the old stay ending `transferred` with the destination unit, then a new stay with a new id. A person who leaves is `discharged`. A person who dies is `died`. The morgue is not a unit: "a death is a stay ending".
- **Still display only.** The publisher "reads the engine and the hospital, writes only the outbox, and draws no random number", and "nothing sent here changes care, and a dashboard action on one of these stays changes nothing" (`publish.ts` header). A test scans the file for writes and random draws (`hospital/vitals.test.ts`).
- **A side effect on W4's occupancy.** The comment in [`hospital/attach.ts`](../src/sim/hospital/attach.ts) records W4 occupancy of about 50% under `typical` in hospital mode, against 75% for W4 alone. The 75% target and its test ([`published.test.ts`](../src/sim/published.test.ts) line 105) apply to the ward-only run.

**What the API does with units** (Intelligence [PR #87](https://github.com/kitchen-station/BioSentry-Intelligence/commit/35e02d0), [migration 0014](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/backend/src/biosentry/db/migrations/0014_hospital_units.sql), [`services/ward.py`](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/backend/src/biosentry/services/ward.py)):

- A run has 1 to 12 units, each with a `kind`: `ranked` (W4, MED3A, MED3B, SURG5A and, since the owner's decision orch-h10, the ER), `shown` (no unit of this runner now; a run started before that decision has the ER there) or `unranked` (ICU). Only a `ranked` unit is scored: "no score, rank or model flag is computed for the others". The ER is sent with a `score_note`, served with the unit and printed by the page: "NEWS2 used as an aid: evidence in the emergency department is mixed (RCP 2017/2020; studies AUROC 0.59-0.88)." A `shown` unit gives a NEWS2 band when every input is present and no rank. The ICU gives no band, score or rank.
- A patient row is one stay in one unit. A person who moves gets a new row with the same `person`. A stay that ended leaves the live lists and stays in the stay history, with its ending (`discharged`, `higher_care`, `transferred` or `died`; the database constraint is in migration 0014).
- One charge nurse is added for each other unit, with no passphrase, so nobody can sign in as them until one is set on the server.
- Two open routes, behind the server's open-view setting, need no sign-in: a list of the run's units (PR #90) and a read-only bed card (PR #91). The bed card gives the bed label, unit, floor, kind, the NEWS2 score and band, the trend word and the newest stored value of five vitals, each with its time and source. It gives no name, no patient id. The simulator's public page reads both routes (sim PR #77, [`docs/open-view.md`](open-view.md)).
- Everything is still marked synthetic. Migration 0002's rule (a run's `synthetic` flag must be true) is not changed by any later migration.

**Patient flow and staffing** come from [`src/sim/hospital/params.ts`](../src/sim/hospital/params.ts). Each default carries a tag. Counted by tag in the file: 36 `cited`, 2 `unverified`, 11 reused from W4's code, and about 100 `judgement`. The file's first lines say: "Nothing here is fitted to a Philippine hospital's own records". Most hospital-layer values are therefore judgement.

**Vital signs outside W4** come from [`src/sim/hospital/vitals.ts`](../src/sim/hospital/vitals.ts), described in [`docs/hospital-vitals.md`](hospital-vitals.md). How it differs from W4:

| | Ward W4 | Every other unit |
|---|---|---|
| Generator | The fitted generator | The same generator. No unit has a fit of its own |
| Baselines | Fixture or eICU ward-like tables | The same tables. Age, sex and patient group change no vital |
| Role | Feeds the ranked list, the API and the trials | **Display only.** "A score here never changes care, a move, a staff task or any hospital number". In hospital mode the runner also writes these people to the API as that unit's patients, still display only |
| NEWS2 | Ranked | In the simulator: ranked in wards and the ER, not ranked in intensive care. In the API: W4, MED3A, MED3B, SURG5A and the ER are ranked (`kind: ranked`); the ER carries a `score_note` saying its NEWS2 is an aid (owner decision orch-h10); the ICU is `unranked` (nothing) |
| Episodes | Drawn at admission or started by hand | Start only when the hospital model records an onset. Cleared at an ICU step-down and marked "not modelled" |
| Realism checks | Sections 5.1 to 5.3 | None. No check compares another unit's output with real data |
| On-screen label | None | For example "Synthetic. Not ER data: ward generator." |

A known artefact: everyone present at minute 0 opens as a new admission, so for about the first simulated day the share at NEWS2 5 or more is about twice W4's (32% at 6 hours against 11 to 12%). The page says so on screen.

The simulator's own doc says the engine is made only by the standalone page ([`docs/hospital-vitals.md`](hospital-vitals.md) line 52). That is out of date: the runner's hospital mode now makes it too, as the updated test in `hospital/vitals.test.ts` records.

### 4.6 What the hospital data is and is not

- **It is synthetic.** Every person, vital, move and death in the hospital model is generated. No hospital record is used.
- **Units other than W4 use the W4 generator.** The ER, MED3A, MED3B, SURG5A and ICU get their vital signs from the same generator as ward W4, fitted to ICU data at ward-like baselines. This is unchanged at `b804a3d`: `hospital/vitals.ts` and `source.ts` are identical to the first draft, and `publish.ts` sends what the engine produces. No unit has a shifted baseline, and age, sex and patient group change no vital ([`docs/hospital-vitals.md`](hospital-vitals.md)).
- **Not ER data, not ICU physiology, not surgical patients.** The on-screen labels say so (for example "Synthetic. ICU vitals are not modelled: ward generator values.").
- **Moves, deaths and discharges come from the hospital model's rules.** Most of its parameters are tagged `judgement` ([section 4.5](#45-the-whole-hospital-layer)). The ICU has no recovery model. A step-down clears the episode and is marked "not modelled".
- **Nothing outside W4 is checked against real data.** The realism checks in [section 5](#5-realism-checks) test the generator as W4 uses it.
- **Seeing a person in the API or on the public page is not a finding.** A NEWS2 band on a bed outside W4 is a display of a synthetic score. It is not a finding about any real ward.

## 5. Realism checks

`npm run realism` prints every check: the simulator's number, the real number, the tolerance and the verdict. The full output is in [`docs/realism.md`](realism.md). The tolerances are the test suite's own. They are judgement values, not statistical tests.

### 5.1 What is compared with real data

| Check | Simulator | Real data | Tolerance | Test |
|---|---|---|---|---|
| A1 to A3: spread and 5-minute correlation of heart rate, respiratory rate, SpO2 | One fixture patient, 200 seeds, 6 hours | 46 held-out eICU hospitals | SD ratio 0.75 to 1.25; correlation within 0.2 | [`sim.test.ts`](../src/sim/sim.test.ts) line 257 |
| A4: the same for temperature | The same | 189 held-out windows with a temperature probe | The same, reused unchanged | [`src/realism.ts`](../src/realism.ts) only |
| B1, B2: systolic step size at 30 and 180 minutes | One fixture patient, 2,000 seeds | Held-out eICU cuff pairs | Ratio 0.75 to 1.25 | `sim.test.ts` line 285 |
| C1 to C12: size of change at 5, 15, 60, 180 minutes | Ten fixture patients, 3 seeds, 3 days | eICU calibration hold-out (weaker: see 2.3) | Inside the real 25th to 75th percentile | [`calibration.test.ts`](../src/sim/calibration.test.ts) |
| D1 to D4: percentiles of heart rate, respiratory rate, SpO2, systolic | Ward W4 with patient flow, 6 seeds, 30 days each, last 20 days | Welch 2015, monitored wards | Within 10, 3, 3 and 15 | [`published.test.ts`](../src/sim/published.test.ts) |
| E1, E2: share of observation sets at NEWS 5+ and 7+ | The same runs | RCP 2012, medical wards | Within 7 and 5 points | `published.test.ts` |

### 5.2 The numbers

From the committed output in [`docs/realism.md`](realism.md):

| Signal | Statistic | Simulator | Real | Verdict |
|---|---|---|---|---|
| Heart rate | SD of 5-minute reads | 6.12 | 6.07 | pass |
| Heart rate | 5-minute autocorrelation | 0.709 | 0.813 | pass |
| Respiratory rate | SD | 2.69 | 3.00 | pass |
| Respiratory rate | 5-minute autocorrelation | 0.531 | 0.567 | pass |
| SpO2 | SD | 1.52 | 1.78 | pass |
| SpO2 | 5-minute autocorrelation | 0.614 | 0.641 | pass |
| Temperature | SD | 0.20 | 0.26 | pass |
| Temperature | 5-minute autocorrelation | 0.623 | 0.938 | **known miss** |
| Systolic | Cuff step SD, 30 min | 16.65 | 15.28 | pass |
| Systolic | Cuff step SD, 180 min | 20.48 | 19.94 | pass |
| Heart rate | Median (Welch) | 84.66 | 81 | pass |
| Respiratory rate | Median (Welch) | 18.19 | 16 | pass |
| Systolic | Median (Welch) | 120 | 121 | pass |
| SpO2 | 1st and 5th percentile (Welch) | 90.30, 92.63 | 86, 89 | **known miss** |
| Respiratory rate | Change SD over 5 min | 1.71 | 1.96 to 3.08 | **known miss** |
| SpO2 | Change SD over 5 min | 0.92 | 0.94 to 1.63 | **known miss** |
| NEWS2 | Observation sets at 5 or more | 34.66% | about 20% | **known miss** |
| NEWS2 | Observation sets at 7 or more | 16.25% | about 10% | **known miss** |
| Heart rate, respiratory rate | 24-hour swing | 6.77, 0.97 | 6.9, 1.0 | fitted target, not evidence |

All other heart rate, respiratory rate and systolic percentiles pass; the full list of 56 rows is in `docs/realism.md`.

### 5.3 The six known misses

| Miss | Likely reason, as the repository gives it |
|---|---|
| Temperature 5-minute correlation too low (0.623 against 0.938) | The hand-set minute noise is added to every read. Removing it fixes the correlation but breaks the spread. Nothing was changed to move either row |
| Respiratory rate changes too small over 5 minutes | The minute noise comes from BIDMC and runs below eICU's 5-minute medians |
| SpO2 changes too small over 5 minutes | The same |
| SpO2 low end too high | Simulated patients desaturate less deeply than monitored ward patients. No cause is established. The fit kept only windows with a median SpO2 of 92 to 100 |
| Too many observation sets at NEWS 5+ | The test samples sick patients at the NEWS2 minimum frequency. The repository cites no source for how often real wards meet it. RCP's figure is for NEWS 2012, not NEWS2 |
| Too many observation sets at NEWS 7+ | The same |

Recount at `b804a3d`: the test files and `docs/realism.md` are unchanged since `881fb13`, so the count stays six (three in `published.test.ts`, two conditional in `calibration.test.ts`, A4 in `realism.ts`). The simulator README still says three. Each known miss is marked as an expected failure in the tests (`it.fails`). If one starts passing, the build goes red, so the marker cannot go stale.

### 5.4 What is not checked at all

From [`docs/realism.md`](realism.md), "What is not matched or not modelled":

- **Diastolic pressure:** fitted, never tested.
- **Heart rhythm:** fitted from MIT-BIH, AFDB and LTAFDB, never compared with real data. The ECG strip on screen is drawn, not data.
- **Deterioration episodes**, **how the vitals move together**, and **the spread between patients:** not compared with held-out data.
- **Held-out checks use fixture patients** (one patient for A and B, ten for C), not the people the ward admits.
- **Other hospital units:** no check.
- **Infection or fever:** not modelled.

The page's own summary: "So the pitch line is only partly supported. ... The simulator is not validated."

## 6. Models

All model files, cards and results are in the Intelligence repository under [`models/`](https://github.com/kitchen-station/BioSentry-Intelligence/tree/main/models). The training and evaluation code is under [`research/`](https://github.com/kitchen-station/BioSentry-Intelligence/tree/main/research).

### 6.1 The data the models use

Every learned model was trained, tuned, calibrated and scored on trials written by this simulator. A trial is 30 simulated days of ward W4 with the default scenario, as four files (`manifest.json`, `cohort.csv`, `episodes.csv`, `summary.json`; [`docs/trial-format.md`](trial-format.md)). The trials are kept outside both repositories. No real patient row was used to train anything.

| Set | Seeds | Simulator commit | Role |
|---|---|---|---|
| ward-v2 | 1 to 10 | `f7647c5` | Tuning the own-baseline rule |
| ward-v2 | 11 to 30 | `f7647c5` | **Held-out set 1** (20 trials, 1,873 patients, 91 episodes) |
| ward-v2-train | 31 to 60 | `f7647c5` | Pilot for the reward policy's power note |
| ward-v2-ext | 61 to 160 | `b4b7cdc` | Student and teacher training |
| ward-v2-ext | 261 to 300 | `b4b7cdc` | Student validation (early stopping, model choice, threshold) |
| ward-v2-ext | 301 to 340 | `b4b7cdc` | Confidence-check calibration |
| ward-v2-ext | 341 to 400 | `b4b7cdc` | Reward-policy validation |
| ward-v2-ext | 401 to 584 | `b4b7cdc` | Reward-policy search |
| ward-v2-heldout2 | 1001 to 1400 | `4b86f96` | **Held-out set 2** (400 trials, 37,062 patients, 1,743 episodes) |

Sources: the data cards for [ward-v2](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/models/data/ward-v2/card.md), [ward-v2-ext](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/models/data/ward-v2-ext/card.md) and [ward-v2-heldout2](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/models/data/ward-v2-heldout2/card.md). The cards record that one seed made at each later commit was byte-identical to the same seed at `f7647c5`, so all sets are draws from one generator.

An earlier set, ward-v1, came from a simulator that added a fixed 0.6 °C temperature rise to every episode. Any detector that read temperature was flattered by it. The rise was removed, ward-v2 was made, and the gains seen on ward-v1 went away ([baseline card](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/models/tier_b/baseline/card.md)). The ward-v1 numbers are kept in that card as a record of the artefact.

### 6.2 How the held-out sets were protected

- **Set 1** (ward-v2 seeds 11 to 30): the evaluation code scores only these seeds and refuses a seed outside 1 to 30. Each model was scored on it once. The cards say plainly that this is "by procedure; nothing in the code enforces it" for most commands, and that the same seeds were used earlier for earlier models. The confidence check does refuse a second run while its output file exists.
- **Set 2** (seeds 1001 to 1400): declared in [`research/README.md`](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/research/README.md), "Held-out set 2", before any trial was read. The analysis, the three comparisons and the verdict rule were written down first. Every loader that trains, tunes, calibrates or learns refuses these seeds by number (for example [`reward_loop.py`](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/research/reward_loop.py) lines 39 to 40 and 170). Nothing was re-tuned after the read. It was read once per command on 2026-11-14.
- **Parity:** every cohort row is re-scored with the backend's NEWS2 and must equal the simulator's score. Set 1: 726,031 rows, 0 mismatches ([`held_out.txt`](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/models/tier_c/student_vitals/held_out.txt)).
- **Checksums:** [`models/manifest.json`](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/models/manifest.json) holds the size and sha256 of every shipped model file, and a test fails if a file changes.

### 6.3 How alerts are scored

Definitions from [`research/README.md`](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/research/README.md), "Definitions":

- **Event:** a true episode from the simulator. Its window runs from the true start to "fully in" plus 120 minutes.
- **New alert:** an alert fires inside the window. **Any bin:** the rule is alerting somewhere in the window, new or already open.
- **Chance:** the same windows laid on patients with no episode. With alerts this frequent, such a window often contains an alert by itself. **Excess** is the detection rate minus chance. Excess cannot be compared between rules with different chance rates.
- **Burden:** alerts per patient per 12-hour shift, and the share of time in alert.
- **Intervals:** patient-level bootstrap on set 1; trial-level bootstrap on set 2.

### 6.4 The models, one by one

| Model | Kind | Inputs | Trained on | In the deployed system? |
|---|---|---|---|---|
| NEWS2 (Tier A) | Published rule, no learning | Respiratory rate, SpO2, SpO2 scale, oxygen, systolic, heart rate, consciousness, temperature | Nothing | **Yes.** It alone sorts the ward list |
| Escalation arbiter | Fixed rules, no learning | NEWS2 result, Tier B finding, the prediction flag | Nothing | **Yes** |
| Own-baseline rule (Tier B) | Median and MAD arithmetic, no learning | One vital's 15-minute values since admission (four device vitals; systolic blood pressure as a fifth, charted vital) | Nothing; k and p tuned on ward-v2 seeds 1 to 10 | **Yes**, as a tie-break and a reason, on its code defaults |
| Reward-driven policy (Tier B) | Six numbers found by search | Each vital's z from the patient's own baseline | ward-v2-ext seeds 401 to 500 | **No. Dropped as a flag** (owner decision models-rl-5). Research result only |
| Distilled student (Tier C) | Neural network, 1,185 parameters | 35 features per 15-minute bin | ward-v2-ext seeds 61 to 160 | **Yes**, as a reason-only flag, through the confidence check |
| Teacher | Neural network, 79,873 parameters | 53 features | The same | No. Research only |
| Confidence check (Tier C) | One calibrated quantile | The student's probability | ward-v2-ext seeds 301 to 340 | **Yes**, gates the student's flag |
| Research agent's language model | LoRA adapter on a small open model | Text | Generated text, no patient data | No. Not running anywhere |

"Deployed" here means the API code on `main` loads and uses it ([`services/models.py`](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/backend/src/biosentry/services/models.py), [`domain/arbiter.py`](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/backend/src/biosentry/domain/arbiter.py)). Intelligence PR #80 (2026-11-16) corrected the model cards, `INTEGRATION.md` and the README, so they now agree with the code; the first draft of this page found them disagreeing. The code loads only the student, its confidence check and the NEWS2 and baseline code. "On the server" in the team's own words is not checked here: this page reads code, not the running server.

#### NEWS2 (Tier A)

- **What:** the RCP 2017 tables, "unmodified, no local tuning" ([card](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/models/tier_a/news2/card.md)). Code: `backend/src/biosentry/domain/scoring/tier_a/`. This repository holds a port in [`src/sim/news2.ts`](../src/sim/news2.ts).
- **Added around the score, not to it:** abstention when an input is missing or impossible (nothing is imputed), and half-up rounding before banding.
- **Evaluation:** as an alerting rule on the held-out sets, it is the yardstick for every other row below. The card: "No claim about performance on this population or on synthetic data."

#### Escalation arbiter

- **What:** "the only component allowed to change displayed priority" ([`arbiter.py`](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/backend/src/biosentry/domain/arbiter.py), lines 1 to 21). This repository holds a port in [`src/sim/arbiter.ts`](../src/sim/arbiter.ts).
- **Rules that are live:** (1) any NEWS2 trigger escalates: a total of 5 or more, or a single parameter at 3. (2) The student's prediction flag, shown only when the confidence check says "alert", adds one reason line. The reward policy has no flag: the arbiter's header says "The reward policy has no flag (owner decision models-rl-5)". (3) A significant own-baseline finding is listed and breaks ties between patients with no trigger and an equal total. (5) A missing required input gives NOT RANKED, naming it.
- **Order:** trigger level, then NEWS2 total, then the Tier B flag, then patient id. The model flags never set `escalated` or `flagged` and never touch the order (as the arbiter was read at the first draft; PR #88 only removed the policy).
- **One ranking per unit.** Since the API learned units (PR #87), a rank is within one unit, and only `ranked` units are scored ([section 4.5](#45-the-whole-hospital-layer)).
- **Evaluation:** `news2_chart_trigger` in the research code is the arbiter's own escalation, so the NEWS2 rows below are also the arbiter's.

#### Own-baseline rule (Tier B)

- **What:** for each device vital, the median and spread (1.4826 × MAD) of the patient's first 24 valid 15-minute bins, then frozen. It flags when the latest value is k spreads away in the bad direction for p bins in a row. No training ([card](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/models/tier_b/baseline/card.md)).
- **Tuning:** a grid sweep of k and p on ward-v2 seeds 1 to 10, with the selection rule fixed before the run. Chosen: k 4.0, p 8.
- **Held-out set 1:**

| Rule | Alerts per patient per 12 h | Any bin (not cut short) | Chance | Excess |
|---|---|---|---|---|
| NEWS2 chart trigger alone | 0.414 | 0.684 (54/79) | 0.473 | +0.210 |
| Baseline alone | 0.042 | 0.278 (22/79) | 0.032 | +0.246 |
| NEWS2 or baseline | 0.426 | 0.722 (57/79) | 0.486 | +0.235 |

- **The card's reading:** "The baseline adds nothing measurable to NEWS2." Alone it is a quiet, late rule: median 82 minutes after the episode is fully in.
- **Deployed:** the API runs it on its code defaults (k 2.0, p 3), not the sweep's choice ([README](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/README.md), `GET /patients/{id}/baseline`; the card now says so too). The defaults are judgement values.
- **Blood pressure as a fifth vital (PR #89).** `baseline.py` adds `systolic_bp` as a "charted" vital, built from the stored blood-pressure readings: the median of the systolic values in each 15-minute set, with a set that has none as a gap. The same detector runs on it, a fall is the flagged way, and the floor is 5 mmHg, a judgement marked `shortcut:` in the code. It is not in the device vitals that the models and the sweeps read, so it was never tuned or scored on the held-out sets. The code comment in `baseline.py` (line 45) says it is not in VITALS, "so no model, no research sweep and no ranking reads it: the baseline panel shows it, nothing more". The card says it "never feeds a rank or an alert reason". No result is reported for it.

#### Reward-driven alerting policy (Tier B): no longer part of the system

- **Status:** dropped. The API once ran it as a reason-only flag. Since Intelligence PR #88 the server does not load it: `services/models.py` line 13 says "The reward policy is not loaded: owner decision models-rl-5 dropped it as a flag (a loss on held-out set 2)", and [`domain/arbiter.py`](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/backend/src/biosentry/domain/arbiter.py) line 20 says "The reward policy has no flag". The student is now the only model flag.
- **Why:** the owner's decision models-rl-5 (2026-11-16), cited in the card, `INTEGRATION.md` and the README, dropped the flag because "held-out set 2 shows a loss" for NEWS2 plus the policy (the reward-policy card status row; `INTEGRATION.md` line 14 agrees). The pre-registered verdict on set 2 was "a loss is shown" (gain -0.0127, interval -0.0245 to -0.0001, at the edge). The decision text itself is in a team note I read (`goals-left.md`, which lists "models-rl-5 drop" with no reason); the reason is from the card.
- **What stays:** the policy file, its card and its held-out results stay as a research result. The card says "Research result only: the API does not run it".
- **What it was:** six numbers: four weights on the vitals' baseline z values, a threshold and a persistence. It alerts when the weighted sum stays above the threshold ([card](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/models/tier_b/reward_policy/card.md)).
- **How it was found:** a (1+30) evolution strategy. The reward per trial is episodes caught early, minus 0.5 × episodes × (the policy's alert rate over NEWS2's). A candidate is kept only if it beats the current policy on 12 fresh trials by a one-sided paired t-test at 5%. The stop rule was fixed before the run. The card says it is "not deep or per-step reinforcement learning".
- **Outcome of the search:** one accepted step in round 1. Round 2 accepted nothing and was dropped.
- **Held-out set 1:** alone, 0.153 alerts per patient per 12 h (NEWS2 0.414) and a median lead of -3.8 minutes (NEWS2 +47.2). Added to NEWS2: 7 more of 91 episode windows at 1.12 times the alerts; "No gain beyond chance is shown."
- **Held-out set 2:** see the table in 6.5. Added to NEWS2, "a loss is shown".

#### Distilled student and its teacher (Tier C)

- **What:** the student is a network with one hidden layer of 32 units: 35 inputs, 1,185 parameters, 5,334 bytes as ONNX. It gives one probability per scored 15-minute bin that an episode is starting ([card](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/models/tier_c/student_vitals/card.md)).
- **Inputs:** per vital, the value, its z from the patient's own baseline, the change over 1 hour and 4 hours, and missing flags; plus the NEWS2 total, on oxygen, and consciousness not alert. Each bin reads only earlier bins of the same stay. Missing is a zero and a flag; nothing is imputed.
- **Label:** positive from the true episode start to fully in. About 0.3% of bins are positive.
- **Training:** MindSpore 2.11.0. A teacher (two hidden layers of 256, 79,873 parameters) is fitted to the true labels. The student is fitted to the teacher's outputs and never sees a label. Seeds 61 to 160 train; seeds 261 to 300 stop training, choose the model and set the threshold (0.006, the smallest whose alerts and time in alert are at most NEWS2's).
- **Validation, stated by the card:** the distilled student's log loss (0.018969) "is not better than the same small network fitted on the true labels (0.018925)". "So distillation bought nothing measurable here."
- **Exports:** MindIR, ONNX, MindSpore Lite (`.ms`, converted and checked on 20 rows) and a plain JSON file. The API reads only the JSON and imports no ML library ([`INTEGRATION.md`](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/models/INTEGRATION.md)).
- **Not done:** it was not run on a small ARM board or a ward hub. Nothing was run in the cloud.
- **Stays past 7 days get no flag.** The API no longer stores the admission baseline. The reason shown is "stay past 7 days: admission baseline not kept". `models/INTEGRATION.md` line 740 gives the reason: on 50 training stays over 7 days (of 298), scoring only the last 7 days changed the student's alerts (of 1,819 bins that alert with the admission baseline, 1,060 still alert), and "that rule was never evaluated, so it is not run". The student's and check's cards were not re-read for this line.
- **Two inputs are dead:** "consciousness not A" and the value-missing flags were constant 0 in training, so the student ignores them.

#### Confidence check (Tier C)

- **What:** split-conformal calibration on the student. One quantile q is taken from one negative bin per stay in seeds 301 to 340 (3,238 stays). The student alerts only when its probability is at least the threshold and above q; otherwise it is "not sure" and stays quiet ([card](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/models/tier_c/confidence_check/card.md)).
- **What it controls:** for a patient who is not deteriorating, at most 1 in 100 of their 15-minute checks shows a supported alert, on average over stays (alpha 0.01).
- **What it does not control:** the share of alerts that are true. The card: "even when the target is met, most supported alerts are false."
- **Held-out:** achieved error 0.0065 on set 1 and 0.0070 on set 2, against 0.01. The pre-registered target was met on both, inside the simulator.
- **Cost:** it removes about 6 in 10 of the student's alerting bins. On set 1 it lost 8 of the 61 episodes the student was alerting in, and it alerted in 0 of 27 hypotensive episodes.
- **Limit:** the card says that mathematically the check "is a second threshold". By the code's own rule, the target cannot be claimed on a live ward run.
- **In the system:** the API runs the student with this check. The row shows "Prediction model flag (synthetic, not validated)" only when the check says "alert"; "not sure" shows no flag.

#### The research agent's language model

- **What:** a LoRA adapter on `Qwen/Qwen2.5-0.5B-Instruct` (Apache-2.0), for one narrow job: routing a clinician's question to one of three fixed experiments, or refusing ([card](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/models/agent/card.md)).
- **Data:** text generated from the project's own rule planner and question frames. "No patient data of any kind."
- **Result on its blind held-out questions:** after the guard, "the tuned model alone is worse than the keyword matcher" (7 of 30 answerable questions right, against 13).
- **Status:** optional, off by default, "not running anywhere yet". It cannot touch the rank or the arbiter. The separate patient question worker uses a keyword matcher and fixed sentences; "No model chooses anything in this version" ([card](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/research/patient_agent/card.md)).

### 6.5 Reported numbers

**Held-out set 1** (ward-v2 seeds 11 to 30: 20 trials, 1,873 patients, 91 episodes, 79 not cut short). Source: [`held_out.txt`](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/models/tier_c/student_vitals/held_out.txt) and the student and confidence cards.

| Rule | Alerts per patient per 12 h (95% interval) | Time in alert | New alert in window, all episodes | Any bin, all episodes (95% interval) | Chance | Excess |
|---|---|---|---|---|---|---|
| NEWS2 chart trigger | 0.414 (0.395 to 0.434) | 0.158 | 0.363 (33/91) | 0.626 (0.522 to 0.727) | 0.473 | +0.210 |
| NEWS2 total 5 or more | 0.340 (0.322 to 0.357) | 0.120 | 0.396 (36/91) | 0.571 (0.462 to 0.675) | 0.376 | +0.244 |
| Student | 0.413 (0.394 to 0.430) | 0.064 | 0.560 (51/91) | 0.670 (0.570 to 0.762) | 0.319 | +0.415 |
| NEWS2 or student | 0.525 (0.507 to 0.543) | 0.185 | not repeated here | 0.747 (0.655 to 0.831) | 0.580 | +0.243 |
| Student with the confidence check | 0.128 (0.116 to 0.140) | 0.026 | not repeated here | 0.582 (0.473 to 0.681) | 0.089 | +0.544 |

Chance and excess are for episodes not cut short and have no interval.

The Intelligence README's headline table uses the "new alert" column: NEWS2 36% (33 of 91) and the student 56% (51 of 91) at the same alert count. The student's own card adds two cautions about that column: the two intervals "miss each other by less than 0.001", and NEWS2 already had an alert open in 24 episodes, so "it raises fewer new alerts inside the window by construction. Treat this as weak." On the "any bin" measure the intervals overlap. Added to NEWS2, the card's verdict on set 1 is "No gain beyond chance is shown."

**Held-out set 2** (seeds 1001 to 1400: 400 trials, 37,062 patients, 1,743 episodes, 1,601 not cut short). Source: the cards and [`models/held_out_2/analysis.txt`](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/models/held_out_2/analysis.txt). The cards say: "Set 2 is the larger read and is the one to quote."

| Rule | Alerts per patient per 12 h | Time in alert | Any bin (not cut short) | Chance | Excess | Median lead (min) |
|---|---|---|---|---|---|---|
| NEWS2 chart trigger | 0.415 | 0.166 | 0.785 (1257/1601) | 0.479 | +0.306 | 46.6 |
| Teacher | 0.397 | 0.071 | 0.743 (1189/1601) | 0.290 | +0.452 | 81.1 |
| Student | 0.425 | 0.065 | 0.751 (1202/1601) | 0.308 | +0.443 | 82.9 |
| NEWS2 or student | 0.521 | 0.193 | 0.843 (1350/1601) | 0.577 | +0.266 | 99.8 |
| Student with the confidence check | 0.132 | 0.025 | 0.691 (1106/1601) | 0.084 | +0.607 | 38.9 |
| NEWS2 or checked student | 0.435 | 0.172 | 0.820 (1313/1601) | 0.496 | +0.325 | 71.5 |
| Reward policy, final | 0.164 | 0.036 | 0.669 (1071/1601) | 0.132 | +0.537 | 15.2 |
| NEWS2 or reward policy | 0.470 | 0.186 | 0.828 (1326/1601) | 0.534 | +0.294 | 64.1 |

The three pre-registered comparisons, "NEWS2 or X" against NEWS2 alone, on the gain in excess over chance (98.33% interval, trials as the unit):

| Added to NEWS2 | Gain in excess | Interval | Alerts against NEWS2 | Verdict |
|---|---|---|---|---|
| Student | -0.0401 | -0.0542 to -0.0253 | 1.254 times | a loss is shown |
| Student with the confidence check | +0.0181 | +0.0080 to +0.0291 | 1.048 times | a gain beyond chance is shown |
| Reward policy, final | -0.0127 | -0.0245 to -0.0001 | 1.131 times | a loss is shown (at the edge) |

**Reading these numbers honestly:**

- On the larger set, the student alone alerts in slightly fewer episode windows than NEWS2 (0.751 against 0.785) at a similar alert count, with much less time in alert (0.065 against 0.166) and a lower chance rate.
- Adding the student or the reward policy to NEWS2 brings more alerts than it brings detections beyond chance. Only the checked student shows a gain, and it is small: about 1.8 points, bought with 4.8% more alerts.
- Hypotensive episodes are the weak spot for every rule: on set 2 the student alerts in 92 of 458 and NEWS2 in 169 of 458. In 295 of the 458, NEWS2 saw no new blood pressure.
- **All of it is circular.** The same simulator makes the data, the episodes and the labels, and judges the alerts. The baseline card: results on simulator data "are an upper bound". These are statements about this simulator, not about patients.

## 7. Data handling and limits

### 7.1 What is stored and what is not

- **No dataset is committed** to either repository. The fit scripts read a local folder. The committed outputs hold aggregate statistics only: "no recording and no single patient's values" ([`NOTICE.md`](../NOTICE.md)).
- **No real patient data** is in the API's database. Every run is `fixture` or `synthetic`, and the database refuses a run whose synthetic flag is false ([`0002_drop_eicu_replay.sql`](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/backend/src/biosentry/db/migrations/0002_drop_eicu_replay.sql), lines 21 to 22).
- **The simulator writes only synthetic sources** to the API. A source with `synthetic: false` is never registered ([`README.md`](../README.md) line 332).
- **Trial data** stays outside both repositories. Trial files hold no names.

### 7.2 Licences

| Item | Licence | Source |
|---|---|---|
| Code, both repositories | MIT | `LICENSE` |
| `fitted.json`, `calibration.json` | ODbL v1.0, with attribution | [`NOTICE.md`](../NOTICE.md) |
| eICU-CRD Demo | ODbL v1.0 | `NOTICE.md` |
| BIDMC, MIT-BIH Arrhythmia, AFDB, LTAFDB | ODC-By v1.0 | `NOTICE.md` |
| NEWS2 tables | Belong to the RCP; not covered by the MIT licence | `NOTICE.md` |
| Simulator trials | None stated: the project's own output | Intelligence data cards |

### 7.3 Open licence questions

- **NEWS2 in software.** The RCP's page says there is no copyright restriction on NEWS2, on conditions the repository follows: acknowledge the RCP, do not modify the material. But "The RCP page does not address software", so "its application to code is unconfirmed" ([`README.md`](../README.md) line 359). The Intelligence NEWS2 card still lists the licence as "unverified". The RCP has not been asked.
- **Publishing fitted statistics under ODbL.** `fitted.json` mixes statistics from one ODbL database and four ODC-By databases and is published under ODbL. `NOTICE.md` ends: "This notice is not legal advice." A team note records that this reading has had no qualified review. No committed file records one.
- **Licences were not re-checked for this document.** The table above repeats what the repositories record.

### 7.4 Considered and rejected

| Choice | Decision | Reason | Source |
|---|---|---|---|
| MIMIC-IV for the public generator | Rejected | "its terms treat derived data as sensitive, which rules it out for a public generator" | [`README.md`](../README.md) line 310 |
| Replaying real eICU stays on the ward | Built, then removed | The ward became one shared synthetic ward | Commit `40f1527`; Intelligence migration 0002 |
| A fixed 0.6 °C temperature rise per episode | Removed | It had no source, and it flattered every detector that read temperature | [`README.md`](../README.md) line 306; baseline card |
| Raw eICU counts for the episode mix | Not used | ICU sedation and drugs would make hypotension half of events | `source.ts` lines 292 to 294 |
| A rhythm check against SHDB-AF | Not built | "no honest check can be built from it": the simulator has no ECG signal, so the comparison would test the source recordings, not the simulator | [`docs/realism.md`](realism.md) |
| An outcome figure in `npm run compare` | Off by default | Nothing in the run responds to a warning. The optional figure is labelled a model assumption | [`docs/compare.md`](compare.md) |
| Other datasets (table in 2.1) | Not used | Credentialed, non-commercial, ICU-only, intraoperative, or unlicensed | Team notes, not committed |

### 7.5 What has not been validated

- **Nothing has been validated on ward patients or on Philippine patients.** No open ward-level dataset was found ([`README.md`](../README.md) line 302).
- The generator's dynamics come from US ICU stays in 2014 to 2015. Real ward patients may be steadier.
- The deterioration definition is the project's own. "No open dataset labels deterioration and no source validates these rules."
- Hypotensive episodes are ICU-derived, fast, and may reflect sedation or drugs.
- AF episodes are short (median a few minutes), as recorded in patients referred for AF.
- Every model result is from one simulator judged on itself.
- The one real-data test (eICU, section 2.7) drew no conclusion.
- The hardware (patch, gateway, edge server) is a described design. "None of it is built."
- The student was not run on ward hardware. Nothing was run on Huawei Cloud.

### 7.6 What real patients would need

Drawn from the repositories' own stated limits; none of this has been done:

- A real, de-identified ward dataset. The simulator has one seam for it, the `VitalsSource` interface ([`README.md`](../README.md), "Adding another dataset").
- A change to the API's rule that accepts only synthetic runs, "and a validation first" (Intelligence README, "Your own feed").
- A deterioration label from real outcomes, in place of the project's own rule.
- Validation of NEWS2 input handling on local data. The NEWS2 card's status is "implemented, not validated on local data".
- Recalibration of the confidence check on real stays. Its guarantee holds only inside the simulator.
- An identity provider, and the privacy rules already listed for the Philippines' Data Privacy Act (rule I7 in the Intelligence README).
- Qualified review of the two open licence questions.
- Intelligence rule I5 would apply: "No training on BioSentry patients: local data calibrates and validates only."

## 8. How to reproduce

No dataset is downloaded by any command. Get each one from its PhysioNet page (section 2.1).

### 8.1 Simulator (this repository)

```bash
npm install
npm test
```

Fit the generator. The folder must hold `eicu-crd-demo-2.0.1`, `bidmc-1.0.0`, `mitdb-1.0.0`, `afdb-1.0.0` and `ltafdb-1.0.0`. It writes `src/sim/fitted.json`:

```bash
npm run fit -- ~/Documents/datasets
```

Fit the calibration file. The folder is the one holding the eICU `.csv.gz` tables. It writes `src/sim/calibration.json`:

```bash
npm run fit:calibration -- <folder holding the eICU .csv.gz files>
```

Print the realism table (about three minutes), or also write it as JSON:

```bash
npm run realism
npm run realism -- --json trials/realism.json
```

Run the realism tests alone:

```bash
npx vitest run src/sim/sim.test.ts src/sim/calibration.test.ts src/sim/published.test.ts
```

Make one ward trial, as the data cards record it (the commit string is written into the manifest):

```bash
npx vite build --ssr src/trial.ts --outDir dist/trial --logLevel warn
TRIAL_SIM_COMMIT=<commit> node dist/trial/trial.js --scenario scenarios/default.json --seed 11 --days 30 --out seed-11
```

Compare two warning rules on the same patients, and run a hospital trial:

```bash
npm run compare -- --seed 4 --days 30 --baseline rule=news2_total_ge_5 --change rule=news2_chart_trigger --out trials/compare-w4
npm run hospital-trial -- --scenario scenarios/hospital/typical.json --seed 101 --days 30 --out trials/typical-101
```

### 8.2 Models (Intelligence repository)

Run from the repository root, inside the research environment. Setting it up is described in [`research/README.md`](https://github.com/kitchen-station/BioSentry-Intelligence/blob/main/research/README.md), "Gate (ML-GATE)". Trial folders are passed in from outside the repository.

NEWS2 and the own-baseline rule on held-out set 1, and the baseline sweep:

```bash
python -m research.evaluate <trial folder>...
python -m research.sweep <ward-v2 folders> --write-params models/tier_b/baseline/params.json
```

Train the student, export it, calibrate the confidence check, run the reward search:

```bash
python -m research.train_student /data/trials/ward-v2-ext/seed-{61..160} /data/trials/ward-v2-ext/seed-{261..300} --lite_rows <dir> --run_log training/runs/student_vitals/<run_id>.json --commit <sha> --run_id <run_id>
python -m research.export_plain
python -m research.confidence calibrate /data/trials/ward-v2-ext/seed-{301..340} --run_log training/runs/confidence_check/<run_id>.json --run_id <run_id> --commit <sha>
python -m research.reward_loop --data /data/trials/ward-v2-ext --out models/tier_b/reward_policy --round 1
```

Check that the shipped model files match their manifest:

```bash
python -m research.manifest --check
```

NEWS2 and the baseline rule on the real eICU test hospitals (about 30 seconds):

```bash
python -m research.realdata.evaluate /data/eicu-crd-demo/2.0.1
```

**Held-out commands. Do not run these again on the same seeds.** Each was run once. Re-running reads the held-out sets a second time, which the procedure forbids. They are listed so the method can be checked, and so they can be run on a new, declared set:

```bash
python -m research.evaluate_student <ward-v2 seed-11..30 folders> <ward-v2-ext seed-61..160 folders> --json models/tier_c/student_vitals/held_out.json > models/tier_c/student_vitals/held_out.txt
python -m research.confidence evaluate <ward-v2 folders of seeds 11-30> --json models/tier_c/confidence_check/heldout.json
python -m research.reward_loop --evaluate /data/trials/ward-v2 --out models/tier_b/reward_policy
python -m research.evaluate_student <set-2 folders> <ext 61-160 folders> --held-out-set 2 --cache /cache --json models/tier_c/student_vitals/held_out_2.json > models/tier_c/student_vitals/held_out_2.txt
python -m research.confidence evaluate <set-2 folders> --held-out-set 2 --json models/tier_c/confidence_check/heldout_2.json
python -m research.reward_loop --evaluate /data/trials/ward-v2-heldout2 --held-out-set 2 --out models/tier_b/reward_policy --json models/tier_b/reward_policy/held_out_2.json > models/tier_b/reward_policy/held_out_2.txt
python -m research.heldout2 analyse <the three JSON files> --out models/held_out_2/analysis.json
```

The research tests run with the two gate commands in `research/README.md` ("Gate (RESEARCH-GATE)" and "Gate (ML-GATE)").

## 9. Where notes and code disagreed

The code is what this page reports. Each disagreement found while writing it:

| Topic | One source says | The code or committed file says |
|---|---|---|
| Are the model cards, `INTEGRATION.md` and the README current? | The first draft of this page found the cards saying "not wired" while the code wired the student, confidence check and baseline | Resolved by Intelligence PR #80 and #88 (2026-11-16). The cards now agree with the code. `models/INTEGRATION.md` still carries older design-record sections that are labelled as such; its new status block is the current statement |
| Is the reward policy part of the system? | The first draft, the older cards and README: a reason-only flag | No. Dropped by owner decision models-rl-5; `services/models.py` does not load it (section 6.4) |
| Is the whole hospital display only? | Older sim notes and `docs/hospital-vitals.md` line 52 | Other units' people are now sent to the API as stays (`hospital/publish.ts`), though their vitals are still made by the W4 generator and only MED3A, MED3B and SURG5A are ranked. `hospital-vitals.md` line 52 is out of date (the updated `vitals.test.ts` shows the runner's hospital mode now makes the engine) |
| What is the default scenario? | Sim docs written before the change: the hand-written 12 | In hospital mode `WARD_SCENARIO` defaults to `typical`; `pitch` keeps the hand-written 12. The runner's `WARD_MODE` default is still `ward`. Whether the team server runs hospital mode is not in the code |
| How many datasets does the generator fit read? | [`README.md`](../README.md) line 269 and the usage comment in `fit-generator.mjs` line 3: four | Five. The script also reads `ltafdb-1.0.0` (lines 524 to 534), and `NOTICE.md` lists five |
| Which command writes `calibration.json`? | The usage comment in `fit-eicu.mjs` line 2: `npm run fit` | `npm run fit:calibration` (`package.json`). `npm run fit` runs the generator fit |
| What does `calibration.json` supply? | Its header comment: "the synthetic generator's dynamics constants" | Only the peak hour of the 24-hour rhythm is read by the generator (`source.ts` line 142). The dynamics constants now come from `fitted.json` |
| How many known misses? | [`README.md`](../README.md): three | Six, counting the two calibration checks and A4. `docs/realism.md` explains the difference. The tests and `realism.md` are unchanged at `b804a3d`, so the README is still stale |
| Time at NEWS2 5 or more | [`README.md`](../README.md) line 298: "about 14%" | The comment in `published.test.ts` line 92: "about 15%". Neither figure is printed by a test |
| May model results be reported from synthetic data? | [`README.md`](../README.md) line 288: "no model result may be reported from this synthetic data" | The Intelligence repository reports them, labelled synthetic and not clinical (section 1) |
| Which eICU baseline settings gave the published numbers? | `params.json` now holds k 4.0, p 8 | The eICU run used k 3.0, p 4. The card says a re-run "would not reproduce the published baseline numbers. It has not been re-run" |
| What trains the reward policy? | A team note and the ward-v2 data card: ward-v2-train seeds 31 to 60 | The reward-policy card: seeds 401 to 584 of ward-v2-ext. Seeds 31 to 60 served only the pilot for the power note |
| Episode ramp lengths | An older team survey: ramps of 20 to 30 minutes, four sources | `fitted.json`: ramps over hours (medians 60 to 300 minutes), five sources |
| Line numbers | The team's dataset survey cites `source.ts` lines at an older commit | This page cites sim lines unchanged since `881fb13` (the files were checked as unchanged at `b804a3d`); README line numbers are from `881fb13` |
