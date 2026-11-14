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
// Numbers that are not whole are rounded to 3 decimals before hashing. The last digits of a float depend on the machine's
// maths library (CI on Linux and Node 22 gave other raw digits than macOS and Node 25, with every random draw the same),
// so a hash of raw floats is not a fair pin. The golden test rounds for the same reason. The random draws themselves are
// pinned exactly, as whole numbers, in the first test below.
const mapped = (_: string, v: unknown) =>
  v instanceof Map ? [...v] : v instanceof Set ? [...v] : typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v;
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
    save: hash(JSON.stringify(sv, mapped)),
  };
}

const STATES = { "20260903:0": "2a307f43", "20260903:1": "d2c3d2fd", "777:0": "1d569343", "777:1": "ed8c2dd5" } as Record<string, string>;
// Rounded form. Read on the tree as it is, and again with src/sim/source.ts as it was before the drawn cohort (commit
// 42b56d8): the same four values. The raw-float form of this pin (30eab6e0, 071ebad4, a73b6b2a, 34f40790 on macOS) was
// captured on the untouched tree first and held after the change, on one machine.
const WHOLE: Record<number, { sim: string; save: string }> = {
  20260903: { sim: "b9ece37d", save: "7dd9a7a9" },
  777: { sim: "2c9ee0da", save: "335577ef" },
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
