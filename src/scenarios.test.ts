import { describe, expect, it } from "vitest";
import doh from "../scenarios/hospital/doh-standard.json?raw";
import moreNurses from "../scenarios/hospital/more-nurses.json?raw";
import typical from "../scenarios/hospital/typical.json?raw";
import { buildQuery, buildWorld, drawSeed, MAX_SEED, NAMED, parseQuery, parseSeed, seedText } from "./scenarios";
import { createHospitalSim } from "./sim/hospital/attach";
import { parseScenario } from "./sim/hospital/scenario";
import { setSpeed, step, type Sim } from "./sim/sim";
import { createSyntheticSource, FIXTURE_SEED } from "./sim/source";

// FNV-1a 32-bit, as in golden.test.ts (not imported: that file stays untouched).
const hash = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
};
const mapped = (_: string, v: unknown) => (v instanceof Map ? [...v] : v instanceof Set ? [...v] : v);
const fingerprint = (s: Sim) => hash(JSON.stringify({ flow: s.flow, patients: s.patients, hospital: s.hospital, clock: s.clockS }, mapped));

// Today's newWorld("typical"), written out.
const oldWorld = () => {
  const src = createSyntheticSource(FIXTURE_SEED, true);
  return { s: createHospitalSim(src, parseScenario(typical), 101), src };
};

describe("pitch", () => {
  it("builds exactly today's world, at 0 steps and after a few thousand", () => {
    const a = oldWorld();
    const b = buildWorld("pitch", null);
    expect(fingerprint(b.s)).toBe(fingerprint(a.s));
    for (const w of [a, b]) setSpeed(w.s, 60);
    for (let i = 0; i < 4000; i += 1) {
      step(a.s, a.src);
      step(b.s, b.src);
    }
    expect(fingerprint(b.s)).toBe(fingerprint(a.s));
  });

  it("a seed changes the run, the same seed repeats it", () => {
    const run = (seed: number | null) => {
      const w = buildWorld("pitch", seed);
      setSpeed(w.s, 60);
      for (let i = 0; i < 2000; i += 1) step(w.s, w.src);
      return fingerprint(w.s);
    };
    expect(run(7)).toBe(run(7));
    expect(run(7)).not.toBe(run(null));
  });
});

describe("more-nurses.json", () => {
  const flat = (o: unknown, path = ""): Record<string, unknown> =>
    typeof o === "object" && o !== null ? Object.assign({}, ...Object.entries(o).map(([k, v]) => flat(v, path ? `${path}.${k}` : k))) : { [path]: o };
  const t = flat(JSON.parse(typical));
  const m = flat(JSON.parse(moreNurses));
  const d = flat(JSON.parse(doh));
  const NURSES = ["units.MED3A.nurses", "units.MED3B.nurses", "units.SURG5A.nurses"];

  it("differs from typical only in the ward nurse counts, and they equal the DOH file's", () => {
    const diff = Object.keys(t).filter((k) => t[k] !== m[k] && k !== "name" && k !== "note");
    expect(diff.sort()).toEqual(NURSES);
    for (const k of NURSES) expect(m[k]).toBe(d[k]);
    expect(Object.keys(m).sort()).toEqual(Object.keys(t).sort());
  });

  it("parses", () => {
    expect(parseScenario(moreNurses).units.MED3A.nurses).toBe(3);
  });
});

describe("named list", () => {
  it("has the four ids, and every file parses", () => {
    expect(NAMED.map((n) => n.id)).toEqual(["pitch", "calm", "surge", "more-nurses"]);
    for (const n of NAMED) expect(() => buildWorld(n.id, null)).not.toThrow();
  });
});

describe("seed and URL", () => {
  it("takes digits from 1 to 2147483647 and nothing else", () => {
    expect(parseSeed("1")).toBe(1);
    expect(parseSeed(String(MAX_SEED))).toBe(MAX_SEED);
    for (const bad of ["12abc", "1e3", "-5", " 7", "", "0", "2147483648", "99999999999999999999", "1.5", "+7", null]) expect(parseSeed(bad)).toBeNull();
  });

  it("reads a known scenario and a valid seed, and ignores the rest", () => {
    expect(parseQuery("")).toEqual({ id: "pitch", seed: null });
    expect(parseQuery("?scenario=surge&seed=42")).toEqual({ id: "surge", seed: 42 });
    expect(parseQuery("?scenario=nope&seed=1e3")).toEqual({ id: "pitch", seed: null });
    expect(parseQuery("?seed=%207")).toEqual({ id: "pitch", seed: null });
  });

  it("builds a query that keeps other parameters and round-trips", () => {
    const q = buildQuery("?perf&scenario=surge&seed=5", "calm", 99);
    expect(new URLSearchParams(q).has("perf")).toBe(true);
    expect(parseQuery(q)).toEqual({ id: "calm", seed: 99 });
    expect(parseQuery(buildQuery(q, "calm", null))).toEqual({ id: "calm", seed: null });
  });

  it("draws from 1 to 2147483647 and redraws on 0", () => {
    const seq = [0, 1, 0xffffffff];
    expect(drawSeed(() => seq.shift()!)).toBe(MAX_SEED); // 0 and 1 both give 0 after the shift, so both are skipped
    expect(drawSeed(() => 0xffffffff)).toBe(MAX_SEED);
    expect(drawSeed(() => 2)).toBe(1);
  });

  it("shows the seed", () => {
    expect(seedText("pitch", null)).toBe("Seed 101 / 20260903");
    expect(seedText("surge", 55)).toBe("Seed 55");
  });
});
