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

/** Runs `f` with A3 off (no returns, the old name lists). */
function a3Off<T>(f: () => T): T {
  const keep = PARAMS.returns.enabled.value;
  PARAMS.returns.enabled.value = false;
  try { return f(); } finally { PARAMS.returns.enabled.value = keep; }
}

/** Runs `f` with A2's response and A3 off (no class flip or ICU request, no death from the delay, stay deaths unscaled, no returns). */
function a2Off<T>(f: () => T): T {
  const C = PARAMS.course, keep = [C.escalate.value, PARAMS.obs.excessDeathPerHour.value, C.stayDeathScale.value] as const;
  C.escalate.value = false; PARAMS.obs.excessDeathPerHour.value = 0; C.stayDeathScale.value = 1;
  try { return a3Off(f); } finally { [C.escalate.value, PARAMS.obs.excessDeathPerHour.value, C.stayDeathScale.value] = keep; }
}

describe("hospital trial", () => {
  let day: TrialResult, again: TrialResult, long: TrialResult, off: TrialResult, off3: TrialResult, secs: number;
  beforeAll(() => {
    day = runHospitalTrial(101, typical, 1);
    again = runHospitalTrial(101, typical, 1);
    const t0 = performance.now();
    long = runHospitalTrial(101, typical, DAYS);
    secs = Math.round((performance.now() - t0) / 100) / 10;
    off = a2Off(() => runHospitalTrial(101, typical, DAYS));
    off3 = a3Off(() => runHospitalTrial(101, typical, DAYS));
  }, 600_000);

  it("gives byte-identical files for the same seed and scenario", () => {
    expect(sha(again)).toEqual(sha(day));
  });

  it("differs for another seed and for another scenario", () => {
    const a = sha(day), b = sha(runHospitalTrial(102, typical, 1)), c = sha(runHospitalTrial(101, load("surge"), 1));
    for (let i = 0; i < 3; i += 1) { expect(b[i]).not.toBe(a[i]); expect(c[i]).not.toBe(a[i]); }
  }, 30_000);

  it("writes one hourly row per unit per hour, columns as designed", () => {
    const rows = long.hourlyCsv.trimEnd().split("\n");
    expect(rows[0]).toBe("hour,unit,census,beds,stretchers_used,occupancy_pct,arrivals,admitted_in,discharged,transferred_in,transferred_out,died,nurses,patients_per_nurse,er_waiting,er_consult,er_workup,er_boarding,er_boarding_hours,er_lwbs,door_to_doctor_median_min,icu_indicated_not_in_icu,morgue" +
      ",obs_due,obs_done,obs_late,obs_overdue_now,obs_longest_overdue_min,care_min_demanded,care_min_available,obs_longest_since_round_min,obs_rel_late_median" +
      ",deteriorated,noticed,noticed_late,unnoticed_now,recognition_delay_median_min,returns");
    expect(rows.length - 1).toBe(UNITS * DAYS * 24);
    expect(long.hourlyRows).toBe(UNITS * DAYS * 24);
    for (const r of rows) expect(r.split(",")).toHaveLength(38);
    for (const r of rows.slice(1)) { const f = r.split(","); expect(f[37], r).toMatch(f[1] === "ER" ? /^\d+$/ : /^$/); } // A3: returns, ER only
    const er = rows.filter((r) => r.split(",")[1] === "ER" && r.split(",")[0] !== "hour");
    expect(er.every((r) => r.split(",")[14] !== "")).toBe(true); // ER-only columns filled on the ER
    expect(rows.filter((r) => r.split(",")[1] === "ICU").every((r) => r.split(",")[14] === "")).toBe(true); // blank elsewhere
    // the observation columns: filled on the ER and the three wards, blank on the ICU, W4 and the morgue
    for (const r of rows.slice(1)) {
      const f = r.split(",");
      const on = ["ER", "MED3A", "MED3B", "SURG5A"].includes(f[1]);
      expect(f.slice(23, 31).every((x) => (on ? /^\d+(\.\d+)?$/.test(x) : x === "")), r).toBe(true);
      expect(on ? /^(\d+(\.\d+)?)?$/.test(f[31]) : f[31] === "", r).toBe(true); // blank when no round was done that hour
      expect(f.slice(32, 36).every((x) => (on ? /^\d+$/.test(x) : x === "")), r).toBe(true); // A2's counts
      expect(on ? /^(\d+(\.\d+)?)?$/.test(f[36]) : f[36] === "", r).toBe(true); // blank when nothing was noticed that hour
    }
  });

  it("writes events in minute order, eight fields, news2_independent yes or no, w4_higher_care no", () => {
    const rows = long.eventsCsv.trimEnd().split("\n").slice(1).map((r) => r.split(","));
    expect(rows.length).toBe(long.eventRows);
    let last = 0;
    for (const f of rows) {
      expect(f).toHaveLength(8);
      expect(f[7]).toMatch(/^[1-9]\d*$/); // A3: the visit
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
    const row = { minute: 1, person: "h-000001", visit: 1, w4_id: "p-001", unit: "ICU" as const, kind: "transfer" as const, news2_independent: false };
    expect(isHigherCare({ ...row, detail: "W4 to ICU" })).toBe(true);
    expect(isHigherCare({ ...row, kind: "board", detail: "W4 higher care, no ICU bed" })).toBe(true);
    expect(isHigherCare({ ...row, detail: "ICU to MED3A" })).toBe(false);
    const w4Discharges = long.eventsCsv.split("\n").filter((l) => l.split(",")[3] === "W4" && l.split(",")[4] === "discharge");
    expect(w4Discharges.every((l) => l.split(",")[6] === "no")).toBe(true);
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
    expect(s.limits).toContain("observation workload uses judgement values (share of nurse time); see params");
    expect(s.limits).toContain("deaths after late recognition come from one judgement number (obs.excessDeathPerHour); all other deaths are pre-drawn");
    expect(s.limits).toContain("not evidence about real wards");
    expect(s.format_version).toBe(4);
    expect(s.limits).toContain("A return takes the place of a new arrival");
    for (const b of [s.all_days, s.after_warm_up]) {
      expect(Object.keys(b).slice(-5)).toEqual(["returns", "return_scheduled", "return_dropped", "return_share_of_discharges", "return_share_of_arrivals"]);
      expect(b.returns).toBeGreaterThan(5);
      expect(b.return_share_of_discharges).toBeGreaterThan(0.1);
    }
    const rec = s.all_days.recognition;
    expect(Object.keys(rec)).toEqual(["per_unit", "excess_deaths_total", "excess_deaths_share_of_deaths", "excess_deaths_label", "w4"]);
    expect(Object.keys(rec.per_unit)).toEqual(["ER", "MED3A", "MED3B", "SURG5A", "ICU"]);
    expect(Object.keys(rec.per_unit.MED3A)).toEqual(["deteriorated", "count", "delay_median_min", "delay_p90_min", "late_share", "unnoticed", "escalated_to_icu", "patients_per_nurse_mean", "excess_deaths"]);
    expect(rec.per_unit.MED3A.count + rec.per_unit.MED3B.count).toBeGreaterThan(5);
    expect(rec.excess_deaths_label).toBe("model output under a judgement relation, not evidence");
    expect(Object.keys(rec.w4)).toEqual(["episodes", "alerted", "alert_lead_median_min", "alert_lead_p90_min"]);
    expect(rec.w4.episodes).toBeGreaterThanOrEqual(rec.w4.alerted);
    expect(Object.keys(s.all_days.per_unit.MED3A)).toEqual(["occupancy_mean_pct", "occupancy_max_pct", "admissions", "deaths", "obs_late_share", "obs_longest_overdue_max_min", "care_demand_over_available", "obs_longest_since_round_max_min", "obs_rel_late_median_of_hours"]);
    expect(s.all_days.per_unit.ICU.obs_late_share).toBeNull();
    expect(s.all_days.per_unit.MED3A.care_demand_over_available).toBeGreaterThan(0);
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

  // With A2's response off, A2's event rows, columns and `recognition` blocks taken out, the 30-day typical trial must hash to what
  // older code gives. v1: recorded on ae80706 (no A1 logic). v2: recorded from origin/main 75fda0f's own hospital-trial output
  // (A1, no A2) for seed 101, typical, 30 days. Only appended columns, added keys and added event rows may differ.
  it("keeps every v1 and v2 byte of the 30-day typical trial when A2's additions are stripped and its response is off", () => {
    const h = (x: string) => createHash("sha256").update(x).digest("hex").slice(0, 16);
    const A2_KINDS = new Set(["deteriorate", "noticed", "unnoticed"]);
    const A3_KINDS = new Set(["return_scheduled", "return", "return_dropped"]);
    const v7 = (l: string) => l.split(",").slice(0, 7).join(","); // A3 appends the visit column
    const events = off.eventsCsv.split("\n").filter((l) => !A2_KINDS.has(l.split(",")[4])).map(v7).join("\n");
    expect(off.eventsCsv.split("\n").length - events.split("\n").length).toBeGreaterThan(10);
    expect(off.eventsCsv.split("\n").some((l) => A3_KINDS.has(l.split(",")[4]))).toBe(false); // A2 rows were there to strip
    const cols = (n: number) => off.hourlyCsv.split("\n").map((l) => l.split(",").slice(0, n).join(",")).join("\n");
    const strip = (keys: string[]) => { const ks = new Set(keys); return JSON.stringify(JSON.parse(off.summaryJson), (k, v) => (ks.has(k) ? undefined : v)); };
    const A1_SUMMARY = ["obs_late_share", "obs_longest_overdue_max_min", "care_demand_over_available", "obs_longest_since_round_max_min", "obs_rel_late_median_of_hours"];
    const A3_SUMMARY = ["returns", "return_scheduled", "return_dropped", "return_share_of_discharges", "return_share_of_arrivals"];
    const OUT = ["format_version", "limits", "recognition", ...A3_SUMMARY];
    expect([h(events), h(cols(23)), h(strip([...OUT, ...A1_SUMMARY]))]).toEqual(["06bcca99478acddf", "72abf5628b361263", "6b841afc19dc32a4"]);
    expect([h(events), h(cols(32)), h(strip(OUT))]).toEqual(["06bcca99478acddf", "6b503e0176568031", "616a37b838e19926"]);
  });

  // v3 is origin/main 8616326's own output (A2 on, no A3 code) for seed 101, typical, 30 days. With returns off (and the old name lists), the
  // visit column, A3's event kinds, the `returns` column and A3's summary keys taken out, every v3 byte must be the same.
  it("keeps every v3 byte of the 30-day typical trial when returns are off and A3's additions are stripped", () => {
    const h = (x: string) => createHash("sha256").update(x).digest("hex").slice(0, 16);
    const events = off3.eventsCsv.split("\n").map((l) => l.split(",").slice(0, 7).join(",")).join("\n");
    const cols = off3.hourlyCsv.split("\n").map((l) => l.split(",").slice(0, 37).join(",")).join("\n");
    const out = ["format_version", "limits", "returns", "return_scheduled", "return_dropped", "return_share_of_discharges", "return_share_of_arrivals"];
    const summary = JSON.stringify(JSON.parse(off3.summaryJson), (k, v) => (out.includes(k) ? undefined : v));
    expect([h(events), h(cols), h(summary)]).toEqual(["2f1da5ca8d6b81b3", "ec1c816fe4d8938e", "1a8566d828e2d1f4"]);
    expect(JSON.parse(off3.summaryJson).all_days.returns).toBe(0);
    expect(long.eventsCsv).not.toBe(off3.eventsCsv); // and with returns on, people do come back
    expect(long.eventsCsv.split("\n").filter((l) => l.split(",")[4] === "return").length).toBeGreaterThan(10);
  });

  it("finishes a 30-day typical trial", () => {
    console.log(`30-day typical trial: ${secs} s; hourly ${long.hourlyCsv.length} B, events ${long.eventsCsv.length} B, summary ${long.summaryJson.length} B`);
    expect(long.hourlyRows).toBe(UNITS * DAYS * 24);
  });
});

describe("summary figures", () => {
  const ev = (minute: number, person: string, kind: string, detail = "", unit: UnitId = "ER"): TrialEvent =>
    ({ minute, person, visit: 1, w4_id: null, unit, kind: kind as TrialEvent["kind"], detail, news2_independent: true });
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
    const noObs = { obs_late_share: null, obs_longest_overdue_max_min: null, care_demand_over_available: null, obs_longest_since_round_max_min: null, obs_rel_late_median_of_hours: null }; // these rows carry no rounds
    expect(a.per_unit.ER).toEqual({ occupancy_mean_pct: 100, occupancy_max_pct: 150, admissions: 5, deaths: 1, ...noObs });
    expect(all.per_unit.ER).toEqual({ occupancy_mean_pct: 96.67, occupancy_max_pct: 150, admissions: 6, deaths: 1, ...noObs });
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

  it("observation keys: late over done, the longest overdue, demand over available as sum over sum; null with nothing to divide by", () => {
    const o = (hour: number, unit: UnitId, done: number, late: number, longest: number, demanded: number, available: number) =>
      ({ ...hr(hour, unit, 0), obs_done: done, obs_late: late, obs_longest_overdue_min: longest, care_min_demanded: demanded, care_min_available: available }) as HourRow;
    const rows = [o(80, "MED3A", 4, 1, 30, 50, 30), o(81, "MED3A", 6, 4, 170, 40, 30), o(80, "SURG5A", 0, 0, 0, 25, 0), hr(80, "ICU", 10)];
    const f = summarize([], rows, ["MED3A", "SURG5A", "ICU"], 5).after_warm_up.per_unit as Record<string, Record<string, unknown>>;
    expect(f.MED3A).toMatchObject({ obs_late_share: 0.5, obs_longest_overdue_max_min: 170, care_demand_over_available: 1.5 });
    expect(f.SURG5A).toMatchObject({ obs_late_share: null, obs_longest_overdue_max_min: 0, care_demand_over_available: null }); // zero nurses
    expect(f.ICU).toMatchObject({ obs_late_share: null, obs_longest_overdue_max_min: null, care_demand_over_available: null });
  });

  it("ICU access counts people still waiting as not placed, and reports them", () => {
    expect(s.after_warm_up.icu_access).toEqual({ icu_indicated_admitted_from_er: 2, reached_icu: 1, share: 0.5, icu_indicated_pending_at_end: 1 });
  });
});
