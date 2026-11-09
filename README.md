# BioSentry ward simulation

**Live demo:** <https://biosentry-ward-sim.pages.dev> (synthetic patients; deploys from `main`)

An interactive demo of how BioSentry Intelligence would behave on a live ward. Twelve patients sit on ward W4, covered by two staff nurses, a charge nurse and two physicians. Samples travel through the pipeline, the ranked list changes, and nurses and physicians respond.

It runs on synthetic patients wearing chest patches. A real de-identified dataset is planned and will plug in at the vitals source (see "Adding another dataset").

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

The sim can also write to the BioSentry database API. Run the sim with the API's address and the ingest key:

```bash
VITE_API_URL=http://127.0.0.1:8000 VITE_INGEST_KEY=dev-local npm run dev
```

With `VITE_API_URL` unset, nothing is sent. The ingest key is read only from `VITE_INGEST_KEY`.

**Rule: the public Cloudflare Pages build must have neither `VITE_API_URL` nor `VITE_INGEST_KEY`.** Vite inlines both into the shipped JavaScript, so anything set there is public. Nothing in this repository sets them; set them only in your own shell or an uncommitted `.env.local`. The hosted API is reached over the team's private network, so only a sim running on that network can use it.

Each page load picks one random `client_id` (`crypto.randomUUID()`) and keeps it. Each world (first load, Reset) registers a run with `source: "synthetic"`, its 12 patients, their minute-0 state and the last 3 hours of history. A restart replaces the page's own earlier run. About once a second the page then sends a batch of what changed, and sends one even when nothing changed, including while paused, because the server treats a run that sends no batch for 30 seconds as stale and lets anyone take it. When a sim ends it sends `ended: true`.

- **Observations:** the four device vitals, and the nurse-charted blood pressure, consciousness, oxygen and SpO2 scale. A value is sent only when it or its quality changes. A vital with no usable reading is sent as absent, with the reason, never as a made-up value.
- **Bins:** the 15-minute medians behind the trend charts.
- **Events:** the sim's log lines.
- **Patients:** trend, signal quality and the minute of the last sample.

There is one shared ward. While a sim holds it, a sim on another page cannot save. The top bar says so, and the sim keeps running locally:

| Top bar | Meaning |
|---|---|
| Not saved: another ward simulation is live | The API answered 409 to registration: a different page holds the ward. The sim does not retry. Reset registers again, and succeeds once the other run has ended or gone 30 seconds without a batch. |
| Not saved: a newer simulation replaced this one | A batch got 409: another sim took the ward. The sim stops sending and drops its queue. |
| Not saved: the API refused the ingest key | Registration got 403 or 503: the key is wrong or missing. The sim does not retry. |

If the API is down, or answers 5xx, the rows wait and go with the next batch. The queue holds 50,000 rows of each kind; past that the oldest are dropped. The sim runs the same either way. A source that is not synthetic never registers.

`src/sim/ingest.test.ts` tests the sync with a fake fetch, and, when `BIOSENTRY_API` is set, runs the headless sim through a real sync and checks that the API's ranks, scores and NOT RANKED reasons equal the sim's every 15 sim-minutes, that each clinician sees exactly the fixture's patients, and that a second client gets 409 while the first is live. Sign-in needs the clinicians' passphrase:

```bash
BIOSENTRY_API=http://127.0.0.1:8123 BIOSENTRY_INGEST_KEY=dev-local BIOSENTRY_PASSPHRASE=... npx vitest run src/sim/ingest.test.ts
```

The tests always use one `client_id`, so consecutive runs replace each other. Another client's live run makes them fail with 409 until it ends or goes stale.

The dev-server bridge above stays for now. A physician's list is the fixture's: p-004 and p-005 are stored with no physician.

## What you can do

- Set the speed: pause, 1x, 10x or 60x. Staff movement is capped at 6x so walks stay visible.
- Click a bed or a ranked row to open a chart with the five vitals (heart rate, respiratory rate, SpO2, temperature and blood pressure), an illustrative ECG strip, and the reasons in plain words.
- Start a deterioration, detach a patch, apply a patch, or record a blood pressure.
- Open Pipeline for stage counts and Log for ward events.

## How it works

| Stage | Where |
|---|---|
| Vitals source, the seam for a real dataset | `src/sim/source.ts` |
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

The ward has 20 beds. The 12 occupied ones carry the BioSentry dashboard's bed labels (1C, 2B, 3A and so on); the other 8 are empty. Patients keep their bed for the whole run; they do not move as their scores change.

The flow follows the Kitchen BioSentry page: chest patch, BLE to the ward gateway, IoT Device Access to the ward edge server, and a synced copy in Huawei Cloud. NEWS2 and the arbiter run on the edge server. The Pipeline tab marks each stage built, planned, not built or demo rule, and lists the planned stages (anomaly detection, conformal abstention, the explainer agent) without simulating them.

Kitchen also shapes three other things:

- **Ward size:** Kitchen says one nurse has 20 to 50 patients, against a DOH standard of 12. The sim mirrors the dashboard's roster instead: 12 patients and two staff nurses, about 1:6. It does not show the workload pressure Kitchen describes.
- **ECG:** the patch sends ECG. The chart draws an illustrative strip from the heart rate, irregular for the AF patient. It is not data and nothing analyses it.
- **Explainer agent:** planned in the product. The chart shows a fixed template in its place, built from the NEWS2 breakdown and the RCP responses. It is not an AI agent and it does not rank.

The sim is plain data with no React or canvas, so it runs headless in tests. At minute 0 it reproduces the BioSentry fixture: all ten NEWS2 totals, the rank order, the reason strings and the NOT RANKED text. `src/sim/sim.test.ts` checks this against `src/sim/synthetic.json`.

### Adding another dataset

Implement `VitalsSource` (defined in `src/sim/source.ts`) and pass it to `createSim`. `createSyntheticSource` in the same file is the working example. A source supplies the patients, its gate rules, device samples and, if it has them, charted values (`charted`) and a run length (`durationMin`). Leave out `inject` and the deterioration button goes away. The database writer stores only synthetic sources, so a source with `synthetic: false` is never registered with the API.

## What is demo design, not product

BioSentry only ranks and displays. A human decides. These parts were invented for this demo:

- **Staff response loop:** the product has no alert or acknowledgement flow. Messages, walks, assessments and physician calls are demo design.
- **Reassessment:** medium and high risk patients are seen at least every 60 sim-minutes.
- **Physician calls:** at NEWS2 5 or more the nurse calls the patient's physician, following the Kitchen page and RCP 2017 ("immediately inform the medical team"). Below 5, including a single parameter at 3, the nurse handles it.
- **Quality gate:** a 15-minute median of 8 or more usable readings, degraded after 15 stale minutes.
- **NOT RANKED cutoff:** 30 stale minutes.
- **Filled fixture gaps:** a cuff reading of 128/76 for p-004, a baseline for p-005, and a physician to call to the bedside for both. They are on no physician's list.
- **Hardware:** the patch, gateway and edge server are the described design. None of it is built.

The demo deliberately shows no recovery after review and no response-time figures. Either would imply an outcome benefit the product does not claim.

## Art

All art is drawn in this repository's code, in `src/render/`. The panel layout and status palette take their idiom from [Munder Difflin](https://github.com/HarnessMD/munder-difflin) (MIT). None of its assets are used.

## Before sharing publicly

BioSentry's NEWS2 model card lists the licence as unverified. Resolve that before making this repository or demo public.
