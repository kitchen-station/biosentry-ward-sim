/// <reference types="node" />
// `npm run realism`: the simulator's statistic beside the real-data number the existing tests already use.
// Every computation copies a test, with the same seeds, lengths and functions; src/realism.test.ts pins each copied literal
// against that test file. No new fitting, tolerance or clinical number. It must not import src/trial.ts, src/compare.ts,
// src/hospital-trial.ts or src/headless.ts: their command line would run inside the bundle.
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSimulator, checkArgs, compareBlocks, decode, Refusal, writeJson } from "./export-evaluation";
import calibration from "./sim/calibration.json";
import fitted from "./sim/fitted.json";
import { createSim, setSpeed, step } from "./sim/sim";
import { createSyntheticSource, VITALS } from "./sim/source";

export interface Row {
  check: string;
  signal: string;
  statistic: string;
  sim: string;
  real: string;
  tolerance: string;
  inside: boolean | null; // null: there is no real comparison
  data: string;
}
export type Expected = "pass" | "known miss" | "fitted target" | "no real comparison";

const SIGNALS = ["heart rate", "breathing", "SpO2", "temperature", "blood pressure (systolic)", "blood pressure (diastolic)", "heart rhythm"];
const NAMES = { heart_rate: SIGNALS[0], respiratory_rate: SIGNALS[1], spo2: SIGNALS[2] };
const MAIN3 = ["heart_rate", "respiratory_rate", "spo2"] as const;
const f2 = (x: number) => x.toFixed(2);
const f3 = (x: number) => x.toFixed(3);

// What each check is today: C lag 5 for breathing and SpO2, D SpO2 and both E rows are known misses; F is a fitted target.
export const EXPECTED: Record<string, Expected> = {
  A1: "pass", A2: "pass", A3: "pass", B1: "pass", B2: "pass",
  D1: "pass", D2: "pass", D3: "known miss", D4: "pass", E1: "known miss", E2: "known miss",
  F1: "fitted target", F2: "fitted target", H1: "no real comparison", B3: "no real comparison", R1: "no real comparison",
};
MAIN3.forEach((v, vi) => calibration.changeSd[v].forEach(({ lag }, k) => {
  EXPECTED[`C${vi * 4 + k + 1}`] = lag === 5 && v !== "heart_rate" ? "known miss" : "pass"; // mirrors calibration.test.ts:66
}));

// ---- A, mirrors sim.test.ts "moves like the held-out real hospitals"
function rowsA(): Row[] {
  const series = Array.from({ length: 200 }, (_, i) => {
    const src = createSyntheticSource(i + 1);
    return Array.from({ length: 360 }, (_, m) => src.read("p-002", m + 1)).filter((_, m) => m % 5 === 0);
  });
  const rows: Row[] = [];
  MAIN3.forEach((v, vi) => {
    let sum = 0;
    let lag = 0;
    let n = 0;
    for (const run of series) {
      const xs = run.map((r) => r?.[v] ?? NaN);
      const ok = xs.filter((x) => !Number.isNaN(x));
      const m = ok.reduce((a, b) => a + b) / ok.length;
      xs.forEach((x, i) => {
        if (Number.isNaN(x)) return;
        sum += (x - m) ** 2;
        n += 1;
        if (i + 1 < xs.length && !Number.isNaN(xs[i + 1])) lag += (x - m) * (xs[i + 1] - m);
      });
    }
    const real = fitted.holdout[v];
    const sd = Math.sqrt(sum / n);
    const data = "eICU held-out hospitals";
    const base = { check: `A${vi + 1}`, signal: NAMES[v], data };
    rows.push({ ...base, statistic: "sd, 5-min reads", sim: f2(sd), real: f2(real.sd), tolerance: "ratio 0.75-1.25", inside: sd / real.sd > 0.75 && sd / real.sd < 1.25 });
    rows.push({ ...base, statistic: "lag-1 (5 min) autocorrelation", sim: f3(lag / sum), real: f3(real.lag5Corr), tolerance: "abs diff < 0.2", inside: Math.abs(lag / sum - real.lag5Corr) < 0.2 });
  });
  return rows;
}

// ---- B, mirrors sim.test.ts "moves blood pressure like the held-out real hospitals"
function rowsB(): Row[] {
  const steps = (gap: number) => {
    let total = 0;
    for (let i = 0; i < 2000; i += 1) {
      const src = createSyntheticSource(i + 1);
      const a = src.cuff("p-002", 10)!.systolic;
      total += (src.cuff("p-002", 10 + gap)!.systolic - a) ** 2;
    }
    return Math.sqrt(total / 2000);
  };
  const { at15to45min, at120to240min } = fitted.holdout.systolic;
  return ([[30, at15to45min, "B1"], [180, at120to240min, "B2"]] as const).map(([gap, real, check]) => {
    const sim = steps(gap);
    return { check, signal: SIGNALS[4], statistic: `cuff step sd, ${gap} min`, sim: f2(sim), real: f2(real.stepSd), tolerance: "ratio 0.75-1.25", inside: sim / real.stepSd > 0.75 && sim / real.stepSd < 1.25, data: "eICU held-out hospitals" };
  });
}

// ---- C, mirrors calibration.test.ts
const SKIP = new Set(["p-001", "p-009"]); // scripted slope, atrial fibrillation
const SEEDS = [1, 2, 3];
const DAYS = 3;
const HALF_WINDOW = 36; // 6-hour rolling median, as in the fit

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const mid = (s.length - 1) / 2;
  return (s[Math.floor(mid)] + s[Math.ceil(mid)]) / 2;
};

function detrend(x: number[]) {
  return x.map((value, i) => {
    if (Number.isNaN(value)) return NaN;
    const window = x.slice(Math.max(0, i - HALF_WINDOW), i + HALF_WINDOW + 1).filter((w) => !Number.isNaN(w));
    return window.length >= 12 ? value - median(window) : NaN;
  });
}

function changes(x: number[], lagSlots: number) {
  const out: number[] = [];
  for (let i = 0; i + lagSlots < x.length; i += 1) {
    if (!Number.isNaN(x[i]) && !Number.isNaN(x[i + lagSlots])) out.push(x[i + lagSlots] - x[i]);
  }
  return out;
}

const sd = (d: number[]) => {
  const mean = d.reduce((a, b) => a + b) / d.length;
  return Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length);
};

function rowsC(): Row[] {
  const pooled: Record<string, Record<string, number[][]>> = {};
  for (const seed of SEEDS) {
    const src = createSyntheticSource(seed);
    for (const { id } of src.seeds()) {
      if (SKIP.has(id)) continue;
      const slots = (DAYS * 1440) / 5;
      const bins = Object.fromEntries(MAIN3.map((v) => [v, Array.from({ length: slots }, () => [] as number[])]));
      for (let minute = 1; minute <= DAYS * 1440; minute += 1) {
        const reading = src.read(id, minute);
        if (!reading) continue;
        for (const v of MAIN3) bins[v][Math.floor((minute - 1) / 5)].push(reading[v]!);
      }
      for (const v of MAIN3) {
        const x = detrend(bins[v].map((b) => (b.length ? median(b) : NaN)));
        const per = ((pooled[id] ??= {})[v] ??= calibration.changeSd[v].map(() => [] as number[]));
        calibration.changeSd[v].forEach(({ lag }, k) => per[k].push(...changes(x, lag / 5)));
      }
    }
  }
  return MAIN3.flatMap((v, vi) => calibration.changeSd[v].map((band, k) => {
    const m = median(Object.values(pooled).map((byVital) => sd(byVital[v][k])));
    return { check: `C${vi * 4 + k + 1}`, signal: NAMES[v], statistic: `change sd, lag ${band.lag} min`, sim: f2(m), real: `${f2(band.p25)}-${f2(band.p75)}`, tolerance: "inside p25-p75", inside: m >= band.p25 && m <= band.p75, data: "eICU calibration hold-out" };
  }));
}

// The real figures the F and E rows are compared with, printed from the same constants.
const SWING_HR = 6.9;
const SWING_RR = 1;
const NEWS5 = 20;
const NEWS7 = 10;

// ---- F, mirrors published.test.ts "24-hour rhythm matches van Goor 2022"
function rowsF(): Row[] {
  const amplitude = (v: (typeof VITALS)[number]) => {
    let swing = 0;
    const runs = 1500;
    for (let i = 0; i < runs; i += 1) {
      const src = createSyntheticSource(i + 1);
      swing += (src.read("p-002", 360)?.[v] ?? 0) - (src.read("p-002", 1080)?.[v] ?? 0);
    }
    return swing / runs / 2;
  };
  const hr = amplitude("heart_rate");
  const rr = amplitude("respiratory_rate");
  const data = "van Goor 2022 (set from)";
  return [
    { check: "F1", signal: SIGNALS[0], statistic: "24-h swing", sim: f2(hr), real: f2(SWING_HR), tolerance: "abs diff <= 1.5", inside: Math.abs(hr - SWING_HR) <= 1.5, data },
    { check: "F2", signal: SIGNALS[1], statistic: "24-h swing", sim: f2(rr), real: f2(SWING_RR), tolerance: "abs diff <= 0.5", inside: Math.abs(rr - SWING_RR) <= 0.5, data },
  ];
}

const none = (check: string, signal: string, statistic: string): Row => ({ check, signal, statistic, sim: "-", real: "-", tolerance: "-", inside: null, data: "none" });

/** Checks A, B, C, F and the rows that have no real comparison. Takes seconds. */
export const fastRows = (): Row[] => [
  ...rowsA(), ...rowsB(), ...rowsC(), ...rowsF(),
  none("H1", SIGNALS[3], "fitted from eICU; not tested"), none("B3", SIGNALS[5], "fitted from eICU; not tested"),
  none("R1", SIGNALS[6], "fitted from MIT-BIH, AFDB, LTAFDB; not tested"),
];

// ---- D and E, mirror published.test.ts beforeAll
const PERCENTILES = [0.01, 0.05, 0.1, 0.5, 0.9, 0.95, 0.99];
// Welch 2015, Table 4: ten US hospitals, 94,575 monitored ward hours.
const WELCH = {
  heart_rate: { values: [50, 58, 63, 81, 105, 112, 128], tolerance: 10 },
  respiratory_rate: { values: [7, 10, 11, 16, 23, 25, 30], tolerance: 3 },
  spo2: { values: [86, 89, 91, 95, 99, 100, 100], tolerance: 3 },
  systolic: { values: [83, 93, 98, 121, 151, 161, 180], tolerance: 15 },
};
type Series = keyof typeof WELCH;
const percentile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)];
const pct = (count: number, of: number) => (100 * count) / of;
const BURN_IN_DAYS = 10;
const MEASURED_DAYS = 20;

/** What the slow ward run leaves for D and E. */
export interface WardStats {
  percentiles: Record<Series, number[]>;
  sets: number;
  setsAt5: number;
  setsAt7: number;
}

/** The slow part: about 3 minutes. */
export function wardStats(): WardStats {
  const seen: Record<Series, number[]> = { heart_rate: [], respiratory_rate: [], spo2: [], systolic: [] };
  let sets = 0;
  let setsAt5 = 0;
  let setsAt7 = 0;
  for (let seed = 1; seed <= 6; seed += 1) {
    const src = createSyntheticSource(seed, true);
    const s = createSim(src);
    setSpeed(s, 60);
    const nextSet = new Map<string, number>();
    const start = s.clockS;
    let lastSlot = -1;
    while (s.clockS < start + (BURN_IN_DAYS + MEASURED_DAYS) * 86400) {
      step(s, src);
      const slot = Math.floor((s.clockS - start) / 300);
      if (slot === lastSlot) continue;
      lastSlot = slot;
      const minute = slot * 5;
      if (minute < BURN_IN_DAYS * 1440) continue; // the 20 starting patients must have turned over
      for (const p of s.patients) {
        for (const v of ["heart_rate", "respiratory_rate", "spo2"] as const) {
          const value = p.held[v];
          if (value !== null) seen[v].push(value);
        }
        if (p.bp) seen.systolic.push(p.bp.systolic);
        if (p.decision.kind !== "ranked") continue;
        const total = p.decision.news2.total;
        // RCP counts observation sets, so sample at NEWS2 minimum frequency. 30 minutes stands in for "continuous".
        if (minute < (nextSet.get(p.id) ?? 0)) continue;
        sets += 1;
        if (total >= 5) setsAt5 += 1;
        if (total >= 7) setsAt7 += 1;
        nextSet.set(p.id, minute + (total >= 7 ? 30 : total >= 5 ? 60 : total >= 1 ? 300 : 720));
      }
    }
  }
  const percentiles = Object.fromEntries(
    (Object.keys(seen) as Series[]).map((k) => [k, PERCENTILES.map((p) => percentile(seen[k], p))]),
  ) as Record<Series, number[]>;
  return { percentiles, sets, setsAt5, setsAt7 };
}

/** D and E rows from the statistics; pure. */
export function wardRows(stats: WardStats): Row[] {
  const names: Record<Series, string> = { ...NAMES, systolic: SIGNALS[4] };
  const rows: Row[] = (Object.keys(WELCH) as Series[]).flatMap((series, si) => {
    const { values, tolerance } = WELCH[series];
    return PERCENTILES.map((p, i) => ({
      check: `D${si + 1}`, signal: names[series], statistic: `p${Math.round(p * 100)}, 5-min held values`,
      sim: f2(stats.percentiles[series][i]), real: String(values[i]), tolerance: `abs diff <= ${tolerance}`,
      inside: Math.abs(stats.percentiles[series][i] - values[i]) <= tolerance, data: "Welch 2015 (monitored wards)",
    }));
  });
  const data = "RCP 2012 (medical wards)";
  const at5 = pct(stats.setsAt5, stats.sets);
  const at7 = pct(stats.setsAt7, stats.sets);
  rows.push(
    { check: "E1", signal: "NEWS2", statistic: "% of sets at 5+", sim: f2(at5), real: String(NEWS5), tolerance: "abs diff <= 7", inside: Math.abs(at5 - NEWS5) <= 7, data },
    { check: "E2", signal: "NEWS2", statistic: "% of sets at 7+", sim: f2(at7), real: String(NEWS7), tolerance: "abs diff <= 5", inside: Math.abs(at7 - NEWS7) <= 5, data },
  );
  return rows;
}

/** One verdict per row. ok is false when any check is not what EXPECTED says. */
export function judge(rows: Row[]): { verdicts: string[]; ok: boolean } {
  let ok = true;
  const verdicts = rows.map((r) => {
    const want = EXPECTED[r.check] as Expected | undefined;
    const group = rows.filter((g) => g.check === r.check);
    let v: string;
    if (want === undefined) v = "UNEXPECTED"; // a check nobody listed must not pass
    else if (want === "no real comparison") v = want;
    else if (want === "known miss") v = group.some((g) => g.inside === false) ? (r.inside ? "pass" : "known miss") : "UNEXPECTED";
    else v = r.inside ? (want === "fitted target" ? want : "pass") : "UNEXPECTED";
    if (v === "UNEXPECTED") ok = false;
    return v;
  });
  return { verdicts, ok };
}

const FOOTER = [
  "synthetic, not validated",
  "held out: eICU-CRD Demo 2.0.1 hospitals not used to fit src/sim/fitted.json (46 of 186)",
  "calibration rows: stays held out from src/sim/calibration.json only, not from the fit in src/sim/fitted.json (another hospital split)",
  "published: Welch 2015 (US monitored wards) and RCP 2012, never used for fitting",
  "fitted target: the simulator was set from this number, so agreement is by construction",
  "fitted from: adult ICU (eICU-CRD Demo, BIDMC) and Holter and AF (MIT-BIH, AFDB, LTAFDB) recordings; not a general ward, not the Philippines",
  "only ward W4 has vitals; summary statistics only; fitted and calibration data ODbL v1.0, see NOTICE.md",
];

/** The printed cells of every row, in printed order, without the header. */
export function tableRows(rows: Row[]): { cells: string[][]; ok: boolean } {
  const { verdicts, ok } = judge(rows);
  const rank = (r: Row) => (r.check[0] === "E" ? 7 : r.check[0] === "F" ? 8 : SIGNALS.indexOf(r.signal));
  const cells = rows.map((r, i) => ({ r, v: verdicts[i], i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map(({ r, v }) => [r.check, r.signal, r.statistic, r.sim, r.real, r.tolerance, v, r.data]);
  return { cells, ok };
}

/** The same rows and footer as formatRealism, as data: every cell as printed, unpadded. */
export interface RealismBlock {
  rows: { check: string; signal: string; statistic: string; sim: string; real: string; tolerance: string; verdict: string; real_data: string }[];
  notes: string[];
  ok: boolean;
}
export function realismBlock(rows: Row[]): RealismBlock {
  const { cells, ok } = tableRows(rows);
  return { rows: cells.map(([check, signal, statistic, sim, real, tolerance, verdict, real_data]) => ({ check, signal, statistic, sim, real, tolerance, verdict, real_data })), notes: FOOTER, ok };
}

/** The fixed-width table and footer; the caller prints it. */
export function formatRealism(rows: Row[]): { text: string; ok: boolean } {
  const { cells, ok } = tableRows(rows);
  const table = [["check", "signal", "statistic", "sim", "real", "tolerance", "verdict", "real data"], ...cells];
  const widths = table[0].map((_, c) => Math.max(...table.map((row) => row[c].length)));
  const lines = table.map((row) => row.map((cell, c) => cell.padEnd(widths[c])).join(" | ").trimEnd());
  return { text: [...lines, "", ...FOOTER].join("\n"), ok };
}

/** True when this module is the program being run, also when it was started through a symlink. */
function isMain(argv1: string | undefined, moduleUrl: string) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

const REALISM_USAGE = "realism: usage: realism [--json FILE] | realism export --compare FILE --date YYYY-MM-DD --commit HEX40 --source \"LINE\" --out FILE";
const allRows = () => [...fastRows(), ...wardRows(wardStats())];

/** Why a new file cannot be written at path, as a refusal; nothing is created. */
export function checkOut(flag: string, path: string) {
  if (existsSync(path)) throw new Refusal(`${flag} exists`);
  if (!existsSync(dirname(path))) throw new Refusal(`${flag}: parent folder does not exist`);
  if (!statSync(dirname(path)).isDirectory()) throw new Refusal(`${flag}: parent is not a folder`);
}

/** The compare file as text, with the checks that need the file system. The cap is a parameter only so a test needs no big file. */
export function readCompare(path: string, cap = 1024 * 1024): string {
  const shown = [...path].slice(0, 40).join("").replace(/[\p{Cc}\p{Cf}]/gu, "?");
  let bytes: Buffer;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new Refusal("--compare: not a regular file");
    if (st.size > cap) throw new Refusal("--compare: over 1024 KB");
    bytes = readFileSync(path);
  } catch (e) {
    throw e instanceof Refusal ? e : new Refusal(`--compare: cannot read "${shown}"`);
  }
  return decode(bytes);
}

/** Runs one of the two file-writing modes. Returns the exit code; a refusal is exit 2 and a crash is exit 1. */
function runMode(name: string, go: () => number): number {
  try {
    return go();
  } catch (e) {
    console.error(e instanceof Refusal ? `${name}: ${e.message}` : `${name}: failed: ${e instanceof Error ? e.message : String(e)}`);
    return e instanceof Refusal ? 2 : 1;
  }
}

function runJson(path: string): number {
  checkOut("--json", path);
  const rows = allRows();
  const { text, ok } = formatRealism(rows);
  console.log(text);
  const { rows: cells, notes } = realismBlock(rows);
  writeFileSync(path, writeJson({ notes, rows: cells }), { flag: "wx" });
  return ok ? 0 : 1;
}

function runExport(argv: string[]): number {
  const a = checkArgs(argv);
  checkOut("--out", a.out);
  const compare = readCompare(a.compare);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  compareBlocks(compare, a.source, nodeMajor); // every compare-side refusal comes before the 3-minute run
  const realism = realismBlock(allRows());
  writeFileSync(a.out, buildSimulator({ realism, compare, date: a.date, commit: a.commit, source: a.source, nodeMajor }), { flag: "wx" });
  const unexpected = realism.rows.filter((r) => r.verdict === "UNEXPECTED").length;
  if (unexpected === 0) console.log(`export: wrote ${a.out}`);
  else console.error(`export: wrote ${a.out}; ${unexpected} realism rows are UNEXPECTED (the file holds them)`);
  return unexpected === 0 ? 0 : 1;
}

if (isMain(process.argv[1], import.meta.url)) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === undefined) {
    const { text, ok } = formatRealism(allRows());
    console.log(text);
    process.exitCode = ok ? 0 : 1;
  } else if (mode === "export") {
    process.exitCode = runMode("export", () => runExport(rest));
  } else if (mode === "--json" && rest.length === 1) {
    process.exitCode = runMode("realism", () => runJson(rest[0]));
  } else {
    console.error(REALISM_USAGE);
    process.exitCode = 2;
  }
}
