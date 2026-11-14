/// <reference types="node" />
// The ward as a headless Node process: steps the sim against the wall clock and writes it to the
// BioSentry API, so the ward keeps running with no browser tab open. Run with `npm run ward`.
// The ward is saved to a file and a restart continues it: same patients, same clock, same run.
// The time the runner was down is not replayed. Delete the file to start a new ward.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { applyAction } from "./sim/actions";
import { applyCommand, clinicianName, freshWard } from "./sim/commands";
import { refuseHospitalState } from "./sim/hospital/attach";
import { loadWard, saveWard } from "./sim/persist";
import { minuteOf, say, step, type Speed } from "./sim/sim";
import { createSync, STOP_TEXT } from "./sim/sync";
import { createTruthPoster, startedEpisodes } from "./sim/truth";
import { createPublisher } from "./sim/view";

const TICK = 1 / 60;
const apiUrl = process.env.BIOSENTRY_API_URL;
const key = process.env.BIOSENTRY_INGEST_KEY;
// Real time by default: at 60x one ward writes about 7 million observations a day.
const speed = Number(process.env.WARD_SPEED ?? 1) as Speed;
if (!apiUrl || !key || ![1, 10, 60].includes(speed)) {
  console.error("Set BIOSENTRY_API_URL and BIOSENTRY_INGEST_KEY. WARD_SPEED may be 1, 10 or 60.");
  process.exit(2);
}

const stateFile = process.env.WARD_STATE_FILE ?? "ward-state.json";
const SAVE_EVERY_MS = 10_000;
// A state file that cannot be read stops the runner: starting a new ward over it would lose the old one.
const saved = existsSync(stateFile) ? loadWard(readFileSync(stateFile, "utf8")) : null;
const refused = saved && refuseHospitalState(saved.s);
if (refused) {
  console.error(refused); // before sync starts: nothing is sent
  process.exit(2);
}
// WARD_SPEED is the starting speed: a saved ward resumes at the speed it had, which a clinician may have changed.
let { s, src } = saved ?? freshWard(speed);
s.rounds = true; // the deployed ward: nurses re-take observations on the NEWS2 schedule (also for a ward saved before this existed)
// A fixed client id: a runner that begins a new ward replaces its own run at once instead of waiting out the old one.
const sync = createSync({ apiUrl, key, clientId: "ward-runner", fetch });
const view = createPublisher();
// Owner decision dashboard-7: started episodes go to the API, only from here. See docs/episode-truth.md.
const poster = createTruthPoster({ apiUrl, key, fetch, now: Date.now, log: console.error });

let savedAt = 0;
function save() {
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

async function flush() {
  await sync.flush();
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
if (saved) await sync.resume(s, src, saved.run);
else await sync.start(s, src);
started = true;
console.log(`Ward ${saved ? `resumed at minute ${minuteOf(s)}, run ${sync.run.runId},` : "started"} running at ${s.speed}x, writing to ${apiUrl}`);
setInterval(() => {
  const now = performance.now();
  spare += (now - last) / 1000; // a late timer or a suspended host is caught up, so sim minutes stay on the wall clock
  last = now;
  for (; spare >= TICK; spare -= TICK) step(s, src);
  void flush();
}, 1000);
// What the page in viewer mode draws. Every 2 s, as often as it polls.
setInterval(() => void sync.publish(view(s)), 2000);
// A new ward at the current speed, in a new run. start() registers it before this returns to the timers, so no tick or save sees the old world with the new run.
async function reset(by: string) {
  const fresh = freshWard(s.speed); // its own source: the old one remembers who deteriorated and when
  fresh.s.rounds = true;
  const starting = sync.start(fresh.s, fresh.src);
  [s, src] = [fresh.s, fresh.src];
  say(s, `${clinicianName(by)} reset the ward`);
  await starting;
  save();
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

// What clinicians sent from the viewer: speed, reset and a patient's controls.
setInterval(async () => {
  for (const c of await sync.pullCommands()) {
    try {
      if (c.kind === "reset") await reset(c.clinician_id);
      else applyCommand(s, src, c);
    } catch (error) {
      console.error(`Command ${c.seq} (${c.kind}) was not applied:`, error);
    }
  }
}, 2000);
