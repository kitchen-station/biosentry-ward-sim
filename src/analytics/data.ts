// The developer page reads only the committed copies in src/data/evaluation, as text.
// Every file is checked here. A file that fails is "invalid" and the page shows it as missing.
// The page prints numbers as the file writes them. It never rounds or adds.

const RAW = import.meta.glob<string>(
  [
    "../data/evaluation/{pipeline,evaluations,simulator,registry,research-agent,sync}.json",
    "../data/evaluation/repo/models/manifest.json",
    "../data/evaluation/repo/models/tier_b/baseline/params.json",
    "../data/evaluation/repo/models/tier_b/reward_policy/policy.json",
    "../data/evaluation/repo/models/tier_b/reward_policy/no_temperature/policy.json",
    "../data/evaluation/repo/models/tier_c/confidence_check/calibration.json",
    "../data/evaluation/repo/models/tier_c/confidence_check/calibration_no_temp.json",
    "../data/evaluation/repo/models/tier_c/student_vitals/metadata.json",
    "../data/evaluation/repo/training/runs/student_vitals/*.json",
    "../data/evaluation/repo/training/runs/reward_policy/*.json",
    "../data/evaluation/repo/training/runs/confidence_check/*.json",
    "../data/evaluation/repo/training/agent/runs/run1.json",
    "../data/evaluation/repo/training/agent/runs/run1.scores.json",
  ],
  { eager: true, query: "?raw", import: "default" },
);

/** The copies by path under src/data/evaluation. */
export const FILES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([path, text]) => [path.replace("../data/evaluation/", ""), text]),
);

export const LABEL = "MODEL ASSUMPTION, not evidence about patients";
export const BANNED = /AI predicts deterioration|reinforcement learning|self-learning|conformal guarantee|fewer false alarms than NEWS2|(?<!not )validated/i;

const MAX_BYTES = 262144;
const MAX_STR = 2000; // the largest cap in the data contract (agent answer line, proposal conclusion)
const MAX_ARR = 5000;
const MAX_DEPTH = 10;
const POINTS = 200;

type Obj = Record<string, unknown>;
export type Ctx = { tokens: WeakMap<object, Map<string, string>>; direct: boolean };
export type Cell = string | { code: string } | string[];
export type Table = { caption: string; head: string[]; rows: Cell[][]; lead?: string };
export type Curve = { label: string; ys: (number | null)[]; last: string; thinned: boolean };
export type Prov = { repo: string; commit: string; date: string };

const bad = (why: string): never => {
  throw new Error(why);
};
const own = (o: Obj, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);
const obj = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : bad("not an object"));
const arr = (v: unknown, cap: number): unknown[] => (Array.isArray(v) && v.length <= cap ? v : bad("not an array within its cap"));
// No string the page reads may hold a control, any invisible format character (direction marks, zero-width and tag characters),
// a line separator, a lone surrogate, or a digit that is not 0 to 9 (it would pass for a number the number test cannot see).
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]|(?![0-9])\p{Nd}/u;
const str = (v: unknown, max = MAX_STR): string => (typeof v === "string" && v.length <= max && !UNSAFE.test(v) ? v : bad("not a string within its cap, or it holds a control character"));
const oneOf = <T extends string>(v: unknown, words: readonly T[]): T => (words.includes(v as T) ? (v as T) : bad("not an allowed word"));

/**
 * The text of a number: its token as the file writes it (1e-05, 4.0 in a direct file; 1.0 or 0.4700 from a Python exporter).
 * An exported file must hold its printed numbers in plain form: no exponent, no integer too large to be exact.
 * An engine whose JSON.parse gives no source text (context.source) has no token, so it prints String(value): "4" for 4.0.
 */
function show(c: Ctx, h: object, k: string): string {
  const v = Object.hasOwn(h, k) ? (h as Obj)[k] : undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) bad(`${k} is not a number`);
  const token = c.tokens.get(h)?.get(k);
  const text = token ?? String(v);
  if (!c.direct) {
    if (/e/i.test(text)) bad(`${k} is in exponent form`);
    if (Math.abs(v as number) > Number.MAX_SAFE_INTEGER) bad(`${k} is too large to be exact`);
  }
  return text;
}

export function rd(c: Ctx, h: unknown) {
  const o = obj(h);
  const get = (k: string) => own(o, k);
  return {
    o,
    c,
    get,
    s: (k: string, max?: number) => str(get(k), max),
    sn: (k: string, max?: number) => (get(k) === null ? "none" : str(get(k), max)),
    n: (k: string) => show(c, o, k),
    nn: (k: string) => (get(k) === null ? "none" : show(c, o, k)),
    yn: (k: string) => (get(k) === null ? "none" : get(k) === true ? "yes" : get(k) === false ? "no" : bad("not a boolean")),
    a: (k: string, cap: number) => arr(get(k), cap),
    r: (k: string) => rd(c, get(k)),
    ra: (k: string, cap: number) => arr(get(k), cap).map((x) => rd(c, x)),
    w: <T extends string>(k: string, words: readonly T[]) => oneOf(get(k), words),
  };
}
type Rd = ReturnType<typeof rd>;

const nums = (c: Ctx, a: unknown[]) => a.map((_, i) => show(c, a, String(i)));
const T = (caption: string, head: string[], rows: Cell[][], lead?: string): Table => ({ caption, head, rows, lead });

/** y values for a Sparkline from (holder, key) pairs, thinned to 200 points. */
function curve(c: Ctx, label: string, pts: [object, string][]): Curve {
  const last = pts.length - 1;
  const k = Math.max(1, Math.ceil(last / (POINTS - 1))); // at most POINTS - 1 points before the last
  const kept = pts.length > POINTS ? pts.filter((_, i) => i % k === 0 || i === last) : pts; // the step is never shown
  const ys = kept.map(([h, key]) => {
    const v = (h as Obj)[key];
    if (v === null) return null;
    show(c, h, key);
    return v as number;
  });
  const at = ys.findLastIndex((y) => y !== null);
  return { label, ys, last: at < 0 ? "none" : show(c, kept[at][0], kept[at][1]), thinned: pts.length > POINTS };
}
const listCurve = (c: Ctx, label: string, a: unknown[]) => curve(c, label, a.map((_, i) => [a, String(i)]));

/** JSON.parse that also records each number's source text per (holder, key). */
function parse(raw: string) {
  if (new TextEncoder().encode(raw).length > MAX_BYTES) bad("over 256 KB");
  const tokens = new WeakMap<object, Map<string, string>>();
  // The third reviver argument ({ source }) is not in TypeScript's lib yet, so the function is cast below.
  const reviver = function (this: unknown, key: string, value: unknown, context?: { source?: string }) {
    if (typeof value === "number" && typeof context?.source === "string" && typeof this === "object" && this !== null) {
      let m = tokens.get(this);
      if (!m) tokens.set(this, (m = new Map()));
      m.set(key, context.source);
    }
    return value;
  } as (this: unknown, key: string, value: unknown) => unknown;
  const root: unknown = JSON.parse(raw, reviver);
  walk(root, 0);
  return { root: obj(root), tokens };
}

function walk(v: unknown, depth: number): void {
  if (depth > MAX_DEPTH) bad("too deep");
  if (typeof v === "string") {
    if (v.length > MAX_STR) bad("string too long");
  } else if (typeof v === "number") {
    if (!Number.isFinite(v)) bad("not finite");
  } else if (Array.isArray(v)) {
    if (v.length > MAX_ARR) bad("array too long");
    for (const x of v) walk(x, depth + 1);
  } else if (v !== null && typeof v === "object") {
    for (const x of Object.values(v)) walk(x, depth + 1);
  }
}

// ---- exported files ----

const FORMATS = {
  pipeline: "biosentry-evaluation/3",
  evaluations: "biosentry-evaluation/4",
  simulator: "biosentry-evaluation/3",
  registry: "biosentry-evaluation/2",
  "research-agent": "biosentry-evaluation/1",
} as const;
const REPO = "kitchen-station/BioSentry-Intelligence";
const REPOS = [REPO, "kitchen-station/biosentry-ward-sim"];

function envelope(root: Obj, c: Ctx, name: keyof typeof FORMATS) {
  const r = rd(c, root);
  if (r.s("format") !== FORMATS[name] || r.s("section") !== name) bad("format or section");
  const p = r.r("provenance");
  if (p.get("synthetic") !== true || p.get("validated") !== false) bad("synthetic or validated");
  const commit = p.s("commit", 40);
  const date = p.s("date", 10);
  const repo = oneOf(p.get("repo"), REPOS);
  if (!/^[0-9a-f]{40}$/.test(commit) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) bad("commit or date");
  for (const x of p.a("source", 10)) str(x);
  p.r("exporter").s("name");
  p.r("exporter").s("version");
  p.s("data");
  for (const x of p.ra("seeds", 5)) {
    x.s("role");
    for (const n of x.a("seeds", 100)) if (typeof n !== "number") bad("seed");
  }
  for (const x of r.a("notes", 10)) str(x, 300);
  return { prov: { repo, commit, date }, body: r.r("body") };
}

const exported = <V>(name: keyof typeof FORMATS, view: (body: Rd, c: Ctx) => V) => (root: Obj, c: Ctx) => {
  const { prov, body } = envelope(root, c, name);
  return { prov, ...view(body, c) };
};

const STATES = ["live in the ranking", "shown, does not change the ranking", "research only, offline", "planned"] as const;
const SHOWN_IN = { models: "Models", evaluations: "Evaluations", "research-agent": "Research agent" } as const;

function noDigits(v: unknown): void {
  if (typeof v === "string") {
    if (/\d/.test(v.replace(/news2|spo2/gi, ""))) bad("a digit in the pipeline body");
  } else if (Array.isArray(v)) v.forEach(noDigits);
  else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) (noDigits(k), noDigits(x));
}

const pipeline = exported("pipeline", (body) => {
  noDigits(body.o);
  const stages = body.ra("stages", 12);
  const states = new Map<string, string>();
  const rows = stages.map((s) => {
    const id = s.s("id", 40);
    const state = s.w("state", STATES);
    for (const k of ["in", "out"]) if (s.s(k, 80).length < 1) bad("empty in or out");
    const links = s.get("links_to") === null ? "none" : SHOWN_IN[s.w("links_to", ["models", "evaluations", "research-agent"])];
    states.set(id, state);
    return [s.s("name", 80), state, s.s("in", 80), s.s("out", 80), links];
  });
  return { states, table: T("Stages", ["Stage", "State", "In", "Out", "Shown in"], rows) };
});

const frac = (q: Rd) => `${q.n("n")} of ${q.n("d")}`;
const fracCi = (q: Rd) => `${frac(q)}, ${q.nn("rate")} [${q.nn("lo")}, ${q.nn("hi")}]`;
const ci = (q: Rd) => `${q.nn("value")} [${q.nn("lo")}, ${q.nn("hi")}]`;

const CONF_SOURCE = "models/tier_c/confidence_check/heldout.json";
const d4 = (q: Rd, k: string) => (/\.\d{5}/.test(q.n(k)) ? bad(`${k} has more than 4 decimals`) : q.n(k)); // the exporter rounds to at most 4 decimals
const mean = (q: Rd) => `${d4(q, "mean")} [${d4(q, "lo")}, ${d4(q, "hi")}]`;

/** The rounded copy of the held-out confidence result (v3.6). Every key of ConfidenceVariant is read, so a missing or wrong one makes the file invalid. */
function confidence(x: Rd) {
  const src = x.r("source");
  const path = src.s("path", 100);
  const sha256 = src.s("sha256", 64);
  if (path !== CONF_SOURCE || !/^[0-9a-f]{64}$/.test(sha256)) bad("confidence source");
  const rows = VARIANTS.map((name) => {
    const q = x.r("variants").r(name);
    for (const k of ["alpha", "calibration_sha256", "onnx_sha256"]) q.s(k, 100);
    for (const k of ["q", "t", "spread"]) d4(q, k);
    for (const k of ["j", "k", "n_calibration", "n_stays"]) q.n(k);
    for (const k of ["binding", "conservative"]) q.yn(k);
    for (const k of ["checked_share", "student_share"]) mean(q.r(k));
    const pooled = q.r("pooled");
    const notSure = q.r("not_sure");
    const alerting = q.r("alerting_bins");
    const alerts = q.r("new_alerts");
    const lost = q.r("lost");
    const both = (a: Rd) => `student ${a.n("student")}, checked ${a.n("checked")}`;
    const lostOf = (k: string) => `${k.replace(/_/g, " ")}: any ${lost.r(k).n("any")}, early ${lost.r(k).n("early")}`;
    return [
      name,
      mean(q.r("achieved_error")),
      d4(q, "bound"),
      q.w("verdict", ["MET", "NOT MET"]),
      `bins ${notSure.n("bins")}, of scored bins ${notSure.n("of_scored_bins")}, of student alerting bins ${notSure.n("of_student_alerting_bins")}`,
      both(alerting),
      both(alerts),
      `${lostOf("all")}; ${lostOf("not_cut_short")}`,
      `negative bins ${pooled.n("negative_bins")}, scored bins ${pooled.n("scored_bins")}, above q ${pooled.n("above_q")}, checked ${pooled.n("checked")}, student ${pooled.n("student")}`,
    ];
  });
  const head = ["Variant", "Achieved error [low, high]", "Bound", "Verdict", "Not sure", "Alerting bins", "New alerts", "Lost episodes", "Pooled, context only, not the pre-registered quantity"];
  return { path, sha256, table: T("Confidence check", head, rows) };
}

const evaluations = exported("evaluations", (body) => {
  const context =
    body.get("context") === null
      ? null
      : (() => {
          const x = body.r("context");
          const k = x.r("ci");
          return {
            line: `shift ${x.n("shift_hours")} h, bins ${x.n("bin_minutes")} min, ${k.n("level_percent")}% interval, ${k.n("resamples")} resamples, ${x.n("trials")} trials, ${x.n("patients")} patients, ${x.n("patient_days")} patient days`,
            texts: [k.s("method"), x.s("tuning")],
          };
        })();
  const rules =
    body.get("rules") === null
      ? null
      : T(
          "Rules",
          ["Rule", "Adds to", "Alerts per patient per shift", "New alert", "Any bin", "Chance, new", "Chance, any", "Lead, median min"],
          body.ra("rules", 30).map((x) => [
            x.s("name"),
            x.get("adds_to") === null ? "none" : x.w("adds_to", ["news2"]),
            ci(x.r("per_shift")),
            fracCi(x.r("new_alert")),
            fracCi(x.r("any_bin")),
            frac(x.r("chance_new")),
            frac(x.r("chance_any")),
            `${x.r("lead").nn("median_minutes")} (n ${x.r("lead").n("n")})`,
          ]),
        );
  const conf = body.get("confidence") === null ? null : confidence(body.r("confidence"));
  return { context, rules, confidence: conf };
});

// The metric names compare.json really writes (src/compare.ts); any other name makes the file invalid.
const POOLED = ["alerts", "alerts_per_patient_per_12h_shift", "episodes_evaluated", "episodes_with_new_alert", "episodes_with_new_alert_share", "episodes_no_new_alert", "episodes_alerting_any_bin", "alerts_outside_episode_windows", "lead_median_minutes", "delay_median_minutes", "bins", "bins_alerting"] as const;
const SPREAD = ["lead_median_minutes", "delay_median_minutes", "alerts_per_patient_per_12h_shift", "episodes_with_new_alert_share"] as const;
const PAIRED = ["episodes_with_new_alert_under_both", "change_earlier", "same_bin", "change_later", "min", "median", "max", "mean", "sd"] as const;
const VERDICTS = ["pass", "known miss", "fitted target", "no real comparison", "UNEXPECTED"] as const;
const ARM_KEYS = [
  "episodes_evaluated",
  "recognised_by_rule",
  "recognised_by_rule_without_new_alert",
  "recognised_by_round",
  "unrecognised_at_leave_or_run_end",
  "recognition_delay_mean_hours",
  "recognition_delay_median_hours",
  "modelled_excess_bad_outcomes_per_100_episodes",
  "alerts",
  "bins_alerting",
];
const ASSUMED = ["zero", "half", "central", "double"] as const;
const COUNTS = ["alerts", "bins_alerting"]; // integers in the contract, never null: they are the alert cost
const arm = (a: Rd, k: string) => (COUNTS.includes(k) ? a.n(k) : a.nn(k));
const STAT_KEYS = ["min", "median", "max", "mean", "sd"];
const SPREAD_HEAD = ["Metric", "Seeds with value", "Min", "Median", "Max", "Mean", "SD"];
const notes = (x: Rd, cap: number) => x.a("notes", cap).map((n) => str(n, 1200));

function outcome(o: Rd) {
  const c = o.c;
  const label = o.s("label", 100);
  if (label !== LABEL) bad("outcome label");
  const p = o.r("parameter");
  const interval = p.a("interval_95", 2);
  if (interval.length !== 2) bad("interval_95 is two numbers");
  const assumption = o.s("assumption", 1000);
  const rule = o.s("recognition_rule", 1000);
  const seeds = o.a("seeds", 100);
  const arms = o.r("arms");
  const [base, change, diff] = [arms.r("baseline"), arms.r("change"), o.r("difference")];
  const spread = o.r("spread");
  const paired = o.r("paired_episodes");
  const sens = o.ra("sensitivity", 4);
  if (sens.length !== 4 || sens.some((s, i) => s.get("assumption") !== ASSUMED[i])) bad("sensitivity is zero, half, central, double");
  return {
    label,
    lines: [
      `${p.s("name")} ${p.n("value")} (${p.s("tag")}), applied to ${p.s("applied_to_tag")}`,
      p.s("reference", 1200),
      `interval ${nums(c, interval).join(" to ")}`,
      `baseline risk ${p.n("baseline_risk")} at ${p.n("baseline_risk_at_hours")} h (${p.s("anchor_tag")})`,
      `assumption: ${assumption}`,
      `recognition rule: ${rule}`,
      `seeds ${nums(c, seeds).join(", ")}`,
    ],
    tables: [
      T("Pooled", ["Metric", "Baseline", "Change", "Difference"], ARM_KEYS.map((k) => [k, arm(base, k), arm(change, k), arm(diff, k)]), label),
      T(
        "Spread over seeds",
        SPREAD_HEAD,
        ["modelled_excess_bad_outcomes_per_100_episodes", "recognition_delay_mean_hours"].map((k) => {
          const s = spread.r(k);
          return [k, s.n("seeds_with_value"), ...STAT_KEYS.map((x) => s.nn(x))];
        }),
        label,
      ),
      T(
        "Paired episodes",
        ["Metric", "Value"],
        [
          ...["episodes_paired", "change_earlier", "same_minute", "change_later"].map((k) => [k, paired.n(k)]),
          ...["delay_difference_hours", "excess_difference_per_100"].flatMap((k) => {
            const s = paired.r(k);
            return STAT_KEYS.map((x) => [`${k} ${x}`, s.nn(x)]);
          }),
        ],
        label,
      ),
      T(
        "Sensitivity",
        ["Assumed", "Odds ratio per hour", "Metric", "Baseline", "Change", "Difference"],
        sens.map((s) => [s.w("assumption", ASSUMED), s.n("odds_ratio_per_hour"), "modelled_excess_bad_outcomes_per_100_episodes", s.nn("baseline"), s.nn("change"), s.nn("difference")]),
        label,
      ),
    ],
    cost: `alert cost, change minus baseline: alerts ${diff.n("alerts")}, bins alerting ${diff.n("bins_alerting")}`,
    notes: notes(o, 20),
  };
}
// An outcome figure may appear only in the labelled outcome block, so the other blocks may not word one in their free text.
const OUTCOME_TEXT = /modelled_excess|excess_difference|bad outcomes?\D{0,20}\d/i;
const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v !== null && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
// A compare number must fit the kind its row states: a whole number for int, at most 4 decimals for d4.
const fitsKind = (kind: "int" | "d4", text: string) => text === "none" || (kind === "int" ? /^-?\d+$/ : /^-?\d+(\.\d{1,4})?$/).test(text) || bad(`a number does not fit its kind ${kind}`);
const simulator = exported("simulator", (body, c) => {
  for (const k of ["realism", "compare"]) if (strings(body.get(k)).some((t) => OUTCOME_TEXT.test(t))) bad("outcome wording outside the outcome block");
  const realism =
    body.get("realism") === null
      ? null
      : (() => {
          const x = body.r("realism");
          return {
            table: T(
              "Realism",
              ["Check", "Signal", "Statistic", "Sim", "Real", "Tolerance", "Verdict", "Real data"],
              x.ra("rows", 200).map((q) => [q.s("check"), q.s("signal"), q.s("statistic"), q.s("sim"), q.s("real"), q.s("tolerance"), q.w("verdict", VERDICTS), q.s("real_data")]),
            ),
            notes: notes(x, 10),
          };
        })();
  const compare =
    body.get("compare") === null
      ? null
      : (() => {
          const x = body.r("compare");
          x.w("mode", ["w4_seeds"]);
          const seeds = x.a("seeds", 100);
          const kinds = ["int", "d4"] as const;
          const pooled = x.ra("pooled", 30).map((q) => {
            const kind = q.w("kind", kinds);
            const cells = [q.nn("baseline"), q.nn("change"), q.nn("difference")];
            cells.forEach((t) => fitsKind(kind, t));
            return [q.w("metric", POOLED), ...cells];
          });
          const spread = x.ra("spread", 10).map((q) => [q.w("metric", SPREAD), q.n("seeds_with_value"), ...STAT_KEYS.map((k) => q.nn(k))]);
          const paired = x.ra("paired", 15).map((q) => {
            const value = q.nn("value");
            fitsKind(q.w("kind", kinds), value);
            return [q.w("metric", PAIRED), value];
          });
          return {
            line: `${x.s("baseline")} vs ${x.s("change")}, ${x.n("days")} days, seeds ${nums(c, seeds).join(", ")}, pairing: ${x.s("pairing_status")}`,
            tables: [T("Pooled", ["Metric", "Baseline", "Change", "Difference"], pooled), T("Spread over seeds", SPREAD_HEAD, spread), T("Paired episodes", ["Metric", "Value"], paired)],
            notes: notes(x, 20),
          };
        })();
  const out = body.get("outcome") === null ? null : outcome(body.r("outcome"));
  return { node: body.n("node_major"), realism, compare, outcome: out };
});

const registry = exported("registry", (body) => {
  const entries = (k: string) => body.ra(k, 30).map((e) => (e.get("path") === null ? [e.s("id"), e.s("name"), e.s("licence"), "not committed", e.s("source", 200)] : bad("path is not null")));
  const head = ["Id", "Name", "Licence", "Path", "Source"];
  return { datasets: T("Datasets", head, entries("datasets")), weights: T("Open weights", head, entries("open_weights")) };
});

const agent = exported("research-agent", (body) => {
  const ledger = body.r("ledger");
  const scores =
    body.get("scores") === null
      ? null
      : (() => {
          const x = body.r("scores");
          x.s("question_set", 300);
          const n = x.n("n");
          const runs = x.ra("runs", 2);
          if (runs.length !== 2 || runs[0].get("label") !== "before" || runs[1].get("label") !== "after") bad("scores.runs");
          return T(
            "Before and after",
            ["Run", "Model", "Answered", "Refused", "Grounding passed", "Correct template"],
            runs.map((q) => [q.s("label"), q.s("model", 200), ...["answered", "refused", "grounding_passed", "correct_template"].map((k) => `${q.n(k)} of ${n}`)]),
          );
        })();
  return {
    records: `${ledger.n("records")} ledger records`,
    sha: ledger.s("sha256", 100),
    questions: T(
      "Questions",
      ["Id", "Asked", "Question", "Template", "Status", "Answer"],
      body.ra("questions", 200).map((q) => [
        q.s("id"),
        q.s("asked_at"),
        q.s("question", 500),
        q.w("template", ["news2_threshold", "baseline_vs_news2", "alerts_per_nurse", "none"]),
        q.w("status", ["answered", "refused"]),
        q.a("answer", 20).map((l) => str(l, 2000)),
      ]),
    ),
    proposals: T(
      "Proposals",
      ["Id", "Action", "Step", "State", "Approved by", "Approved at", "Conclusion"],
      body.ra("proposals", 50).map((q) => [
        q.s("id"),
        q.w("action", ["set_baseline_params", "adopt_reward_policy"]),
        q.s("step"),
        q.w("state", ["proposed", "approved", "applied"]),
        q.sn("approved_by", 200),
        q.sn("approved_at"),
        q.s("conclusion", 2000),
      ]),
    ),
    scores,
  };
});

// ---- direct files ----

const RUN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const VARIANTS = ["all", "no_temp"] as const;

const sync = (root: Obj, c: Ctx) => {
  const r = rd(c, root);
  const commit = r.s("commit", 40);
  const date = r.s("commit_date", 10);
  if (!/^[0-9a-f]{40}$/.test(commit) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) bad("sync commit or date");
  for (const f of r.ra("files", 100)) (f.s("path", 300), f.n("bytes"), HEX64.test(f.s("sha256", 64)) || bad("sha256"));
  if (r.get("repo") !== REPO) bad("sync repo");
  return { repo: REPO, commit, date };
};

const manifest = (root: Obj, c: Ctx) => {
  const r = rd(c, root);
  if (r.get("schema") !== 1 || r.get("generated_by") !== "python -m research.manifest --write") bad("manifest");
  const runs = new Map<string, string>(); // the first run_id the manifest names for each model
  const rows = r.ra("models", 50).map((m) => {
    const model = m.s("model");
    const run = m.get("run_id");
    if (run !== null && !RUN_ID.test(str(run, 64))) bad("run_id");
    if (typeof run === "string" && !runs.has(model)) runs.set(model, run);
    const version = m.sn("framework_version");
    return [model, m.s("variant"), m.s("path"), m.s("format"), version === "none" ? m.s("framework") : `${m.s("framework")} ${version}`, m.n("bytes"), { code: m.s("sha256", 64) }, run === null ? "none" : (run as string)];
  });
  return { runs, table: T("Model files", ["Model", "Variant", "Path", "Format", "Framework", "Bytes", "sha256", "Run"], rows) };
};

const baseline = (root: Obj, c: Ctx) => {
  const r = rd(c, root);
  return { line: `k ${r.n("k")}, p ${r.n("p")}`, chosen: `chosen on ${r.s("chosen_on")}` };
};

function claim(r: Rd, name: string, expect: string, key: "run_id" | "variant") {
  if (r.get("model") !== name || r.s(key) !== expect) bad("model or run_id");
}

const studentRun = (root: Obj, c: Ctx, expect: string) => {
  const r = rd(c, root);
  claim(r, "tier_c/student_vitals", expect, "run_id");
  const curves: Curve[] = [];
  for (const v of VARIANTS) {
    const x = r.r("variants").r(v);
    const fits = x.ra("fits", 40);
    const chosen = x.r("chosen");
    const st = chosen.r("student");
    const kind = chosen.get("distilled") === true ? "distilled" : "hard_label";
    const idx = st.get("fit_index");
    const hits = typeof idx === "number" ? [idx].filter((i) => fits[i]?.get("kind") !== "teacher" && fits[i] !== undefined) : fits.map((_, i) => i).filter((i) => ["inputs", "width", "weight_decay"].every((k) => fits[i].get(k) === st.get(k)) && fits[i].get("kind") === kind);
    if (hits.length !== 1) continue; // no single match: no chosen fit is shown
    const fit = fits[hits[0]];
    curves.push(listCurve(c, `${v} train loss`, fit.a("train_loss_by_epoch", MAX_ARR)), listCurve(c, `${v} val log loss`, fit.a("val_log_loss_by_epoch", MAX_ARR)));
  }
  return { line: `${r.s("framework")} ${r.sn("framework_version")}`, commit: r.s("commit", 40), curves };
};

const studentMeta = (root: Obj, c: Ctx) => {
  const r = rd(c, root);
  if (r.get("name") !== "tier_c/student_vitals" || r.get("synthetic") !== true || r.get("validated") !== false) bad("student metadata");
  const rows = VARIANTS.map((v) => {
    const x = r.r("variants").r(v);
    const s = x.r("student");
    return [v, s.n("width"), s.n("parameters"), s.n("best_epoch"), s.n("val_log_loss"), x.n("onnx_bytes"), { code: x.s("onnx_sha256", 64) }];
  });
  return T("Student", ["Variant", "Width", "Parameters", "Best epoch", "Val log loss", "ONNX bytes", "ONNX sha256"], rows);
};

const policy = (root: Obj, c: Ctx, expect: string) => {
  const r = rd(c, root);
  if (r.get("name") !== expect || r.get("synthetic") !== true || r.get("validated") !== false) bad("policy");
  const params = r.r("params");
  const seeds = r.r("seeds");
  const gens = r.ra("curve", MAX_ARR);
  return {
    cells: [r.n("round"), r.n("chosen_generation"), r.n("lambda"), params.n("p"), params.n("theta"), r.n("validation_reward"), `${seeds.n("first")} to ${seeds.n("last")}`, r.s("stop_reason")],
    curve: curve(c, "validation reward", gens.map((g) => [g.o, "validation_reward"])),
  };
};

const rewardRun = (root: Obj, c: Ctx, expect: string) => {
  const r = rd(c, root);
  claim(r, "tier_b/reward_policy", expect, "run_id");
  const rows = r.ra("runs", 5).flatMap((run) => {
    const name = run.s("name", 40);
    return run.ra("generations", 200).map((g): Cell[] => {
      const sel = g.get("selection") === null ? null : g.r("selection"); // null at generation 0
      const con = g.get("confirmation") === null ? null : g.r("confirmation");
      return [name, g.n("generation"), g.yn("accepted"), g.n("patience"), g.nn("validation_reward"), sel?.nn("winner_mean") ?? "none", sel?.nn("current_mean") ?? "none", con?.nn("mean_d") ?? "none", con?.nn("stdev_d") ?? "none", con?.nn("threshold") ?? "none", g.sn("reason", 300)];
    });
  });
  const head = ["Run", "Generation", "Accepted", "Patience", "Validation reward", "Selection, winner mean", "Selection, current mean", "Confirmation mean d", "Confirmation sd d", "Threshold", "Reason"];
  return { line: `run ${expect}: ${r.r("stop").s("reason")}`, table: T("Generations", head, rows) };
};

const calibration = (root: Obj, c: Ctx, expect: string) => {
  const r = rd(c, root);
  const variant = r.w("variant", VARIANTS);
  if (variant !== expect) bad("variant");
  return {
    cells: [variant, r.s("alpha", 20), ...["q", "t", "n", "k", "j", "days", "speed", "negative_bins"].map((k) => r.n(k))],
    seeds: `seeds ${nums(c, r.a("seeds", 100)).join(", ")}`,
  };
};

const confidenceRun = (root: Obj, c: Ctx, expect: string) => {
  const r = rd(c, root);
  claim(r, "tier_c/confidence_check", expect, "run_id");
  return new Map<string, string>(VARIANTS.map((v) => [v, r.r("variants").r(v).yn("binding")]));
};

const agentRun = (root: Obj, c: Ctx) => {
  const r = rd(c, root);
  if (r.get("format_version") !== 1 || r.get("synthetic") !== true) bad("agent run log");
  const cols = r.get("step_columns");
  const text = typeof cols === "string" ? cols : arr(cols, 20).map((x) => str(x)).join(", ");
  const steps = r.a("steps", MAX_ARR).map((row) => arr(row, 10));
  const curves = [curve(c, "loss", steps.map((row) => [row, "3"]))];
  if (text.endsWith(", control loss")) curves.push(curve(c, "control loss", steps.map((row) => [row, "5"])));
  let table: Table | null = null;
  if (r.get("evaluations") !== undefined) {
    const e = r.r("evaluations");
    const arms: [string, Rd][] = [
      ...["matcher", "perfect", "untuned", "tuned"].map((k): [string, Rd] => [k, e.r("question").r(k)]),
      ...["perfect", "untuned", "tuned"].map((k): [string, Rd] => [`planner ${k}`, e.r("planner").r(k)]),
    ];
    table = T(
      "Agent tuning",
      ["Arm", "Exact", "Refused right", "Valid JSON"],
      arms.map(([name, a]): Cell[] => {
        if (a.get("complete") === false) return [name, `${a.n("answers")} of ${a.n("of")}, not complete`, "none", "none"];
        if (a.get("complete") !== true) bad("complete");
        const s = a.r("scores");
        return [name, `${s.n("exact")} of ${s.n("exact_of")}`, `${s.n("refused_ok")} of ${s.n("negatives")}`, `${s.n("valid_json")} of ${s.n("n")}`];
      }),
    );
  }
  return { curves, table };
};

// The scores file only feeds research-agent.json; the page checks it and shows nothing from it.
const agentScores = (root: Obj, c: Ctx) => {
  rd(c, root).get("scores") === undefined && bad("no scores");
  return {};
};

const VIEWS = { pipeline, evaluations, simulator, registry, agent, sync, manifest, baseline, studentRun, studentMeta, policy, rewardRun, calibration, confidenceRun, agentRun, agentScores };
export type Kind = keyof typeof VIEWS;
type ViewOf<K extends Kind> = ReturnType<(typeof VIEWS)[K]>;
const EXPORTED = new Set<Kind>(["pipeline", "evaluations", "simulator", "registry", "agent"]);

export type Loaded<V> = { state: "missing" } | { state: "invalid"; why: string } | { state: "ok"; view: V };

/** Checks one file's text. `expect` is the run_id or variant a run log or calibration must carry. */
export function load<K extends Kind>(kind: K, raw: string | undefined, expect = ""): Loaded<ViewOf<K>> {
  if (raw === undefined) return { state: "missing" };
  try {
    const { root, tokens } = parse(raw);
    const view = (VIEWS[kind] as (r: Obj, c: Ctx, e: string) => unknown)(root, { tokens, direct: !EXPORTED.has(kind) }, expect);
    return { state: "ok", view: view as ViewOf<K> };
  } catch (e) {
    return { state: "invalid", why: String(e) };
  }
}

// ---- what the page reads ----

export type Src<V> = { v: V; line: { path: string } & Prov };
const D = "repo/";
const P = {
  manifest: `${D}models/manifest.json`,
  baseline: `${D}models/tier_b/baseline/params.json`,
  rewardAll: `${D}models/tier_b/reward_policy/policy.json`,
  rewardNo: `${D}models/tier_b/reward_policy/no_temperature/policy.json`,
  calibAll: `${D}models/tier_c/confidence_check/calibration.json`,
  calibNo: `${D}models/tier_c/confidence_check/calibration_no_temp.json`,
  studentMeta: `${D}models/tier_c/student_vitals/metadata.json`,
  agentRun: `${D}training/agent/runs/run1.json`,
};

/** Loads every file the page shows. A missing or invalid file, or a direct file with no sync record, is null. */
export function read(files: Record<string, string | undefined>) {
  const rec = load("sync", files["sync.json"]);
  const s = rec.state === "ok" ? rec.view : null;
  const ex = <K extends Kind>(kind: K, name: string): Src<ViewOf<K>> | null => {
    const r = load(kind, files[`${name}.json`]);
    return r.state === "ok" ? { v: r.view, line: { path: `${name}.json`, ...(r.view as unknown as { prov: Prov }).prov } } : null;
  };
  const dr = <K extends Kind>(kind: K, path: string, expect?: string): Src<ViewOf<K>> | null => {
    const r = s ? load(kind, files[path], expect) : null;
    return r?.state === "ok" ? { v: r.view, line: { path: path.replace(D, ""), repo: s!.repo, commit: s!.commit, date: s!.date } } : null;
  };
  const man = dr("manifest", P.manifest);
  const run = (model: string, folder: string) => {
    const id = man?.v.runs.get(model);
    return id ? `${D}training/runs/${folder}/${id}.json` : "";
  };
  const id = (model: string) => man?.v.runs.get(model) ?? "";
  return {
    pipeline: ex("pipeline", "pipeline"),
    evaluations: ex("evaluations", "evaluations"),
    simulator: ex("simulator", "simulator"),
    registry: ex("registry", "registry"),
    agent: ex("agent", "research-agent"),
    manifest: man,
    baseline: dr("baseline", P.baseline),
    rewardAll: dr("policy", P.rewardAll, "tier_b/reward_policy"),
    rewardNo: dr("policy", P.rewardNo, "tier_b/reward_policy/no_temperature"),
    rewardRun: dr("rewardRun", run("tier_b/reward_policy", "reward_policy"), id("tier_b/reward_policy")),
    calibAll: dr("calibration", P.calibAll, "all"),
    calibNo: dr("calibration", P.calibNo, "no_temp"),
    confRun: dr("confidenceRun", run("tier_c/confidence_check", "confidence_check"), id("tier_c/confidence_check")),
    studentMeta: dr("studentMeta", P.studentMeta),
    studentRun: dr("studentRun", run("tier_c/student_vitals", "student_vitals"), id("tier_c/student_vitals")),
    agentRun: dr("agentRun", P.agentRun),
  };
}
export type Data = ReturnType<typeof read>;
