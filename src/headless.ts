/// <reference types="node" />
// The ward as a headless Node process: steps the sim against the wall clock and writes it to the
// BioSentry API, so the ward keeps running with no browser tab open. Run with `npm run ward`.
// The ward is saved to a file and a restart continues it: same patients, same clock, same run.
// The time the runner was down is not replayed. Delete the file to start a new ward.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { applyAction } from "./sim/actions";
import { applyCommand, clinicianName, freshWard, skipAhead, SKIPS } from "./sim/commands";
import { refuseHospitalState, refuseWardState } from "./sim/hospital/attach";
import { freshHospital, HOSPITAL_SCENARIOS } from "./sim/hospital/fresh";
import { createMonthLoop, type World } from "./sim/hospital/month";
import { publishHospital } from "./sim/hospital/publish";
import { createVitals, feedVitals } from "./sim/hospital/vitals";
import { loadWard, saveWard } from "./sim/persist";
import { minuteOf, say, step, type Speed } from "./sim/sim";
import { createSync, STOP_TEXT, withTimeout } from "./sim/sync";
import { createTruthPoster, startedEpisodes } from "./sim/truth";
import { createPublisher } from "./sim/view";

const TICK = 1 / 60;
// WARD_MODE=hospital runs the whole hospital, saves it, and writes every unit's patients to the API in a run that lists the
// units. The default mode is the ward-only runner, unchanged. WARD_SCENARIO picks the hospital a new run starts: the typical
// hospital by default (owner decision orch-h4), or a named scenario such as pitch. A saved hospital continues as it is.
const mode = process.env.WARD_MODE ?? "ward";
const hospital = mode === "hospital";
const scenario = process.env.WARD_SCENARIO ?? "typical";
const apiUrl = process.env.BIOSENTRY_API_URL;
const key = process.env.BIOSENTRY_INGEST_KEY;
// Real time by default: at 60x one ward writes about 7 million observations a day.
const speed = Number(process.env.WARD_SPEED ?? 1) as Speed;
if (!apiUrl || !key || ![1, 10, 60].includes(speed) || !["ward", "hospital"].includes(mode) || (hospital && !HOSPITAL_SCENARIOS.includes(scenario))) {
  console.error(`Set BIOSENTRY_API_URL and BIOSENTRY_INGEST_KEY. WARD_SPEED may be 1, 10 or 60. WARD_MODE may be ward or hospital. WARD_SCENARIO (hospital mode) may be ${HOSPITAL_SCENARIOS.join(", ")}.`);
  process.exit(2);
}

const stateFile = process.env.WARD_STATE_FILE ?? (hospital ? "hospital-state.json" : "ward-state.json");
const SAVE_EVERY_MS = 10_000;
// A state file that cannot be read stops the runner: starting a new ward over it would lose the old one.
const saved = existsSync(stateFile) ? loadWard(readFileSync(stateFile, "utf8")) : null;
const refused = saved && (hospital ? refuseWardState(saved.s) : refuseHospitalState(saved.s));
if (refused) {
  console.error(refused); // before sync starts: nothing is sent
  process.exit(2);
}
// WARD_SPEED is the starting speed: a saved ward resumes at the speed it had, which a clinician may have changed.
let { s, src } = saved ?? (hospital ? freshHospital(speed, scenario) : freshWard(speed));
// Hospital mode: the vitals engine for everyone outside W4, display only. It is not saved: a restart builds it again from the hospital.
let vitals = createVitals();
s.rounds = true; // the deployed ward: nurses re-take observations on the NEWS2 schedule (also for a ward saved before this existed)
// A fixed client id: a runner that begins a new ward replaces its own run at once instead of waiting out the old one.
// Every request gives up after 30 s, so a request that hangs cannot hold a flush, or a month's switch, for ever.
// The state is saved at the moment the API accepts a new run: a stop right after that finds the new run in the file.
const sync = createSync({ apiUrl, key, clientId: "ward-runner", fetch: withTimeout(fetch, 30_000), onRun: () => save() });
const view = createPublisher();
// Owner decision dashboard-7: started episodes go to the API, only from here. See docs/episode-truth.md.
const poster = createTruthPoster({ apiUrl, key, fetch, now: Date.now, log: console.error });

// Hospital mode: at ward day 30 the run closes and the next seed starts (src/sim/hospital/month.ts).
const month = createMonthLoop({ sync, fresh: (at, seed) => freshHospital(at, scenario, seed), log: console.log });

let savedAt = 0;
function save() {
  if (hospital && !month.maySave()) return; // a new month the API has not accepted yet: the file stays the old month's
  writeFileSync(`${stateFile}.tmp`, saveWard(s, src, sync.run));
  renameSync(`${stateFile}.tmp`, stateFile); // a crash mid-write leaves the last whole file
  savedAt = Date.now();
}

// Never awaited: a slow or failing episodes post cannot hold the sync or the tick loop.
function offerTruth() {
  const run = sync.run.runId;
  if (run === null || !src.save) return;
  try {
    const ids = s.patients.map((p) => p.id);
    poster.offer(run, sync.generation, startedEpisodes(src.save(ids), ids, minuteOf(s)), sync.acked);
    void poster.tick();
  } catch {
    console.error(`episodes run ${run}: not read`); // the ward goes on
  }
}

// Hospital mode: the next month's world takes the place of the old one, with a new engine.
const swap = (w: World) => {
  [s, src] = [w.s, w.src];
  vitals = createVitals(); // an old engine fed a new world would reuse its streams
  spare = 0;
};

async function flush() {
  await sync.flush();
  // Superseded at a month's end: this runner had started the next month and was stopped before its file was written.
  if (hospital && sync.stopped === "superseded" && (await month.recover({ s, src }, swap))) return save();
  if (!sync.stopped) {
    offerTruth();
    // After a flush, so the file never holds less than the database was sent.
    if (Date.now() - savedAt >= SAVE_EVERY_MS) save();
    return;
  }
  console.error(STOP_TEXT[sync.stopped]);
  process.exit(1);
}

// Registered before the sync starts, so a stop during startup ends the process: as PID 1 in a container node ignores a signal with no handler.
let started = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    // A stop is a pause, not the end of the run: the API shows the ward as not sending after 30 s.
    if (started) {
      await sync.flush();
      if (!sync.stopped) save();
    } // before then there is nothing of this run to save, and the file on disk is the last whole one
    process.exit(0);
  });
}

let last = performance.now();
let spare = 0;
// A saved hospital whose month is over is not continued: the next month starts at once (a restart at the boundary).
const newMonth = hospital && saved !== null && month.due(s);
if (newMonth) {
  await month.turn({ s, src }, swap);
  save();
} else if (saved) await sync.resume(s, src, saved.run);
else await sync.start(s, src);
started = true;
console.log(`${hospital ? "Hospital" : "Ward"} ${newMonth ? `started a new month (seed ${s.hospital?.seed}), run ${sync.run.runId},` : saved ? `resumed at minute ${minuteOf(s)}, run ${sync.run.runId},` : "started"} running at ${s.speed}x, writing to ${apiUrl}`);
setInterval(async () => {
  if (skipping) return; // the skip steps, publishes and flushes on its own
  const now = performance.now();
  spare += (now - last) / 1000; // a late timer or a suspended host is caught up, so sim minutes stay on the wall clock
  last = now;
  for (; spare >= TICK; spare -= TICK) {
    step(s, src);
    if (hospital) feedVitals(vitals, s.hospital!, s.clockS);
    if (hospital && month.due(s)) break; // the month is over at this step: the rest of the time belongs to the next one
  }
  if (hospital) publishHospital(s, vitals); // reads from this interval, sent as that unit's patients
  if (hospital && month.due(s)) {
    await month.turn({ s, src }, swap); // the old world is marked ended first, so a tick meanwhile steps nothing
    save(); // already written at the moment of acceptance; if the API has not accepted yet, this writes nothing
  }
  void flush();
}, 1000);
// What the page in viewer mode draws. Every 2 s, as often as it polls.
setInterval(() => void sync.publish(view(s)), 2000);
// A new ward at the current speed, in a new run. start() registers it before this returns to the timers, so no tick or save sees the old world with the new run.
async function reset(by: string) {
  const fresh = hospital ? freshHospital(s.speed, scenario) : freshWard(s.speed); // its own source: the old one remembers who deteriorated and when
  fresh.s.rounds = true;
  vitals = createVitals(); // an old engine fed a new world would reuse its streams
  const starting = sync.start(fresh.s, fresh.src);
  [s, src] = [fresh.s, fresh.src];
  say(s, `${clinicianName(by)} reset the ward`);
  await starting;
  save();
}
// A clinician's skip: the world moves ahead that many ward minutes at once, at 60x fidelity whatever the speed (as skipDay).
// The hospital's readings are published every ward minute and everything is sent every ward hour. A month that ends inside
// the skip closes as always: the skip stops there, the rest of it is dropped, and the next month starts.
let skipping = false;
async function skip(minutes: number, by: string) {
  const word = SKIPS.find(([m]) => m === minutes)?.[1];
  if (!word || skipping) return; // not one of the four the API takes: nothing is stepped
  skipping = true;
  try {
    say(s, `${clinicianName(by)} skipped ahead ${word.slice(1)}`);
    await skipAhead(minutes, {
      tick: () => {
        if (s.ended || (hospital && month.due(s))) return false;
        const speed = s.speed;
        s.speed = 60; // one ward second a step; set back at once, so nothing else ever sees it
        step(s, src);
        s.speed = speed;
        if (hospital) feedVitals(vitals, s.hospital!, s.clockS);
        return true;
      },
      minute: () => void (hospital && publishHospital(s, vitals)),
      hour: flush,
    });
    if (hospital && month.due(s)) {
      await month.turn({ s, src }, swap);
      save();
    }
  } finally {
    skipping = false;
    [last, spare] = [performance.now(), 0]; // the wall time the skip took is not stepped a second time
  }
}
// What clinicians did on the dashboard, applied to the ward. pull() answers nothing while one is under way or once the sync stopped.
setInterval(async () => {
  for (const a of await sync.pull()) {
    try {
      applyAction(s, src, a);
    } catch (error) {
      console.error(`Clinician action ${a.seq} (${a.kind}) was not applied:`, error); // one bad row must not stop the ward
    }
  }
}, 2000);

// What clinicians sent from the viewer: speed, reset, skip and a patient's controls.
// The feed is not read again until every command of the last read was applied. The API holds a second skip back until the
// feed is asked for what comes after the first one, so that ask must not go out while the first is still being stepped.
let applying = false;
setInterval(async () => {
  if (applying) return;
  applying = true;
  try {
    for (const c of await sync.pullCommands()) {
      try {
        if (c.kind === "reset") await reset(c.clinician_id);
        else if (c.kind === "skip") await skip(c.minutes ?? 0, c.clinician_id);
        else applyCommand(s, src, c);
      } catch (error) {
        console.error(`Command ${c.seq} (${c.kind}) was not applied:`, error);
      }
    }
  } finally {
    applying = false;
  }
}, 2000);
