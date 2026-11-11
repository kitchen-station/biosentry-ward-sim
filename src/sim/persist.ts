// Saves a ward and loads it again, so a restarted runner continues the same ward in the same run.
// Pure: no browser or Node APIs. The text is JSON.

import type { Sim } from "./sim";
import { createSyntheticSource, type SavedSource, type VitalsSource } from "./source";

const VERSION = 1;

/** The API run a ward is written to, the wall time of its minute 0, and the last clinician action applied. */
export interface Run {
  runId: number | null;
  origin: string;
  cursor: number;
}

export function saveWard(s: Sim, src: VitalsSource, run: Run): string {
  if (!src.save) throw new Error("This vitals source cannot be saved");
  const ids = s.patients.map((p) => p.id);
  const { outbox, ...sim } = s;
  return JSON.stringify({
    version: VERSION,
    run,
    source: src.save(ids), // holds the seed
    sim,
    // Patients who left are never queued again, so what was last sent for them is dropped.
    outbox: outbox && { ...outbox, sent: [...outbox.sent].filter(([key]) => ids.includes(key.split("/")[0])) },
  });
}

export function loadWard(text: string): { s: Sim; src: VitalsSource; run: Run } {
  let saved: { version: number; run: Run; source: SavedSource; sim: Sim; outbox?: Omit<NonNullable<Sim["outbox"]>, "sent"> & { sent: [string, string][] } };
  try {
    saved = JSON.parse(text);
  } catch (error) {
    throw new Error(`The ward state is not valid JSON: ${(error as Error).message}`);
  }
  if (saved?.version !== VERSION) throw new Error(`The ward state is version ${saved?.version}, this runner reads version ${VERSION}`);
  const s = saved.sim;
  if (saved.outbox) s.outbox = { ...saved.outbox, sent: new Map(saved.outbox.sent) };
  // A patient's stay and its entry in s.stays are one object, which JSON made two.
  for (const p of s.patients) {
    const stay = s.stays.find((x) => x.id === p.id && x.outMin === null);
    if (!stay) throw new Error(`The ward state has no open stay for ${p.id}`);
    p.stay = stay;
  }
  return { s, src: createSyntheticSource(saved.source.seed, saved.source.flow, saved.source), run: { ...saved.run, cursor: saved.run.cursor ?? 0 } }; // saved before the cursor existed: 0
}
