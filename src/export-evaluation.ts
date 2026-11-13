// The pure part of `npm run export:evaluation`: it maps one realism block and one compare.json to simulator.json.
// No file access, no clock, no git call. It must have no runtime import from src/: `vite build --ssr` inlines every import into
// the one bundle of src/realism.ts, and an inlined src/compare.ts or src/trial.ts would run its own command line there.
import type { RealismBlock } from "./realism";

// Same text as OUTCOME_LABEL in src/compare.ts; the test pins both.
export const OUTCOME_LABEL = "MODEL ASSUMPTION, not evidence about patients";

export class Refusal extends Error {}
const refuse = (message: string): never => {
  throw new Refusal(message);
};

export const USAGE = 'usage: export:evaluation -- --compare FILE --date YYYY-MM-DD --commit HEX40 --source "LINE" --out FILE';
const FLAGS = ["--compare", "--date", "--commit", "--source", "--out"] as const;
const FILE_CAP = 262144;
const SOURCE_START = "npm run compare -- ";
const REALISM_NOTE = "realism: the rows and footer of npm run realism, run by this export at provenance.commit; its seeds are fixed in src/realism.ts and are not listed in seeds";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const chars = (s: string) => [...s].length;

/** Every object's keys sorted, indent 1, one newline at the end: the data contract's write rule. */
export function writeJson(x: unknown): string {
  const sorted = (_: string, v: unknown) => (isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
  return `${JSON.stringify(x, sorted, 1)}\n`;
}

/** The compare file's bytes as text. */
export function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return refuse("--compare: not valid UTF-8 JSON");
  }
}

export interface Args { compare: string; date: string; commit: string; source: string; out: string }

/** The flags after `export`: each once, each with a value. */
export function checkArgs(argv: string[]): Args {
  const got: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!(FLAGS as readonly string[]).includes(flag) || flag in got || value === undefined || value.startsWith("--")) return refuse(USAGE);
    got[flag] = value;
  }
  if (FLAGS.some((f) => !(f in got))) return refuse(USAGE);
  const a: Args = { compare: got["--compare"], date: got["--date"], commit: got["--commit"], source: got["--source"], out: got["--out"] };
  const day = new Date(`${a.date}T00:00:00Z`);
  if (!/^\d{4}-\d\d-\d\d$/.test(a.date) || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== a.date) refuse("--date must be a real date, YYYY-MM-DD");
  if (!/^[0-9a-f]{40}$/.test(a.commit)) refuse("--commit must be 40 lower-case hex characters");
  if (!a.source.startsWith(SOURCE_START)) refuse(`--source must be the compare command line, starting with "${SOURCE_START}"`);
  return a;
}

// ---- shapes. A string is a leaf (text, int, d4, or d4? for a number that may be null; text takes a cap after a colon),
// ---- an array [shape, cap] is a list, an object is a block with exactly those keys.
type Shape = string | [Shape, number] | { [key: string]: Shape };
const STATS: { [key: string]: Shape } = { min: "d4?", median: "d4?", max: "d4?", mean: "d4?", sd: "d4?" };
const OUTCOME_ARM: Shape = {
  episodes_evaluated: "int", recognised_by_rule: "int", recognised_by_rule_without_new_alert: "int", recognised_by_round: "int",
  unrecognised_at_leave_or_run_end: "int", recognition_delay_mean_hours: "d4?", recognition_delay_median_hours: "d4?",
  modelled_excess_bad_outcomes_per_100_episodes: "d4?", alerts: "int", bins_alerting: "int",
};
const OUTCOME_SPREAD: Shape = { seeds_with_value: "int", ...STATS };
const OUTCOME: Shape = {
  label: "text:100",
  parameter: {
    name: "text", value: "d4", tag: "text", applied_to_tag: "text", reference: "text:1200", interval_95: ["d4", 10],
    baseline_risk: "d4", baseline_risk_at_hours: "d4", anchor_tag: "text",
  },
  assumption: "text:1000",
  recognition_rule: "text:1000",
  arms: { baseline: OUTCOME_ARM, change: OUTCOME_ARM },
  difference: OUTCOME_ARM,
  spread: { modelled_excess_bad_outcomes_per_100_episodes: OUTCOME_SPREAD, recognition_delay_mean_hours: OUTCOME_SPREAD },
  paired_episodes: { episodes_paired: "int", change_earlier: "int", same_minute: "int", change_later: "int", delay_difference_hours: STATS, excess_difference_per_100: STATS },
  sensitivity: [{ assumption: "text", odds_ratio_per_hour: "d4", baseline: "d4?", change: "d4?", difference: "d4?" }, 4],
  notes: ["text:1200", 20],
};

// Kinds are fixed by metric name: a metric compare adds later is a contract change, so it is refused here.
const POOLED: Record<string, "int" | "d4"> = {
  alerts: "int", alerts_per_patient_per_12h_shift: "d4", episodes_evaluated: "int", episodes_with_new_alert: "int", episodes_with_new_alert_share: "d4",
  episodes_no_new_alert: "int", episodes_alerting_any_bin: "int", alerts_outside_episode_windows: "int", lead_median_minutes: "d4",
  delay_median_minutes: "d4", bins: "int", bins_alerting: "int",
};
const PAIRED: Record<string, "int" | "d4"> = {
  episodes_with_new_alert_under_both: "int", change_earlier: "int", same_bin: "int", change_later: "int", min: "d4", median: "d4", max: "d4", mean: "d4", sd: "d4",
};
const SPREAD_METRICS = ["lead_median_minutes", "delay_median_minutes", "alerts_per_patient_per_12h_shift", "episodes_with_new_alert_share"];
const SPREAD_ROW: Shape = { seeds_with_value: "int", ...STATS };

const over = (path: string, what: string, n: number, cap: number) => refuse(`${path}: ${n} ${what}, the cap is ${cap}`);

/** An object whose other keys do not matter. */
function obj(v: unknown, path: string): Json {
  if (v === undefined) return refuse(`--compare: ${path} is missing`);
  return isObj(v) ? v : refuse(`--compare: ${path} is not an object`);
}

/** The same keys as `keys`, no more, no fewer. */
function exactKeys(v: unknown, path: string, keys: string[]): Json {
  const o = obj(v, path);
  for (const k of keys) if (!(k in o)) refuse(`--compare: ${path}.${k} is missing`);
  for (const k of Object.keys(o)) if (!keys.includes(k)) refuse(`--compare: ${path}.${k} is an unknown key`);
  return o;
}

/** One number. int must be an integer; d4 must survive round-trip at 4 places, so compare's own rounding is copied, never redone.
 *  Both must be exact in a double: past 2^53 JSON.parse has already changed the number, and the file would hold one no input has. */
function num(v: unknown, path: string, kind: "int" | "d4", nullable: boolean): number | null {
  if (v === undefined) return refuse(`--compare: ${path} is missing`);
  if (v === null && nullable) return null;
  const fits = typeof v === "number" && Number.isFinite(v) && (kind === "int" ? Number.isSafeInteger(v) : Number.isSafeInteger(Math.round(v * 1e4)) && Math.round(v * 1e4) / 1e4 === v);
  return fits ? (v as number) : refuse(`--compare: ${path} is not ${kind === "int" ? "an int" : "a d4 number"}`);
}

/** The copy of v that `shape` describes, or a refusal. */
function copy(v: unknown, shape: Shape, path: string): unknown {
  if (typeof shape === "string") {
    const [kind, cap] = shape.split(":");
    if (kind !== "text") return num(v, path, kind.replace("?", "") as "int" | "d4", kind.endsWith("?"));
    if (v === undefined) return refuse(`--compare: ${path} is missing`);
    if (typeof v !== "string") return refuse(`--compare: ${path} is not text`);
    if (cap && chars(v) > Number(cap)) over(path, "characters", chars(v), Number(cap));
    return v;
  }
  if (Array.isArray(shape)) {
    if (v === undefined) return refuse(`--compare: ${path} is missing`);
    if (!Array.isArray(v)) return refuse(`--compare: ${path} is not a list`);
    if (v.length > shape[1]) over(path, "items", v.length, shape[1]);
    return v.map((x, i) => copy(x, shape[0], `${path}[${i}]`));
  }
  const o = exactKeys(v, path, Object.keys(shape));
  return Object.fromEntries(Object.keys(shape).map((k) => [k, copy(o[k], shape[k], `${path}.${k}`)]));
}

const BANNED = ["ai predicts deterioration", "reinforcement learning", "self-learning", "conformal guarantee", "fewer false alarms than news2"];
// A path that starts at the root or the home folder, or a Windows drive. A slash inside a word (src/sim, 10.1186/s13054) is not one.
const ABSOLUTE = /(^|[\s"'`=(:[,;<|])(\/[^\s/]|~\w*\/)|file:\/\/|\\\\|[A-Za-z]:\\/;

/** Every key and string of x: no banned phrase, no absolute path. "validated" is banned only in a string and only when not "not validated". */
function scan(x: unknown, path: string): void {
  const text = (s: string, isKey: boolean) => {
    const low = s.toLowerCase();
    for (const p of BANNED) if (low.includes(p)) refuse(`banned phrase "${p}" in ${path}`);
    if (!isKey && /(?<!not )validated/i.test(s)) refuse(`banned phrase "validated" in ${path}`);
    if (ABSOLUTE.test(s)) refuse(`an absolute path in ${path}`);
  };
  if (typeof x === "string") text(x, false);
  else if (Array.isArray(x)) x.forEach((v, i) => scan(v, `${path}[${i}]`));
  else if (isObj(x)) for (const [k, v] of Object.entries(x)) {
    const at = path ? `${path}.${k}` : k;
    text(k, true);
    scan(v, at);
  }
}

const SOURCE_FLAGS = ["--seed", "--seeds", "--days", "--baseline", "--change", "--out"];

/** The source line must be one compare would accept (its flags, each once) and must say what compare.json says. --out is not compared. */
function matchSource(source: string, c: { seeds: number[]; days: number; baseline: string; change: string; outcome: boolean }): void {
  const all = source.startsWith(SOURCE_START) ? source.slice(SOURCE_START.length).trim().split(/\s+/) : refuse("--source is not a compare command line");
  const t = all.filter((x) => x !== "--outcome-model");
  const got: Record<string, string> = {};
  for (let i = 0; i < t.length; i += 2) {
    if (!SOURCE_FLAGS.includes(t[i]) || t[i] in got || t[i + 1] === undefined) refuse("--source is not a compare command line: a flag is unknown, repeated, missing or has no value");
    got[t[i]] = t[i + 1];
  }
  if (all.length - t.length > 1 || !("--out" in got)) refuse("--source is not a compare command line: a flag is unknown, repeated, missing or has no value");
  const wrong = (flag: string) => refuse(`--source does not match compare.json: ${flag}`);
  if (got["--seed"] !== String(c.seeds[0])) wrong("--seed");
  if (got["--seeds"] !== String(c.seeds.length) || c.seeds.some((s, i) => s !== c.seeds[0] + i)) wrong("--seeds");
  if (got["--days"] !== String(c.days)) wrong("--days");
  if (got["--baseline"] !== `rule=${c.baseline}`) wrong("--baseline");
  if (got["--change"] !== `rule=${c.change}`) wrong("--change");
  if (all.length - t.length === 1 !== c.outcome) wrong("--outcome-model");
}

export interface Blocks { nodeMajor: number; seeds: number[]; compare: Json; outcome: Json | null }

/** The compare and outcome blocks of one many-seed compare.json. Every check here runs before the slow realism run. */
export function compareBlocks(text: string, source: string, nodeMajor: number): Blocks {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return refuse("--compare: not valid UTF-8 JSON");
  }
  scan(source, "--source");
  if (!isObj(j)) return refuse("--compare: not valid UTF-8 JSON");
  if (j.compare_format !== 1) refuse("--compare: compare_format must be 1");
  if (j.synthetic !== true) refuse("--compare: synthetic must be true");
  if (j.mode !== "w4_seeds") refuse('--compare: mode must be "w4_seeds" (made with --seeds)');
  const seeds = copy(j.seeds, ["int", 100], "seeds") as number[];
  const days = copy(j.days, "int", "days") as number;
  const baseline = copy(j.baseline, "text", "baseline") as string;
  const change = obj(j.change, "change");
  if (change.kind !== "rule") refuse('--compare: change.kind must be "rule"');
  const name = copy(change.name, "text", "change.name") as string;
  const pairing = obj(j.pairing, "pairing");
  const status = copy(pairing.status, "text", "pairing.status") as string;
  matchSource(source, { seeds, days, baseline, change: name, outcome: "outcome_model" in j });
  const major = copy(j.node_major, "int", "node_major") as number;
  if (major !== nodeMajor) refuse(`Node ${nodeMajor} differs from compare.json node_major ${major}`);

  const arms = obj(j.arms, "arms");
  const pooled = Object.keys(POOLED);
  const base = exactKeys(obj(arms.baseline, "arms.baseline").pooled, "arms.baseline.pooled", pooled);
  const chg = exactKeys(obj(arms.change, "arms.change").pooled, "arms.change.pooled", pooled);
  const dif = exactKeys(obj(j.difference, "difference").pooled, "difference.pooled", pooled);
  const spread = exactKeys(j.spread, "spread", SPREAD_METRICS);
  const paired = exactKeys(j.paired_episodes, "paired_episodes", Object.keys(PAIRED));
  const compare = {
    mode: "w4_seeds", seeds, days, baseline, change: name, pairing_status: status,
    pooled: Object.keys(base).map((m) => ({
      metric: m,
      baseline: num(base[m], `arms.baseline.pooled.${m}`, POOLED[m], POOLED[m] === "d4"),
      change: num(chg[m], `arms.change.pooled.${m}`, POOLED[m], POOLED[m] === "d4"),
      difference: num(dif[m], `difference.pooled.${m}`, POOLED[m], POOLED[m] === "d4"),
      kind: POOLED[m],
    })),
    spread: Object.keys(spread).map((m) => ({ metric: m, ...(copy(spread[m], SPREAD_ROW, `spread.${m}`) as Json) })),
    paired: Object.keys(paired).map((m) => ({ metric: m, value: num(paired[m], `paired_episodes.${m}`, PAIRED[m], PAIRED[m] === "d4"), kind: PAIRED[m] })),
    notes: copy(j.notes, ["text:1200", 20], "notes") as string[],
  };
  let outcome: Json | null = null;
  if ("outcome_model" in j) {
    const o = copy(j.outcome_model, OUTCOME, "outcome_model") as Json;
    const rows = o.sensitivity as Json[];
    if (rows.length !== 4 || ["zero", "half", "central", "double"].some((a, k) => rows[k].assumption !== a)) refuse("--compare: outcome_model.sensitivity must hold zero, half, central, double in that order");
    if (o.label !== OUTCOME_LABEL) refuse(`--compare: outcome_model.label is not "${OUTCOME_LABEL}"`);
    outcome = { ...o, seeds };
  }
  scan(compare, "body.compare");
  scan(outcome, "body.outcome");
  return { nodeMajor: major, seeds, compare, outcome };
}

export interface Input { realism: RealismBlock; compare: string; date: string; commit: string; source: string; nodeMajor: number }

/** The text of simulator.json. Throws Refusal; an UNEXPECTED realism row is written as it is. */
export function buildSimulator(i: Input): string {
  const b = compareBlocks(i.compare, i.source, i.nodeMajor);
  const { rows, notes } = i.realism;
  if (rows.length > 200) over("body.realism.rows", "items", rows.length, 200);
  if (notes.length > 10) over("body.realism.notes", "items", notes.length, 10);
  const doc = {
    format: "biosentry-evaluation/3",
    section: "simulator",
    provenance: {
      repo: "kitchen-station/biosentry-ward-sim",
      commit: i.commit,
      source: [i.source, "npm run realism"],
      exporter: { name: "npm run export:evaluation", version: "1" },
      date: i.date,
      synthetic: true,
      validated: false,
      data: "biosentry-ward-sim ward W4 runs and realism checks",
      seeds: [{ role: "compare", seeds: b.seeds }],
    },
    body: { node_major: b.nodeMajor, realism: { rows, notes }, compare: b.compare, outcome: b.outcome },
    notes: [REALISM_NOTE],
  };
  scan(doc, "");
  const text = writeJson(doc);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > FILE_CAP) refuse(`the file is ${bytes} bytes, the cap is ${FILE_CAP}`);
  return text;
}
