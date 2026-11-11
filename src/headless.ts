/// <reference types="node" />
// The ward as a headless Node process: steps the sim against the wall clock and writes it to the
// BioSentry API, so the ward keeps running with no browser tab open. Run with `npm run ward`.
// The ward is saved to a file and a restart continues it: same patients, same clock, same run.
// The time the runner was down is not replayed. Delete the file to start a new ward.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { applyAction } from "./sim/actions";
import { loadWard, saveWard } from "./sim/persist";
import { createSim, minuteOf, setSpeed, step, type Speed } from "./sim/sim";
import { createSyntheticSource, FIXTURE_SEED } from "./sim/source";
import { createSync, STOP_TEXT } from "./sim/sync";
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
const src = saved?.src ?? createSyntheticSource(FIXTURE_SEED, true);
const s = saved?.s ?? createSim(src);
setSpeed(s, speed);
// A fixed client id: a runner that begins a new ward replaces its own run at once instead of waiting out the old one.
const sync = createSync({ apiUrl, key, clientId: "ward-runner", fetch });
const view = createPublisher();

let savedAt = 0;
function save() {
  writeFileSync(`${stateFile}.tmp`, saveWard(s, src, sync.run));
  renameSync(`${stateFile}.tmp`, stateFile); // a crash mid-write leaves the last whole file
  savedAt = Date.now();
}

async function flush() {
  await sync.flush();
  if (!sync.stopped) {
    // After a flush, so the file never holds less than the database was sent.
    if (Date.now() - savedAt >= SAVE_EVERY_MS) save();
    return;
  }
  console.error(STOP_TEXT[sync.stopped]);
  process.exit(1);
}

let last = performance.now();
let spare = 0;
if (saved) await sync.resume(s, src, saved.run);
else await sync.start(s, src);
console.log(`Ward ${saved ? `resumed at minute ${minuteOf(s)}, run ${sync.run.runId},` : "started"} running at ${speed}x, writing to ${apiUrl}`);
setInterval(() => {
  const now = performance.now();
  spare += (now - last) / 1000; // a late timer or a suspended host is caught up, so sim minutes stay on the wall clock
  last = now;
  for (; spare >= TICK; spare -= TICK) step(s, src);
  void flush();
}, 1000);
// What the page in viewer mode draws. Every 2 s, as often as it polls.
setInterval(() => void sync.publish(view(s)), 2000);
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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    // A stop is a pause, not the end of the run: the API shows the ward as not sending after 30 s.
    await sync.flush();
    if (!sync.stopped) save();
    process.exit(0);
  });
}
