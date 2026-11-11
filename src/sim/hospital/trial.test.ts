import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { GIVEN, SURNAMES } from "./names";
import { PARAMS } from "./params";
import { parseScenario } from "./scenario";
import { createHospital } from "./step";
import { stepHospital, takeRows } from "./step";
import type { HourRow, UnitId, W4Port } from "./types";
import { isHigherCare, labelEvents, runHospitalTrial, summarize, WARM_UP_DAYS, type TrialEvent, type TrialResult } from "./trial";

const load = (name: string) => parseScenario(readFileSync(`scenarios/hospital/${name}.json`, "utf8"));
const typical = load("typical");
const sha = (t: TrialResult) => [t.hourlyCsv, t.eventsCsv, t.summaryJson].map((x) => createHash("sha256").update(x).digest("hex"));
const UNITS = 7;
const DAYS = 30;

describe("hospital trial", () => {
  let day: TrialResult, again: TrialResult, long: TrialResult, secs: number;
  beforeAll(() => {
    day = runHospitalTrial(101, typical, 1);
    again = runHospitalTrial(101, typical, 1);
    const t0 = performance.now();
    long = runHospitalTrial(101, typical, DAYS);
    secs = Math.round((performance.now() - t0) / 100) / 10;
  }, 300_000);

  it("gives byte-identical files for the same seed and scenario", () => {
    expect(sha(again)).toEqual(sha(day));
  });

  it("differs for another seed and for another scenario", () => {
    const a = sha(day), b = sha(runHospitalTrial(102, typical, 1)), c = sha(runHospitalTrial(101, load("surge"), 1));
    for (let i = 0; i < 3; i += 1) { expect(b[i]).not.toBe(a[i]); expect(c[i]).not.toBe(a[i]); }
  }, 30_000);

  it("writes one hourly row per unit per hour, columns as designed", () => {
    const rows = long.hourlyCsv.trimEnd().split("\n");
    expect(rows[0]).toBe("hour,unit,census,beds,stretchers_used,occupancy_pct,arrivals,admitted_in,discharged,transferred_in,transferred_out,died,nurses,patients_per_nurse,er_waiting,er_consult,er_workup,er_boarding,er_boarding_hours,er_lwbs,door_to_doctor_median_min,icu_indicated_not_in_icu,morgue");
    expect(rows.length - 1).toBe(UNITS * DAYS * 24);
    expect(long.hourlyRows).toBe(UNITS * DAYS * 24);
    for (const r of rows) expect(r.split(",")).toHaveLength(23);
    const er = rows.filter((r) => r.split(",")[1] === "ER" && r.split(",")[0] !== "hour");
    expect(er.every((r) => r.split(",")[14] !== "")).toBe(true); // ER-only columns filled on the ER
    expect(rows.filter((r) => r.split(",")[1] === "ICU").every((r) => r.split(",")[14] === "")).toBe(true); // blank elsewhere
  });

  it("writes events in minute order, seven fields, news2_independent yes or no, w4_higher_care no", () => {
    const rows = long.eventsCsv.trimEnd().split("\n").slice(1).map((r) => r.split(","));
    expect(rows.length).toBe(long.eventRows);
    let last = 0;
    for (const f of rows) {
      expect(f).toHaveLength(7);
      expect(["yes", "no"]).toContain(f[6]);
      expect(Number(f[0])).toBeGreaterThanOrEqual(last);
      last = Number(f[0]);
      expect(f[1]).toMatch(/^\d+$/);
    }
    const higher = rows.filter((f) => f[4] === "w4_higher_care");
    // seed 101 has none in 30 days (W4 rarely deteriorates in hospital mode), so the mapping is also tested directly below
    expect(higher.every((f) => f[6] === "no")).toBe(true);
    expect(long.eventsCsv).not.toContain("\r");
    // the files cover minutes 0 to days x 1440, exclusive: the last stepped minute has no hourly row, so it has no events either
    expect(last).toBeLessThan(DAYS * 1440);
    for (const seed of [7, 8, 9, 10, 11]) {
      const two = runHospitalTrial(seed, typical, 2).eventsCsv.trimEnd().split("\n").slice(1);
      expect(Math.max(...two.map((r) => Number(r.split(",")[0])))).toBeLessThan(2 * 1440);
    }
  }, 120_000);

  it("labels a W4 move for higher care, and a W4 discharge is also not NEWS2-independent", () => {
    const row = { minute: 1, person: "h-000001", w4_id: "p-001", unit: "ICU" as const, kind: "transfer" as const, news2_independent: false };
    expect(isHigherCare({ ...row, detail: "W4 to ICU" })).toBe(true);
    expect(isHigherCare({ ...row, kind: "board", detail: "W4 higher care, no ICU bed" })).toBe(true);
    expect(isHigherCare({ ...row, detail: "ICU to MED3A" })).toBe(false);
    const w4Discharges = long.eventsCsv.split("\n").filter((l) => l.split(",")[3] === "W4" && l.split(",")[4] === "discharge");
    expect(w4Discharges.every((l) => l.endsWith(",no"))).toBe(true);
  });

  it("holds no name from the names lists in any file", () => {
    const names = [...SURNAMES, ...GIVEN.F, ...GIVEN.M];
    for (const text of [long.hourlyCsv, long.eventsCsv, long.summaryJson]) {
      for (const n of names) expect(new RegExp(`\\b${n}\\b`).test(text), n).toBe(false);
    }
  });

  it("states the limits and the warm-up in the summary", () => {
    const s = JSON.parse(long.summaryJson);
    expect(s.limits).toContain("synthetic, not validated");
    expect(s.synthetic).toBe(true);
    expect(s.seed).toBe(101);
    expect(s.scenario).toEqual(typical);
    expect(s.warm_up_days).toBe(WARM_UP_DAYS);
    expect(Object.keys(s.all_days.per_unit)).toHaveLength(UNITS);
    expect(s.all_days.deaths).toBeGreaterThanOrEqual(s.after_warm_up.deaths);
    expect(s.after_warm_up.er_arrivals).toBeLessThan(s.all_days.er_arrivals);
  });

  it("fails loudly when a row buffer is full at a drain", () => {
    expect(() => runHospitalTrial(101, typical, 1, { events: 5, hourly: PARAMS.bufferCap.hourly.value })).toThrow(/buffer was full/);
    expect(() => runHospitalTrial(101, typical, 1, { events: PARAMS.bufferCap.events.value, hourly: 3 })).toThrow(/buffer was full/);
  });

  it("labels W4 higher-care rows from a W4 double, as news2_independent: no", () => {
    const sc = { ...typical, units: { ...typical.units, ICU: { beds: 1, stretchers: 0, nurses: 3 } } };
    const h = createHospital(82, sc);
    const at: Record<string, number> = {};
    let now = 0, k = 0;
    const port: W4Port = {
      admit(_p, minute) { k += 1; at[`w4-${k}`] = minute; return `w4-${k}`; },
      left(id) { return now - at[id] >= 1440 ? { outcome: "higher_care", minute: now } : null; }, // everyone needs the ICU after a day
    };
    for (; now < 8 * 1440; now += 1) stepHospital(h, port, now);
    const rows = labelEvents(takeRows(h).events);
    const higher = rows.filter((e) => e.kind === "w4_higher_care");
    expect(higher.length).toBeGreaterThan(3);
    expect(higher.every((e) => !e.news2_independent)).toBe(true);
    expect(rows.filter((e) => e.kind !== "w4_higher_care").some((e) => isHigherCare(e as never))).toBe(false);
    expect(() => labelEvents([{ ...higher[0], kind: "transfer", news2_independent: true }])).toThrow(/news2_independent/);
  }, 120_000); // steps a hospital for days: about 1 s alone, far more on a busy machine

  it("finishes a 30-day typical trial", () => {
    console.log(`30-day typical trial: ${secs} s; hourly ${long.hourlyCsv.length} B, events ${long.eventsCsv.length} B, summary ${long.summaryJson.length} B`);
    expect(long.hourlyRows).toBe(UNITS * DAYS * 24);
  });
});

describe("summary figures", () => {
  const ev = (minute: number, person: string, kind: string, detail = "", unit: UnitId = "ER"): TrialEvent =>
    ({ minute, person, w4_id: null, unit, kind: kind as TrialEvent["kind"], detail, news2_independent: true });
  const hr = (hour: number, unit: UnitId, occ: number, admitted = 0, died = 0) => ({ hour, unit, occupancy_pct: occ, admitted_in: admitted, died }) as HourRow;
  // Warm-up ends at minute 4320. p6 and p7 are minute-0 residents (no arrive event). The trial is 5 days: minute 7200 is outside.
  const events: TrialEvent[] = [
    ev(4310, "p7", "board", "MED3A"), ev(4370, "p7", "place", "MED3A", "MED3A"),
    ev(4319, "p1", "arrive"), ev(4319, "p1", "triage", "urgent"), ev(4349, "p1", "consult"),
    ev(4320, "p2", "arrive"), ev(4320, "p2", "triage", "emergent"), ev(4320, "p2", "consult"),
    ev(4400, "p2", "decide_admit", "cardiac, ICU-indicated"), ev(4450, "p2", "place", "ICU", "ICU"),
    ev(4330, "p6", "board", "MED3A"), ev(4500, "p6", "decide_home"), ev(4630, "p6", "place", "MED3A", "MED3A"),
    ev(4400, "p3", "arrive"), ev(4400, "p3", "triage", "urgent"), ev(4460, "p3", "consult"), ev(4600, "p3", "decide_home"),
    ev(4500, "p4", "arrive"), ev(4500, "p4", "triage", "non_urgent"), ev(4800, "p4", "lwbs"),
    ev(4600, "p5", "arrive"), ev(4600, "p5", "triage", "urgent"), ev(4620, "p5", "consult"),
    ev(4700, "p5", "decide_admit", "stroke, ICU-indicated"), ev(4700, "p5", "board", "ICU"),
    ev(4700, "p8", "arrive"), ev(4700, "p8", "triage", "emergent"), ev(4710, "p8", "consult"), ev(5000, "p8", "died", "consult"),
    ev(7200, "p9", "arrive"), ev(7200, "p9", "triage", "emergent"),
  ].sort((a, b) => a.minute - b.minute);
  const hourly = [hr(71, "ER", 90, 1), hr(72, "ER", 50, 2, 1), hr(73, "ER", 150, 3), hr(120, "ER", 999, 9), hr(72, "ICU", 10)];
  const s = summarize(events, hourly, ["ER", "ICU"], 5);

  it("counts from minute 4320 on, and stops before the last minute", () => {
    const a = s.after_warm_up, all = s.all_days;
    expect(a.er_arrivals).toBe(5); // p2 p3 p4 p5 p8; p1 is before the warm-up, p9 after the end
    expect(all.er_arrivals).toBe(6);
    expect(a.per_unit.ER).toEqual({ occupancy_mean_pct: 100, occupancy_max_pct: 150, admissions: 5, deaths: 1 });
    expect(all.per_unit.ER).toEqual({ occupancy_mean_pct: 96.67, occupancy_max_pct: 150, admissions: 6, deaths: 1 });
    expect(a.deaths).toBe(1);
  });

  it("door to doctor leaves out people who left unseen", () => {
    const a = s.after_warm_up;
    expect([a.door_to_doctor_median_min, a.door_to_doctor_p90_min, a.share_seen_within_30_min, a.share_seen_in_arrival_minute]).toEqual([15, 60, 0.75, 0.25]);
    expect(a.door_to_doctor_median_min_by_triage).toEqual({ emergent: 5, urgent: 40, non_urgent: null });
    expect([a.left_without_being_seen, a.lwbs_wait_median_min]).toEqual([1, 300]);
    expect([s.all_days.door_to_doctor_median_min, s.all_days.door_to_doctor_p90_min]).toEqual([20, 60]);
  });

  it("ER shares count only people who arrived in the run, not the minute-0 resident p6", () => {
    expect(s.after_warm_up.er_admission_share).toBe(0.6667); // admit p2 p5 of admit + home p3
    expect(s.after_warm_up.er_death_share).toBe(0.2);
  });

  it("boarding: completed stays only, and the one still boarding is reported apart", () => {
    const a = s.after_warm_up;
    expect([a.er_boarding_hours_median, a.er_boarding_hours_p90, a.er_boarders_ended]).toEqual([5, 5, 1]); // p6; p7 began before the warm-up
    expect(a.er_still_boarding_at_end).toEqual({ count: 1, median_hours_so_far: 41.67 });
    expect([s.all_days.er_boarding_hours_median, s.all_days.er_boarders_ended]).toEqual([3, 2]);
  });

  it("ICU access counts people still waiting as not placed, and reports them", () => {
    expect(s.after_warm_up.icu_access).toEqual({ icu_indicated_admitted_from_er: 2, reached_icu: 1, share: 0.5, icu_indicated_pending_at_end: 1 });
  });
});
