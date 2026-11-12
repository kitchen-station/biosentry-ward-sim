// What clinicians send from the viewer to the runner, and what each does to the running ward. The page
// posts a command (sendCommand); the runner reads the feed (src/sim/sync.ts) and calls applyCommand
// between ticks. Reset is the runner's own: it replaces the whole world (src/headless.ts).

import { applyPatch, createSim, detachPatch, injectDeterioration, say, setSpeed, startArrhythmia, STAFF, type Sim, type Speed } from "./sim";
import { createSyntheticSource, FIXTURE_SEED, type VitalsSource } from "./source";

/** One row of GET /sim/runs/{run_id}/commands. `speed` is set only for set_speed, `patient_id` only for the patient kinds. */
export interface Command {
  seq: number;
  kind: "set_speed" | "reset" | "inject_deterioration" | "start_arrhythmia" | "detach_patch" | "apply_patch";
  patient_id: string | null;
  clinician_id: string;
  speed: number | null;
}

/** The body of POST /wards/W4/sim/commands. */
export type CommandBody = Pick<Command, "kind" | "patient_id" | "speed">;

const SPEEDS = [0, 1, 10, 60];

/** A new ward and its own source, as the runner starts one. The source holds per-patient state, so a world never shares it with another. */
export function freshWard(speed: Speed): { s: Sim; src: VitalsSource } {
  const src = createSyntheticSource(FIXTURE_SEED, true);
  const s = createSim(src);
  setSpeed(s, speed);
  return { s, src };
}

export const clinicianName = (id: string) => STAFF.find(([staffId]) => staffId === id)?.[1] ?? id;

export function applyCommand(s: Sim, src: VitalsSource, c: Command) {
  const clinician = clinicianName(c.clinician_id);
  if (c.kind === "set_speed") {
    if (c.speed === null || !SPEEDS.includes(c.speed)) return;
    setSpeed(s, c.speed as Speed);
    return say(s, c.speed === 0 ? `${clinician} paused the ward` : `${clinician} set the speed to ${c.speed}x`);
  }
  if (c.kind === "reset") return; // the runner replaces the world itself
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
export function commandNotice(status: number): string | null {
  if (status === 204) return null;
  if (status === 403) return "Not sent: your role cannot control the ward";
  if (status === 404) return "Not sent: no such ward or patient";
  if (status === 409) return "Not sent: the ward is not live";
  return "Not sent: cannot reach the ward";
}

/** Posts one command as the signed-in clinician. Answers the HTTP status, 0 when the API cannot be reached. */
export async function sendCommand(apiUrl: string, token: string | null, body: CommandBody, send: typeof fetch = fetch): Promise<number> {
  try {
    const response = await send(`${apiUrl}/wards/W4/sim/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return response.status;
  } catch {
    return 0;
  }
}
