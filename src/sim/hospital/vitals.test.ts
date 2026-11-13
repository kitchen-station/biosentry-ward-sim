import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { rankWard } from "../arbiter";
import { BEDS } from "../map";
import { roundHalfUp } from "../news2";
import { decide, gate, seat, setSpeed, step, type Sim } from "../sim";
import { createSyntheticSource, FIXTURE_SEED } from "../source";
import { createHospitalSim } from "./attach";
import { drawPerson } from "./people";
import { streamSeed } from "./rng";
import { parseScenario } from "./scenario";
import { runHospitalTrial } from "./trial";
import type { Hospital, Person, UnitId } from "./types";
import {
  CAPS, CLEAR_EPISODE_AT_ICU_STEP_DOWN, createVitals, feedVitals, RANKED_UNITS, riskBySel, summary, unitRank, vitalsOf,
  type HospitalVitals,
} from "./vitals";

// The trial runner calls step() from ../sim. This wrapper feeds the engine after each step when `feeder.on`, so the trial's own
// code and its own output files can be compared with and without the engine, with no edit to trial.ts.
const feeder = vi.hoisted(() => ({ on: false, v: null as unknown, feed: null as unknown }));
vi.mock("../sim", async (orig) => {
  const m = await orig<typeof import("../sim")>();
  return {
    ...m,
    step: (s: Sim, src: Parameters<typeof m.step>[1]) => {
      m.step(s, src);
      if (feeder.on && s.hospital) (feeder.feed as typeof feedVitals)(feeder.v as HospitalVitals, s.hospital, s.clockS);
    },
  };
});

vi.setConfig({ testTimeout: 120_000 });

const typical = parseScenario(readFileSync("scenarios/hospital/typical.json", "utf8"));
const sha = (x: string) => createHash("sha256").update(x).digest("hex");
const expand = (_k: string, x: unknown) => (x instanceof Map ? { map: [...x] } : x instanceof Set ? { set: [...x] } : x);

/** One seeded hospital run: W4's source and the Sim, `ticks` steps at `speed`, with `after` called after each step. */
function run(seed: number, speed: 1 | 10 | 60, ticks: number, after?: (s: Sim) => void) {
  const src = createSyntheticSource(FIXTURE_SEED, true);
  const s = createHospitalSim(src, typical, seed);
  setSpeed(s, speed);
  const t0 = performance.now();
  for (let i = 0; i < ticks; i += 1) {
    step(s, src);
    after?.(s);
  }
  const ms = performance.now() - t0;
  return { s, ms, simSha: sha(JSON.stringify(s, expand)), w4Sha: sha(JSON.stringify(src.save!(s.patients.map((p) => p.id)))) };
}

const DAY = 1440 * 60; // steps in a day at 60x

// ---- a small hand-made hospital, for the tests that need an exact move or onset ----
const SEED = 101;
const world = (): Hospital => ({ seed: SEED, lastMinute: -1, people: [] as Person[] }) as unknown as Hospital;
function person(n: number, unit: UnitId, over: Partial<Person> = {}): Person {
  return {
    ...drawPerson(SEED, n), arrivedMin: 0, unit, where: "bed", sinceMin: 0, slot: 0, wants: null, seenMin: null, decideMin: null, dueMin: null,
    dieMin: null, boardedMin: 0, w4Id: null, fromW4: false, obsDueMin: null, obsLastMin: null, course: null, visit: 1, history: [], ...over,
  };
}
const course = (onsetMin: number | null) => ({ atMin: onsetMin, excessU: 1, onsetMin, noticedMin: null, unnoticedMin: null, escalated: false, excess: false });
/** Feeds minute by minute up to `to`, at the end of each minute (every person's second has passed). `each` may move people. */
function advance(v: HospitalVitals, h: Hospital, to: number, each?: (minute: number) => void) {
  for (let m = h.lastMinute + 1; m <= to; m += 1) {
    h.lastMinute = m;
    each?.(m);
    feedVitals(v, h, m * 60 + 59);
  }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

describe("read-only", () => {
  let unfed: ReturnType<typeof run>, fed: ReturnType<typeof run>, v: HospitalVitals;
  beforeAll(() => {
    unfed = run(101, 60, DAY);
    v = createVitals();
    fed = run(101, 60, DAY, (s) => feedVitals(v, s.hospital!, s.clockS));
  });

  it("leaves the whole Sim, and ward W4's source state, byte-identical over a day", () => {
    expect(fed.simSha).toBe(unfed.simSha);
    expect(fed.w4Sha).toBe(unfed.w4Sha);
    expect(v.live.size).toBeGreaterThan(50);
  });

  it("leaves the hospital trial's output files byte-identical", () => {
    const files = (r: ReturnType<typeof runHospitalTrial>) => [r.hourlyCsv, r.eventsCsv, r.summaryJson].map(sha);
    feeder.on = false;
    const plain = files(runHospitalTrial(101, typical, 1));
    feeder.on = true;
    feeder.v = createVitals();
    feeder.feed = feedVitals;
    try {
      const withEngine = files(runHospitalTrial(101, typical, 1));
      expect((feeder.v as HospitalVitals).reads).toBeGreaterThan(10_000); // the engine did run inside the trial
      expect(withEngine).toEqual(plain);
    } finally {
      feeder.on = false;
    }
  });

  it("gives the same summary for the same seed, and a different one for another seed", () => {
    const again = createVitals();
    run(101, 60, DAY, (s) => feedVitals(again, s.hospital!, s.clockS));
    expect(summary(again)).toEqual(summary(v));
    const other = createVitals();
    run(102, 60, DAY, (s) => feedVitals(other, s.hospital!, s.clockS));
    expect(summary(other)).not.toEqual(summary(v));
  });

  it("opens people outside W4 only, and gives every unit with people some vitals", () => {
    const sum = summary(v);
    expect([...v.live.values(), ...v.finished].some((pv) => pv.bins.some((b) => b.unit === "W4"))).toBe(false);
    expect(Object.keys(sum.byUnit).length).toBeGreaterThanOrEqual(3);
    expect(sum.byUnit.ICU.people).toBeGreaterThan(0);
    expect(sum.byUnit.ICU.ranked).toBe(0); // NEWS2 is a ward score
    expect(sum.episodes).toBe([...v.live.values(), ...v.finished].filter((pv) => pv.episode).length);
    for (const pv of v.live.values()) {
      const q = fed.s.hospital!.people.find((x) => x.id === pv.id)!;
      expect(pv.episode?.startMin ?? null).toBe(q.course?.onsetMin ?? null); // no course, no episode
    }
  });

  it("logs the two timings: one simulated day with and without the engine (not asserted)", () => {
    console.log(`TIMING one simulated day, seed 101: without engine ${Math.round(unfed.ms)} ms, with engine ${Math.round(fed.ms)} ms`);
    console.log(`SUMMARY ${JSON.stringify(summary(v))}`);
    expect(fed.ms).toBeGreaterThan(0);
  });
});

describe("one read per person per simulated minute", () => {
  // At speed 1 and 10 a step is a fraction of a second, so these runs are shorter than a day: a day at speed 1 is 5 million steps.
  for (const [speed, ticks] of [[60, DAY], [10, 6 * 3600 * 6], [1, 90 * 60 * 60]] as const) {
    it(`reads each person once a minute on their own second, never twice, never skipped (speed ${speed}, ${ticks} steps)`, () => {
      const v = createVitals();
      const last = new Map<string, { next: number; reads: number }>();
      let bad = 0, checked = 0;
      run(101, speed, ticks, (s) => {
        feedVitals(v, s.hospital!, s.clockS);
        for (const pv of v.live.values()) {
          const prev = last.get(pv.id);
          if (pv.unit !== "W4" && prev) {
            const dn = pv.next - prev.next, dr = pv.reads - prev.reads;
            if (dr !== dn) bad += 1; // one read for each minute moved on: none twice, none skipped
            if (pv.next * 60 + pv.offsetS <= s.clockS) bad += 1; // nothing that is due is left unread
            if (dn > 0 && (pv.next - 1) * 60 + pv.offsetS > s.clockS) bad += 1; // never before the person's own second
            checked += 1;
          }
          if (prev) { prev.next = pv.next; prev.reads = pv.reads; } else last.set(pv.id, { next: pv.next, reads: pv.reads });
        }
      });
      expect(checked).toBeGreaterThan(ticks);
      expect(bad).toBe(0);
      expect(v.gaps).toBe(0); // stepping one tick at a time never jumps
      expect(v.reads).toBeGreaterThan(1000);
    });
  }

  it("spreads reads over the minute: people have different seconds", () => {
    const v = createVitals();
    run(101, 60, 60 * 90, (s) => feedVitals(v, s.hospital!, s.clockS));
    expect(new Set([...v.live.values()].map((pv) => pv.offsetS)).size).toBeGreaterThan(20);
  });

  it("does not catch up over a jump: it keeps a not_read gap instead, and reads once", () => {
    const h = world();
    const v = createVitals();
    h.people.push(person(5, "MED3A"));
    advance(v, h, 30);
    const pv = v.live.get(h.people[0].id)!;
    const before = pv.reads;
    h.lastMinute = 30 + 300;
    feedVitals(v, h, (30 + 300) * 60 + 59);
    expect(pv.reads - before).toBe(1);
    expect(pv.next).toBe(331);
    expect(pv.spans.map((s) => s.gap ?? null)).toEqual([null, "not_read", null]);
    expect(pv.spans[1].fromMin).toBe(31);
    expect(v.gaps).toBe(1);
    // A jump of exactly the cap is still caught up.
    const w = world(), u = createVitals();
    w.people.push(person(6, "MED3A"));
    advance(u, w, 10);
    w.lastMinute = 10 + CAPS.catchUpMin;
    feedVitals(u, w, (10 + CAPS.catchUpMin) * 60 + 59);
    expect(u.gaps).toBe(0);
    expect(u.live.get(w.people[0].id)!.reads).toBe(10 + CAPS.catchUpMin);
  });
});

describe("episodes", () => {
  /** Two engines on the same person: B never gets an onset, A gets one at `onset`. Both have a round each hour. */
  function pair(onset: number, until: number, unitAt: (m: number) => UnitId = () => "MED3A") {
    const out: { v: HospitalVitals; h: Hospital }[] = [];
    for (const withOnset of [true, false]) {
      const h = world(), v = createVitals();
      const q = person(5, unitAt(0));
      h.people.push(q);
      advance(v, h, until, (m) => {
        q.unit = unitAt(m);
        if (m % 60 === 0) q.obsLastMin = m;
        if (withOnset && m === onset) q.course = course(onset);
      });
      out.push({ v, h });
    }
    return out;
  }

  it("starts an episode at the recorded onset through the generator's inject, and not before", () => {
    const [a, b] = pair(400, 2400);
    const pa = a.v.live.values().next().value!, pb = b.v.live.values().next().value!;
    expect(pa.episode).toEqual({ startMin: 400 });
    expect(pb.episode).toBeNull();
    expect((pa.src!.save!([pa.id]).streams[pa.id] as { injectAt: number }).injectAt).toBe(400);
    expect(same(pa.bins.filter((x) => x.m <= 400), pb.bins.filter((x) => x.m <= 400))).toBe(true);
    expect(same(pa.bins.filter((x) => x.m > 400), pb.bins.filter((x) => x.m > 400))).toBe(false);
  });

  it("clears an episode the generator drew at admission, and readings before its time are unchanged by the rebuild", () => {
    // Find a person whose own source drew an episode at admission (about 6 in 100), with a short ramp so the effect is plain.
    let n = 0, at = 0;
    for (let k = 1; k < 3000 && !n; k += 1) {
      const probe = createSyntheticSource(streamSeed(SEED, `vitals:${drawPerson(SEED, k).id}:v1`), true);
      probe.admit!(0, [], { id: "x", bed: BEDS[0].label }, { name: "X", age: 50, sex: "F" });
      const st = probe.save!(["x"]).streams.x as { injectAt: number | null; rampMin: number };
      if (st.injectAt !== null && st.injectAt > 300 && st.injectAt < 4000 && st.rampMin <= 120) { n = k; at = st.injectAt; }
    }
    expect(n).toBeGreaterThan(0);
    const h = world(), v = createVitals();
    const q = person(n, "MED3A");
    h.people.push(q);
    advance(v, h, 100);
    const pv = v.live.get(q.id)!;
    expect(v.generatorEpisodesCleared).toBe(1);
    expect(pv.episode).toBeNull();
    expect((pv.src!.save!([q.id]).streams[q.id] as { injectAt: number | null }).injectAt).toBeNull();
    const end = Math.ceil(at) + 600;
    advance(v, h, end);

    // The reference is the same stream with the episode left in, run through the same steps.
    const ref = createSyntheticSource(streamSeed(SEED, `vitals:${q.id}:v1`), true);
    const seed = ref.admit!(0, [], { id: q.id, bed: BEDS[0].label }, { name: q.name, age: q.age, sex: q.sex })!;
    const p = seat(ref, seed, 0, 0);
    const refBins: Record<number, (number | null)[]> = {};
    for (let m = 1; m <= end; m += 1) {
      const r = ref.read(q.id, m);
      if (p.oxygenUntilMin !== null && m >= p.oxygenUntilMin) { p.onOxygen = false; p.oxygenUntilMin = null; }
      gate(p, r, m);
      decide(p, m);
      if (m % 15 === 0) refBins[m] = [p.held.heart_rate, p.held.respiratory_rate, p.held.spo2, p.decision.kind === "ranked" ? p.decision.news2.total : null];
    }
    const differs = (x: (typeof pv.bins)[number]) => {
      const r = refBins[x.m];
      return roundHalfUp(r[0]!, 0) !== x.hr || roundHalfUp(r[1]!, 0) !== x.rr || roundHalfUp(r[2]!, 0) !== x.spo2 || r[3] !== x.news2;
    };
    const before = pv.bins.filter((x) => x.m < at && x.hr !== null && x.rr !== null && x.spo2 !== null);
    expect(before.length).toBeGreaterThan(10);
    expect(before.filter(differs)).toEqual([]); // every bin before the old time is the same
    expect(pv.bins.filter((x) => x.m > at + 200 && x.hr !== null).some(differs)).toBe(true); // after it the reference moves away
  });

  it("clears the episode at an ICU to ward step-down and marks the span, when the switch is on", () => {
    expect(CLEAR_EPISODE_AT_ICU_STEP_DOWN).toBe(true);
    const unitAt = (m: number): UnitId => (m <= 600 ? "ICU" : "MED3A");
    const [on] = pair(300, 2400, unitAt);
    const pv = on.v.live.values().next().value!;
    expect(createVitals().clearAtStepDown).toBe(CLEAR_EPISODE_AT_ICU_STEP_DOWN);
    // `pair` uses the default switch: the span is marked and the stream has no schedule.
    expect(pv.spans.map((s) => [s.unit, s.recovery ?? null])).toEqual([["ICU", null], ["MED3A", "not_modelled"]]);
    expect(pv.cleared).toBe(true);
    expect((pv.src!.save!([pv.id]).streams[pv.id] as { injectAt: number | null }).injectAt).toBeNull();
    expect(pv.episode).toEqual({ startMin: 300 }); // the record of what happened stays
    expect(on.v.stepDownsCleared).toBe(1);
  });

  it("keeps the episode running at step-down, with no marker, when the switch is off; the readings agree until the step-down", () => {
    const unitAt = (m: number): UnitId => (m <= 600 ? "ICU" : "MED3A");
    const mk = (flag: boolean) => {
      const h = world(), v = createVitals({ clearEpisodeAtIcuStepDown: flag }), q = person(5, "ICU");
      h.people.push(q);
      advance(v, h, 2400, (m) => { q.unit = unitAt(m); if (m % 60 === 0) q.obsLastMin = m; if (m === 300) q.course = course(300); });
      return v.live.values().next().value!;
    };
    const off = mk(false), on = mk(true);
    expect(off.spans.map((s) => s.recovery ?? null)).toEqual([null, null]);
    expect(off.cleared).toBe(false);
    expect((off.src!.save!([off.id]).streams[off.id] as { injectAt: number | null }).injectAt).toBe(300);
    expect(same(off.bins.filter((x) => x.m <= 600), on.bins.filter((x) => x.m <= 600))).toBe(true);
    expect(same(off.bins.filter((x) => x.m > 1500), on.bins.filter((x) => x.m > 1500))).toBe(false);
  });
});

describe("no clear on other moves, no shift by unit", () => {
  it("does not clear an episode on a move into the ICU: only a move out of it", () => {
    const h = world(), v = createVitals(), q = person(5, "MED3A");
    h.people.push(q);
    advance(v, h, 900, (m) => { if (m === 300) q.course = course(300); if (m >= 601) q.unit = "ICU"; });
    const pv = v.live.get(q.id)!;
    expect(pv.cleared).toBe(false);
    expect(v.stepDownsCleared).toBe(0);
    expect(pv.spans.map((s) => [s.unit, s.recovery ?? null])).toEqual([["MED3A", null], ["ICU", null]]);
    expect((pv.src!.save!([pv.id]).streams[pv.id] as { injectAt: number | null }).injectAt).toBe(300);
  });

  it("gives the same person the same readings in every unit: no baseline shift", () => {
    const binsIn = (unit: UnitId) => {
      const h = world(), v = createVitals(), q = person(5, unit);
      h.people.push(q);
      advance(v, h, 240);
      return v.live.get(q.id)!.bins.map(({ unit: _u, ...rest }) => rest);
    };
    const base = binsIn("MED3A");
    expect(base.length).toBeGreaterThan(10);
    for (const u of ["ER", "ICU", "SURG5A", "MED3B"] as UnitId[]) expect(binsIn(u)).toEqual(base);
  });
});

describe("ward W4 and moves", () => {
  it("reads nothing while a person is on W4, keeps a span with their W4 id, and restarts at the current minute", () => {
    const h = world(), v = createVitals();
    const q = person(5, "ER");
    h.people.push(q);
    advance(v, h, 100);
    const pv = v.live.get(q.id)!;
    advance(v, h, 200, (m) => { if (m === 101) { q.unit = "W4"; q.w4Id = "n-0007"; } });
    const reads = pv.reads;
    advance(v, h, 300);
    expect(pv.reads).toBe(reads);
    expect(pv.bins.some((b) => b.unit === "W4")).toBe(false);
    advance(v, h, 400, (m) => { if (m === 301) { q.unit = "ICU"; q.w4Id = null; q.fromW4 = true; } });
    expect(pv.spans.map((s) => [s.unit, s.w4Id])).toEqual([["ER", null], ["W4", "n-0007"], ["ICU", null]]);
    expect(pv.spans[2].fromMin).toBe(301);
    expect(pv.reads).toBe(reads + 99); // minutes 302 to 400
    expect(v.gaps).toBe(0);
    expect(riskBySel(v)[`h:${q.n}`]).toBeUndefined(); // ICU has no key
  });

  it("gives a W4 resident no stream until they leave W4", () => {
    const h = world(), v = createVitals();
    const q = person(9, "W4", { w4Id: "p-001" });
    h.people.push(q);
    advance(v, h, 60);
    expect(v.live.size).toBe(0);
    expect(vitalsOf(v, q.id)).toBeNull();
    advance(v, h, 120, (m) => { if (m === 61) { q.unit = "ICU"; q.w4Id = null; q.fromW4 = true; } });
    expect(vitalsOf(v, q.id)!.spans.map((s) => [s.unit, s.w4Id])).toEqual([["ICU", null]]);
  });

  it("takes a new cuff at each observation round and keeps the arrival cuff otherwise", () => {
    const h = world(), v = createVitals();
    const q = person(5, "MED3A");
    h.people.push(q);
    advance(v, h, 10);
    const pv = v.live.get(q.id)!;
    const arrival = pv.p.bp;
    advance(v, h, 50);
    expect(pv.p.bp).toBe(arrival);
    advance(v, h, 60, (m) => { if (m === 60) q.obsLastMin = 60; });
    expect(pv.p.bp).not.toBe(arrival);
    expect(pv.p.bpAt).toBe(60);
  });

  it("drops a stream at death or when the person leaves, and keeps the finished ones within the cap; a return is a new visit", () => {
    const h = world(), v = createVitals();
    const people = Array.from({ length: CAPS.finished + 30 }, (_, i) => person(100 + i, "MED3A"));
    h.people.push(...people);
    advance(v, h, 5);
    expect(v.live.size).toBe(people.length);
    h.people.length = 0;
    advance(v, h, 6);
    expect(v.live.size).toBe(0);
    expect(v.finished).toHaveLength(CAPS.finished);
    expect(v.finished[0].src).toBeNull();
    const last = people.at(-1)!;
    expect(vitalsOf(v, last.id)!.id).toBe(last.id);
    expect(vitalsOf(v, people[0].id)).toBeNull(); // the oldest was pushed out
    // a body is dropped, a return is a new stream
    const w = createVitals(), g = world();
    const q = person(7, "MED3A");
    g.people.push(q);
    advance(w, g, 5);
    q.where = "awaiting_morgue";
    advance(w, g, 6);
    expect(w.live.size).toBe(0);
    q.where = "bed"; q.visit = 2;
    advance(w, g, 7);
    expect(vitalsOf(w, q.id, 2)!.visit).toBe(2);
    expect(vitalsOf(w, q.id, 1)!.visit).toBe(1);
    expect(w.created).toBe(2);
  });
});

describe("bounded memory", () => {
  it("holds the caps over 9.5 simulated days for one person", () => {
    const h = world(), v = createVitals();
    h.people.push(person(5, "MED3A"));
    advance(v, h, 9.5 * 1440);
    const pv = v.live.values().next().value!;
    expect(pv.bins).toHaveLength(CAPS.bins);
    expect(pv.scores).toHaveLength(CAPS.scores);
    expect(pv.bins.at(-1)!.m).toBe(Math.floor((9.5 * 1440) / 15) * 15);
    expect(pv.p.history.heart_rate).toHaveLength(12);
    expect(pv.p.totals).toHaveLength(13);
  });
});

describe("ranking and risk keys", () => {
  it("lists a unit in the ward's own order, and returns null for ICU, W4 and the morgue", () => {
    const h = world(), v = createVitals();
    const ward = [10, 11, 12, 13, 14, 15].map((n) => person(n, "MED3A"));
    const icu = person(20, "ICU");
    h.people.push(...ward, icu, person(21, "SURG5A"));
    advance(v, h, 120);
    // make the order non-trivial: one person not ranked, one at a higher score than the others
    const pvs = ward.map((q) => v.live.get(q.id)!);
    const d = pvs[4].p.decision;
    if (d.kind === "ranked") pvs[4].p.decision = { ...d, news2: { ...d.news2, total: 7, risk: "high" } };
    pvs[2].p.decision = { kind: "not_ranked", patientId: pvs[2].id, reason: "r", instruction: "i" };
    const got = unitRank(v, h, "MED3A")!;
    const want = rankWard(pvs.map((pv) => pv.p.decision));
    expect(got.ranked.map((x) => x.id)).toEqual(want.ranked.map((d) => d.patientId));
    expect(got.notRanked.map((x) => x.id)).toEqual([pvs[2].id]);
    expect(got.ranked.length + got.notRanked.length).toBe(ward.length);
    expect(unitRank(v, h, "ICU")).toBeNull();
    expect(unitRank(v, h, "W4")).toBeNull();
    expect(unitRank(v, h, "MORGUE")).toBeNull();
    expect(unitRank(v, h, "SURG5A")!.ranked.length + unitRank(v, h, "SURG5A")!.notRanked.length).toBe(1);
    expect(RANKED_UNITS).toEqual(["ER", "MED3A", "MED3B", "SURG5A"]);
    for (const u of RANKED_UNITS) expect(unitRank(v, h, u)).not.toBeNull();
  });

  it("has a risk key for every live person outside ICU and W4, and none for intensive care", () => {
    const h = world(), v = createVitals();
    const a = person(30, "MED3A"), b = person(31, "ICU"), c = person(32, "ER", { where: "waiting" });
    h.people.push(a, b, c);
    advance(v, h, 90);
    const risk = riskBySel(v);
    expect(Object.keys(risk).sort()).toEqual([`h:${a.n}`, `h:${c.n}`].sort());
    expect(Object.keys(risk).some((k) => k === `h:${b.n}`)).toBe(false);
    for (const r of Object.values(risk)) expect([null, "low", "low_medium", "medium", "high"]).toContain(r);
    expect(vitalsOf(v, b.id)!.p.decision.kind).toBeDefined(); // ICU still has vitals
  });
});

describe("scans", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
  const all = files("src");

  const imports = (f: string) => /from\s+["'][^"']*\bvitals["']/.test(readFileSync(f, "utf8"));
  it("is imported by no file under src other than tests in this slice (the page wiring is next)", () => {
    const importers = all.filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith("hospital/vitals.ts") && imports(f));
    expect(importers).toEqual([]);
    for (const named of ["src/headless.ts", "src/trial.ts", "src/hospital-trial.ts", "src/compare.ts", "src/lab-worker.ts", "src/sim/trial.ts", "src/sim/hospital/trial.ts"]) {
      expect(all).toContain(named);
      expect(imports(named)).toBe(false);
    }
  });

  it("imports only the pure pieces: no module that writes a Sim, and only a few names from sim.ts", () => {
    const text = readFileSync("src/sim/hospital/vitals.ts", "utf8");
    const specs = [...text.matchAll(/^import[^;]*from "([^"]+)";/gm)].map((m) => m[1]).sort();
    expect(specs).toEqual(["../arbiter", "../map", "../news2", "../sim", "../source", "./params", "./rng", "./types"]);
    const fromSim = /import \{([^}]*)\} from "\.\.\/sim"/.exec(text)![1].split(",").map((x) => x.trim().replace(/^type /, "")).sort();
    expect(fromSim).toEqual(["Patient", "decide", "gate", "seat", "vitalQuality"]);
    expect(text).not.toMatch(/\bh\.[\w.]+\s*(=|\+=|-=)[^=]/); // no write through `h`
    expect(text).not.toMatch(/Math\.random|stream\("/);
  });
});
