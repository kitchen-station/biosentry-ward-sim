# BioSentry ward simulation

**Live demo:** <https://biosentry-ward-sim.pages.dev> (synthetic patients; deploys from `main`)

An interactive demo of how BioSentry Intelligence would behave on a live ward. Twelve patients sit on ward W4, covered by two staff nurses, a charge nurse and two physicians. Samples travel through the pipeline, the ranked list changes, and nurses and physicians respond.

It runs on two sources: synthetic patients wearing chest patches, or real de-identified ICU stays replayed on the same simulated ward. The synthetic patients' movement is fitted to real open datasets; see [Fitted to real data](#fitted-to-real-data).

Advisory only. BioSentry does not replace a monitor alarm. This demo makes no clinical claim.

## Run it

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

CI runs the tests and the build on every push and pull request. Dependabot proposes dependency updates weekly.

`npm install` needs the committed `package-lock.json`. Without it, npm 10 fails while resolving Vitest's optional peers.

## Feed the BioSentry dashboard

The sim is the ward. The [BioSentry dashboard](https://github.com/garcieee/BioSentry-Intelligence) is the clinician's view of it. While the sim page is open, its dev server answers the dashboard's API at `/api`, using the dashboard's own data shapes:

```bash
npm run dev -- --port 5180
```

Then, in the dashboard's `frontend` folder:

```bash
VITE_API_URL=http://localhost:5180/api npm run dev
```

Sign in as a clinician on the sim's staff (Nurse de la Cruz, Nurse Reyes, Charge Nurse Manalo, Dr. Santos or Dr. Aquino). Each one sees only the patients on their own list, live: same ranks, NEWS2 totals and NOT RANKED rows as the sim's ranked list. The two staff nurses see 6 patients each, the physicians 5 each, and the charge nurse all 12. The fixture gives p-004 and p-005 no physician, so neither physician sees them.

- The sim page sends its ward to `POST /api/snapshot` every 2 seconds (`src/bridge/snapshot.ts`). Keep the tab open, or the dashboard stops updating.
- `src/bridge/api.ts` answers `POST /session`, `GET /wards/W4/rows`, `GET /patients`, `GET /patients/{id}` and its notes. Scoping is on the server and each view is logged as `[audit]` in the dev server's terminal.
- It is read-only. Notes, admissions, labs and vitals entry answer 501, because the sim owns the ward.
- Labs, Tier B and Tier C are not simulated, so they arrive empty, never made up.
- Identity is a stub: any staff id gets a token. The API exists only on the local dev server; never expose it on a network.

## Feed the BioSentry database

The sim can also write to the BioSentry database API. Start the API from the dashboard repo with `make api-dev` (it listens on port 8000), then run the sim with the API's address and ingest key:

```bash
VITE_API_URL=http://127.0.0.1:8000 VITE_INGEST_KEY=dev-local npm run dev
```

With `VITE_API_URL` unset, nothing is sent. Each world (first load, restart, switching to the replay) registers a new run with its 12 patients, their minute-0 state and the last 3 hours of history. About once a second the page then sends a batch of what changed:

- **Observations:** the four device vitals, and the nurse-charted blood pressure, consciousness, oxygen and SpO2 scale. A value is sent only when it or its quality changes. A vital with no usable reading is sent as absent, with the reason, never as a made-up value.
- **Bins:** the 15-minute medians behind the trend charts.
- **Events:** the sim's log lines.
- **Patients:** trend, signal quality and the minute of the last sample.

If the API is down, the rows wait and go with the next batch. The queue holds 50,000 rows of each kind; past that the oldest are dropped. The sim runs the same either way. `src/sim/ingest.test.ts` runs the headless sim through a real sync and checks that the API's ranks, scores and NOT RANKED reasons equal the sim's every 15 sim-minutes. It needs a running API: `BIOSENTRY_API=http://127.0.0.1:8000 BIOSENTRY_INGEST_KEY=dev-local npx vitest run src/sim/ingest.test.ts`.

The dev-server bridge above stays for now. A physician's list is the fixture's: p-004 and p-005 are stored with no physician.

The eICU replay is stored too, flagged as `eicu_demo` and not synthetic. It is real de-identified data, so run `make db-purge-eicu` in the dashboard repo before sharing the database.

## What you can do

- Switch between synthetic patients and the eICU replay.
- Set the speed: pause, 1x, 10x or 60x. Staff movement is capped at 6x so walks stay visible.
- Click a bed, a staff member or a machine to zoom in on it and see only its details. A patient shows the five vitals (heart rate, respiratory rate, SpO2, temperature and blood pressure), an illustrative ECG strip, and the reasons in plain words.
- Start a deterioration or an AF episode (synthetic only), detach a patch, apply a patch, or record a blood pressure.
- Click the WARD LIST screen at the nurse station for the ranked list.

## How it works

| Stage | Where |
|---|---|
| Vitals source, the seam for a real dataset | `src/sim/source.ts` |
| eICU replay source | `src/sim/replay.ts` |
| eICU extract | `scripts/extract-eicu.mjs` |
| Calibration fit and its output | `scripts/fit-eicu.mjs`, `src/sim/calibration.json` |
| Database writer | `src/sim/sync.ts` |
| Quality gate, staff loop, commands | `src/sim/sim.ts` |
| NEWS2, ported from BioSentry | `src/sim/news2.ts` |
| Arbiter and ranking, ported from BioSentry | `src/sim/arbiter.ts` |
| Ward map and pathing | `src/sim/map.ts` |
| Isometric renderer and sprites | `src/render/` |
| Panels | `src/panels.tsx` |

### The floor plan

Ward W4 is laid out like a real cardiology ward. One corridor runs from the entrance past every room:

- **High-dependency bay** (4 beds): glazed toward the nurse station. The four sickest patients at the start go here.
- **Female bay and male bay** (6 beds each): single-sex bays, three beds filled in each.
- **Side rooms** (4): single rooms with their own toilet, two in use.
- **Nurse station:** a counter on the corridor facing the high-dependency bay, with the medication room and clean utility behind it.
- **Doctors' office:** desks for both physicians.
- **Support rooms:** the sluice, the relatives' room, and the edge server room for the BioSentry pipeline.

The ward has 20 beds. The 12 occupied ones carry the BioSentry dashboard's bed labels (1C, 2B, 3A and so on); the other 8 are empty. Patients keep their bed for the whole run; they do not move as their scores change. The replay uses the same 12 beds: the first four stays take the high-dependency beds and the rest take a bed of their sex.

The flow follows the Kitchen BioSentry page: chest patch, BLE to the ward gateway, IoT Device Access to the ward edge server, and a synced copy in Huawei Cloud. NEWS2 and the arbiter run on the edge server. Clicking a machine shows whether that stage is built, planned or a demo rule. Anomaly detection, conformal abstention and the explainer agent are planned and not simulated.

Kitchen also shapes three other things:

- **Ward size:** Kitchen says one nurse has 20 to 50 patients, against a DOH standard of 12. The sim mirrors the dashboard's roster instead: 12 patients and two staff nurses, about 1:6. It does not show the workload pressure Kitchen describes.
- **ECG:** the patch sends ECG. The chart draws an illustrative strip from the heart rate, irregular for the AF patient. It is not data and nothing analyses it. The eICU demo has no waveforms, so the replay shows none.
- **Explainer agent:** planned in the product. The chart shows a fixed template in its place, built from the NEWS2 breakdown and the RCP responses. It is not an AI agent and it does not rank.

The sim is plain data with no React or canvas, so it runs headless in tests. At minute 0 it reproduces the BioSentry fixture: all ten NEWS2 totals, the rank order, the reason strings and the NOT RANKED text. `src/sim/sim.test.ts` checks this against `src/sim/synthetic.json`.

### The eICU replay

The replay uses 12 stays from the [eICU-CRD Demo 2.0.1](https://physionet.org/content/eicu-crd-demo/2.0.1/), which is open under ODbL v1.0. The data is not in this repository. To add it locally, put these four files in a folder outside the repo: `patient.csv.gz`, `vitalPeriodic.csv.gz`, `vitalAperiodic.csv.gz` and `nurseCharting.csv.gz`. Then run:

```bash
npm run extract -- /path/to/that/folder
```

On the author's machine the files live in `~/Documents/datasets/eicu-crd-demo-2.0.1`, with PhysioNet's `SHA256SUMS.txt` beside them.

That writes `public/replay/eicu-12.json`, which git ignores, and turns on the eICU replay button. If you share an extract, ODbL requires attribution and keeps it under the same licence.

This is real ICU data on a simulated ward. It is not ward data, and it is not from a chest patch. The stays are US ICU stays, the monitor stands in for the patch, and NEWS2 scores run high because these patients are sicker than a ward population. The 12 stays were hand-picked from 39 cardiac, awake, unventilated stays discharged alive, for a spread of NEWS2 paths. Every stay has all inputs at the start. They are not a representative sample.

| Input | Replay source | Rule |
|---|---|---|
| HR, RR, SpO2 | Monitor, every 5 minutes | Median of 2 of 3 readings in 15 minutes, NOT RANKED after 30 minutes |
| Temperature | Nurse charting | Holds 8 hours |
| Blood pressure | Non-invasive cuff | Holds until the next reading |
| Oxygen | Nurse charting | Holds until the next entry; any flow except 0 or 21 counts as on oxygen |
| Consciousness | GCS from nurse charting | GCS 15 is Alert, lower is new confusion |
| SpO2 scale | Not recorded | Scale 1 for everyone |

Counting a change when the score differs from 15 minutes earlier, scores change about 24.5 times an hour across the 12 replay patients, about 2.0 per patient. The synthetic patients change about 2.5 times an hour across all 12 (2.54), about 0.2 per patient. That figure counts non-overlapping 15-minute samples over 24 hours, for the 12 patients, mean of seeds 1 to 5, after the calibration below. The previous constants give 1.01 by this same method. The replay's figures were not re-measured, and the replay source does not use these constants. That is left visible, because smoothing it would change how the arbiter behaves.

### Fitted to real data

`src/sim/calibration.json` (from `npm run fit:calibration`, cohort of 885 eICU stays, adult, alive, awake, 12 hours or more) supplies the hour each 24-hour rhythm peaks and the held-out range used by `src/sim/calibration.test.ts`. Its 25% scaling (`LIVE_WANDER`) is gone: the ward now runs at full fitted size. Its RR and SpO2 checks at 5 minutes are marked as known misses, because this generator takes that noise from BIDMC.

`src/sim/fitted.json` replaces the generator's hand-set constants. It holds aggregate statistics only: no recording and no single patient's values. To rebuild it, put the four datasets in one folder and run:

```bash
npm run fit -- ~/Documents/datasets
```

| Generator part | Source | Licence |
|---|---|---|
| Vital-sign drift, how fast it moves, how vitals move together, patient-to-patient spread | [eICU-CRD Demo 2.0.1](https://physionet.org/content/eicu-crd-demo/2.0.1/) | ODbL v1.0 |
| Blood pressure drift, cuff noise, how diastolic follows systolic | eICU-CRD Demo | ODbL v1.0 |
| Deterioration size and speed, in three kinds: respiratory, tachycardic, hypotensive | eICU-CRD Demo | ODbL v1.0 |
| Minute-to-minute noise for HR, RR, SpO2 | [BIDMC PPG and Respiration 1.0.0](https://physionet.org/content/bidmc/1.0.0/) | ODC-By v1.0 |
| Premature beat rates and timing | [MIT-BIH Arrhythmia 1.0.0](https://physionet.org/content/mitdb/1.0.0/), 100 series only | ODC-By v1.0 |
| AF beat irregularity, rate change | [MIT-BIH Atrial Fibrillation 1.0.0](https://physionet.org/content/afdb/1.0.0/) | ODC-By v1.0 |
| AF episode length | AFDB and [Long Term AF Database 1.0.0](https://physionet.org/content/ltafdb/1.0.0/) | ODC-By v1.0 |

`fitted.json` is published under ODbL v1.0. Attribution and citations are in [NOTICE.md](NOTICE.md).

Every fourth eICU hospital (46 of 186) is kept out of fitting. `src/sim/sim.test.ts` checks the generator's variability and 5-minute correlation, and its systolic step sizes at 30 and 180 minutes, against those held-out hospitals. That checks realism only. It says nothing about how well BioSentry predicts, and no model result may be reported from this synthetic data.

`src/sim/published.test.ts` runs the ward for 30 simulated days, six times, and checks the last 20 days against published ward figures, using fixed tolerances. Heart rate, respiratory rate, systolic, oxygen use, patch data loss, occupancy and the 24-hour heart rate and respiratory rate swings pass. Three checks are marked as known misses:

| Known miss | Sim | Published |
|---|---|---|
| Observation sets at NEWS 5+ | about 35% | about 20% (RCP 2012, medical wards) |
| Observation sets at NEWS 7+ | about 18% | about 10% |
| SpO2, low end | 1st to 10th percentiles 90 to 93 | 86 to 91 (Welch 2015) |

Patients spend about 14% of their time at NEWS2 5 or more. Observation sets show more because the test samples sick patients at the NEWS2 minimum frequency (hourly at 5 or more), and real wards often fall short of that. Respiratory rate adds the most points. The tolerances are judgement. RCP's figures are for NEWS 2012, not NEWS2. A marked check turns the build red once it starts passing, so the marker must then come off.

Limits:

- **No ward data:** no open ward-level dataset was found. The dynamics come from ICU stays, restricted to six-hour windows with ward-like medians, and applied around the ward patients' own baselines. Real ward patients may be steadier.
- **Deterioration events are physiological rise events, our definition:** a rise of 4 or more in an hourly three-vital NEWS2 (HR, RR, SpO2) held for 2 hours, or two cuff readings at or below 100 systolic and at least 20 below baseline. No open dataset labels deterioration and no source validates these rules.
- **Hypotensive events are ICU-derived:** they are fast (median about an hour) and may reflect sedation or drugs. The patch does not measure blood pressure, so a hypotensive event shows only when a nurse takes a cuff reading. Some go unseen on a low-risk patient, as they could on a real ward.
- **Still hand-set:** the mix of event kinds (55% respiratory, 20% tachycardic, 25% hypotensive, a judgement because no published split exists), temperature noise and deterioration rise, circadian size for temperature, and the value clamps. Patch dropouts use ViSi Mobile ward pilot figures for rate and length, with a judgement 4-hour cap. The time of day each rhythm peaks comes from eICU.
- **AF episodes are short:** the median is a few minutes, as recorded in patients referred for AF, so a Start AF episode can end quickly.

MIMIC-IV is not used: its terms treat derived data as sensitive, which rules it out for a public generator.

### Patient flow

The synthetic ward in the app admits and discharges patients. Tests of the fixture turn this off with `createSyntheticSource(seed)`; the app passes `true` as the second argument. The 12 starting patients leave over the first days and new patients take their place, using all 20 beds. When `VITE_API_URL` is set, flow is off and the ward keeps its 12 patients, because the database API registers a fixed roster when a run starts.

| Part | Value | Source |
|---|---|---|
| Occupancy | about 75% | Philippine Heart Center 73-76%; the admission rate is set from this |
| Length of stay | Lognormal by condition, capped at 30 days | PhilHealth 2014 and 2017 medians and spreads |
| Baseline vitals of a new patient | Drawn from real six-hour medians | eICU-CRD Demo, ward-like windows; each vital drawn separately |
| On oxygen at admission | 39% | Pimentel 2019; the share of stay on oxygen is tuned to match 18-19% of observation sets |
| AF | 8% pre-existing, 5% new onset | Published cardiac cohorts |
| Deterioration | 6.1% of admissions, at a random time in the stay | Churpek 2016 |
| Discharge time | About 15% before noon, median near 15:00 | US sources only |

Case mix (35% heart failure, 45% coronary medical, 20% coronary procedure), age range, and the 48-hour hold before moving a patient with NEWS2 of 5 or more to higher care are judgement. Moving to higher care leaves the ward; it is not modelled further. Admission figures come from whole hospitals, not one ward.

### Adding another dataset

Implement `VitalsSource` in `src/sim/source.ts` and pass it to `createSim`. `src/sim/replay.ts` is the working example. A source supplies the patients, its gate rules, device samples and, if it has them, charted values. Leave out `inject` and the deterioration button goes away.

## What is demo design, not product

BioSentry only ranks and displays. A human decides. These parts were invented for this demo:

- **Staff response loop:** the product has no alert or acknowledgement flow. Messages, walks, assessments and physician calls are demo design.
- **Reassessment:** medium and high risk patients are seen at least every 60 sim-minutes.
- **Physician calls:** at NEWS2 5 or more the nurse calls the patient's physician, following the Kitchen page and RCP 2017 ("immediately inform the medical team"). Below 5, including a single parameter at 3, the nurse handles it.
- **Quality gate:** a 15-minute median of 8 or more usable readings, degraded after 15 stale minutes. The replay uses its own rules, listed above.
- **NOT RANKED cutoff:** 30 stale minutes.
- **Filled fixture gaps:** a cuff reading of 128/76 for p-004, a baseline for p-005, and a physician to call to the bedside for both. They are on no physician's list.
- **Hardware:** the patch, gateway and edge server are the described design. None of it is built.

The demo deliberately shows no recovery after review and no response-time figures. Either would imply an outcome benefit the product does not claim.

## Art

All art is drawn in this repository's code, in `src/render/`. The panel layout and status palette take their idiom from [Munder Difflin](https://github.com/HarnessMD/munder-difflin) (MIT). None of its assets are used.

## Licence

The code is under the [MIT License](LICENSE). The fitted data files are not: `src/sim/fitted.json` and `src/sim/calibration.json` are under ODbL v1.0, as set out in [NOTICE.md](NOTICE.md).

## Before sharing publicly

NEWS2: the RCP's page says there is no copyright restriction, on conditions this repository follows (see [NOTICE.md](NOTICE.md)). It does not mention software, so its application to code is unconfirmed. Queries go to cqid@rcp.ac.uk. BioSentry's own model card still lists the licence as unverified.
