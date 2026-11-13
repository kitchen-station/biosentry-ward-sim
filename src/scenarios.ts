// Named scenarios for the standalone page, and the URL form that repeats a run. Pure: no DOM, no network.
import doh from "../scenarios/hospital/doh-standard.json?raw";
import moreNurses from "../scenarios/hospital/more-nurses.json?raw";
import surge from "../scenarios/hospital/surge.json?raw";
import typical from "../scenarios/hospital/typical.json?raw";
import { createHospitalSim } from "./sim/hospital/attach";
import { parseScenario } from "./sim/hospital/scenario";
import type { Sim } from "./sim/sim";
import { createSyntheticSource, FIXTURE_SEED, type VitalsSource } from "./sim/source";

/** The scenario files by name, as text. */
export const FILES: Record<string, string> = { typical, "doh-standard": doh, surge, "more-nurses": moreNurses };
const HOSPITAL_SEED = 101;
export const MAX_SEED = 2147483647;

export type Named = { id: string; label: string; sentence: string; file: string; seed: number; vitalsSeed: number };
export const NAMED: Named[] = [
  { id: "pitch", label: "Pitch ward", sentence: "Today's run, exactly.", file: "typical", seed: HOSPITAL_SEED, vitalsSeed: FIXTURE_SEED },
  { id: "calm", label: "Calm, fully staffed", sentence: "Fewer arrivals and the DOH staffing standard.", file: "doh-standard", seed: HOSPITAL_SEED, vitalsSeed: FIXTURE_SEED },
  { id: "surge", label: "Surge", sentence: "More arrivals than typical, same staff.", file: "surge", seed: HOSPITAL_SEED, vitalsSeed: FIXTURE_SEED },
  { id: "more-nurses", label: "More ward nurses (DOH ward staffing)", sentence: "The typical hospital with the ward nurse counts of the DOH standard and nothing else changed, ready for a compare.", file: "more-nurses", seed: HOSPITAL_SEED, vitalsSeed: FIXTURE_SEED },
];
export const DEFAULT_ID = "pitch";
const byId = (id: string) => NAMED.find((n) => n.id === id) ?? NAMED[0];

/** A seed from the page: digits only, 1 to 2147483647. Anything else is null. */
export function parseSeed(text: string | null): number | null {
  if (text === null || !/^\d{1,10}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= MAX_SEED ? n : null;
}

/** What `?scenario=<id>&seed=<n>` asks for. A bad part is ignored, never an error. */
export function parseQuery(search: string): { id: string; seed: number | null } {
  const q = new URLSearchParams(search);
  const id = q.get("scenario");
  return { id: NAMED.some((n) => n.id === id) ? id! : DEFAULT_ID, seed: parseSeed(q.get("seed")) };
}

/** The query string to show: the scenario and the seed set, every other parameter kept. */
export function buildQuery(search: string, id: string, seed: number | null): string {
  const q = new URLSearchParams(search);
  q.set("scenario", id);
  if (seed === null) q.delete("seed");
  else q.set("seed", String(seed));
  return `?${q}`;
}

/** A seed from 1 to 2147483647 out of a 32-bit source (crypto.getRandomValues in the page). It redraws on 0, so no value is favoured. */
export function drawSeed(u32: () => number): number {
  for (;;) {
    const n = u32() >>> 1;
    if (n >= 1) return n;
  }
}

/** The text of the seed pill: the hospital seed, and the vitals seed too if it differs. */
export function seedText(id: string, seed: number | null): string {
  const n = byId(id);
  return seed !== null ? `Seed ${seed}` : n.seed === n.vitalsSeed ? `Seed ${n.seed}` : `Seed ${n.seed} / ${n.vitalsSeed}`;
}

/** The standalone hospital world. A seed override sets both the hospital seed and the vitals seed. */
export function buildWorld(id: string, seed: number | null): { s: Sim; src: VitalsSource } {
  const n = byId(id);
  const src = createSyntheticSource(seed ?? n.vitalsSeed, true);
  return { s: createHospitalSim(src, parseScenario(FILES[n.file]), seed ?? n.seed), src };
}
