# BioSentry ward simulation

**Live demo:** <https://biosentry-ward-sim.pages.dev> (synthetic patients; deploys from `main`)

An interactive demo of how BioSentry Intelligence would behave on a live ward. Twelve patients sit on ward W4, covered by two staff nurses, a charge nurse and two physicians. Samples travel through the pipeline, the ranked list changes, and nurses and physicians respond. The standalone hospital page shows a whole synthetic hospital around it: an emergency room, wards and intensive care, each with synthetic vital signs (display only outside W4).

It runs on synthetic patients wearing chest patches. Their movement is fitted to real open datasets; see [Fitted to real data](#fitted-to-real-data). A real de-identified dataset is planned and will plug in at the vitals source (see "Adding another dataset").

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

The customer app is the simulation only. It has no developer page. The developer page is a separate build (`npm run dev:view`, `npm run build:dev`) that shows the pipeline, models, evaluations, simulator checks, registry and research agent record from committed, synthetic files only. `npm run sync:evaluation -- <BioSentry-Intelligence checkout>` brings those files up to date. See [docs/analytics.md](docs/analytics.md).

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

Each page load picks one random `client_id` (32 hex characters from `crypto.getRandomValues`, which works without a secure context) and keeps it. Each world (first load, Reset) registers a run with `source: "synthetic"`, its 12 patients, their minute-0 state and the last 3 hours of history. A restart replaces the page's own earlier run. About once a second the page then sends a batch of what changed, and sends one even when nothing changed, including while paused, because the server treats a run that sends no batch for 30 seconds as stale and lets anyone take it. When a sim ends it sends `ended: true`.

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

The dev-server bridge above stays for now. A physician's list starts as the fixture's: p-004 and p-005 are stored with no physician. A new admission goes on the list of the physician who is called to their bedside.

## How fast 60x is

- 60x means 60 simulated seconds per real second. The top bar shows the speed as text next to the clock, and the clock counts seconds.
- Measured: 59.992 simulated seconds per real second in a browser at 60 frames a second over 20 s on a development build (59.996 before this change).
- Measured: 60.00 from the page's frame arithmetic with the real `step()` in a test, at 1 to 120 frames a second.
- Measured: 59.995 from the headless runner over 70 s.
- Before this change, a page that got about one frame a second ran at about a quarter of its speed (0.242 at 1x, 2.74 at 10x). After it, with frame gaps up to 1017 ms, it measured 0.994 at 1x, 9.92 at 10x and 60.9 at 60x over 20 s windows. A stall longer than 5 s still loses the time beyond 5 s.
- A hidden tab's own simulation pauses and does not jump ahead on return. This follows from the code; it was not measured.
- Staff figures walk and work at 6x at most, so they look the same at 10x and 60x. This was kept on purpose.
- The viewer's clock runs on between reads at the runner's speed, and moves toward each read at no more than twice that speed. It snaps on the first read, a runner restart, a pause, an end, a speed change, or a gap over 10 real seconds. It stops when the run has ended or the page says "Not updating". A read lower than the last is taken as a late answer and ignored once; a second lower read in a row, or one lower by 600 s or more, is a restart. With no new read, the clock stops 3 s after the last one. This was modelled in tests, not measured against a real runner.
- The minute turns over with a flip at 1x and 10x; at 60x it changes in place, because it changes every second.

## Run the ward without a browser

`npm run ward` builds `src/headless.ts` and runs the same sim engine as a Node process. It writes to the BioSentry API, so the ward keeps running with no tab open.

```bash
BIOSENTRY_API_URL=http://127.0.0.1:8000 BIOSENTRY_INGEST_KEY=dev-local npm run ward
```

The key `dev-local` is the one `make api-dev` sets in the BioSentry-Intelligence repo.

- `BIOSENTRY_API_URL`: the API's address. Required.
- `BIOSENTRY_INGEST_KEY`: the ingest key. Required.
- `WARD_SPEED`: 1, 10 or 60. Default 1, which is real time. At 60x one ward writes about 7 million observations a day. It is the starting speed of a new ward: a saved ward continues at the speed it had, which a clinician may have changed from the viewer.
- `WARD_STATE_FILE`: where the ward is saved. Default `ward-state.json` in the folder you run from.

The runner saves the ward every 10 seconds and when it is stopped. Started again, it continues the same ward: same patients, same clock, same run in the API. The time it was down is not replayed. To start a new ward, delete the state file.

### As a container

The `Dockerfile` builds the runner into a `node:22-slim` image that runs as a non-root user. The built file needs only Node, so the image holds no npm packages. The ward is saved to `/state/ward-state.json` (`WARD_STATE_FILE`): mount a volume at `/state` to keep it across restarts.

```bash
docker build -t biosentry-ward-sim:local .
docker run --rm -v ward-state:/state --add-host=host.docker.internal:host-gateway \
  -e BIOSENTRY_API_URL=http://host.docker.internal:8000 -e BIOSENTRY_INGEST_KEY=dev-local \
  biosentry-ward-sim:local
```

`--add-host` is what makes `host.docker.internal` resolve on Linux; Docker Desktop has it already. In the team deployment the compose file in the dashboard repository runs the image, and it reaches the API as `http://api:8000`.

Behaviour:

- One shared ward. If a browser sim is live, the API refuses the run, and the runner exits with code 1 and the reason.
- It uses a fixed client id, so a restart replaces its own run at once.
- Ctrl+C or SIGTERM marks the run ended.
- If the API is unreachable, rows stay queued and are retried.
- A restart continues the saved ward in the same run (see `WARD_STATE_FILE` above).

Every 2 seconds it also reads what clinicians did on the dashboard (`GET /sim/runs/{run_id}/actions`) and applies it to the ward. An acknowledgement sends the patient's nurse to assess them, recorded vitals count at once and a recorded blood pressure is entered by the nurse at the bed, a note is logged, and an admitted patient is put in the bed that was typed and a nurse fits their patch. The last action applied is saved with the ward, so a restart does not apply one twice.

It reads a second feed the same way, `GET /sim/runs/{run_id}/commands`: what a clinician sent from the viewer (see below). `set_speed` sets the speed (pause, 1, 10 or 60), `inject_deterioration`, `start_arrhythmia`, `detach_patch` and `apply_patch` do what the buttons in the patient panel do, and each is written to the ward log with the clinician's name. A command for a patient who has left is logged and skipped. `reset` replaces the ward with a new one at the current speed and starts a new run, so the commands and actions feeds begin again from 0 and the old ward's unsent rows are dropped. The new ward has its own vitals source: nothing the old one was told (a deterioration, an AF episode) carries over. A command sent in the second or so between a reset and the new run registering can be lost. The last command applied is saved with the ward too.

While it runs, it also publishes the ward as it would be drawn (`src/sim/view.ts`) to `POST /sim/runs/{run_id}/view` every 2 seconds.

### The lab worker

The same image holds a second program, the lab worker: `node dist/lab/lab-worker.js`. It claims a compare request from the BioSentry API with the ingest key, runs this repository's `compare` once, and posts the two files compare wrote. The dashboard's Simulation lab is what makes the requests. Locally: `BIOSENTRY_API_URL=http://127.0.0.1:8000 BIOSENTRY_INGEST_KEY=dev-local npm run lab-worker`. It refuses to start behind a proxy variable, never writes the key down, and never passes text from a request to a shell. [docs/lab-worker.md](docs/lab-worker.md) has the rules.

## Compare two runs of the same patients

A real ward cannot run the same night twice. The simulator can. `npm run compare` runs two arms with the same seed and days, changes exactly one named thing, and writes what differs.

```bash
npm run compare -- --seed 4 --days 30 --baseline rule=news2_total_ge_5 --change rule=news2_chart_trigger --out trials/compare-w4
```

```bash
npm run compare -- --seed 101 --days 7 --baseline scenarios/hospital/typical.json --change staffing=scenarios/hospital/doh-standard.json --out trials/compare-staffing
```

- **Ward W4, two warning rules.** Both rules read the same vitals from one run. `--seeds 20` repeats that over 20 seeds and gives the spread across them. Both forms give a paired figure: the same episode under both rules. The simulator knows the minute each patient started to get worse, so the report gives alerts per patient per 12-hour shift, the share of true episodes with an alert, alerts outside any episode window, and the lead time from the first new alert in the episode window to the episode being fully in.
- **Hospital, one group of settings.** For example the staffing of `doh-standard` on the `typical` hospital. The report shows the trial's hourly and summary figures for both arms, and their difference.
- **The pairing is checked and printed.** On W4 both arms are the same cohort, proved by a second run with the same hashes. On the hospital the minute-0 residents and the arrival minutes are the same. The report says whether the same person is at each arrival, and names the minute of the first event that differs. A change that breaks the pairing, or more than one change, is refused with exit 2.
- **What it does not show.** On W4 a staff review does not change vitals, so nothing in the run responds to a warning: by default the report covers alert timing and alarm counts only. `--outcome-model` adds a modelled outcome over 20 or more seeds, printed as a MODEL ASSUMPTION with its cited parameter and a sensitivity table; it is arithmetic on the run's files after the run and changes nothing in the run. Everything is synthetic and not validated.

The numbers, the limits and a worked example with real output are in [docs/compare.md](docs/compare.md).

## Watch the runner's ward in the browser

A build with `VITE_VIEW_API_URL` set is a viewer. It never makes a ward: a clinician signs in, and the page draws what the headless runner publishes, read from `GET /wards/W4/live` every 2 seconds.

With no token, the viewer first asks `GET /wards/W4/open-view`; while the answer stays valid it asks again 2 s after each answer. If the API answers a valid body, the page shows the ward read-only ("watching") with no controls and no names. Anything else shows the sign-in form. See [docs/open-view.md](docs/open-view.md).

```bash
VITE_VIEW_API_URL=http://127.0.0.1:8000 npm run dev
```

- `VITE_VIEW_API_URL`: the API's address. It turns viewer mode on, and `VITE_API_URL` and `VITE_INGEST_KEY` are then ignored. It is inlined into the shipped JavaScript like they are, but it is an address and not a secret.
- The API sends a staff nurse only their own patients; the charge nurse sees all. Other beds draw empty.
- A physician or the charge nurse can control the runner's ward: when `GET /wards/W4/live` answers `can_control: true`, the top bar's Pause, 1x, 10x, 60x and Reset and a patient's Start deterioration, Start AF, Detach patch and Apply patch are on. Each sends `POST /wards/W4/sim/commands` and the runner does it. The buttons show the speed the runner published, not the one just clicked, so a change appears on the next answer. A refusal (403 role, 404 unknown ward or patient, 409 ward not live, which also covers a ward that was just replaced by a reset) shows as a short line in the top bar; 401 signs out.
- Everyone else, and an API that does not send `can_control`, gets a read-only page: no speed, Reset, deterioration, AF, patch or BP entry. BP entry and Skip 1 day are never offered, and the hospital scenario picker belongs to the public build.
- Not shown: the ward log (staff cards have no recent activity) and finished stays (empty beds, the entrance and the bed timeline list only patients on the ward now).
- Staff move in 2-second jumps.
- The session token is kept in memory only, so a reload signs out.

## Analytics page

The top bar has two links, Simulation and Analytics. Analytics shows charts for the hospital, for ward W4 and for one person, from the run in the page. The data is synthetic and the page makes no outcome claim. In a viewer build the Hospital section says "The runner runs ward W4 only." and the ward charts say "Not available from the runner yet". Under the ward charts a table lists each simulated deterioration episode (true start, first alert, minutes between) as the simulator's ground truth, with no outcome. See [docs/ward-analytics.md](docs/ward-analytics.md).

## Scenarios, Shuffle and the seed

The standalone hospital page has a select of four named scenarios (Pitch ward is the default and is the run the page always opened on), a Shuffle button and a seed pill. Shuffle draws a new seed for the hospital and the vitals, and ward W4 starts with 12 newly drawn synthetic patients; the same seed gives the same 12, and a named scenario with no seed shows the fixture 12. `?scenario=<id>&seed=<n>` in the address repeats a run. A viewer build and the ward-only build do not show them. See [docs/scenarios.md](docs/scenarios.md).

In the standalone hospital page every unit shows synthetic vital signs and a NEWS2 colour for its people, and each ward and the ER has a ranked list. Intensive care shows vitals but no rank, because NEWS2 is a ward score. A person outside ward W4 has the same vital cards as a W4 patient. Each unit says what its numbers are: the same generator as W4, not fitted to that unit. It is display only: care in the model does not read it. A viewer build and the ward-only build do not show it. See [docs/hospital-vitals.md](docs/hospital-vitals.md). A person outside ward W4 also shows their whole stay as unit bands and charts, with a link to the W4 stay, and each unit panel shows how many moves happened today (for the ER: how many people left it, split by how).

## What you can do

- Set the speed: pause, 1x, 10x or 60x. Staff movement is capped at 6x so walks stay visible.
- Click a bed, a staff member or a machine to zoom in on it and see only its details. A patient shows the five vitals (heart rate, respiratory rate, SpO2, temperature and blood pressure), an illustrative ECG strip, and the reasons in plain words.
- Start a deterioration or an AF episode, detach a patch, apply a patch, or record a blood pressure.
- Click the WARD LIST screen at the nurse station for the ranked list.
- Click ENTRANCE for who came and went, length of stay and the bed timeline, or to skip a day. Click an empty bed or a past stay for its history. Without the database API, stays live in memory, so a reload starts over.

## How it works

| Stage | Where |
|---|---|
| Vitals source, the seam for a real dataset | `src/sim/source.ts` |
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

The ward has 20 beds. The 12 occupied ones carry the BioSentry dashboard's bed labels (1C, 2B, 3A and so on); the other 8 are empty. Patients keep their bed for the whole run; they do not move as their scores change.

The flow follows the Kitchen BioSentry page: chest patch, BLE to the ward gateway, IoT Device Access to the ward edge server, and a synced copy in Huawei Cloud. NEWS2 and the arbiter run on the edge server. Clicking a machine shows whether that stage is built, planned or a demo rule. Anomaly detection, conformal abstention and the explainer agent are planned and not simulated.

Kitchen also shapes three other things:

- **Ward size:** Kitchen says one nurse has 20 to 50 patients, against a DOH standard of 12. The sim mirrors the dashboard's roster instead: 12 patients and two staff nurses, about 1:6. It does not show the workload pressure Kitchen describes.
- **ECG:** the patch sends ECG. The chart draws an illustrative strip from the heart rate, irregular for the AF patient. It is not data and nothing analyses it.
- **Explainer agent:** planned in the product. The chart shows a fixed template in its place, built from the NEWS2 breakdown and the RCP responses. It is not an AI agent and it does not rank.

The sim is plain data with no React or canvas, so it runs headless in tests. At minute 0 it reproduces the BioSentry fixture: all ten NEWS2 totals, the rank order, the reason strings and the NOT RANKED text. `src/sim/sim.test.ts` checks this against `src/sim/synthetic.json`.

Counting a change when the score differs from 15 minutes earlier, the synthetic patients change about 2.5 times an hour across all 12 (2.54), about 0.2 per patient. That figure counts non-overlapping 15-minute samples over 24 hours, for the 12 patients, mean of seeds 1 to 5, after the calibration below. The previous constants give 1.01 by this same method.

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
| Temperature does not change in a deterioration episode | [Churpek 2012](https://pmc.ncbi.nlm.nih.gov/articles/PMC3342781), [Churpek 2015](https://pmc.ncbi.nlm.nih.gov/articles/PMC4359655), [Payvar 2013](https://europepmc.org/abstract/MED/23858000) | Literature, no data used |
| Minute-to-minute noise for HR, RR, SpO2 | [BIDMC PPG and Respiration 1.0.0](https://physionet.org/content/bidmc/1.0.0/) | ODC-By v1.0 |
| Premature beat rates and timing | [MIT-BIH Arrhythmia 1.0.0](https://physionet.org/content/mitdb/1.0.0/), 100 series only | ODC-By v1.0 |
| AF beat irregularity, rate change | [MIT-BIH Atrial Fibrillation 1.0.0](https://physionet.org/content/afdb/1.0.0/) | ODC-By v1.0 |
| AF episode length | AFDB and [Long Term AF Database 1.0.0](https://physionet.org/content/ltafdb/1.0.0/) | ODC-By v1.0 |

`fitted.json` is published under ODbL v1.0. Attribution and citations are in [NOTICE.md](NOTICE.md).

Every fourth eICU hospital (46 of 186) is kept out of fitting. `src/sim/sim.test.ts` checks the generator's variability and 5-minute correlation, and its systolic step sizes at 30 and 180 minutes, against those held-out hospitals. That checks realism only. It says nothing about how well BioSentry predicts, and no model result may be reported from this synthetic data.

`src/sim/published.test.ts` runs the ward for 30 simulated days, six times, and checks the last 20 days against published ward figures, using fixed tolerances. Heart rate, respiratory rate, systolic, oxygen use, patch data loss and occupancy pass. The 24-hour heart rate and respiratory rate swings also pass, but the simulator was set from those figures, so that agreement is by construction. Three checks are marked as known misses:

| Known miss | Sim | Published |
|---|---|---|
| Observation sets at NEWS 5+ | about 35% | about 20% (RCP 2012, medical wards) |
| Observation sets at NEWS 7+ | about 16% | about 10% |
| SpO2, low end | 1st to 10th percentiles 90 to 94 | 86 to 91 (Welch 2015) |

Patients spend about 14% of their time at NEWS2 5 or more. Observation sets show more because the test samples sick patients at the NEWS2 minimum frequency (hourly at 5 or more), and real wards often fall short of that. Respiratory rate adds the most points. The tolerances are judgement. RCP's figures are for NEWS 2012, not NEWS2. A marked check turns the build red once it starts passing, so the marker must then come off.

Limits:

- **No ward data:** no open ward-level dataset was found. The dynamics come from ICU stays, restricted to six-hour windows with ward-like medians, and applied around the ward patients' own baselines. Real ward patients may be steadier.
- **Deterioration events are physiological rise events, our definition:** a rise of 4 or more in an hourly three-vital NEWS2 (HR, RR, SpO2) held for 2 hours, or two cuff readings at or below 100 systolic and at least 20 below baseline. No open dataset labels deterioration and no source validates these rules.
- **Hypotensive events are ICU-derived:** they are fast (median about an hour) and may reflect sedation or drugs. The patch does not measure blood pressure, so a hypotensive event shows only when a nurse takes a cuff reading. Some go unseen on a low-risk patient, as they could on a real ward.
- **Still hand-set:** the mix of event kinds (55% respiratory, 20% tachycardic, 25% hypotensive, a judgement because no published split exists), temperature noise (SD 0.1 °C, a judgement), circadian size for temperature, and the value clamps. Patch dropouts use ViSi Mobile ward pilot figures for rate and length, with a judgement 4-hour cap. The time of day each rhythm peaks comes from eICU.
- **Temperature does not rise in an episode:** ward studies find it does not separate patients who go on to cardiac arrest from controls, and it runs slightly low if anything (Churpek 2012, 2015). In heart failure, low temperature marks worse outcome (Payvar 2013). Earlier versions added a fixed 0.6 °C rise to every episode; that had no source and is removed.
- **Infection is not modelled:** infection with fever or low temperature is not modelled as its own episode kind yet.
- **AF episodes are short:** the median is a few minutes, as recorded in patients referred for AF, so a Start AF episode can end quickly.

MIMIC-IV is not used: its terms treat derived data as sensitive, which rules it out for a public generator.

`npm run realism` prints the vital-sign and NEWS checks from `sim.test.ts`, `calibration.test.ts` and `published.test.ts`: the simulator's number beside the real one, the verdict and the dataset. It leaves out oxygen use, patch data loss and occupancy. It adds one check of its own, A4: temperature against the held-out eICU hospitals, with check A's tolerance. The spread passes and the 5-minute correlation is a known miss (0.623 against 0.938). Diastolic pressure and heart rhythm are mostly fitted from real recordings, but are not compared with real data. Temperature's minute noise and daily swing are hand-set. [docs/realism.md](docs/realism.md) says what "fitted to real data" means here, signal by signal. `npm run export:evaluation` writes the realism table and one many-seed compare as `simulator.json` for the developer page ([docs/export-evaluation.md](docs/export-evaluation.md)).

### Patient flow

The synthetic ward in the app admits and discharges patients. Tests of the fixture turn this off with `createSyntheticSource(seed)`; the app passes `true` as the second argument. The 12 starting patients leave over the first days and new patients take their place, using all 20 beds. When `VITE_API_URL` is set, admissions and departures go to the database API with the other rows, and the dashboard's Station page shows them under Patient flow. Skip 1 day is hidden then, because a day at once would overflow the queue.

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

## Licence

The code is under the [MIT License](LICENSE). The fitted data files are not: `src/sim/fitted.json` and `src/sim/calibration.json` are under ODbL v1.0, as set out in [NOTICE.md](NOTICE.md).

## Before sharing publicly

NEWS2: the RCP's page says there is no copyright restriction, on conditions this repository follows (see [NOTICE.md](NOTICE.md)). It does not mention software, so its application to code is unconfirmed. Queries go to cqid@rcp.ac.uk. BioSentry's own model card still lists the licence as unverified.
