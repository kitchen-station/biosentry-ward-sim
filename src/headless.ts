/// <reference types="node" />
// The ward as a headless Node process: steps the sim against the wall clock and writes it to the
// BioSentry API, so the ward keeps running with no browser tab open. Run with `npm run ward`.
// shortcut: a restart begins a new run at minute 0 with the same seed; save and reload the Sim when the ward must survive restarts.

import { createSim, setSpeed, step, type Speed } from "./sim/sim";
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

const src = createSyntheticSource(FIXTURE_SEED, true);
const s = createSim(src);
setSpeed(s, speed);
// A fixed client id: a restarted runner replaces its own run at once instead of waiting out the old one.
const sync = createSync({ apiUrl, key, clientId: "ward-runner", fetch });
const view = createPublisher();

async function flush() {
  await sync.flush();
  if (!sync.stopped) return;
  console.error(STOP_TEXT[sync.stopped]);
  process.exit(1);
}

let last = performance.now();
let spare = 0;
await sync.start(s, src);
console.log(`Ward running at ${speed}x, writing to ${apiUrl}`);
setInterval(() => {
  const now = performance.now();
  spare += (now - last) / 1000; // a late timer or a suspended host is caught up, so sim minutes stay on the wall clock
  last = now;
  for (; spare >= TICK; spare -= TICK) step(s, src);
  void flush();
}, 1000);
// What the page in viewer mode draws. Every 2 s, as often as it polls.
setInterval(() => void sync.publish(view(s)), 2000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    s.ended = true; // frees the ward for the next sim without the 30 s wait
    await sync.publish(view(s)); // viewers see Run ended
    await sync.flush();
    process.exit(0);
  });
}
