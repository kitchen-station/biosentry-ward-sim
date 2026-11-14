import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import doh from "../scenarios/hospital/doh-standard.json?raw";
import moreNurses from "../scenarios/hospital/more-nurses.json?raw";
import typical from "../scenarios/hospital/typical.json?raw";
import { buildQuery, buildWorld, drawSeed, MAX_SEED, NAMED, parseQuery, parseSeed, seedText } from "./scenarios";
import { createHospitalSim } from "./sim/hospital/attach";
import { parseScenario } from "./sim/hospital/scenario";
import { setSpeed, step, type Sim } from "./sim/sim";
import { createSyntheticSource, FIXTURE_SEED } from "./sim/source";
import * as rngModule from "./sim/hospital/rng";
import { createWardStats, feed, summary } from "./sim/ward-stats";

// FNV-1a 32-bit, as in golden.test.ts (not imported: that file stays untouched).
const hash = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
};
const mapped = (_: string, v: unknown) => (v instanceof Map ? [...v] : v instanceof Set ? [...v] : v);
// The whole Sim, not a chosen part: staff, tasks, the log and the stays are in it too.
const fingerprint = (s: Sim) => hash(JSON.stringify(s, mapped));

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

describe("seed draws ward W4's 12", () => {
  const w4 = (id: string, seed: number | null) => buildWorld(id, seed).s.patients.map((p) => `${p.id}|${p.name}`);
  it("no seed keeps the fixture 12 in every named scenario; any seed draws c-001 to c-012", () => {
    for (const n of NAMED.filter((x) => !x.critical)) { // critical always draws, see its own tests
      expect(w4(n.id, null)).toEqual(createSyntheticSource(FIXTURE_SEED, true).seeds().map((p) => `${p.id}|${p.name}`));
      expect(w4(n.id, null).every((x) => x.startsWith("p-"))).toBe(true);
      expect(w4(n.id, 777).map((x) => x.split("|")[0])).toEqual(Array.from({ length: 12 }, (_, i) => `c-${String(i + 1).padStart(3, "0")}`));
    }
  });

  it("the same seed gives the same people, another seed other people, and the hospital keeps their names", () => {
    expect(w4("pitch", 777)).toEqual(w4("pitch", 777));
    expect(w4("pitch", 777)).not.toEqual(w4("pitch", 778));
    expect(w4("pitch", 777)).toEqual(w4("more-nurses", 777));
    const w = buildWorld("pitch", 777);
    expect(w.s.hospital!.people.filter((p) => p.unit === "W4" && p.w4Id).map((p) => p.name)).toEqual(w.s.patients.map((p) => p.name));
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
  it("has the five ids, and every file parses", () => {
    expect(NAMED.map((n) => n.id)).toEqual(["pitch", "calm", "surge", "more-nurses", "critical"]);
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

describe("who gets Shuffle", () => {
  it("only the standalone hospital page: a viewer or ward-only build passes no handler", () => {
    const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    expect(app).toContain("onShuffle: HOSPITAL ? ");
    expect(app.match(/onShuffle:/g)).toHaveLength(1);
    expect(app).toContain("const HOSPITAL = !VIEW_API && !import.meta.env.VITE_API_URL;");
  });
});

describe("critical group", () => {
  const injectAts = (w: ReturnType<typeof buildWorld>) =>
    Object.fromEntries(Object.entries((w.src.save!(w.s.patients.map((p) => p.id)) as unknown as { streams: Record<string, { injectAt: number | null }> }).streams).map(([id, v]) => [id, v.injectAt]));
  // The same world without the critical step.
  const plain = (seed: number | null) => {
    const src = createSyntheticSource(seed ?? 20261114, true, undefined, "drawn");
    return { s: createHospitalSim(src, parseScenario(typical), seed ?? 101), src };
  };
  const picked = (seed: number | null) => {
    const a = injectAts(plain(seed));
    const b = injectAts(buildWorld("critical", seed));
    return Object.keys(b).filter((id) => a[id] !== b[id]).map((id) => [id, b[id]] as const);
  };

  it("sets exactly the chosen streams, each in [0, 360), and no other", () => {
    for (const seed of [null, 777]) {
      const w = buildWorld("critical", seed);
      const cand = w.s.patients.filter((p) => p.dueMin !== null && p.dueMin > 360).length;
      const a = injectAts(plain(seed));
      const b = injectAts(w);
      const changed = Object.keys(b).filter((id) => a[id] !== b[id]);
      expect(changed.length).toBeLessThanOrEqual(Math.min(4, cand));
      for (const id of changed) expect(Number.isInteger(b[id])).toBe(true);
      for (const id of changed) expect(b[id]!).toBeGreaterThanOrEqual(0), expect(b[id]!).toBeLessThan(360);
      for (const id of Object.keys(b)) if (!changed.includes(id)) expect(b[id]).toBe(a[id]);
      expect(w.s.log[0].text).toContain(`Chosen group: ${Math.min(4, cand)} of 12`);
    }
  });

  it("repeats for a seed, differs for another, and never picks someone due by minute 360", () => {
    expect(picked(777)).toEqual(picked(777));
    // Pinned: a pick from another stream, or the first four, gives other people or minutes.
    expect([...picked(777)].sort()).toEqual([["c-005", 349], ["c-007", 207], ["c-009", 305], ["c-011", 172]]);
    expect(picked(777)).not.toEqual(picked(778));
    for (const seed of [null, 777, 778]) {
      const w = buildWorld("critical", seed);
      const due = new Map(w.s.patients.map((p) => [p.id, p.dueMin]));
      for (const [id] of picked(seed)) expect(due.get(id)!).toBeGreaterThan(360);
    }
  });

  it("leaves every other scenario alone", () => {
    for (const id of ["pitch", "calm", "surge", "more-nurses"]) {
      const spy = vi.spyOn(rngModule, "stream");
      buildWorld(id, 777);
      expect(spy.mock.calls.some((c) => c[1] === "critical")).toBe(false);
      spy.mockRestore();
    }
    const spy = vi.spyOn(rngModule, "stream");
    buildWorld("critical", 777);
    expect(spy.mock.calls.some((c) => c[0] === 777 && c[1] === "critical")).toBe(true);
    spy.mockRestore();
    const a = oldWorld();
    const b = buildWorld("pitch", null);
    expect(fingerprint(b.s)).toBe(fingerprint(a.s));
  });

  it("shows the label on the seed pill", () => {
    expect(seedText("critical", null)).toBe("Seed 101 / 20261114 · chosen group");
    expect(seedText("critical", 777)).toBe("Seed 777 · chosen group");
  });

  it("reaches NEWS2 5 or more for some picked patients in 12 hours, and the episode table lists each chosen start (seed 20261114)", () => {
    const w = buildWorld("critical", null);
    const ids = picked(null).map(([id]) => id);
    const reached = new Set<string>();
    const stats = createWardStats();
    setSpeed(w.s, 60);
    while (w.s.clockS < 12 * 3600) {
      step(w.s, w.src);
      feed(stats, w.s, w.src);
      for (const p of w.s.patients) if (ids.includes(p.id) && p.decision.kind === "ranked" && p.decision.news2.total >= 5) reached.add(p.id);
    }
    const starts = summary(stats).episodes!.map((e) => e.start);
    for (const [, at] of picked(null)) expect(starts).toContain(at);
    expect(reached.size).toBeGreaterThanOrEqual(2);
  });
});
