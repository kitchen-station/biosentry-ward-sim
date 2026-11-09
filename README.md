# BioSentry ward simulation

**Live demo:** <https://biosentry-ward-sim.pages.dev> (synthetic patients; deploys from `main`)

An interactive demo of how BioSentry Intelligence would behave on a live ward. Twelve patients sit on ward W4, covered by two staff nurses, a charge nurse and two physicians. Samples travel through the pipeline, the ranked list changes, and nurses and physicians respond.

It runs on two sources: synthetic patients wearing chest patches, or real de-identified ICU stays replayed on the same simulated ward.

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
- Click a bed or a ranked row to open a chart with the five vitals (heart rate, respiratory rate, SpO2, temperature and blood pressure), an illustrative ECG strip, and the reasons in plain words.
- Start a deterioration (synthetic only), detach a patch, apply a patch, or record a blood pressure.
- Open Pipeline for stage counts and Log for ward events.

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

The flow follows the Kitchen BioSentry page: chest patch, BLE to the ward gateway, IoT Device Access to the ward edge server, and a synced copy in Huawei Cloud. NEWS2 and the arbiter run on the edge server. The Pipeline tab marks each stage built, planned, not built or demo rule, and lists the planned stages (anomaly detection, conformal abstention, the explainer agent) without simulating them.

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

### Calibration

The synthetic generator's dynamics are fitted from the same eICU-CRD Demo instead of set by hand. The generator is a small statistical model: per-vital Ornstein-Uhlenbeck wander, one latent factor shared by the vitals, a circadian cosine and white noise. To refit, with the same folder as the extract:

```bash
npm run fit -- /path/to/that/folder
```

That prints the fit and writes `src/sim/calibration.json`, which is committed.

**Cohort:** adult stays discharged alive, awake (median charted GCS 14 or more), with 12 hours or more of heart rate, respiratory rate and SpO2. That is 885 stays. Hospitals are split by a stable hash: 716 stays fit the numbers and 169 are held out. The 122 cardiac-unit stays (103 fit, 19 held out) are fitted separately for comparison and are not used.

**Method:** values outside the gate range are dropped and the rest snapped to a 5-minute grid. The circadian cosine is fitted on stays of 24 hours or more, on the raw values of each stay, separately from the detrended residuals. It is not subtracted before detrending, and the 6-hour median absorbs about 10% of the 24-hour amplitude. The cosine and sine coefficients are pooled by their median, separately. The amplitude moves about 20% with the pooling estimator, while the peak hour is stable. Everything else uses the residual from a rolling 6-hour median, so real trends do not inflate the wander. Tau comes from the 5 and 10 minute autocovariances: `tau = -5 / ln(C(10) / C(5))`, and the OU variance is `C(5)^2 / C(10)`. The ratio cancels the white noise that a lag-1 fit would mistake for fast dynamics. The latent factor is the first principal component of the HR, RR and SpO2 residual correlations, with a positive HR loading, in vital units. Wander is fitted on what is left after removing it. Each stay gives one estimate and the pooled value is the median.

| Fitted | Heart rate | Respiratory rate | SpO2 | Was |
|---|---|---|---|---|
| Coupling to the latent factor | 3.25 | 1.83 | -0.46 | 1.2, 0.35, -0.25 |
| Wander sd | 2.30 | 1.44 | 1.13 | 2.5, 0.6, 0.4 |
| Wander tau (min) | 19.4 | 16.3 | 17.0 | 20 for all |
| Circadian amplitude | 1.46 | 0.69 | 0.10 | 2.0, 0.3, 0 |
| Circadian peak (clock hour) | 21.6 | 21.2 | 19.5 | none |
| Fast noise sd at 5 minutes | not fitted | 1.25 | 0.50 | |
| Measurement noise per minute | 0.8 (hand-set) | 2.33 | 0.94 | 0.8, 0.4, 0.25 |

The fast noise is the white part of the detrended 5-minute series, `C(0) - C(5)^2 / C(10)`, fitted for RR and SpO2 only. It is measured only at 5-minute resolution and is assumed white below it. eICU stores 5-minute medians, and the sd of a median of 5 Gaussians is about 0.536 of one reading's, so the sim's per-minute noise is the fast sd divided by 0.536. Like the wander, it is multiplied by the `wander` scale. Heart rate and temperature keep their hand-set noise, and the AF irregularity is unchanged.

The latent factor's tau is 16.9 minutes (was 45). The circadian term is shifted to 0 at minute 0, so the fixture's values still hold there. `LIVE_WANDER` (0.25) scales the fitted wander and latent factor for the live demo; 1 is the fitted variability. It is the largest 0.05 step that keeps `sim.test.ts` score churn under its limit of 6 an hour: 0.25 gives 4.76, 0.30 gives 6.69, now that the fitted noise scales with it too. These figures use the churn test's metric (4 seeds, 8 patients, change against the previous minute), which differs from the per-hour figure above. A seed fixes the run, and `createSyntheticSource(seed, wander)` takes the scale.

**Not fitted:** temperature (charted about every 3.4 hours, too sparse), the heart rate and temperature measurement noise (the data is 5-minute, so 1-minute noise is not visible; RR and SpO2 noise is fitted at 5 minutes under a white-noise assumption, above), dropouts (monitor gaps are not patch contact loss), the deterioration injection (ICU courses are treated and confounded), and the fixture anchors, slope, cuff and clamps.

**Check:** `src/sim/calibration.test.ts` runs the source at wander 1, takes 5-minute medians, detrends the same way and compares the change sd at 5, 15, 60 and 180 minutes with the held-out stays' p25 to p75 band, skipping p-001 (scripted slope) and p-009 (AF). eICU stores 5-minute medians of 1-minute averages, so the sim's 1-minute readings get the same treatment. The band is the middle half of the held-out stays and the sim side is the median patient, so passing is a weak check. It reads only `calibration.json`, so CI needs no dataset. All twelve checks pass (three vitals, four lags). Sim change sd against the held-out band, with nothing widened:

| Vital | 5 min | 15 min | 60 min | 180 min |
|---|---|---|---|---|
| Heart rate | 2.39 (2.30 to 4.30) | 3.96 (3.37 to 5.93) | 5.30 (4.67 to 8.19) | 5.21 (5.06 to 8.60) |
| Respiratory rate | 2.25 (1.96 to 3.08) | 2.96 (2.39 to 3.67) | 3.64 (2.80 to 4.58) | 3.56 (2.84 to 4.70) |
| SpO2 | 1.01 (0.94 to 1.63) | 1.42 (1.20 to 2.08) | 1.80 (1.61 to 2.57) | 1.76 (1.68 to 2.72) |

Before RR and SpO2 got their fitted noise, four lags failed: RR at 5 and 15 minutes and SpO2 at 5 minutes, because the hand-set noise was far below the real fast component, and SpO2 at 180 minutes by about 2.5%, whose cause was never established (the 100 percent clamp was ruled out). The fitted noise lifts that lag over the band, which does not explain why it was short. No lag overshoots its p75. Several sit close to p25: heart rate at 5 minutes (2.39 against 2.30), SpO2 at 180 minutes (1.76 against 1.68) and heart rate at 180 minutes (5.21 against 5.06), which is the usual weakness of a median-patient check against a middle-half band.

What the pass does and does not show: the fast component is measured at 5-minute resolution only, so the per-minute noise rests on the assumption that it is white below that. Any lag-1 structure inside the 5 minutes is invisible to this data. Heart rate passes at every lag without a fitted noise, so it keeps its hand-set value.

Limits on these numbers. Run back through the fit's own estimator at wander 1, the generator returns a fast sd of 1.06 for RR and 0.32 for SpO2, against the fitted 1.25 and 0.50. With the noise off, it returns a wander timescale of 14.5 minutes for RR and 14.9 for HR, against the configured 16.3 and 19.4. So the estimator is biased on the generator's own output, through the 5-minute medians and the 6-hour detrend, and the fitted values may carry a bias of unknown direction. The twelve checks compare change sd and do not catch this. The 180-minute checks pass only with seeds pooled: of 288 single-seed evaluations, 7 fail, all at 180 minutes, for HR and SpO2. At the default `LIVE_WANDER` of 0.25 the fast noise runs at a quarter of its fitted size (per minute: RR 0.58, SpO2 0.235), so the default demo is calmer than the data. For patients with an SpO2 anchor of 99, the 100 percent ceiling trims about 5 percent of the noise variance. The fit drops 8 to 10 stays per vital where the OU estimate is invalid; including them moves the SpO2 fast sd from 0.504 to 0.511.

**Limits:** this calibrates to ICU monitors, not a ward and not a chest patch. ICU patients are sicker and actively treated, so the fitted variability is an upper-side estimate for a ward. It makes the demo's motion more realistic; it validates nothing about BioSentry's performance, and the no-clinical-claim line above stands.

**Licence:** `calibration.json` holds numbers derived from the eICU-CRD Demo 2.0.1, which is open under ODbL v1.0. Treat the file as ODbL: keep the attribution to the dataset (Pollard et al., PhysioNet) and the same licence on any copy. It holds pooled values only, never per-stay values.

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

## Before sharing publicly

BioSentry's NEWS2 model card lists the licence as unverified. Resolve that before making this repository or demo public.
