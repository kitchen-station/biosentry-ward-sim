import { describe, expect, it } from "vitest";
import { parseRule, rescore, w4Arm } from "../compare";
import typical from "../../scenarios/hospital/typical.json?raw";
import { createHospitalSim } from "./hospital/attach";
import { parseScenario } from "./hospital/scenario";
import { BEDS } from "./map";
import { createSim, minuteOf, setSpeed, step, type Sim } from "./sim";
import { createSyntheticSource, FIXTURE_SEED } from "./source";
import { runTrial, SCENARIO_V1 } from "./trial";
import { ALERT_AT, CAPS, createWardStats, feed, REARM_BINS, SHIFT_MIN, summary } from "./ward-stats";

const DAY = 1440 * 60; // steps in a day at 60x: one tick is one sim second

function run(seed: number, days: number, fed: boolean) {
  const src = createSyntheticSource(seed, true);
  const s = createSim(src);
  setSpeed(s, 60);
  const stats = createWardStats();
  for (let i = 0; i < days * DAY; i += 1) {
    step(s, src);
    if (fed) feed(stats, s, src);
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
    expect(sm.episodes).toBeNull();
    expect(sm.staff).toBeNull();
    expect(sm.hospital).toBeNull();
    expect(sm.levels.every((r) => r.low + r.low_medium + r.medium + r.high + r.not_ranked === r.beds)).toBe(true);
    expect(sm.shifts.length).toBe(5); // 15:00 start: a part shift, then 19:00, 07:00, 19:00, 07:00
    expect(sm.shifts.map((x) => x.partial)).toEqual([true, false, false, false, true]); // the 07:00 shift began before minute 0; the last has not ended
  });

  it("changes nothing in the run: a fed run ends in the same state as one never fed", () => {
    expect(state(a.s)).toBe(state(plain.s));
    expect(a.s.flow).toEqual(plain.s.flow);
    expect(a.s.counts).toEqual(plain.s.counts);
  }, 120_000);

  it("closes a bin after the last offset in the ward", () => {
    expect(BEDS.length * 5 - 5).toBe(95); // the last offset in the ward, as LAST_OFFSET_S assumes
  });

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

describe("alerts", () => {
  it("equal the compare runner's count for news2_total_ge_5 on the same seeded run", () => {
    const days = 3;
    const trial = runTrial({ scenario: { ...SCENARIO_V1, format_version: 1, name: "default" }, seed: 4, days, scenarioSha256: "0".repeat(64), simCommit: "unknown", nodeMajor: 0 });
    const byPatient = new Map<string, ReturnType<typeof rescore>>();
    for (const r of rescore(trial["cohort.csv"])) byPatient.set(r.id, [...(byPatient.get(r.id) ?? []), r]);
    const episodes = trial["episodes.csv"].trimEnd().split("\n").slice(1).map((l) => l.split(","));
    const patientDays = (JSON.parse(trial["summary.json"]) as { patient_days: number }).patient_days;
    const expected = w4Arm(byPatient, parseRule("news2_total_ge_5"), episodes, patientDays, days);

    const { stats } = run(4, days, true);
    const fed = summary(stats).shifts.reduce((n, x) => n + x.alerts, 0);
    expect(expected.alerts).toBeGreaterThan(0);
    expect(fed).toBe(expected.alerts);
  }, 240_000);

  it("fires once, waits for 16 quiet bins, and counts a missing bin as quiet", () => {
    const st = createWardStats();
    const at = (bin: number, total: number | null) => {
      for (const c of [59, 95]) {
        const s = { clockS: bin * 900 + c, patients: [{ id: "p", offsetS: 0, stay: { inMin: 0 }, totals: [total], decision: { kind: "not_ranked" } }], stays: [] } as unknown as Sim;
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
