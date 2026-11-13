/// <reference types="node" />
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { EXPECTED, fastRows, formatRealism, judge, wardRows, type Row, type WardStats } from "./realism";

// Checks A, B, C and F run in full. D and E take about 190 seconds, so they are pinned by text instead of run:
// every literal copied from a test file must still be there, and the expected status must equal its it / it.fails marker.
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
const published = read("./sim/published.test.ts");
const simTest = read("./sim/sim.test.ts");
const calibrationTest = read("./sim/calibration.test.ts");
const mine = read("./realism.ts");

// [file text, the exact source line, the text that realism.ts uses for it when it is written differently]
const PINS: [string, string, string?][] = [
  [published, "const PERCENTILES = [0.01, 0.05, 0.1, 0.5, 0.9, 0.95, 0.99];"],
  [published, "heart_rate: { values: [50, 58, 63, 81, 105, 112, 128], tolerance: 10 },"],
  [published, "respiratory_rate: { values: [7, 10, 11, 16, 23, 25, 30], tolerance: 3 },"],
  [published, "spo2: { values: [86, 89, 91, 95, 99, 100, 100], tolerance: 3 },"],
  [published, "systolic: { values: [83, 93, 98, 121, 151, 161, 180], tolerance: 15 },"],
  [published, "const percentile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)];"],
  [published, "const BURN_IN_DAYS = 10;"],
  [published, "const MEASURED_DAYS = 20;"],
  [published, "for (let seed = 1; seed <= 6; seed += 1) {"],
  [published, "const src = createSyntheticSource(seed, true);"],
  [published, "setSpeed(s, 60);"],
  [published, "const slot = Math.floor((s.clockS - start) / 300);"],
  [published, "const minute = slot * 5;"],
  [published, "if (minute < BURN_IN_DAYS * 1440) continue; // the 20 starting patients must have turned over"],
  [published, "const value = p.held[v];"],
  [published, "if (p.bp) seen.systolic.push(p.bp.systolic);"],
  [published, "if (minute < (nextSet.get(p.id) ?? 0)) continue;"],
  [published, "if (total >= 5) setsAt5 += 1;"],
  [published, "if (total >= 7) setsAt7 += 1;"],
  [published, "nextSet.set(p.id, minute + (total >= 7 ? 30 : total >= 5 ? 60 : total >= 1 ? 300 : 720));"],
  [published, "PERCENTILES.forEach((p, i) => expect(Math.abs(percentile(seen[series], p) - values[i])).toBeLessThanOrEqual(tolerance));", "Math.abs(stats.percentiles[series][i] - values[i]) <= tolerance"],
  [published, "expect(Math.abs(pct(setsAt5, sets) - 20)).toBeLessThanOrEqual(7);", "Math.abs(at5 - NEWS5) <= 7"],
  [published, "expect(Math.abs(pct(setsAt7, sets) - 10)).toBeLessThanOrEqual(5);", "Math.abs(at7 - NEWS7) <= 5"],
  [published, "const runs = 1500;"],
  [published, "const src = createSyntheticSource(i + 1);"],
  [published, "swing += (src.read(\"p-002\", 360)?.[v] ?? 0) - (src.read(\"p-002\", 1080)?.[v] ?? 0);"],
  [published, "return swing / runs / 2;"],
  [published, "expect(Math.abs(amplitude(\"heart_rate\") - 6.9)).toBeLessThanOrEqual(1.5);", "Math.abs(hr - SWING_HR) <= 1.5"],
  [published, "expect(Math.abs(amplitude(\"respiratory_rate\") - 1)).toBeLessThanOrEqual(0.5);", "Math.abs(rr - SWING_RR) <= 0.5"],
  [simTest, "const series = Array.from({ length: 200 }, (_, i) => {"],
  [simTest, "return Array.from({ length: 360 }, (_, m) => src.read(\"p-002\", m + 1)).filter((_, m) => m % 5 === 0);"],
  [simTest, "expect(sd / real.sd).toBeGreaterThan(0.75);", "sd / real.sd > 0.75 && sd / real.sd < 1.25"],
  [simTest, "expect(sd / real.sd).toBeLessThan(1.25);", ""],
  [simTest, "expect(Math.abs(lag / sum - real.lag5Corr)).toBeLessThan(0.2);", "Math.abs(lag / sum - real.lag5Corr) < 0.2"],
  [simTest, "for (let i = 0; i < 2000; i += 1) {"],
  [simTest, "const a = src.cuff(\"p-002\", 10)!.systolic;"],
  [simTest, "total += (src.cuff(\"p-002\", 10 + gap)!.systolic - a) ** 2;"],
  [simTest, "return Math.sqrt(total / 2000);"],
  [simTest, "expect(steps(30) / at15to45min.stepSd).toBeGreaterThan(0.75);", "sim / real.stepSd > 0.75 && sim / real.stepSd < 1.25"],
  [simTest, "expect(steps(30) / at15to45min.stepSd).toBeLessThan(1.25);", ""],
  [simTest, "expect(steps(180) / at120to240min.stepSd).toBeGreaterThan(0.75);", ""],
  [simTest, "expect(steps(180) / at120to240min.stepSd).toBeLessThan(1.25);", ""],
  [calibrationTest, "const SKIP = new Set([\"p-001\", \"p-009\"]); // scripted slope, atrial fibrillation"],
  [calibrationTest, "const SEEDS = [1, 2, 3];"],
  [calibrationTest, "const DAYS = 3;"],
  [calibrationTest, "const HALF_WINDOW = 36; // 6-hour rolling median, as in the fit"],
  [calibrationTest, "const check = band.lag === 5 && v !== \"heart_rate\" ? it.fails : it;", "lag === 5 && v !== \"heart_rate\" ? \"known miss\" : \"pass\""],
  [calibrationTest, "expect(m).toBeGreaterThanOrEqual(band.p25);", "m >= band.p25 && m <= band.p75"],
  [calibrationTest, "expect(m).toBeLessThanOrEqual(band.p75);", ""],
  // the real figures are one constant each, used in the comparison and printed in the real column
  [mine, "const SWING_HR = 6.9;"],
  [mine, "const SWING_RR = 1;"],
  [mine, "const NEWS5 = 20;"],
  [mine, "const NEWS7 = 10;"],
  [mine, "real: f2(SWING_HR)"],
  [mine, "real: f2(SWING_RR)"],
  [mine, "real: String(NEWS5)"],
  [mine, "real: String(NEWS7)"],
  [mine, "process.exitCode = ok ? 0 : 1;"],
  [mine, "if (isMain(process.argv[1], import.meta.url)) {"],
  [published, "while (s.clockS < start + (BURN_IN_DAYS + MEASURED_DAYS) * 86400) {"],
  [published, "if (slot === lastSlot) continue;"],
  [published, "if (value !== null) seen[v].push(value);"],
  [published, "if (p.decision.kind !== \"ranked\") continue;"],
  [published, "const total = p.decision.news2.total;"],
  [published, "const pct = (count: number, of: number) => (100 * count) / of;"],
  [simTest, "for (const v of [\"heart_rate\", \"respiratory_rate\", \"spo2\"] as const) {", "MAIN3.forEach((v, vi) => {"],
  [simTest, "let sum = 0;"],
  [simTest, "let lag = 0;"],
  [simTest, "let n = 0;"],
  [simTest, "for (const run of series) {"],
  [simTest, "const xs = run.map((r) => r?.[v] ?? NaN);"],
  [simTest, "const ok = xs.filter((x) => !Number.isNaN(x));"],
  [simTest, "const m = ok.reduce((a, b) => a + b) / ok.length;"],
  [simTest, "xs.forEach((x, i) => {"],
  [simTest, "if (Number.isNaN(x)) return;"],
  [simTest, "sum += (x - m) ** 2;"],
  [simTest, "n += 1;"],
  [simTest, "if (i + 1 < xs.length && !Number.isNaN(xs[i + 1])) lag += (x - m) * (xs[i + 1] - m);"],
  [simTest, "const real = fitted.holdout[v];"],
  [simTest, "const sd = Math.sqrt(sum / n);"],
  [calibrationTest, "const median = (a: number[]) => {"],
  [calibrationTest, "const s = [...a].sort((x, y) => x - y);"],
  [calibrationTest, "const mid = (s.length - 1) / 2;"],
  [calibrationTest, "return (s[Math.floor(mid)] + s[Math.ceil(mid)]) / 2;"],
  [calibrationTest, "function detrend(x: number[]) {"],
  [calibrationTest, "return x.map((value, i) => {"],
  [calibrationTest, "if (Number.isNaN(value)) return NaN;"],
  [calibrationTest, "const window = x.slice(Math.max(0, i - HALF_WINDOW), i + HALF_WINDOW + 1).filter((w) => !Number.isNaN(w));"],
  [calibrationTest, "return window.length >= 12 ? value - median(window) : NaN;"],
  [calibrationTest, "function changes(x: number[], lagSlots: number) {"],
  [calibrationTest, "const out: number[] = [];"],
  [calibrationTest, "for (let i = 0; i + lagSlots < x.length; i += 1) {"],
  [calibrationTest, "if (!Number.isNaN(x[i]) && !Number.isNaN(x[i + lagSlots])) out.push(x[i + lagSlots] - x[i]);"],
  [calibrationTest, "return out;"],
  [calibrationTest, "const sd = (d: number[]) => {"],
  [calibrationTest, "const mean = d.reduce((a, b) => a + b) / d.length;"],
  [calibrationTest, "return Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length);"],
  [calibrationTest, "const pooled: Record<string, Record<string, number[][]>> = {};"],
  [calibrationTest, "for (const seed of SEEDS) {"],
  [calibrationTest, "const src = createSyntheticSource(seed);"],
  [calibrationTest, "for (const { id } of src.seeds()) {"],
  [calibrationTest, "if (SKIP.has(id)) continue;"],
  [calibrationTest, "const slots = (DAYS * 1440) / 5;"],
  [calibrationTest, "for (let minute = 1; minute <= DAYS * 1440; minute += 1) {"],
  [calibrationTest, "const reading = src.read(id, minute);"],
  [calibrationTest, "if (!reading) continue;"],
  [calibrationTest, "const x = detrend(bins[v].map((b) => (b.length ? median(b) : NaN)));"],
  [calibrationTest, "const per = ((pooled[id] ??= {})[v] ??= calibration.changeSd[v].map(() => [] as number[]));"],
  [calibrationTest, "calibration.changeSd[v].forEach(({ lag }, k) => per[k].push(...changes(x, lag / 5)));"],
  [calibrationTest, "const m = median(Object.values(pooled).map((byVital) => sd(byVital[v][k])));"],
  [calibrationTest, "const bins = Object.fromEntries(VITALS.map((v) => [v, Array.from({ length: slots }, () => [] as number[])]));", "const bins = Object.fromEntries(MAIN3.map((v) => [v, Array.from({ length: slots }, () => [] as number[])]));"],
  [calibrationTest, "for (const v of VITALS) bins[v][Math.floor((minute - 1) / 5)].push(reading[v]!);", "for (const v of MAIN3) bins[v][Math.floor((minute - 1) / 5)].push(reading[v]!);"],
];

// The marker of the test whose title starts with `title`.
const marker = (text: string, title: string) => new RegExp(`\\b(it\\.fails|it)\\("${title}`).exec(text)?.[1];

describe("source pins", () => {
  it("every copied literal is still in its test file and in realism.ts", () => {
    for (const [text, line, own] of PINS) {
      expect(text, line).toContain(line);
      if (own !== "") expect(mine, line).toContain(own ?? line); // "": companion line of a pair, covered by the one before
    }
  });

  it("the expected status of each check equals the it / it.fails marker", () => {
    const want = (m: string | undefined) => (m === "it.fails" ? "known miss" : m === "it" ? "pass" : "missing");
    expect(want(marker(simTest, "moves like the held-out real hospitals"))).toBe(EXPECTED.A1);
    expect(want(marker(simTest, "moves blood pressure like the held-out"))).toBe(EXPECTED.B1);
    expect(want(marker(published, "heart rate matches Welch"))).toBe(EXPECTED.D1);
    expect(want(marker(published, "respiratory rate matches Welch"))).toBe(EXPECTED.D2);
    expect(want(marker(published, "SpO2 matches Welch"))).toBe(EXPECTED.D3);
    expect(want(marker(published, "systolic matches Welch"))).toBe(EXPECTED.D4);
    expect(want(marker(published, "about 20% of observation sets at NEWS 5\\+"))).toBe(EXPECTED.E1);
    expect(want(marker(published, "about 10% of observation sets at NEWS 7\\+"))).toBe(EXPECTED.E2);
    expect(marker(published, "24-hour rhythm matches")).toBe("it"); // a fitted target
    expect(EXPECTED.F1).toBe("fitted target");
    // C: lag 5 of breathing and SpO2 only (the rule itself is pinned above).
    expect(Object.entries(EXPECTED).filter(([k, v]) => k.startsWith("C") && v === "known miss").map(([k]) => k)).toEqual(["C5", "C9"]);
  });
});

// Welch values, inside tolerance by construction.
const INSIDE: WardStats = {
  percentiles: {
    heart_rate: [50, 58, 63, 81, 105, 112, 128],
    respiratory_rate: [7, 10, 11, 16, 23, 25, 30],
    spo2: [86, 89, 91, 95, 99, 100, 100],
    systolic: [83, 93, 98, 121, 151, 161, 180],
  },
  sets: 100,
  setsAt5: 20,
  setsAt7: 10,
};
const withShares = (setsAt5: number, setsAt7: number): WardStats => ({ ...INSIDE, setsAt5, setsAt7 });
const insideOf = (rows: Row[], check: string) => rows.filter((r) => r.check === check).map((r) => r.inside);

describe("D and E rows from statistics", () => {
  it("every percentile inside tolerance: all rows inside, and the known-miss checks are reported as UNEXPECTED", () => {
    const rows = wardRows(INSIDE);
    expect(rows.length).toBe(30);
    expect(rows.every((r) => r.inside)).toBe(true);
    const { verdicts, ok } = judge(rows);
    expect(ok).toBe(false);
    expect(verdicts.filter((v) => v === "UNEXPECTED").length).toBe(7 + 2); // D3 (SpO2) and E1, E2 rows: 7 + 1 + 1
    expect(rows.filter((_, i) => verdicts[i] === "UNEXPECTED").map((r) => r.check)).toEqual([...Array(7).fill("D3"), "E1", "E2"]);
  });

  it("SpO2 outside tolerance is a known miss for that row only", () => {
    const stats = { ...INSIDE, percentiles: { ...INSIDE.percentiles, spo2: [80, 89, 91, 95, 99, 100, 100] } };
    const rows = wardRows({ ...stats, setsAt5: 35, setsAt7: 18 });
    expect(insideOf(rows, "D3")).toEqual([false, true, true, true, true, true, true]);
    const { verdicts, ok } = judge(rows);
    expect(ok).toBe(true);
    const d3 = rows.map((r, i) => [r.check, verdicts[i]]).filter(([c]) => c === "D3").map(([, v]) => v);
    expect(d3).toEqual(["known miss", "pass", "pass", "pass", "pass", "pass", "pass"]);
    expect(verdicts.filter((v) => v === "known miss").length).toBe(3);
  });

  it("the NEWS shares are inside at the tolerance and outside just past it, on both sides", () => {
    const at = (a: number, b: number) => wardRows(withShares(a, b)).filter((r) => r.check[0] === "E").map((r) => r.inside);
    expect(at(27, 15)).toEqual([true, true]);
    expect(at(13, 5)).toEqual([true, true]);
    expect(at(28, 16)).toEqual([false, false]);
    expect(at(12, 4)).toEqual([false, false]);
  });
});

describe("judge", () => {
  it("a check id missing from EXPECTED is UNEXPECTED, not a pass", () => {
    const row: Row = { check: "Z9", signal: "x", statistic: "x", sim: "1", real: "1", tolerance: "-", inside: true, data: "x" };
    expect(judge([row])).toEqual({ verdicts: ["UNEXPECTED"], ok: false });
  });
});

describe("the report", () => {
  let fast: Row[];
  beforeAll(() => {
    fast = fastRows();
  }, 120_000);

  it("A, B, C and F have the expected verdicts", () => {
    const { verdicts, ok } = judge(fast);
    expect(ok).toBe(true);
    const verdictsOf = (check: string) => fast.map((r, i) => [r.check, verdicts[i]]).filter(([c]) => c === check).map(([, v]) => v);
    for (const c of ["A1", "A2", "A3", "B1", "B2", "C1", "C2", "C3", "C4", "C6", "C7", "C8", "C10", "C11", "C12"]) {
      expect(new Set(verdictsOf(c)), c).toEqual(new Set(["pass"]));
    }
    expect(verdictsOf("C5")).toEqual(["known miss"]);
    expect(verdictsOf("C9")).toEqual(["known miss"]);
    expect(verdictsOf("F1")).toEqual(["fitted target"]);
    expect(verdictsOf("F2")).toEqual(["fitted target"]);
  }, 60_000);

  const statistics: Record<string, string> = {
    H1: "fitted from eICU; not tested",
    B3: "fitted from eICU; not tested",
    R1: "fitted from MIT-BIH, AFDB, LTAFDB; not tested",
  };

  it("temperature, diastolic and heart rhythm have no real comparison", () => {
    for (const check of ["H1", "B3", "R1"]) {
      const [row] = fast.filter((r) => r.check === check);
      const { verdicts } = judge([row]);
      expect([row.sim, row.real, row.tolerance, row.data, verdicts[0]]).toEqual(["-", "-", "-", "none", "no real comparison"]);
      expect(row.statistic).toBe(statistics[check]);
    }
  });

  it("prints the same text twice, with no clock or path, and the footer", () => {
    const rows = [...fast, ...wardRows(INSIDE)];
    const a = formatRealism(rows).text;
    expect(formatRealism(rows).text).toBe(a);
    expect(a).not.toMatch(/\d{4}-\d\d-\d\d|\d\d:\d\d:\d\d/);
    expect(a).not.toMatch(/\/Users|\/private|[A-Z]:\\/);
    expect(a.split("\n")[0]).toMatch(/^check +\| signal +\| statistic +\| sim +\| real +\| tolerance +\| verdict +\| real data$/);
    expect(a.split("\n").slice(-7)[0]).toBe("synthetic, not validated");
    expect(a.endsWith("see NOTICE.md")).toBe(true);
    expect(a).toContain("fitted target: the simulator was set from this number, so agreement is by construction");
    expect(a).toContain("calibration rows: stays held out from src/sim/calibration.json only, not from the fit in src/sim/fitted.json (another hospital split)");
    expect(a).toContain("lag-1 (5 min) autocorrelation");
    expect(a).toContain("eICU calibration hold-out");
    expect(a).toContain("van Goor 2022 (set from)");
    const order = a.split("\n").slice(1).map((l) => l.split(" | ")[1]?.trim());
    expect(order.indexOf("heart rate")).toBeLessThan(order.indexOf("breathing"));
    expect(order.indexOf("heart rhythm")).toBeLessThan(order.indexOf("NEWS2"));
  });
});
