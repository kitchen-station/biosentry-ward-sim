import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSim, setSpeed, step } from "./sim";
import { createSyntheticSource, type Vital, VITALS } from "./source";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const drawn = (seed: number) => createSyntheticSource(seed, true, undefined, "drawn");
const IDS = Array.from({ length: 12 }, (_, i) => `c-${String(i + 1).padStart(3, "0")}`);
const who = (seed: number) => drawn(seed).seeds().map((p) => `${p.name}|${p.age}|${p.sex}|${p.bed}`);

function day(seed: number, cohort: "fixture" | "drawn") {
  const src = createSyntheticSource(seed, true, undefined, cohort);
  const s = createSim(src);
  setSpeed(s, 60);
  for (let i = 0; i < 1440 * 60; i += 1) step(s, src);
  return { src, s };
}
const mapped = (_: string, v: unknown) => (v instanceof Map ? [...v] : v instanceof Set ? [...v] : v);

describe("drawn cohort", () => {
  it("has ids c-001 to c-012, the honest story, no invented history, and is not the fixture", () => {
    const seeds = drawn(777).seeds();
    expect(seeds.map((p) => p.id)).toEqual(IDS);
    for (const p of seeds) {
      expect(p.story).toMatch(/^At 15:00: on the ward, admitted (with|for) .+ \(synthetic patient, drawn for this run\)$/);
      expect(p.trend).toBe("insufficient");
      expect(p.dueMin).toBeUndefined();
      for (const v of VITALS) expect(new Set(p.history[v as Vital]).size).toBe(1); // 12 flat values at the drawn baseline
    }
    expect(seeds[0].name).not.toBe(createSyntheticSource(777, true).seeds()[0].name);
  });

  it("repeats for its seed after a simulated day, and differs across seeds", () => {
    const a = day(777, "drawn");
    const b = day(777, "drawn");
    expect(JSON.stringify(b.s, mapped)).toBe(JSON.stringify(a.s, mapped));
    expect(JSON.stringify(b.src.save!(b.s.stays.map((x) => x.id)))).toBe(JSON.stringify(a.src.save!(a.s.stays.map((x) => x.id))));
    expect(who(777)).toEqual(who(777));
    expect(who(777)).not.toEqual(who(778));
    const base = (seed: number) => drawn(seed).seeds().map((p) => p.history.heart_rate[0]);
    expect(base(777)).not.toEqual(base(778));
  });

  it("seats at minute 0 in distinct beds", () => {
    const s = createSim(drawn(777));
    expect(s.patients.map((p) => p.id)).toEqual(IDS);
    expect(new Set(s.patients.map((p) => p.bed)).size).toBe(12);
    expect(s.patients.every((p) => p.dueMin !== null)).toBe(true);
  });

  it("gets the same later arrivals as the fixture cohort with the same seed (the new streams are separate)", () => {
    const f = createSyntheticSource(777, true);
    const sf = createSim(f);
    const d = drawn(777);
    const sd = createSim(d);
    const ids = (s: typeof sf) => s.patients.map((p) => p.id);
    expect(d.save!(ids(sd)).flowRng).toBe(f.save!(ids(sf)).flowRng);
    expect(d.save!(ids(sd)).admitted).toBe(0);
    expect(sd.patients.map((p) => p.dueMin)).toEqual(sf.patients.map((p) => p.dueMin));
    expect(d.admit!(10, sd.patients)!.name).toBe(f.admit!(10, sf.patients)!.name);
  });

  it("restores without redrawing: the same next readings; its seeds() fails loudly", () => {
    const a = day(777, "drawn");
    const ids = a.s.stays.map((x) => x.id);
    const saved = JSON.parse(JSON.stringify(a.src.save!(ids)));
    const b = createSyntheticSource(777, true, saved, "drawn");
    const m = 1440 + 1;
    for (const id of ids) {
      for (let k = 0; k < 5; k += 1) expect(b.read(id, m + k)).toEqual(a.src.read(id, m + k));
      expect(b.cuff(id, m)).toEqual(a.src.cuff(id, m));
    }
    expect(() => b.seeds()).toThrow(/no fixture patient has no seeds/);
    // persist.ts passes no cohort: a saved drawn world must still refuse.
    expect(() => createSyntheticSource(777, true, saved).seeds()).toThrow(/no fixture patient has no seeds/);
  });

  it("a restored fixture source still returns the 12 fixture patients", () => {
    const src = createSyntheticSource(777, true);
    const s = createSim(src);
    const saved = JSON.parse(JSON.stringify(src.save!(s.patients.map((p) => p.id))));
    expect(createSyntheticSource(777, true, saved).seeds()).toEqual(createSyntheticSource(777, true).seeds());
  });
});

const short = (x: unknown) => {
  let h = 0x811c9dc5;
  for (const c of JSON.stringify(x)) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describe("a baseline shift on the drawn path is caught", () => {
  it("pins seeds() and the first reading of every c- id for seed 777", () => {
    const src = drawn(777);
    const seeds = src.seeds();
    const first = seeds.map((p) => src.read(p.id, 1));
    expect({ seeds: short(seeds), first: short(first) }).toEqual({ seeds: "f2c5b441", first: "83165287" });
  });

  it("median baseline heart rate of the 12 drawn equals that of the first 12 admitted, over seeds 1 to 60", () => {
    const drawnHr: number[] = [];
    const admittedHr: number[] = [];
    for (let seed = 1; seed <= 60; seed += 1) {
      drawnHr.push(...drawn(seed).seeds().map((p) => p.history.heart_rate[0] as number));
      const f = createSyntheticSource(seed, true);
      const occupied: { bed: string; rn: string; md: string }[] = [];
      for (let k = 0; k < 12; k += 1) {
        const p = f.admit!(0, occupied)!;
        occupied.push(p);
        admittedHr.push(p.history.heart_rate[0] as number);
      }
    }
    expect(Math.abs(median(drawnHr) - median(admittedHr))).toBeLessThanOrEqual(2);
  });
});

describe("one drawing function", () => {
  const src = read("./source.ts");
  it("has one drawing site for baselines; admit and the cohort both call draw", () => {
    expect(src.match(/drawFrom\(fit\.baseline\.heart_rate/g)).toHaveLength(1);
    expect(src.match(/function draw\(/g)).toHaveLength(1);
    expect(src).toContain("return draw(flowRng, minute, occupied, given, person,");
    expect(src).toContain("const p = draw(mulberry32(streamSeed(seed, `cohort:${i}`)), 0, cohortSeeds,");
    expect(src.match(/[^.\w]draw\(/g)).toHaveLength(3); // the definition and the two calls
  });
});

describe("ids", () => {
  it("no per-id fixture table has a c- id, and a drawn patient gets none of their effects", () => {
    const src = read("./source.ts");
    const names = ["AF_PATIENTS", "SLOPE", "DEMO_CUFF", "DEMO_BASELINE", "NO_PATCH", "SIGNAL_LOST_MIN", "DEMO_PHYSICIAN"];
    const tables = names.map((n) => src.match(new RegExp(`const ${n}\\b[^;]*;`))![0]);
    for (const t of tables) {
      expect(t).not.toMatch(/"c-\d/);
      expect(t.match(/"[a-z]-\d{3}"/g)?.every((k) => k.startsWith('"p-')) ?? true).toBe(true);
    }
    for (const p of drawn(777).seeds()) {
      expect(p.signalLostMin).toBe(0);
      expect(p.patch).toBe(true);
    }
  });
});

describe("duplicate full names", () => {
  // Measured before the redraw: 196 of seeds 1 to 500 had a repeated full name among the 12. Now none do.
  it("no drawn group of 12 has a repeated full name, over seeds 1 to 500", () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const names = drawn(seed).seeds().map((p) => p.name);
      expect(new Set(names).size, `seed ${seed}`).toBe(12);
    }
  });

  it("the redraw uses its own name stream and assigns only the name", () => {
    const src = read("./source.ts");
    expect(src).toContain("p.name = nameOf(p.sex, nameRng)");
    expect(src.match(/nameRng/g)).toHaveLength(2); // only the name stream is used in the redraw
  });
});

describe("the runners keep the fixture cohort", () => {
  it("headless, commands, trial, compare and sync never pass a cohort or say drawn", () => {
    for (const f of ["../headless.ts", "./commands.ts", "../trial.ts", "../compare.ts", "./sync.ts"]) {
      const text = read(f);
      expect(text, f).not.toContain('"drawn"');
      for (const m of text.matchAll(/createSyntheticSource\(([^)]*)\)/g)) expect(m[1].split(",").length, `${f}: ${m[0]}`).toBeLessThanOrEqual(3);
    }
  });
});
