// What clinicians send from the viewer to the runner, and what each does to the running ward. The page
// posts a command (sendCommand); the runner reads the feed (src/sim/sync.ts) and calls applyCommand
// between ticks. Reset and skip are the runner's own: one replaces the whole world, the other steps it ahead (src/headless.ts).

import { applyPatch, createSim, detachPatch, injectDeterioration, say, setSpeed, startArrhythmia, STAFF, step, type Sim, type Speed } from "./sim";
import { createSyntheticSource, FIXTURE_SEED, type VitalsSource } from "./source";

/** One row of GET /sim/runs/{run_id}/commands. `speed` is set only for set_speed, `minutes` only for skip (an older API leaves it out), `patient_id` only for the patient kinds. */
export interface Command {
  seq: number;
  kind: "set_speed" | "reset" | "skip" | "inject_deterioration" | "start_arrhythmia" | "detach_patch" | "apply_patch";
  patient_id: string | null;
  clinician_id: string;
  speed: number | null;
  minutes?: number | null;
}

/** The body of POST /wards/W4/sim/commands. `minutes` is sent with a skip only: the API refuses it on any other kind. */
export type CommandBody = Pick<Command, "kind" | "patient_id" | "speed"> & { minutes?: number };

/** What a skip may ask for, in ward minutes, and the menu's word for each. The API takes these four and no other. */
export const SKIPS: [number, string][] = [[60, "+1 h"], [360, "+6 h"], [720, "+12 h"], [1440, "+1 day"]];

/**
 * Moves a running world ahead by `minutes` ward minutes at once. The world itself is behind the three calls, so this holds
 * no world and a month's end can replace it:
 *  - `tick()` steps one ward second and answers false when the world can go no further (ended, or its month is over);
 *  - `minute()` runs after every ward minute (the runner publishes the hospital's readings there, as it does at 60x);
 *  - `hour()` runs after every ward hour and at the end (the runner flushes there, so no batch holds more than an hour).
 *    It answers whether the skip may go on: false stops it there (the API is not taking the data).
 * Answers the ward seconds stepped.
 */
export async function skipAhead(minutes: number, world: { tick: () => boolean; minute: () => void; hour: () => Promise<boolean> }): Promise<number> {
  let done = 0;
  while (done < minutes * 60 && world.tick()) {
    done += 1;
    if (done % 60 === 0) world.minute();
    if (done % 3600 === 0 && !(await world.hour())) break;
  }
  if (done % 60 !== 0) world.minute();
  if (done % 3600 !== 0) await world.hour();
  return done;
}

const SPEEDS = [0, 1, 10, 60];

/** A new ward and its own source, as the runner starts one. The source holds per-patient state, so a world never shares it with another. */
export function freshWard(speed: Speed): { s: Sim; src: VitalsSource } {
  const src = createSyntheticSource(FIXTURE_SEED, true);
  const s = createSim(src);
  setSpeed(s, speed);
  return { s, src };
}

/** The most rows a skip may leave queued. The sync drops the oldest rows above 50,000 (MAX_QUEUED in sync.ts), so a skip stops well before that. */
export const SKIP_QUEUE_MARK = 40_000;
/**
 * Whether a skip may step another hour. Yes only when the API took the whole queue at this very minute (the hour's flush
 * went through) and little is queued. Otherwise a day's skip against an API that is down would queue more than the sync
 * keeps, and the oldest rows would be dropped.
 */
export const skipMayGoOn = (ackedMinute: number | null, minute: number, queued: number): boolean => ackedMinute === minute && queued <= SKIP_QUEUE_MARK;

/** One ward second at 60x fidelity, whatever the ward's speed. The speed is set back even when the step throws, so a live run is never left at 60x. */
export function stepOneSecond(s: Sim, src: VitalsSource): void {
  const speed = s.speed;
  s.speed = 60;
  try {
    step(s, src);
  } finally {
    s.speed = speed;
  }
}

export const clinicianName = (id: string) => STAFF.find(([staffId]) => staffId === id)?.[1] ?? id;

export function applyCommand(s: Sim, src: VitalsSource, c: Command) {
  const clinician = clinicianName(c.clinician_id);
  if (c.kind === "set_speed") {
    if (c.speed === null || !SPEEDS.includes(c.speed)) return;
    setSpeed(s, c.speed as Speed);
    return say(s, c.speed === 0 ? `${clinician} paused the ward` : `${clinician} set the speed to ${c.speed}x`);
  }
  if (c.kind === "reset" || c.kind === "skip") return; // the runner's own: it replaces the world, or steps it ahead
  const p = s.patients.find((x) => x.id === c.patient_id);
  if (!p) return say(s, `${clinician} sent ${c.kind} for ${c.patient_id}, who is not on the ward`); // already left, or never here
  // The same calls as the buttons in the patient panel, which are off in the same cases. Each logs its own line, so none is added here.
  const requested = s.tasks.some((t) => t.patient === p.id && t.kind === "apply_patch") || s.staff.some((m) => m.task?.patient === p.id && m.task.kind === "apply_patch");
  if (c.kind === "inject_deterioration" && src.inject && !p.injected) {
    injectDeterioration(s, src, p.id);
  } else if (c.kind === "start_arrhythmia" && src.startAf && !p.irregular) {
    startArrhythmia(s, src, p.id);
  } else if (c.kind === "detach_patch" && p.patch) {
    detachPatch(s, p.id);
  } else if (c.kind === "apply_patch" && !p.patch && !requested) {
    applyPatch(s, p.id);
  }
}

/** What the top bar says when the runner did not take a command. 204 is taken; 401 is not here: the page signs out. */
export function commandNotice(status: number, detail = ""): string | null {
  if (status === 204) return null;
  if (status === 409 && /skip/i.test(detail)) return "A skip is still being applied"; // the API's own reason: one skip at a time
  if (status === 403) return "Not sent: your role cannot control the ward";
  if (status === 404) return "Not sent: no such ward or patient";
  if (status === 409) return "Not sent: the ward is not live";
  return "Not sent: cannot reach the ward";
}

/** Posts one command as the signed-in clinician. Answers the HTTP status, 0 when the API cannot be reached. `refused` gets the API's own reason for a 409, when it gives one. */
export async function sendCommand(apiUrl: string, token: string | null, body: CommandBody, send: typeof fetch = fetch, refused?: (detail: string) => void): Promise<number> {
  try {
    const response = await send(`${apiUrl}/wards/W4/sim/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (response.status === 409 && refused) {
      const detail = ((await response.json().catch(() => null)) as { detail?: unknown } | null)?.detail;
      if (typeof detail === "string") refused(detail);
    }
    return response.status;
  } catch {
    return 0;
  }
}
