import { describe, expect, it } from "vitest";
import { parseRule, rescore, w4Arm } from "../compare";
import typical from "../../scenarios/hospital/typical.json?raw";
import { createHospitalSim } from "./hospital/attach";
import { parseScenario } from "./hospital/scenario";
import { scoreNews2 } from "./news2";
import { createSim, minuteOf, setSpeed, step, type Sim } from "./sim";
import { createSyntheticSource, FIXTURE_SEED, type VitalsSource } from "./source";
import { runTrial, SCENARIO_V1 } from "./trial";
import { ALERT_AT, CAPS, createWardStats, feed, REARM_BINS, SHIFT_MIN, summary } from "./ward-stats";

const DAY = 1440 * 60; // steps in a day at 60x: one tick is one sim second

function run(seed: number, days: number, fed: boolean) {
  const src = createSyntheticSource(seed, true);
  const s = createSim(src);
  setSpeed(s, 60);
  const stats = createWardStats();
  let seen = 0;
  for (let i = 0; i < days * DAY; i += 1) {
    step(s, src);
    if (fed) {
      feed(stats, s, src);
      // An episode is never recorded before its start has been reached.
      if (stats.ep && stats.ep.length !== seen) {
        for (const e of stats.ep.slice(seen)) expect(e.start).toBeLessThanOrEqual(minuteOf(s));
        seen = stats.ep.length;
      }
    }
  }
  return { s, stats };
}
// Everything the Sim holds, as text (functions in the rules are left out by JSON): a feed that wrote anything would show here.
const state = (s: Sim) => JSON.stringify(s);

describe("ward stats", () => {
  const a = run(FIXTURE_SEED, 2, true);
  const b = run(FIXTURE_SEED, 2, true);
  const plain = run(FIXTURE_SEED, 2, false);

  it("gives the same summary for the same seed and feeds", () => {
    expect(summary(a.stats)).toEqual(summary(b.stats));
    const sm = summary(a.stats);
    expect(sm.levels.length).toBeGreaterThan(150); // 2 days is 192 bins
    expect(sm.fromMin).toBe(0);
    expect(sm.toMin).toBe(minuteOf(a.s));
    expect(sm.episodes).not.toBeNull(); // was pinned to null before the episodes table
    expect(sm.episodes!.length).toBeGreaterThan(0);
    expect(sm.staff).toBeNull();
    expect(sm.hospital).toBeNull();
    expect(sm.levels.every((r) => r.low + r.low_medium + r.medium + r.high + r.not_ranked === r.beds)).toBe(true);
    expect(sm.shifts.map((x) => x.start)).toEqual([-480, 240, 960, 1680, 2400]); // 15:00 start: a part shift, then 19:00, 07:00, 19:00, 07:00
    expect(sm.shifts.map((x) => x.partial)).toEqual([true, false, false, false, true]); // the 07:00 shift began before minute 0; the last has not ended
  });

  it("changes nothing in the run: a fed run ends in the same state as one never fed", () => {
    expect(state(a.s)).toBe(state(plain.s));
    expect(a.s.flow).toEqual(plain.s.flow);
    expect(a.s.counts).toEqual(plain.s.counts);
  }, 120_000);

  it("returns a copy", () => {
    const first = summary(a.stats);
    first.levels.length = 0;
    first.shifts[0].alerts = 999;
    expect(summary(a.stats).levels.length).toBeGreaterThan(0);
    expect(summary(a.stats).shifts[0].alerts).not.toBe(999);
  });

  it("does nothing between bins", () => {
    const st = createWardStats();
    const src = createSyntheticSource(FIXTURE_SEED, true);
    const s = createSim(src);
    setSpeed(s, 60);
    for (let i = 0; i < 20 * 60; i += 1) (step(s, src), feed(st, s, src)); // 20 min: bin 15 closes at 16 min and 35 s
    expect(st.levels).toHaveLength(1);
    const before = JSON.stringify(st);
    feed(st, s, src);
    feed(st, s, src);
    expect(JSON.stringify(st)).toBe(before);
  });

  it("shows a jump as a gap: the bins in it are not made up", () => {
    const src = createSyntheticSource(FIXTURE_SEED, true);
    const s = createSim(src);
    setSpeed(s, 60);
    const st = createWardStats();
    for (let i = 0; i < 40 * 60; i += 1) (step(s, src), feed(st, s, src));
    s.clockS += 3 * 3600; // a jump with no feed
    for (let i = 0; i < 40 * 60; i += 1) (step(s, src), feed(st, s, src));
    const ms = summary(st).levels.map((r) => r.m);
    expect(ms.slice(0, 2)).toEqual([15, 30]);
    expect(Math.max(...ms.slice(1).map((m, i) => m - ms[i]))).toBeGreaterThan(15);
  });

  it("holds its caps after 10 days", () => {
    const { stats, s } = run(FIXTURE_SEED, 10, true);
    const sm = summary(stats);
    expect(minuteOf(s)).toBe(10 * 1440);
    expect(sm.levels).toHaveLength(CAPS.levels);
    expect(sm.shifts.length).toBeLessThanOrEqual(CAPS.shifts);
    expect(sm.stays.length).toBeLessThanOrEqual(CAPS.stays);
    expect(sm.episodes!.length).toBeLessThanOrEqual(CAPS.episodes);
    expect(sm.levels[0].m).toBeGreaterThan(0);
    expect(Object.keys(stats.alert).length).toBeLessThanOrEqual(12);
  }, 240_000);
});

describe("hospital world", () => {
  it("keeps the units and their hourly counts, at most 7 days of them", () => {
    const src = createSyntheticSource(101, true);
    const s = createHospitalSim(src, parseScenario(typical), 101);
    setSpeed(s, 60);
    const st = createWardStats();
    for (let i = 0; i < 2 * DAY; i += 1) (step(s, src), feed(st, s, src));
    const h = summary(st).hospital!;
    expect(h.units).toHaveLength(7);
    expect(h.hours.length).toBeGreaterThan(30 * 7);
    expect(h.hours.length).toBeLessThanOrEqual(CAPS.hoursPerUnit * 7);
    expect(Object.keys(h.hours[0]).sort()).toEqual(["admitted_in", "arrivals", "census", "discharged", "hour", "transferred_in", "transferred_out", "unit"]);
  }, 120_000);
});

describe("episodes", () => {
  // Seeds 6 and 7 have 3 and 2 episodes in 7 days; most seeds have none in 3 days.
  for (const seed of [6, 7]) {
    it(`equals the truth runTrial writes and compare's first new alerts, seed ${seed}, 7 days`, () => {
      const days = 7;
      const trial = runTrial({ scenario: { ...SCENARIO_V1, format_version: 1, name: "default" }, seed, days, scenarioSha256: "0".repeat(64), simCommit: "unknown", nodeMajor: 0 });
      const byPatient = new Map<string, ReturnType<typeof rescore>>();
      for (const r of rescore(trial["cohort.csv"])) byPatient.set(r.id, [...(byPatient.get(r.id) ?? []), r]);
      const episodes = trial["episodes.csv"].trimEnd().split("\n").slice(1).map((l) => l.split(","));
      const patientDays = (JSON.parse(trial["summary.json"]) as { patient_days: number }).patient_days;
      const { stats } = run(seed, days, true);
      const sm = summary(stats);
      // Compare evaluates a stay that began after minute 0 with an episode that starts inside it and before the run's end.
      // The page records those whose start a closed bin has reached; a start after the last closed bin is not yet known.
      const lastBin = sm.levels.at(-1)!.m;
      const evaluated = episodes.filter((e) => Number(e[1]) > 0 && e[5] !== "" && Number(e[5]) >= Number(e[1]) && (e[2] === "" || Number(e[5]) < Number(e[2])) && Number(e[5]) < days * 1440);
      const reached = evaluated.filter((e) => Number(e[5]) <= lastBin);
      const first = new Map<string, number>();
      const arm = w4Arm(byPatient, parseRule("news2_total_ge_5"), episodes, patientDays, days, first);
      expect(evaluated.length).toBe(arm.episodes_evaluated);
      expect(reached.length).toBeGreaterThan(0);
      const rec = stats.ep!;
      expect(rec.map((e) => e.id).sort()).toEqual(reached.map((e) => e[0]).sort());
      for (const e of reached) {
        const m = rec.find((x) => x.id === e[0])!;
        expect([m.start, m.rampMin, m.kind]).toEqual([Number(e[5]), Number(e[6]), e[4]]);
        expect(m.alertMin).toBe(first.get(e[0]) ?? null);
      }
      // compare exposes each first new alert minute (firstOut), so the match is per episode, and by count:
      expect(rec.filter((x) => x.alertMin !== null).length).toBe(reached.filter((e) => first.has(e[0])).length);
      expect(sm.episodes!.every((x) => x.minutesBetween === null || x.minutesBetween === Math.round(x.alertMin! - x.start))).toBe(true);
    }, 300_000);
  }
});

describe("alerts", () => {
  // One recount per seed from the trial runner's own cohort rows, scored again with scoreNews2, set against the page's stats.
  const shiftOf = (m: number) => m - ((900 + m - 420) % 720); // 15:00 start, shifts at 07:00 and 19:00 (written out: not taken from ward-stats)
  for (const [seed, days] of [[7, 3], [23, 5], [11, 3]] as const) {
    it(`matches an independent recount of the trial's cohort rows, seed ${seed}, ${days} days`, () => {
      const trial = runTrial({ scenario: { ...SCENARIO_V1, format_version: 1, name: "default" }, seed, days, scenarioSha256: "0".repeat(64), simCommit: "unknown", nodeMajor: 0 });
      const csv = trial["cohort.csv"].trimEnd().split("\n").slice(1).map((l) => l.split(","));
      const n = (v: string) => (v === "" ? null : Number(v));
      const bins = new Map<number, Record<string, number>>();
      const patientMin = new Map<number, number>();
      for (const c of csv) {
        const r = scoreNews2({ respiratory_rate: n(c[3]), spo2: n(c[4]), spo2_scale: Number(c[11]) as 1 | 2, supplemental_o2: c[10] === "1", systolic_bp: n(c[6]), heart_rate: n(c[2]), consciousness: c[9] as "A", temperature: n(c[5]) });
        const level = r.kind === "score" && c[13] === "1" ? r.risk : "not_ranked";
        const m = Number(c[1]);
        const row = bins.get(m) ?? { low: 0, low_medium: 0, medium: 0, high: 0, not_ranked: 0, beds: 0 };
        row[level] += 1;
        row.beds += 1;
        bins.set(m, row);
        patientMin.set(shiftOf(m), (patientMin.get(shiftOf(m)) ?? 0) + 15);
      }
      const { stats } = run(seed, days, true);
      const sm = summary(stats);
      const mine = new Map(sm.levels.map(({ m, ...r }) => [m, r]));
      expect(mine.size).toBe(bins.size);
      expect([...mine].filter(([m, r]) => JSON.stringify(Object.entries(r).sort()) !== JSON.stringify(Object.entries(bins.get(m) ?? {}).sort())).map(([m]) => m)).toEqual([]);
      expect(Object.fromEntries(sm.shifts.map((x) => [x.start, x.patientMin]))).toEqual(Object.fromEntries(patientMin));
      // The alerts, as the compare runner counts them for news2_total_ge_5.
      const byPatient = new Map<string, ReturnType<typeof rescore>>();
      for (const r of rescore(trial["cohort.csv"])) byPatient.set(r.id, [...(byPatient.get(r.id) ?? []), r]);
      const episodes = trial["episodes.csv"].trimEnd().split("\n").slice(1).map((l) => l.split(","));
      const patientDays = (JSON.parse(trial["summary.json"]) as { patient_days: number }).patient_days;
      const expected = w4Arm(byPatient, parseRule("news2_total_ge_5"), episodes, patientDays, days).alerts;
      expect(expected).toBeGreaterThan(0);
      expect(sm.shifts.reduce((k, x) => k + x.alerts, 0)).toBe(expected);
    }, 300_000);
  }

  it("keeps at most 200 episodes, oldest dropped; no source keeps episodes null", () => {
    const patients = Array.from({ length: 250 }, (_, i) => ({ id: `p${i}`, nextMinute: 61, rules: { sampleEveryMin: 1 }, decision: { kind: "not_ranked" }, stay: { inMin: 1 } }));
    const streams = Object.fromEntries(patients.map((p, i) => [p.id, { episode: { kind: "k" }, injectAt: 1 + (i % 60), rampMin: 10 }]));
    const src = { save: () => ({ streams }) } as unknown as VitalsSource;
    const st = createWardStats();
    const bare = createWardStats();
    for (const c of [3600, 3600 + 200]) {
      const s = { clockS: c, patients, stays: [] } as unknown as Sim;
      feed(st, s, src);
      feed(bare, s);
    }
    expect(CAPS.episodes).toBe(200);
    // all 250 starts are reached by bin 60: the 50 oldest recorded are dropped
    expect(summary(st).episodes).toHaveLength(200);
    expect(st.ep!.map((e) => e.id)).toEqual(patients.slice(50).map((p) => p.id));
    expect(summary(bare).episodes).toBeNull();
  });

  it("keeps at most 168 hours per unit and 200 finished stays", () => {
    const units = ["ER", "ICU", "MED3A", "MED3B", "W4", "SURG5A", "MORGUE"].map((id, i) => ({ id, name: id, floor: i, beds: 4 }));
    const hourly = Array.from({ length: 200 }, (_, hour) => units.map((u) => ({ hour, unit: u.id, census: 1, arrivals: 0, admitted_in: 0, discharged: 0, transferred_in: 0, transferred_out: 0 }))).flat();
    const stays = Array.from({ length: 300 }, (_, i) => ({ inMin: 1 + i, outMin: 10 + (i % 50), outcome: "discharged" }));
    const st = createWardStats();
    for (const c of [3600, 3600 + 200]) feed(st, { clockS: c, patients: [], stays, hospital: { units, hourly } } as unknown as Sim); // bin 60 opens, then closes after its window
    const sm = summary(st);
    expect(sm.levels).toHaveLength(1);
    expect(sm.hospital!.hours).toHaveLength(168 * 7);
    expect(sm.stays).toHaveLength(200);
  });

  it("fires once, waits for 16 quiet bins, and counts a missing bin as quiet", () => {
    const st = createWardStats();
    const at = (bin: number, total: number | null) => {
      for (const c of [0, 200]) {
        const decision = total === null ? { kind: "not_ranked" } : { kind: "ranked", news2: { total, risk: "low" } };
        const s = { clockS: bin * 900 + c, patients: [{ id: "p", nextMinute: bin * 15 + 1, rules: { sampleEveryMin: 1 }, decision }], stays: [] } as unknown as Sim;
        feed(st, s);
      }
    };
    expect(ALERT_AT).toBe(5);
    expect(REARM_BINS).toBe(16);
    at(1, 5); // alert
    at(2, 7); // still on: no new one
    for (let b = 3; b < 3 + 15; b += 1) at(b, 0); // 15 quiet bins
    at(18, 5); // 15 quiet bins after the last alerting bin: still not armed
    expect(st.shifts.reduce((n, x) => n + x.alerts, 0)).toBe(1);
    for (let b = 19; b < 19 + 16; b += 1) at(b, 0); // 16 quiet bins
    at(35, 6);
    expect(st.shifts.reduce((n, x) => n + x.alerts, 0)).toBe(2);
    // a gap of 16 missing bins also re-arms
    at(52, 5);
    expect(st.shifts.reduce((n, x) => n + x.alerts, 0)).toBe(3);
    expect(SHIFT_MIN).toBe(720);
  });
});
