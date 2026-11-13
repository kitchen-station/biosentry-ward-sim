import { describe, expect, it } from "vitest";
import { createSim, record, setSpeed, step } from "./sim";
import { createSyntheticSource, FIXTURE_SEED } from "./source";

// Proof that the fixture path makes the same random draws as before the drawn cohort existed.
// The reference values were captured from the code before that change, then matched after it.
const hash = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
};
const mapped = (_: string, v: unknown) => (v instanceof Map ? [...v] : v instanceof Set ? [...v] : v);
const DAY = 1440 * 60; // ticks at 60x

function run(seed: number, ticks: number) {
  const src = createSyntheticSource(seed, true);
  const s = createSim(src);
  setSpeed(s, 60);
  s.outbox = { observations: [], bins: [], events: [], admissions: [], departures: [], sent: new Map() };
  for (const p of s.patients) record(s, p, 0);
  for (let i = 0; i < ticks; i += 1) step(s, src);
  const ids = s.stays.map((x) => x.id);
  const sv = src.save!(ids);
  return {
    states: hash(JSON.stringify([sv.flowRng, sv.admitted, ids.map((id) => [id, (sv.streams[id] as { rng: number }).rng, (sv.streams[id] as { bpRng: number }).bpRng])])),
    sim: hash(JSON.stringify(s, mapped)),
    save: hash(JSON.stringify(sv)),
  };
}

const STATES = { "20260903:0": "2a307f43", "20260903:1": "d2c3d2fd", "777:0": "1d569343", "777:1": "ed8c2dd5" } as Record<string, string>;
// Captured on the untouched tree, before source.ts changed.
const WHOLE: Record<number, { sim: string; save: string }> = {
  20260903: { sim: "30eab6e0", save: "071ebad4" },
  777: { sim: "a73b6b2a", save: "34f40790" },
};

describe("fixture cohort draws as before", () => {
  it("pins the state of flowRng and every stream, at the start and after a day", () => {
    expect(FIXTURE_SEED).toBe(20260903);
    for (const seed of [FIXTURE_SEED, 777]) for (const d of [0, 1]) expect(run(seed, d * DAY).states).toBe(STATES[`${seed}:${d}`]);
  });

  it("the whole ward Sim and src.save() after a day equal the reference", () => {
    for (const seed of [FIXTURE_SEED, 777]) {
      const r = run(seed, DAY);
      expect({ sim: r.sim, save: r.save }).toEqual(WHOLE[seed]);
    }
  });
});
