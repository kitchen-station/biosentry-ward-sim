# BioSentry ward simulation

An interactive demo of how BioSentry Intelligence would behave on a live ward. Twelve patients sit on ward W4. Samples travel through the pipeline, the ranked list changes, and nurses and physicians respond.

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

## What you can do

- Switch between synthetic patients and the eICU replay.
- Set the speed: pause, 1x, 10x or 60x. Staff movement is capped at 6x so walks stay visible.
- Click a bed or a ranked row to open a chart with the five vitals: heart rate, respiratory rate, SpO2, temperature and blood pressure.
- Start a deterioration (synthetic only), detach a patch, apply a patch, or record a blood pressure.
- Open Pipeline for stage counts and Log for ward events.

## How it works

| Stage | Where |
|---|---|
| Vitals source, the seam for a real dataset | `src/sim/source.ts` |
| eICU replay source | `src/sim/replay.ts` |
| eICU extract | `scripts/extract-eicu.mjs` |
| Quality gate, staff loop, commands | `src/sim/sim.ts` |
| NEWS2, ported from BioSentry | `src/sim/news2.ts` |
| Arbiter and ranking, ported from BioSentry | `src/sim/arbiter.ts` |
| Ward map and pathing | `src/sim/map.ts` |
| Isometric renderer and sprites | `src/render/` |
| Panels | `src/panels.tsx` |

The flow follows the Kitchen BioSentry page: chest patch, BLE to the ward gateway, IoT Device Access to the ward edge server, and a synced copy in Huawei Cloud. NEWS2 and the arbiter run on the edge server. The Pipeline tab marks each stage built, planned or demo rule. Anomaly detection, conformal abstention, the explainer agent and the patch's ECG are not simulated.

The sim is plain data with no React or canvas, so it runs headless in tests. At minute 0 it reproduces the BioSentry fixture: all ten NEWS2 totals, the rank order, the reason strings and the NOT RANKED text. `src/sim/sim.test.ts` checks this against `src/sim/synthetic.json`.

### The eICU replay

The replay uses 12 stays from the [eICU-CRD Demo 2.0.1](https://physionet.org/content/eicu-crd-demo/2.0.1/), which is open under ODbL v1.0. The data is not in this repository. To add it locally, put these four files in a folder outside the repo: `patient.csv.gz`, `vitalPeriodic.csv.gz`, `vitalAperiodic.csv.gz` and `nurseCharting.csv.gz`. Then run:

```bash
npm run extract -- /path/to/that/folder
```

On the author's machine the files live in `~/Documents/datasets/eicu-crd-demo-2.0.1`, with PhysioNet's `SHA256SUMS.txt` beside them.

That writes `public/replay/eicu-12.json`, which git ignores, and turns on the eICU replay button. If you share an extract, ODbL requires attribution and keeps it under the same licence.

This is real ICU data on a simulated ward. It is not ward data, and it is not from a chest patch. The stays are US ICU stays, the monitor stands in for the patch, and NEWS2 scores run high because these patients are sicker than a ward population. The 12 stays were hand-picked from 39 cardiac, awake, unventilated stays discharged alive, for a spread of NEWS2 paths. They are not a representative sample.

| Input | Replay source | Rule |
|---|---|---|
| HR, RR, SpO2 | Monitor, every 5 minutes | Median of 2 of 3 readings in 15 minutes, NOT RANKED after 30 minutes |
| Temperature | Nurse charting | Holds 8 hours |
| Blood pressure | Non-invasive cuff | Holds until the next reading |
| Oxygen | Nurse charting | Holds until the next entry; any flow except 0 or 21 counts as on oxygen |
| Consciousness | GCS from nurse charting | GCS 15 is Alert, lower is new confusion |
| SpO2 scale | Not recorded | Scale 1 for everyone |

Scores change about 24 times an hour across the ward, against about 2 in the synthetic ward. That is left visible, because smoothing it would change how the arbiter behaves.

### Adding another dataset

Implement `VitalsSource` in `src/sim/source.ts` and pass it to `createSim`. `src/sim/replay.ts` is the working example. A source supplies the patients, its gate rules, device samples and, if it has them, charted values. Leave out `inject` and the deterioration button goes away.

## What is demo design, not product

BioSentry only ranks and displays. A human decides. These parts were invented for this demo:

- **Staff response loop:** the product has no alert or acknowledgement flow. Messages, walks, assessments and physician calls are demo design.
- **Reassessment:** medium and high risk patients are seen at least every 60 sim-minutes.
- **Physician calls:** at NEWS2 5 or more the nurse calls the patient's physician, following the Kitchen page and RCP 2017 ("immediately inform the medical team"). Below 5, including a single parameter at 3, the nurse handles it.
- **Quality gate:** a 15-minute median of 8 or more usable readings, degraded after 15 stale minutes. The replay uses its own rules, listed above.
- **NOT RANKED cutoff:** 30 stale minutes.
- **Filled fixture gaps:** a cuff reading of 128/76 for p-004, a baseline for p-005, and physicians for both.
- **Hardware:** the patch, gateway and edge server are the described design. None of it is built.

The demo deliberately shows no recovery after review and no response-time figures. Either would imply an outcome benefit the product does not claim.

## Art

All art is drawn in this repository's code, in `src/render/`. The panel layout and status palette take their idiom from [Munder Difflin](https://github.com/HarnessMD/munder-difflin) (MIT). None of its assets are used.

## Before sharing publicly

BioSentry's NEWS2 model card lists the licence as unverified. Resolve that before making this repository or demo public.
