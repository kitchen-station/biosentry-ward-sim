/// <reference types="node" />
// Two arms, the same seed (or the same seeds), one difference: `npm run compare -- --seed N [--seeds K] --days N --baseline B --change C --out DIR`.
// Pure functions take strings and objects and return the text of compare.json and compare.txt; the CLI at the bottom only
// reads files and writes the result. It must not import src/trial.ts or src/hospital-trial.ts: their CLI would run inside the bundle.
// Every input check runs before any arm; the pairing checks run after the arms and also refuse. A refusal is one line on stderr and exit 2, and nothing is written.
import { createHash } from "node:crypto";
import { mkdirSync, lstatSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { arbitrate } from "./sim/arbiter";
import { PARAMS } from "./sim/hospital/params";
import { createHospital } from "./sim/hospital/step";
import { MAX_BYTES, parseScenario, ScenarioError, type Scenario } from "./sim/hospital/scenario";
import { LIMITS, runHospitalTrial } from "./sim/hospital/trial";
import { scoreNews2 } from "./sim/news2";
import { runTrial, SCENARIO_V1 } from "./sim/trial";

export class Refusal extends Error {}
const refuse = (message: string): never => { throw new Refusal(message); };
// Echoed text: at most 40 characters, control, format and separator characters shown as "?".
const clean = (text: string) => [...text].slice(0, 40).map((ch) => (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u.test(ch) ? "?" : ch)).join("");

// Both follow BioSentry-Intelligence research/alerts.py and research/events.py. They are a judgement, not a clinical figure.
const REARM_BINS = 16; // quiet bins (4 h) before a patient can alert again
const WINDOW_AFTER_FULL_MIN = 120; // the episode window ends this long after the offset is fully in
const BIN_MIN = 15;

export type CompareFiles = Record<"compare.json" | "compare.txt", string>;
type Json = Record<string, unknown>;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const rows = (csv: string) => csv.trimEnd().split("\n").slice(1).map((l) => l.split(","));
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const share = (n: number, of: number) => (of === 0 ? null : r4(n / of));
/** Median of a sorted list; null when empty. */
const median = (xs: number[]) => (xs.length === 0 ? null : r4(xs.length % 2 ? xs[xs.length >> 1] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2));
const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);

/** Every leaf by dotted path. An array or a null is a leaf. */
function leaves(v: unknown, prefix = ""): Json {
  if (!isObj(v)) return { [prefix]: v };
  return Object.assign({}, ...Object.entries(v).map(([k, x]) => leaves(x, prefix ? `${prefix}.${k}` : k)));
}
/** change minus baseline; null where either side is not a number. */
const diff = (a: unknown, b: unknown): unknown =>
  typeof a === "number" && typeof b === "number" ? r4(b - a)
    : isObj(a) && isObj(b) ? Object.fromEntries(Object.keys({ ...a, ...b }).map((k) => [k, diff(a[k], b[k])])) : null;

interface Report { mode: string; seed: number; seeds?: number[]; spread?: unknown; paired?: Json; outcome?: Outcome; days: number; baseline: unknown; change: { kind: string; name: string; fields: { path: string; baseline: unknown; change: unknown }[] }; pairing: { status: string; same_person_at_each_arrival: boolean; lines: string[] }; arms: { baseline: unknown; change: unknown }; notes: string[] }

function render(r: Report, difference: unknown, nodeMajor: number): CompareFiles {
  const json = { compare_format: 1, synthetic: true, mode: r.mode, seed: r.seed, ...(r.seeds ? { seeds: r.seeds } : {}), days: r.days, node_major: nodeMajor, baseline: r.baseline, change: r.change, pairing: r.pairing, arms: r.arms, difference, ...(r.spread ? { spread: r.spread } : {}), ...(r.paired ? { paired_episodes: r.paired } : {}), ...(r.outcome ? { outcome_model: r.outcome } : {}), notes: r.notes };
  // The Node version is in the JSON only, so the text report reads the same on every Node version.
  const head = r.seeds ? `seeds ${r.seeds[0]} to ${r.seeds[r.seeds.length - 1]} (${r.seeds.length} seeds)` : `seed ${r.seed}`;
  const L = [`compare ${r.seeds ? "w4" : r.mode}: ${head}, ${r.days} days`, `baseline: ${isObj(r.baseline) ? r.baseline.name : r.baseline}`, `change: ${r.change.kind} ${r.change.name}`];
  for (const f of r.change.fields) L.push(`  ${f.path}: ${f.baseline} -> ${f.change}`);
  L.push(`pairing: ${r.pairing.status}`, ...r.pairing.lines.map((l) => `  ${l}`), "");
  const [b, c, d] = [leaves(r.arms.baseline), leaves(r.arms.change), leaves(difference)];
  const all = Object.keys({ ...b, ...c });
  const kind = (p: string) => (Array.isArray(b[p] ?? c[p]) ? "list" : typeof (b[p] ?? c[p]) === "string" ? "text" : "cell");
  const paths = all.filter((p) => kind(p) === "cell"); // the table holds numbers only
  const w = Math.max(...paths.map((p) => p.length), 6);
  const cell = (v: unknown) => (v === null || v === undefined ? "-" : String(v)).padStart(12);
  L.push(`${"metric".padEnd(w)}${"baseline".padStart(14)}${"change".padStart(14)}${"difference".padStart(14)}`);
  for (const p of paths) L.push(`${p.padEnd(w)}  ${cell(b[p])}  ${cell(c[p])}  ${cell(d[p])}`);
  // Lists and fixed wording (a caveat label next to a figure) go under the table, one line per arm.
  for (const p of all.filter((x) => kind(x) !== "cell")) for (const [arm, v] of [["baseline", b[p]], ["change", c[p]]] as const) L.push(`${p} ${arm}: ${(Array.isArray(v) ? v.join(" ") : v) || "-"}`);
  if (isObj(r.spread)) {
    const cols = ["seeds_with_value", "min", "median", "max", "mean", "sd"];
    L.push("", "spread of the per-seed difference (change minus baseline)", `${"metric".padEnd(w)}${cols.map((k) => k.padStart(18)).join("")}`);
    for (const [k, v] of Object.entries(r.spread)) L.push(`${k.padEnd(w)}${cols.map((c) => cell((v as Json)[c]).padStart(18)).join("")}`);
  }
  if (r.paired) {
    L.push("", "same episode under both rules: first new alert of the change rule minus the baseline rule's, in minutes (negative: the change rule warned earlier)");
    for (const [k, v] of Object.entries(r.paired)) L.push(`${k.padEnd(w)}  ${cell(v)}`);
  }
  if (r.outcome) {
    const o = r.outcome;
    const [ob, oc, od, ol, op] = [leaves(o.arms.baseline), leaves(o.arms.change), leaves(o.difference), leaves(o.spread), leaves(o.paired_episodes)];
    const ow = Math.max(...Object.keys({ ...ob, ...ol, ...op }).map((p) => p.length), 6);
    L.push("", o.label, PARAMETER_LINE, ASSUMPTION, RECOGNITION_RULE, `${"metric".padEnd(ow)}${"baseline".padStart(14)}${"change".padStart(14)}${"difference".padStart(14)}`);
    for (const p of Object.keys(ob)) L.push(`${p.padEnd(ow)}  ${cell(ob[p])}  ${cell(oc[p])}  ${cell(od[p])}`);
    const cols = ["seeds_with_value", "min", "median", "max", "mean", "sd"];
    L.push("", "spread of the per-seed difference (change minus baseline)", `${"metric".padEnd(ow)}${cols.map((k) => k.padStart(18)).join("")}`);
    for (const [k, v] of Object.entries(o.spread)) L.push(`${k.padEnd(ow)}${cols.map((c) => cell((v as Json)[c]).padStart(18)).join("")}`);
    L.push("", "same episode under both rules: delay and modelled excess of the change rule minus the baseline rule's (negative: the change rule recognised earlier)");
    for (const [k, v] of Object.entries(op)) L.push(`${k.padEnd(ow)}  ${cell(v)}`);
    L.push("", `${o.label}: sensitivity to the odds ratio per hour (modelled excess per 100 episodes)`, `${"assumption".padEnd(12)}${["odds_ratio_per_hour", "baseline", "change", "difference"].map((k) => k.padStart(20)).join("")}`);
    for (const s of o.sensitivity) L.push(`${s.assumption.padEnd(12)}${[s.odds_ratio_per_hour, s.baseline, s.change, s.difference].map((v) => cell(v).padStart(20)).join("")}`);
    L.push(...o.notes.map((n) => `note: ${n}`));
  }
  L.push("", ...r.notes.map((n) => `note: ${n}`), "synthetic, not validated");
  return { "compare.json": `${JSON.stringify(json, null, 2)}\n`, "compare.txt": `${L.map((l) => l.trimEnd()).join("\n")}\n` };
}

// ---- W4 ----

type Hit = (total: number | null, escalated: boolean) => boolean;
const RULE_USE = "use news2_total_ge_K (K 1 to 20) or news2_chart_trigger";
export function parseRule(text: string): Hit {
  if (text === "news2_chart_trigger") return (_t, escalated) => escalated;
  const k = /^news2_total_ge_([1-9]|1\d|20)$/.exec(text)?.[1];
  return k === undefined ? refuse(`rule: unknown "${clean(text)}"; ${RULE_USE}`) : (t) => t !== null && t >= Number(k);
}

interface Row { id: string; minute: number; total: number | null; escalated: boolean }
/** Re-scores every cohort row from its inputs. A row that disagrees with its own ranked and news2 is a broken pairing. */
export function rescore(cohortCsv: string): Row[] {
  const n = (v: string) => (v === "" ? null : Number(v));
  return rows(cohortCsv).map((c) => {
    const r = scoreNews2({ respiratory_rate: n(c[3]), spo2: n(c[4]), spo2_scale: Number(c[11]) as 1 | 2, supplemental_o2: c[10] === "1", systolic_bp: n(c[6]), heart_rate: n(c[2]), consciousness: c[9] as "A", temperature: n(c[5]) });
    const total = r.kind === "score" ? r.total : null;
    if (c[13] !== (total === null ? "0" : "1") || c[14] !== (total === null ? "" : String(total))) refuse("pairing broken: a cohort row does not re-score to its news2");
    return { id: c[0], minute: Number(c[1]), total, escalated: (d => d.kind === "ranked" && d.escalated)(arbitrate(c[0], r)) };
  });
}

/** Starting patients (admit minute 0) are not evaluated; an episode must start inside the stay and before the trial end. */
const evaluatedOf = (episodes: string[][], days: number) =>
  episodes.filter((e) => Number(e[1]) > 0 && e[5] !== "" && Number(e[5]) >= Number(e[1]) && (e[2] === "" || Number(e[5]) < Number(e[2])) && Number(e[5]) < days * 1440);

/** `firstOut`, when given, receives, for each evaluated episode with a new alert, that first new alert minute by patient, so two arms can be compared episode by episode. */
export function w4Arm(byPatient: Map<string, Row[]>, hit: Hit, episodes: string[][], patientDays: number, days: number, firstOut?: Map<string, number>) {
  const alerts = new Map<string, number[]>();
  const hits = new Map<string, number[]>();
  let bins = 0;
  for (const [id, rs] of byPatient) {
    let armed = true, quiet = 0, last: number | null = null;
    const fired: number[] = [], on: number[] = [];
    // A bin that is not alerting counts toward re-arming; a bin in a gap in the rows is one of them.
    const quietBin = () => { if (!armed && ++quiet >= REARM_BINS) armed = true; };
    for (const r of rs) {
      for (let g = last === null ? 0 : (r.minute - last) / BIN_MIN - 1; g > 0; g -= 1) quietBin();
      last = r.minute;
      bins += 1;
      if (hit(r.total, r.escalated)) {
        on.push(r.minute);
        if (armed) fired.push(r.minute);
        armed = false;
        quiet = 0;
      } else quietBin();
    }
    alerts.set(id, fired);
    hits.set(id, on);
  }
  const evaluated = evaluatedOf(episodes, days);
  const window = new Map(evaluated.map((e) => [e[0], [Number(e[5]), Number(e[5]) + Number(e[6]) + WINDOW_AFTER_FULL_MIN]]));
  const inWin = (id: string, m: number) => { const w = window.get(id); return w !== undefined && m >= w[0] && m <= w[1]; };
  const leads: number[] = [], delays: number[] = [];
  let withNew = 0, withAny = 0;
  for (const e of evaluated) {
    // A stay with no cohort row has no alert, as in the research package.
    const first = (alerts.get(e[0]) ?? []).find((m) => inWin(e[0], m));
    if (first !== undefined) { withNew += 1; leads.push(r4(Number(e[5]) + Number(e[6]) - first)), delays.push(r4(first - Number(e[5]))); firstOut?.set(e[0], first); }
    if ((hits.get(e[0]) ?? []).some((m) => inWin(e[0], m))) withAny += 1;
  }
  leads.sort((a, b) => a - b);
  delays.sort((a, b) => a - b);
  const count = [...alerts.values()].reduce((a, f) => a + f.length, 0);
  return {
    alerts: count,
    alerts_per_patient: share(count, episodes.length),
    alerts_per_patient_per_12h_shift: share(count, patientDays * 2),
    episodes_evaluated: evaluated.length,
    episodes_with_new_alert: withNew,
    episodes_with_new_alert_share: share(withNew, evaluated.length),
    episodes_alerting_any_bin: withAny,
    episodes_alerting_any_bin_share: share(withAny, evaluated.length),
    alerts_outside_episode_windows: [...alerts].reduce((a, [id, f]) => a + f.filter((m) => !inWin(id, m)).length, 0),
    lead_minutes: leads,
    lead_median_minutes: median(leads),
    delay_minutes: delays,
    delay_median_minutes: median(delays),
    episodes_no_new_alert: evaluated.length - withNew,
    bins,
    bins_alerting: [...hits.values()].reduce((a, h) => a + h.length, 0),
  };
}

// ---- outcome model (--outcome-model): arithmetic on cohort.csv and episodes.csv after the run, in the report only ----

const OUTCOME_LABEL = "MODEL ASSUMPTION, not evidence about patients";
const OUTCOME_MIN_SEEDS = 20; // judgement: S3 per-seed lead difference mean 27 min, sd 59; (2 x 59 / 27)^2 = 19.1, so 20
const ODDS_RATIO = 1.02; // cited: Whebell 2021, adjusted OR 1.02 (95% CI 1.0-1.04) per hour
const BASE_RISK_ODDS = 0.274 / 0.726; // cited: Whebell 2021, hospital mortality 27.4% of 632 patients
const BASE_HOURS = 6.3; // cited: Whebell 2021, median time; anchoring the 27.4% at this median is judgement
const ROUND_ZERO_MIN = 720; // cited: NEWS2 Chart 4, RCP 2017, score 0 "minimum 12 hourly"
const ROUND_LOW_MIN = PARAMS.obs.intervalMin.routine.value; // cited: NEWS2 Chart 4, 1-4 "minimum 4-6 hourly", 4 h taken
const ROUND_WATCH_MIN = PARAMS.obs.intervalMin.watch.value; // cited: NEWS2 Chart 4, 5 or more or a 3 in one parameter, "minimum 1 hourly"
const ROUND_CONTINUOUS_MIN = 15; // judgement: "continuous" at 7 or more read as the next 15-minute bin, the data's resolution
const ROUND_UNRANKED_MIN = ROUND_LOW_MIN; // judgement: NOT RANKED or before the first row, the shorter choice, so it lowers delays
const SENSITIVITY: [string, number][] = [["zero", 0], ["half", 0.5], ["central", 1], ["double", 2]]; // judgement: multiples of the log odds ratio
const REFERENCE = `Whebell SF et al., Crit Care 2021;25:226, doi:10.1186/s13054-021-03650-1: adjusted odds ratio 1.02 (95% CI 1.0-1.04) for the time from a first NEWS of 7 or more to critical care admission, which the paper measures in hours (it does not print the words "per hour"); outcome hospital mortality, 27.4% of 632 patients, median time 6.3 h`;
const PARAMETER_LINE = `parameter: odds of a bad outcome multiplied by 1.02 for each hour of recognition delay [cited: ${REFERENCE}]`;
const ASSUMPTION = "under the assumption that each hour from the true start of an episode to its recognition multiplies the odds of a bad outcome by 1.02, as the time from a high NEWS to critical care was associated with hospital mortality in one London cohort; this is an association in other patients, not a measured effect of earlier recognition";
const RECOGNITION_RULE = "recognition = the first 15-minute bin in the episode window where the rule is true, or the next scheduled NEWS2 round, whichever comes first (or the patient leaving, or the run ending)";

/** Risk of a bad outcome after `hours` of recognition delay; s scales the log odds ratio. */
export const riskAt = (s: number, hours: number) => {
  const beta = s * Math.log(ODDS_RATIO);
  const a = Math.log(BASE_RISK_ODDS) - beta * BASE_HOURS;
  return 1 / (1 + Math.exp(-(a + beta * hours)));
};
/** Excess risk over no delay; exactly 0 at s = 0 because both terms are the same number. */
export const excessAt = (s: number, hours: number) => riskAt(s, hours) - riskAt(s, 0);

/** Minutes to the next round, from the patient's latest score. */
const roundInterval = (r: Row | null) =>
  r === null || r.total === null ? ROUND_UNRANKED_MIN : r.total >= 7 ? ROUND_CONTINUOUS_MIN : r.escalated || r.total >= 5 ? ROUND_WATCH_MIN : r.total >= 1 ? ROUND_LOW_MIN : ROUND_ZERO_MIN;

/** Recognition minute of one episode: the earliest of a rule bin in the window, the next round, the patient leaving, the run ending. `rs` is the patient's rows in time order. */
export function recognition(rs: Row[], hit: Hit, e: string[], days: number): { minute: number; how: "rule" | "round" | "left" } {
  const [admit, start] = [Number(e[1]), Number(e[5])];
  const rule = rs.find((r) => r.minute >= start && r.minute <= start + Number(e[6]) + WINDOW_AFTER_FULL_MIN && hit(r.total, r.escalated))?.minute ?? Infinity;
  // Rounds from the admission round; each next round is due after the interval of the score at the last one.
  let round = admit, i = 0;
  while (round < start) {
    while (i + 1 < rs.length && rs[i + 1].minute <= round) i += 1;
    round += roundInterval(rs[i] && rs[i].minute >= admit && rs[i].minute <= round ? rs[i] : null);
  }
  const end = Math.min(e[2] === "" ? Infinity : Number(e[2]), days * 1440);
  const minute = Math.min(rule, round, end);
  return { minute, how: minute === rule ? "rule" : minute === round ? "round" : "left" };
}

interface Rec { delayMin: number; how: "rule" | "round" | "left"; noNew: boolean }
/** One arm of one seed: a record per evaluated episode, in episode order. `first` holds the first new alert minute by patient. */
const recsOf = (byPatient: Map<string, Row[]>, hit: Hit, episodes: string[][], days: number, first: Map<string, number>): Rec[] =>
  evaluatedOf(episodes, days).map((e) => { const r = recognition(byPatient.get(e[0]) ?? [], hit, e, days); return { delayMin: r.minute - Number(e[5]), how: r.how, noNew: !first.has(e[0]) }; });

const per100 = (recs: Rec[], s: number) => (recs.length === 0 ? null : r4((100 * sum(recs.map((x) => excessAt(s, x.delayMin / 60)))) / recs.length));
const meanHours = (recs: Rec[]) => (recs.length === 0 ? null : r4(sum(recs.map((x) => x.delayMin)) / 60 / recs.length));
const outcomeArm = (recs: Rec[]) => ({
  episodes_evaluated: recs.length,
  recognised_by_rule: recs.filter((x) => x.how === "rule").length,
  recognised_by_rule_without_new_alert: recs.filter((x) => x.how === "rule" && x.noNew).length,
  recognised_by_round: recs.filter((x) => x.how === "round").length,
  unrecognised_at_leave_or_run_end: recs.filter((x) => x.how === "left").length,
  recognition_delay_mean_hours: meanHours(recs),
  recognition_delay_median_hours: median(recs.map((x) => x.delayMin / 60).sort((p, q) => p - q)),
  modelled_excess_bad_outcomes_per_100_episodes: per100(recs, 1),
});

interface Outcome { label: string; arms: { baseline: Json; change: Json }; difference: unknown; spread: Json; paired_episodes: Json; sensitivity: { assumption: string; odds_ratio_per_hour: number; baseline: number | null; change: number | null; difference: number | null }[]; notes: string[]; [k: string]: unknown }

/** The outcome block from every seed's records for both arms (same episodes, same order). */
function outcomeModel(runs: { ra: Rec[]; rb: Rec[] }[]): Outcome {
  const [A, B] = [runs.flatMap((r) => r.ra), runs.flatMap((r) => r.rb)];
  const [a, b] = [outcomeArm(A), outcomeArm(B)];
  const spread = { modelled_excess_bad_outcomes_per_100_episodes: spreadOf(runs.map((r) => [per100(r.ra, 1), per100(r.rb, 1)])), recognition_delay_mean_hours: spreadOf(runs.map((r) => [meanHours(r.ra), meanHours(r.rb)])) };
  const pairs = A.map((x, i) => [x, B[i]] as const);
  const dh = pairs.map(([x, y]) => (y.delayMin - x.delayMin) / 60);
  const de = pairs.map(([x, y]) => 100 * (excessAt(1, y.delayMin / 60) - excessAt(1, x.delayMin / 60)));
  const paired = {
    episodes_paired: pairs.length,
    change_earlier: pairs.filter(([x, y]) => y.delayMin < x.delayMin).length,
    same_minute: pairs.filter(([x, y]) => y.delayMin === x.delayMin).length,
    change_later: pairs.filter(([x, y]) => y.delayMin > x.delayMin).length,
    delay_difference_hours: stats(dh),
    excess_difference_per_100: stats(de),
  };
  const sensitivity = SENSITIVITY.map(([assumption, s]) => {
    const [x, y] = [per100(A, s), per100(B, s)];
    return { assumption, odds_ratio_per_hour: r4(ODDS_RATIO ** s), baseline: x, change: y, difference: x === null || y === null ? null : r4(y - x) };
  });
  return {
    label: OUTCOME_LABEL,
    parameter: { name: "odds_ratio_per_hour_of_recognition_delay", value: ODDS_RATIO, tag: "cited", reference: REFERENCE, interval_95: [1.0, 1.04], baseline_risk: 0.274, baseline_risk_at_hours: BASE_HOURS, anchor_tag: "judgement" },
    assumption: ASSUMPTION,
    recognition_rule: RECOGNITION_RULE,
    arms: { baseline: a, change: b },
    difference: diff(a, b),
    spread,
    paired_episodes: paired,
    sensitivity,
    notes: [
      "W4 is a monitored ward in the hospital model, which notices a deterioration there at once; this model instead assumes recognition at the next NEWS2 round when no rule bin comes first",
      "no patient changes: no vital sign is altered and no recovery or outcome is drawn on W4; each figure is a computed expectation per episode, in this report only",
      "W4 episodes are vital-sign offsets fitted from ICU records (eICU), not illnesses with a known risk of a bad outcome",
      "the odds ratio is an observational association in another population (sustained NEWS 7 or more, admitted to critical care, London 2017-2021), timed from a high score to critical care arrival, not from a true onset to recognition",
      `recognised by a round: ${a.recognised_by_round} of ${a.episodes_evaluated} episodes (baseline) and ${b.recognised_by_round} of ${b.episodes_evaluated} (change); left or run ended first: ${a.unrecognised_at_leave_or_run_end} and ${b.unrecognised_at_leave_or_run_end}`,
      `round frequency from NEWS2 Chart 4 (RCP 2017): 12 h at 0, 4 h at 1-4 (band start), 1 h at 5 or more or a 3 in one parameter; "continuous" at 7 or more is taken as the next ${ROUND_CONTINUOUS_MIN}-minute bin and NOT RANKED as ${ROUND_UNRANKED_MIN / 60} h (both judgement)`,
      "the baseline 27.4% at 6.3 h is the cited cohort's own; anchoring it at that median is a modelling step (judgement)",
      "the cited 95% CI 1.0-1.04 runs from the zero row to the double row of the sensitivity table; a difference whose spread crosses zero is not a finding, and at an odds ratio of 1 the difference is exactly zero",
    ],
  };
}

const NOTE_DELAY = "alert delay = first new alert in the window minus episode start (when the rule first flags, not when anyone acts); an episode with no new alert has no delay and is counted, not filled in";
type Arm = ReturnType<typeof w4Arm>;

/** One seed: two runs (the pairing check), then both rules on the first. */
function w4Seed(seed: number, days: number, hitA: Hit, hitB: Hit, trial: typeof runTrial, outcome = false) {
  const run = () => trial({ scenario: { ...SCENARIO_V1, format_version: 1, name: "default" }, seed, days, scenarioSha256: "0".repeat(64), simCommit: "unknown", nodeMajor: nodeMajor() });
  // The rule is applied after the run and never fed back, so the arms share one cohort; the second run proves it is repeatable.
  const [one, two] = [run(), run()];
  const [h1, h2] = [sha(one["cohort.csv"]), sha(one["episodes.csv"])];
  if (h1 !== sha(two["cohort.csv"]) || h2 !== sha(two["episodes.csv"])) refuse("pairing broken: two runs of the same seed differ");
  const byPatient = new Map<string, Row[]>();
  for (const r of rescore(one["cohort.csv"])) byPatient.set(r.id, [...(byPatient.get(r.id) ?? []), r]);
  const episodes = rows(one["episodes.csv"]);
  const patientDays = (JSON.parse(one["summary.json"]) as { patient_days: number }).patient_days;
  const [fa, fb] = [new Map<string, number>(), new Map<string, number>()];
  const [a, b] = [w4Arm(byPatient, hitA, episodes, patientDays, days, fa), w4Arm(byPatient, hitB, episodes, patientDays, days, fb)];
  const [ra, rb] = outcome ? [recsOf(byPatient, hitA, episodes, days, fa), recsOf(byPatient, hitB, episodes, days, fb)] : [[], []];
  return { h1, h2, patientDays, a, b, paired: pairedDiffs(fa, fb), ra, rb };
}

/** For each episode with a new alert under both rules: the change rule's alert minute minus the baseline rule's. */
export const pairedDiffs = (baseline: Map<string, number>, change: Map<string, number>) => [...baseline].flatMap(([id, m]) => (change.has(id) ? [change.get(id)! - m] : []));

const stats = (xs: number[]) => {
  const d = [...xs].sort((p, q) => p - q);
  const mean = d.length === 0 ? null : sum(d) / d.length;
  const sd = d.length < 2 ? null : Math.sqrt(sum(d.map((x) => (x - mean!) ** 2)) / (d.length - 1)); // sample sd
  const n = (v: number | null) => (v === null ? null : r4(v));
  return { min: n(d[0] ?? null), median: median(d), max: n(d[d.length - 1] ?? null), mean: n(mean), sd: n(sd) };
};
/** The same episodes under both rules: how many, which rule was earlier, and the spread of the difference. This is the paired figure; the medians above are over different sets of episodes. */
export const pairedOf = (d: number[]) => ({
  episodes_with_new_alert_under_both: d.length, change_earlier: d.filter((x) => x < 0).length, same_bin: d.filter((x) => x === 0).length, change_later: d.filter((x) => x > 0).length, ...stats(d),
});
const NOTE_PAIRED = "the paired figure is the same episode under both rules, pooled over the seeds of this report (each episode counted once; its sd treats episodes as independent); episodes with a new alert under one rule only are left out (see episodes_with_new_alert); the lead and delay medians of an arm, and their difference column, are over that arm's own alerted episodes, which can differ between arms; alert minutes are 15-minute bins, so each paired difference is a multiple of 15 min";
const NOTE_REARM = "a rule that alerts more can show fewer new alerts in a window: an alert before the window keeps the patient un-armed until 16 quiet bins pass";
const NOTE_NO_OUTCOME = "no outcome is given: the hospital model's late-recognition death rule (obs.excessDeathPerHour, a judgement value) is for unmonitored wards; W4 is monitored, and no one dies on W4";

const W4_NOTES = [
  "the outcome of a warning is not modelled on W4: a staff review does not change vitals and the rule is never fed back into the run, so a rule changes only alerts and their timing",
  "starting patients (admit minute 0) are in the alert burden; their episodes are not evaluated; p-001 has a scripted worsening that is not an episode",
  "lead = fully-in minute minus the first new alert in the window; positive means the alert came before the episode was fully in",
  `alerts re-arm after ${REARM_BINS} bins (4 h) not alerting; window = episode_start to fully in + ${WINDOW_AFTER_FULL_MIN} min (both are judgement values taken from BioSentry-Intelligence research/)`,
  NOTE_DELAY,
];

export function compareW4(seed: number, days: number, baseline: string, change: string, trial = runTrial): CompareFiles {
  const [hitA, hitB] = [parseRule(baseline), parseRule(change)];
  if (baseline === change) refuse("change: same rule as the baseline");
  const { h1, h2, a, b, paired } = w4Seed(seed, days, hitA, hitB, trial);
  return render({
    mode: "w4", seed, days, baseline,
    change: { kind: "rule", name: change, fields: [{ path: "rule", baseline, change }] },
    pairing: {
      status: "one cohort for both arms", same_person_at_each_arrival: true,
      lines: [`one run serves both arms (the rule is applied after it), so the people, arrivals and true episodes are the same; a second run of the same seed gave the same cohort.csv sha256 ${h1} and episodes.csv sha256 ${h2}`],
    },
    arms: { baseline: a, change: b },
    paired: pairedOf(paired),
    notes: [...W4_NOTES, NOTE_PAIRED, NOTE_REARM, NOTE_NO_OUTCOME],
  }, diff(a, b), nodeMajor());
}

/** min, median, max, mean and sample sd of the per-seed differences; a seed with a null on either side is left out. */
export function spreadOf(pairs: [number | null, number | null][]) {
  const d = pairs.flatMap(([x, y]) => (x === null || y === null ? [] : [y - x]));
  // One value is not a spread: nothing but the count is given below two.
  return { seeds_with_value: d.length, ...stats(d.length < 2 ? [] : d) };
}

/** The median over every episode of every seed, not the median of the seeds' medians. */
export const pooledMedian = (lists: number[][]) => median(lists.flat().sort((p, q) => p - q));

/** `--seeds K`: seeds seed .. seed+K-1, each with its own pairing check; any failure refuses the whole run. */
export function compareW4Seeds(seed: number, count: number, days: number, baseline: string, change: string, trial = runTrial, outcome = false): CompareFiles {
  const [hitA, hitB] = [parseRule(baseline), parseRule(change)];
  if (baseline === change) refuse("change: same rule as the baseline");
  const seeds = Array.from({ length: count }, (_, i) => seed + i);
  const runs = seeds.map((s) => w4Seed(s, days, hitA, hitB, trial, outcome));
  const pooled = (arm: "a" | "b") => {
    const arms: Arm[] = runs.map((r) => r[arm]);
    const total = (k: "alerts" | "episodes_evaluated" | "episodes_with_new_alert" | "episodes_no_new_alert" | "episodes_alerting_any_bin" | "alerts_outside_episode_windows" | "bins" | "bins_alerting") => sum(arms.map((x) => x[k]));
    const list = (k: "lead_minutes" | "delay_minutes") => pooledMedian(arms.map((x) => x[k]));
    return {
      alerts: total("alerts"),
      alerts_per_patient_per_12h_shift: share(total("alerts"), sum(runs.map((r) => r.patientDays)) * 2),
      episodes_evaluated: total("episodes_evaluated"),
      episodes_with_new_alert: total("episodes_with_new_alert"),
      episodes_with_new_alert_share: share(total("episodes_with_new_alert"), total("episodes_evaluated")),
      episodes_no_new_alert: total("episodes_no_new_alert"),
      episodes_alerting_any_bin: total("episodes_alerting_any_bin"),
      alerts_outside_episode_windows: total("alerts_outside_episode_windows"),
      lead_median_minutes: list("lead_minutes"),
      delay_median_minutes: list("delay_minutes"),
      bins: total("bins"),
      bins_alerting: total("bins_alerting"),
    };
  };
  const perSeed = (x: Arm) => ({
    episodes_evaluated: x.episodes_evaluated, episodes_with_new_alert: x.episodes_with_new_alert, episodes_no_new_alert: x.episodes_no_new_alert,
    alerts: x.alerts, alerts_per_patient_per_12h_shift: x.alerts_per_patient_per_12h_shift, lead_median_minutes: x.lead_median_minutes, delay_median_minutes: x.delay_median_minutes,
  });
  const arm = (which: "a" | "b") => ({ pooled: pooled(which), ...Object.fromEntries(seeds.map((s, i) => [`seed_${s}`, perSeed(runs[i][which])])) });
  const [a, b] = [arm("a"), arm("b")];
  const metrics = ["lead_median_minutes", "delay_median_minutes", "alerts_per_patient_per_12h_shift", "episodes_with_new_alert_share"] as const;
  return render({
    mode: "w4_seeds", seed, seeds, days, baseline,
    change: { kind: "rule", name: change, fields: [{ path: "rule", baseline, change }] },
    pairing: {
      status: `one cohort for both arms, for each of ${count} seeds`, same_person_at_each_arrival: true,
      lines: [
        `one run per seed serves both arms (the rule is applied after it), so the people, arrivals and true episodes are the same in both arms of a seed; a second run of each seed gave the same cohort.csv and episodes.csv`,
        ...seeds.map((s, i) => `seed ${s}: cohort.csv sha256 ${runs[i].h1}, episodes.csv sha256 ${runs[i].h2}, equal on a second run`),
      ],
    },
    arms: { baseline: a, change: b },
    spread: Object.fromEntries(metrics.map((m) => [m, spreadOf(runs.map((r) => [r.a[m], r.b[m]]))])),
    paired: pairedOf(runs.flatMap((r) => r.paired)),
    outcome: outcome ? outcomeModel(runs) : undefined,
    notes: [
      // With the flag, the first note must not say that no outcome is modelled: the block above is one, as arithmetic on the report.
      ...(outcome ? ["nothing in the run responds to a warning: a staff review does not change vitals and the rule is never fed back into the run; the outcome block above is a labelled model assumption computed from the timing, not something that happens to a patient", ...W4_NOTES.slice(1)] : W4_NOTES),
      NOTE_PAIRED,
      NOTE_REARM,
      "spread is across seeds: each seed is one simulated run of one ward; it says nothing when seeds_with_value is below 2; a difference whose min and max have opposite signs is not a finding, and one whose signs agree is only what this model does",
      ...(outcome ? [] : [NOTE_NO_OUTCOME]), // with the flag the outcome block's own notes say what is and is not modelled
    ],
  }, diff(a, b), nodeMajor());
}

// ---- hospital ----

// Which scenario leaves each group copies from its file. The groups that change who is in the hospital at minute 0, or the arrival clock, are refused.
const GROUPS: Record<string, RegExp> = {
  staffing: /^(er\.(nurses|doctorsDay|doctorsNight)|units\.\w+\.nurses)$/,
  nurses: /^(er\.nurses|units\.\w+\.nurses)$/,
  doctors: /^er\.doctors(Day|Night)$/,
  transferOutAfterH: /^transferOutAfterH$/,
};
const UNPAIRED = ["beds", "startOccupancy", "arrivals"];
function groupTest(group: string): RegExp {
  if (UNPAIRED.includes(group)) refuse(`change: group ${group} is not paired (it changes the minute-0 residents or the arrival clock)`);
  return GROUPS[Object.hasOwn(GROUPS, group) ? group : ""] ?? refuse(`change: unknown group "${clean(group)}"; use staffing, nurses, doctors or transferOutAfterH`);
}

const firstDiff = (x: string[], y: string[]) => { for (let i = 0; i < Math.max(x.length, y.length); i += 1) if (x[i] !== y[i]) return i; return -1; };
const minuteOf = (...r: (string[] | undefined)[]) => Math.min(...r.map((e) => (e ? Number(e[0]) : Infinity)));

/** The pairing facts from two events.csv texts and the two minute-0 resident lists. A broken arrival clock, resident list or course offset refuses. */
export function pairEvents(a: string, b: string, residentsA: string[], residentsB: string[]) {
  const [A, B] = [rows(a), rows(b)];
  const clock = (r: string[][]) => r.filter((e) => (e[4] === "arrive" || e[4] === "turned_away") && Number(e[0]) > 0);
  const [ca, cb] = [clock(A), clock(B)];
  const c = firstDiff(ca.map((e) => e[0]), cb.map((e) => e[0]));
  if (c >= 0) refuse(`pairing broken: arrival minutes differ from minute ${minuteOf(ca[c], cb[c])}`);
  if (residentsA.join() !== residentsB.join()) refuse("pairing broken: the minute-0 residents differ");

  const lines: string[] = [];
  const [pa, pb] = [A.filter((e) => e[4] === "arrive"), B.filter((e) => e[4] === "arrive")];
  const p = firstDiff(pa.map((e) => `${e[0]}:${e[1]}:${e[7]}`), pb.map((e) => `${e[0]}:${e[1]}:${e[7]}`));
  lines.push(p < 0 ? `the same person arrives at each of the ${pa.length} arrival minutes`
    : `same arrival minutes; from minute ${minuteOf(pa[p], pb[p])} the person at ${pa.filter((e, i) => e[1] !== pb[i]?.[1] || e[7] !== pb[i]?.[7]).length} of ${pa.length} arrivals differs (a return or a turned-away arrival depends on the scenario)`);

  const course = (r: string[][]) => {
    const [dec, det] = [new Map<string, number>(), new Map<string, number>()];
    for (const e of r) {
      if (e[4] === "decide_admit") dec.set(`${e[1]}:${e[7]}`, Number(e[0]));
      else if (e[4] === "deteriorate") det.set(`${e[1]}:${e[7]}`, Number(e[0]));
    }
    return { dec, det };
  };
  const [ka, kb] = [course(A), course(B)];
  let same = 0, once = 0, unchecked = 0;
  for (const key of new Set([...ka.det.keys(), ...kb.det.keys()])) {
    if (!ka.det.has(key) || !kb.det.has(key)) once += 1;
    else if (ka.dec.has(key) !== kb.dec.has(key)) refuse(`pairing broken: person ${key.split(":")[0]} has an admit decision in one arm only`);
    else if (ka.dec.has(key)) {
      if (ka.det.get(key)! - ka.dec.get(key)! !== kb.det.get(key)! - kb.dec.get(key)!) refuse(`pairing broken: the course offset from the admit decision differs for person ${key.split(":")[0]}`);
      same += 1;
    } else unchecked += 1; // a minute-0 resident has no admit decision in the run
  }
  lines.push(`deterioration courses seen in both arms: ${same} with an equal offset from the admit decision, ${unchecked} with no admit decision in the run (not checked); courses recorded in one arm only: ${once} (where the person was at onset depends on the scenario)`);

  const e = firstDiff(A.map((r) => r.join(",")), B.map((r) => r.join(",")));
  const at = e < 0 ? null : minuteOf(A[e], B[e]);
  lines.push(at === null ? "event logs identical for the whole run (no differing event)" : `event logs identical before minute ${at}; the first differing event is at minute ${at}`);
  if (at !== null) lines.push(`outcomes after minute ${at} differ by design; cohorts are not identical after it`);
  lines.push("W4 inside the hospital is not paired once placements differ (W4 uses its own fixed seed, drawn in placement order)");
  const what = p < 0 ? "same minute-0 residents, arrival minutes and person at each arrival" : "same minute-0 residents and arrival minutes; the person at some arrivals differs";
  return { status: at === null ? `${what}; no event differs` : `partly paired (${what}; event logs differ from minute ${at})`, same_person_at_each_arrival: p < 0, lines };
}

const MEAN_SKIP = ["hour", "unit"];
function hourlyMeans(csv: string) {
  const [head, ...body] = csv.trimEnd().split("\n").map((l) => l.split(","));
  const out: Record<string, Record<string, number | null>> = {};
  for (const unit of new Set(body.map((r) => r[head.indexOf("unit")]))) {
    const mine = body.filter((r) => r[head.indexOf("unit")] === unit);
    out[unit] = Object.fromEntries(head.flatMap((col, i) => {
      if (MEAN_SKIP.includes(col)) return [];
      const xs = mine.map((r) => r[i]).filter((v) => v !== "").map(Number);
      return [[col, xs.length === 0 ? null : r4(xs.reduce((s, x) => s + x, 0) / xs.length)]];
    }));
  }
  return out;
}

/** Two parsed scenarios and the group that may differ. Every other leaf (name and note aside) must be equal, else it refuses. */
export function compareHospital(seed: number, days: number, a: Scenario, b: Scenario, group: string): CompareFiles {
  const inGroup = groupTest(group);
  const [la, lb] = [leaves(a), leaves(b)];
  for (const k of ["name", "note"]) { delete la[k]; delete lb[k]; }
  const differ = Object.keys(la).filter((k) => la[k] !== lb[k]);
  const outside = differ.filter((k) => !inGroup.test(k));
  if (outside.length > 0) refuse(`change: more than one thing differs (${outside.slice(0, 3).join(", ")})`);
  if (differ.length === 0) refuse(`change: group ${group} has the same values in both files`);

  const [ra, rb] = [runHospitalTrial(seed, a, days), runHospitalTrial(seed, b, days)];
  const pairing = pairEvents(ra.eventsCsv, rb.eventsCsv, createHospital(seed, a).people.map((p) => p.id), createHospital(seed, b).people.map((p) => p.id));
  const arm = (r: typeof ra) => {
    // The run header is already at the top of the report.
    const { scenario: _s, limits: _l, format_version: _f, synthetic: _y, seed: _e, days: _d, warm_up_days: _w, ...summary } = JSON.parse(r.summaryJson);
    return { summary, hourly_means: hourlyMeans(r.hourlyCsv) };
  };
  const [x, y] = [arm(ra), arm(rb)];
  return render({
    mode: "hospital", seed, days, baseline: a,
    change: { kind: "group", name: group, fields: differ.map((path) => ({ path, baseline: la[path], change: lb[path] })) },
    pairing, arms: { baseline: x, change: y },
    notes: [
      "synthetic hospital; the groups compared here keep the same minute-0 residents and the same arrival clock",
      "the effects shown are the simulator's assumptions, not evidence about a real hospital",
      `limits of the hospital model, from its summary.json: ${LIMITS}`,
    ],
  }, diff(x, y), nodeMajor());
}

// ---- command line ----

const nodeMajor = () => Number(process.versions.node.split(".")[0]);
const USAGE = "usage: compare --seed N [--seeds K] --days N --baseline B --change C --out DIR [--outcome-model]";
const FLAGS = ["--seed", "--days", "--baseline", "--change", "--out"]; // required; --seeds is optional

function parseArgs(argv: string[]): Record<string, string> {
  const got: Record<string, string> = {};
  // The one bare flag is taken out first, so it does not shift the pairs after it.
  const bare = argv.filter((x) => x === "--outcome-model").length;
  if (bare > 1) refuse(USAGE);
  if (bare) got["--outcome-model"] = "";
  argv = argv.filter((x) => x !== "--outcome-model");
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === "--change" && argv[i] in got) refuse("exactly one --change is allowed");
    if (![...FLAGS, "--seeds"].includes(argv[i]) || argv[i] in got || i + 1 >= argv.length) refuse(USAGE);
    got[argv[i]] = argv[i + 1];
  }
  if (FLAGS.some((f) => !(f in got))) refuse(USAGE);
  return got;
}
function whole(flag: string, text: string, min: number, max: number): number {
  const n = /^(0|[1-9]\d{0,15})$/.test(text) ? Number(text) : NaN;
  return n >= min && n <= max ? n : refuse(`${flag} must be a whole number from ${min} to ${max}`);
}
const lstatOrNull = (path: string) => { try { return lstatSync(path); } catch { return null; } };

function readScenario(path: string, which: string): Scenario {
  const bad = (why: string) => refuse(`${which}: ${why}`);
  let st: ReturnType<typeof statSync>, buf: Buffer | null = null;
  try {
    st = statSync(path);
    // Only a regular file is read: a pipe or device would hang.
    if (st.isFile() && st.size <= MAX_BYTES) buf = readFileSync(path);
  } catch {
    return bad(`cannot read the scenario file "${clean(path)}"`);
  }
  if (!st.isFile()) bad("the scenario path is not a regular file");
  if (buf === null || buf.length > MAX_BYTES) bad(`scenario: file is over ${MAX_BYTES / 1024} KB`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf!);
  } catch {
    return bad("scenario: not valid UTF-8");
  }
  try {
    return parseScenario(text);
  } catch (e) {
    if (!(e instanceof ScenarioError)) throw e;
    return bad(e.message.split("\n")[0].slice(0, 200).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, "?"));
  }
}

/** Checks everything, runs both arms, and returns where the files go and what they hold. Writes nothing. */
export function compare(argv: string[]): { out: string; files: CompareFiles } {
  const a = parseArgs(argv);
  const seed = whole("--seed", a["--seed"], 0, 2 ** 31 - 1);
  const days = whole("--days", a["--days"], 1, 60);
  const seeds = "--seeds" in a ? whole("--seeds", a["--seeds"], 2, 50) : null;
  if (seeds !== null && seed + seeds - 1 > 2 ** 31 - 1) refuse("--seed plus --seeds runs past 2147483647");
  const out = resolve(a["--out"]);
  const [base, change] = [a["--baseline"], a["--change"]];
  const rules = [base, change].map((t) => t.startsWith("rule="));
  const eq = change.indexOf("=");
  if (rules[0] !== rules[1] || (!rules[1] && eq < 1)) refuse("--baseline and --change must both be rules or a scenario and a group");
  const outcome = "--outcome-model" in a;
  if (outcome && !rules[0]) refuse("--outcome-model is for rule arms only");
  if (outcome && (seeds === null || seeds < OUTCOME_MIN_SEEDS)) refuse(`--outcome-model needs --seeds ${OUTCOME_MIN_SEEDS} or more (one seed, or a few, is noise)`);
  if (seeds !== null && !rules[0]) refuse("--seeds is for rule arms only");
  const group = change.slice(0, eq);
  const inGroup = rules[0] ? null : groupTest(group);
  if (lstatOrNull(out)) refuse("--out exists");
  const parent = lstatOrNull(dirname(out)) && statSync(dirname(out));
  if (!parent) refuse("--out: parent folder does not exist");
  else if (!parent.isDirectory()) refuse("--out: parent is not a folder");
  if (rules[0] && seeds !== null) return { out, files: compareW4Seeds(seed, seeds, days, base.slice(5), change.slice(5), runTrial, outcome) };
  if (rules[0]) return { out, files: compareW4(seed, days, base.slice(5), change.slice(5)) };
  const baseline = readScenario(base, "baseline");
  const other = readScenario(change.slice(eq + 1), "change");
  const arm = structuredClone(baseline);
  for (const [path, v] of Object.entries(leaves(other))) {
    if (!inGroup!.test(path)) continue;
    const keys = path.split(".");
    keys.slice(0, -1).reduce((o, k) => o[k] as Json, arm as unknown as Json)[keys[keys.length - 1]] = v;
  }
  return { out, files: compareHospital(seed, days, baseline, arm, group) };
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

if (isMain(process.argv[1], import.meta.url)) {
  try {
    const { out, files } = compare(process.argv.slice(2));
    mkdirSync(out); // not recursive: the parent was checked, and a folder that appeared since is not overwritten
    try {
      for (const [name, text] of Object.entries(files)) writeFileSync(`${out}/${name}`, text, { flag: "wx" });
    } catch (e) {
      rmSync(out, { recursive: true, force: true });
      throw e;
    }
    console.log(`compare: wrote ${out}`);
  } catch (e) {
    if (e instanceof Refusal) {
      console.error(`compare: ${e.message}`);
      process.exitCode = 2;
    } else {
      console.error(`compare: failed: ${clean((e as Error).message)}`);
      process.exitCode = 1;
    }
  }
}
