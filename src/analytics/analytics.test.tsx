import { readFileSync, readdirSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { pageFromHash } from "../nav";
import { AnalyticsPage } from "./Analytics";
import { BANNED, FILES, LABEL, load, read, type Kind } from "./data";
import { SectionBoundary } from "./sections";


const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DASH = "kitchen-station/BioSentry-Intelligence";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const env = (section: string, format: number, body: any, repo = DASH) => ({
  format: `biosentry-evaluation/${format}`,
  section,
  provenance: { repo, commit: COMMIT, source: ["cmd"], exporter: { name: "e", version: "1" }, date: "2026-11-13", synthetic: true, validated: false, data: "d", seeds: [{ role: "r", seeds: [1, 2] }] },
  body,
  notes: ["a note"],
});
const frac = { n: 1, d: 2, rate: 0.5 };
const stats = { min: 0.1, median: 0.2, max: 0.3, mean: 0.25, sd: 0.05 };
const arm = { episodes_evaluated: 30, recognised_by_rule: 20, recognised_by_rule_without_new_alert: 4, recognised_by_round: 6, unrecognised_at_leave_or_run_end: 4, recognition_delay_mean_hours: 1.5, recognition_delay_median_hours: 1.25, modelled_excess_bad_outcomes_per_100_episodes: 0.75, alerts: 111, bins_alerting: 55 };
const scored = { complete: true, answers: 9, of: 9, scores: { n: 9, valid_json: 8, exact_of: 7, exact: 6, negatives: 3, refused_ok: 2 } };

const outcome = () => ({
  label: LABEL,
  parameter: { name: "odds_ratio_per_hour", value: 1.02, tag: "cited", applied_to_tag: "assumed", reference: "Ref text", interval_95: [1.01, 1.03], baseline_risk: 0.1, baseline_risk_at_hours: 6, anchor_tag: "anchor" },
  assumption: "ASSUMPTION text",
  recognition_rule: "RULE text",
  seeds: [1, 2, 3],
  arms: { baseline: arm, change: { ...arm, alerts: 222 } },
  difference: { ...arm, alerts: 77, bins_alerting: 33 },
  spread: { modelled_excess_bad_outcomes_per_100_episodes: { seeds_with_value: 20, ...stats }, recognition_delay_mean_hours: { seeds_with_value: 19, ...stats } },
  paired_episodes: { episodes_paired: 20, change_earlier: 10, same_minute: 5, change_later: 5, delay_difference_hours: stats, excess_difference_per_100: stats },
  sensitivity: ["zero", "half", "central", "double"].map((a, i) => ({ assumption: a, odds_ratio_per_hour: 1 + i / 100, baseline: 0.5, change: 0.6, difference: 0.1 })),
  notes: ["outcome note"],
});

const VERDICTS = ["pass", "known miss", "fitted target", "no real comparison", "UNEXPECTED"];
const exportedFixtures = () => ({
  pipeline: env("pipeline", 3, {
    stages: [
      ["news2", "NEWS2 ranking", "live in the ranking", "models"],
      ["baseline", "Baseline", "shown, does not change the ranking", "models"],
      ["reward", "Reward", "research only, offline", "models"],
      ["confidence", "Confidence", "research only, offline", "models"],
      ["prediction", "Prediction", "shown, does not change the ranking", "models"],
      ["agent", "Agent", "research only, offline", "research-agent"],
      ["quality", "Quality", "planned", null],
    ].map(([id, name, state, links_to]) => ({ id, name, state, in: "vitals", out: "score", links_to })),
  }),
  evaluations: env("evaluations", 2, {
    context: { shift_hours: 12, bin_minutes: 15, ci: { level_percent: 95, resamples: 1000, generator_seed: 7, method: "percentile bootstrap" }, trials: 10, patients: 100, patient_days: 300.5, episodes_evaluated: 5, episodes_not_cut_short: 4, control_windows: 3, tuning: "tuned on some seeds" },
    rules: [{ id: "student_x", name: "Rule one", adds_to: "news2", per_shift: { value: 0.348, lo: 0.3, hi: 0.4 }, time_in_alert: frac, new_alert: { ...frac, lo: 0.2, hi: 0.9 }, any_bin: { ...frac, lo: 0.1, hi: 0.8 }, any_bin_not_cut_short: frac, chance_new: { n: 5, d: 6, rate: 0.8 }, chance_any: { n: 7, d: 8, rate: 0.9 }, excess_any_not_cut_short: null, lead: { n: 7, median_minutes: 30.5, q1_minutes: 1, q3_minutes: 2 } }],
    confidence: null,
  }),
  simulator: env(
    "simulator",
    3,
    {
      node_major: 24,
      realism: { rows: VERDICTS.map((verdict, i) => ({ check: `check ${i}`, signal: "hr", statistic: "median", sim: "70", real: "72", tolerance: "5", verdict, real_data: "eicu" })), notes: ["realism note"] },
      compare: {
        mode: "w4_seeds",
        seeds: [1, 2, 3],
        days: 30,
        baseline: "news2_total_ge_5",
        change: "news2_chart_trigger",
        pairing_status: "paired",
        pooled: [{ metric: "alerts_per_patient_per_12h_shift", baseline: 0.3483, change: 0.4119, difference: 0.0636, kind: "d4" }],
        spread: [{ metric: "alerts_per_patient_per_12h_shift", seeds_with_value: 20, ...stats }],
        paired: [{ metric: "episodes_paired", value: 20, kind: "int" }],
        notes: ["compare note"],
      },
      outcome: outcome(),
    },
    "kitchen-station/biosentry-ward-sim",
  ),
  registry: env("registry", 2, {
    datasets: [{ id: "ward-v2", name: "Ward", path: null, licence: "not stated", source: "models/data/ward-v2/card.md" }],
    open_weights: [{ id: "Qwen/Qwen2.5-0.5B-Instruct", name: "Qwen", path: null, licence: "Apache-2.0", source: "models/agent/card.md" }],
  }),
  "research-agent": env("research-agent", 1, {
    ledger: { records: 21, sha256: "ab".repeat(32) },
    questions: [{ id: "S-0014", asked_at: "2026-11-13T05:05:46Z", question: "What if we alert at 7?", template: "news2_threshold", status: "answered", answer: ["line one", "line two"], numbers: ["10"] }],
    proposals: [{ id: "P-0001", action: "set_baseline_params", step: "S-0009", conclusion: "held", state: "applied", approved_by: "someone", approved_at: "2026-11-13T05:05:34Z" }],
    scores: { question_set: "set", n: 4, runs: [{ label: "before", model: "m", answered: 3, refused: 1, grounding_passed: 2, correct_template: 2 }, { label: "after", model: "m", answered: 4, refused: 0, grounding_passed: 3, correct_template: 3 }] },
  }),
});

const fit = (kind: string) => ({ kind, inputs: "trend", width: 32, weight_decay: 0.00001, train_loss_by_epoch: [0.5, 0.4], val_log_loss_by_epoch: [0.6, 0.55] });
const variant = { chosen: { distilled: true, student: { inputs: "trend", width: 32, weight_decay: 0.00001 } }, fits: [{ ...fit("teacher"), width: [256, 256] }, fit("distilled"), fit("hard_label")] };
const sv = { onnx_bytes: 5334, onnx_sha256: "cd".repeat(32), student: { width: 32, parameters: 1185, best_epoch: 7, val_log_loss: 0.018969 } };
const policy = (name: string) => ({
  name, synthetic: true, validated: false, round: 1, chosen_generation: 2, lambda: 0.5, params: { p: 5, theta: 2.9776 }, validation_reward: 0.992414, seeds: { first: 401, last: 500 }, stop_reason: "patience",
  curve: [{ generation: 0, accepted: null, patience: 0, validation_reward: null, winner_selection_mean: null, confirmation_mean_d: null }, { generation: 1, accepted: true, patience: 0, validation_reward: 0.5, winner_selection_mean: 0.6, confirmation_mean_d: 0.1 }],
});
const cal = (v: string) => ({ variant: v, alpha: "0.01", q: 0.0198, t: 0.006, n: 3238, k: 3207, j: 32, days: 30, speed: 60, negative_bins: 1257362, seeds: [301, 302] });

const P = "repo/";
const directFixtures = (): Record<string, unknown> => ({
  "sync.json": { repo: DASH, commit: COMMIT, commit_date: "2026-11-14", files: [] },
  [`${P}models/manifest.json`]: {
    schema: 1,
    generated_by: "python -m research.manifest --write",
    note: "n",
    models: [
      { model: "tier_b/baseline", variant: "all", path: "p", format: "JSON", framework: "none", framework_version: null, bytes: 10, sha256: "ab".repeat(32), run_id: null },
      { model: "tier_b/reward_policy", variant: "all", path: "p", format: "JSON", framework: "none", framework_version: null, bytes: 11, sha256: "ab".repeat(32), run_id: "m2-run" },
      { model: "tier_c/confidence_check", variant: "all", path: "p", format: "JSON", framework: "numpy", framework_version: "2.4.6", bytes: 12, sha256: "ab".repeat(32), run_id: "m3-run" },
      { model: "tier_c/student_vitals", variant: "no_temp", path: "p", format: "ONNX", framework: "MindSpore", framework_version: "2.11.0", bytes: 13, sha256: "ab".repeat(32), run_id: "m1-run" },
    ],
  },
  [`${P}models/tier_b/baseline/params.json`]: { k: "@@4.0", p: 8, chosen_on: "ward-v2 seeds 1-10", grid: { student_decay: "@@1e-05" } },
  [`${P}models/tier_b/reward_policy/policy.json`]: policy("tier_b/reward_policy"),
  [`${P}models/tier_b/reward_policy/no_temperature/policy.json`]: policy("tier_b/reward_policy/no_temperature"),
  [`${P}models/tier_c/confidence_check/calibration.json`]: { ...cal("all"), q: "@@0.019854247570037842" },
  [`${P}models/tier_c/confidence_check/calibration_no_temp.json`]: cal("no_temp"),
  [`${P}models/tier_c/confidence_check/heldout.json`]: { format: "biosentry-held-out/1", confidence: { all: { verdict: "NOT MET" } } },
  [`${P}models/tier_c/student_vitals/metadata.json`]: { name: "tier_c/student_vitals", synthetic: true, validated: false, variants: { all: sv, no_temp: sv } },
  [`${P}training/runs/student_vitals/m1-run.json`]: { model: "tier_c/student_vitals", run_id: "m1-run", framework: "MindSpore", framework_version: "2.11.0", commit: "3d634f3", variants: { all: variant, no_temp: variant } },
  [`${P}training/runs/reward_policy/m2-run.json`]: {
    model: "tier_b/reward_policy",
    run_id: "m2-run",
    runs: [
      {
        name: "round 1",
        generations: [
          { generation: 0, accepted: null, patience: 0, reason: null, validation_reward: null, selection: null, confirmation: null },
          { generation: 1, accepted: true, patience: 0, reason: "better", validation_reward: 0.5, selection: { candidates: 30, candidates_rejected: 2, current_mean: 0.4, current_rejected: false, winner_mean: 0.6 }, confirmation: { n: 12, mean_d: 0.1, stdev_d: 0.2, threshold: 0.05, winner_rejected: false } },
        ],
      },
    ],
    stop: { reason: "no change proposed" },
  },
  [`${P}training/runs/confidence_check/m3-run.json`]: { model: "tier_c/confidence_check", run_id: "m3-run", variants: { all: { binding: true }, no_temp: { binding: false } } },
  [`${P}training/agent/runs/run1.json`]: {
    format_version: 1,
    synthetic: true,
    step_columns: "step, task, tokens, loss, seconds, control loss",
    steps: [[1, "t", 10, 0.5, 2.5, 0.6], [2, "t", 10, 0.4, 2.5, 0.6]],
    evaluations: { question: { matcher: scored, perfect: scored, untuned: scored, tuned: scored }, planner: { perfect: scored, untuned: { complete: false, answers: 3, of: 9 }, tuned: scored } },
  },
  [`${P}training/agent/runs/run1.scores.json`]: { scores: null, notes: [] },
});

/** Every fixture as file text, by path under src/data/evaluation. Placeholders "@@x" become the number token x. */
function allFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, doc] of Object.entries(exportedFixtures())) out[`${name}.json`] = JSON.stringify(doc);
  for (const [path, doc] of Object.entries(directFixtures())) out[path] = JSON.stringify(doc).replace(/"@@([^"]*)"/g, "$1");
  return out;
}

// ---- helpers ----

const html = (files: Record<string, string | undefined>) => renderToStaticMarkup(<AnalyticsPage files={files} />);
const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const text = (h: string) => decode(h.replace(/<[^>]*>/g, " "));
const sections = (h: string) => h.split("<section").slice(1);
const count = (h: string, s: string) => h.split(s).length - 1;
const NUMBER = /(?<![\p{L}\p{N}_.])-?\d+(?:\.\d+)?(?![\p{L}\p{N}_])/gu;
const tokens = (s: string) => (s.match(NUMBER) ?? []).map(Number);
const SYNC = "sync.json";
const TODAY = FILES;

const SECTION_FILES: Record<string, (p: string) => boolean> = {
  Pipeline: (p) => p === "pipeline.json",
  Models: (p) => p.startsWith("repo/") && !p.includes("agent/runs/") || p === "pipeline.json" || p.endsWith("run1.json"),
  Evaluations: (p) => p === "evaluations.json" || p.includes("reward_policy") || p.endsWith("run1.json"),
  Simulator: (p) => p === "simulator.json",
  Registry: (p) => p === "registry.json" || p.endsWith("manifest.json"),
  "Research agent": (p) => p === "research-agent.json",
};

function allowed(files: Record<string, string>, pick: (p: string) => boolean) {
  const set = new Set<number>();
  const visit = (v: unknown) => {
    if (typeof v === "number") set.add(v);
    else if (typeof v === "string") tokens(v).forEach((n) => set.add(n));
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  for (const [p, t] of Object.entries(files)) if (p === SYNC || pick(p)) visit(JSON.parse(t));
  return set;
}

function noTypedNumbers(files: Record<string, string>) {
  const secs = sections(html(files));
  expect(secs).toHaveLength(6);
  for (const s of secs) {
    const title = /<h2>([^<]*)</.exec(s)![1];
    const ok = allowed(files, SECTION_FILES[title]);
    for (const n of tokens(text(s))) expect(ok.has(n), `${title}: ${n}`).toBe(true);
  }
}

const all = () => allFiles();
const exp = () => exportedFixtures();
const dir = () => directFixtures();

// ---- navigation ----

describe("pageFromHash", () => {
  it("opens Analytics only for exactly #analytics", () => {
    expect(pageFromHash("#analytics")).toBe("analytics");
    for (const h of ["", "#", "#simulation", "#Analytics", "#analytics/x"]) expect(pageFromHash(h)).toBe("simulation");
  });
});

describe("the Simulation page stays light", () => {
  const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  it("does not import analytics statically", () => {
    for (const f of ["App.tsx", "main.tsx", "panels.tsx", "nav.tsx"]) expect(src(f).replace(/import\("\.\/analytics\/Analytics"\)/g, "")).not.toMatch(/from "\.\/analytics|from "\.\.\/analytics/);
    expect(src("App.tsx").match(/import\("\.\/analytics\/Analytics"\)/g)).toHaveLength(1);
  });
});

// ---- the page ----

describe("states", () => {
  it("zero files: six sections say not on main yet and show no number", () => {
    const h = html({});
    expect(sections(h)).toHaveLength(6);
    for (const s of sections(h)) expect(text(s)).toContain("not on main yet");
    expect(tokens(text(h))).toEqual([]);
  });

  it("says synthetic, not validated six times in every state", () => {
    const bad = Object.fromEntries(Object.keys(all()).map((p) => [p, "{"]));
    for (const files of [{}, all(), bad, TODAY]) expect(count(html(files), "synthetic, not validated")).toBe(6);
  });

  it("today's copies: some sections have data, some say not on main yet", () => {
    const secs = Object.fromEntries(sections(html(TODAY)).map((s) => [/<h2>([^<]*)</.exec(s)![1], text(s)]));
    expect(secs.Pipeline).toMatch(/not on main yet\s*$/);
    expect(secs.Simulator).toMatch(/not on main yet\s*$/);
    expect(secs.Evaluations).toContain("Context: not on main yet");
    expect(secs.Evaluations).toContain("Generations");
    expect(secs.Models).toContain("tier_c/student_vitals");
    expect(secs.Models).toContain("train loss, last");
    expect(secs.Registry).toContain("Model files");
    expect(secs["Research agent"]).toContain("ledger records");
    expect(secs["Research agent"]).toContain("Scores: not on main yet");
  });

  it("today's copies and the fixtures show no number that is not in a file", () => {
    noTypedNumbers(TODAY);
    noTypedNumbers(all());
  });

  it("shows every block of valid files", () => {
    const h = html(all());
    for (const w of ["Stages", "Rules", "Realism", "Pooled", "Spread over seeds", "Paired episodes", "Sensitivity", "Datasets", "Open weights", "Model files", "Questions", "Proposals", "Before and after", "Policies", "Generations", "Calibration", "Student", "Agent tuning"]) expect(h).toContain(w);
    for (const w of ["pass", "known miss", "fitted target", "no real comparison", "UNEXPECTED"]) expect(h).toContain(`>${w}<`);
    expect(h).toContain(LABEL);
    expect(h.indexOf("MODEL ASSUMPTION")).toBeLessThan(h.indexOf("Sensitivity"));
    expect(h).toContain("6 of"); // none of the fixture's own counts is typed by the page: this is the exact scores row
    expect(h).toContain("not complete");
    expect(h).toContain("agent");
    expect(count(h, LABEL)).toBeGreaterThanOrEqual(5); // the first line and each of the four outcome tables
  });

  it("an outcome figure comes with the alert cost", () => {
    const t = text(html(all()));
    expect(t).toMatch(/alerts\s+111\s+222\s+77/);
    expect(t).toContain("bins alerting");
    expect(t).toMatch(/alert cost.*alerts 77, bins alerting 33/);
  });

  it("null blocks and absent files say not on main yet", () => {
    const e = exp();
    e.simulator.body.outcome = null as never;
    e.simulator.body.realism = null as never;
    e.simulator.body.compare = null as never;
    e["research-agent"].body.scores = null as never;
    const files = { ...all(), "simulator.json": JSON.stringify(e.simulator), "research-agent.json": JSON.stringify(e["research-agent"]) };
    delete (files as Record<string, string | undefined>)["repo/models/tier_c/confidence_check/heldout.json"];
    const t = text(html(files));
    for (const w of ["Outcome: not on main yet", "Realism: not on main yet", "Compare: not on main yet", "Scores: not on main yet", "held-out: not on main yet"]) expect(t).toContain(w);
  });

  it("a bad file shows not on main yet and the other sections still render", () => {
    const secs = sections(html({ ...all(), "pipeline.json": "{" }));
    expect(text(secs[0])).toMatch(/not on main yet\s*$/);
    expect(text(secs[5])).toContain("ledger records");
  });

  it("a direct file with no sync record is missing", () => {
    const files = all();
    delete (files as Record<string, string | undefined>)[SYNC];
    expect(read(files).manifest).toBeNull();
    expect(read(files).registry).not.toBeNull();
  });

  it("prints a direct file's numbers as written, an exported file's as String(n)", () => {
    const t = text(html(all()));
    expect(t).toContain("k 4.0, p 8");
    expect(t).toContain("0.019854247570037842");
    expect(t).toContain("from kitchen-station/BioSentry-Intelligence at");
    expect(t).toContain("2026-11-14"); // sync.json commit_date, for a direct file
    expect(t).toContain("2026-11-13"); // provenance.date, for an exported file
  });

  it("thins a long curve and caps long tables", () => {
    const e = exp();
    e.simulator.body.realism!.rows = Array.from({ length: 200 }, (_, i) => ({ ...e.simulator.body.realism!.rows[0], check: `c${i}` }));
    const run = dir()["repo/training/agent/runs/run1.json"] as { steps: unknown[][] };
    run.steps = Array.from({ length: 500 }, (_, i) => [i, "t", 1, 0.5, 1, 0.5]);
    const h = html({ ...all(), "simulator.json": JSON.stringify(e.simulator), "repo/training/agent/runs/run1.json": JSON.stringify(run) });
    const realism = /<caption>Realism<\/caption>.*?<\/table>/s.exec(h)![0];
    expect(count(realism, "<tr>")).toBe(1 + 50 + 1);
    expect(realism).toContain("more rows not shown");
    expect(h).toContain("curve thinned");
  });
});

// ---- v3.4 ----

describe("data contract v3.4", () => {
  it("D4 names: each policy.json carries its own name", () => {
    const f = all();
    const r = read(f);
    expect(r.rewardAll && r.rewardNo).toBeTruthy();
    const swapped = { ...f, "repo/models/tier_b/reward_policy/no_temperature/policy.json": f["repo/models/tier_b/reward_policy/policy.json"] };
    expect(read(swapped).rewardNo).toBeNull();
  });
  it("D4 run log: the round table reads nested selection and confirmation", () => {
    const t = text(html(all()));
    expect(t).toContain("Selection, winner mean");
    expect(t).toContain("Confirmation sd d");
    expect(read(all()).rewardRun?.v.table.rows[1].slice(5)).toEqual(["0.6", "0.4", "0.1", "0.2", "0.05", "better"]);
    expect(read(all()).rewardRun?.v.table.rows[0].slice(5, 10)).toEqual(Array(5).fill("none")); // generation 0
  });
  it("rules: open ids, at most 30, and confidence is null", () => {
    const e = exp();
    const rule = e.evaluations.body.rules![0];
    e.evaluations.body.rules = Array.from({ length: 30 }, () => rule);
    expect(load("evaluations", JSON.stringify(e.evaluations)).state).toBe("ok");
    e.evaluations.body.rules = Array.from({ length: 31 }, () => rule);
    expect(load("evaluations", JSON.stringify(e.evaluations)).state).toBe("invalid");
    e.evaluations.body.rules = [rule];
    (e.evaluations.body as { confidence: unknown }).confidence = { method: "x", target_percent: 99, rows: [] };
    expect(load("evaluations", JSON.stringify(e.evaluations)).state).toBe("invalid");
  });
  it("D8: absent shows not on main yet; present shows the verdict as written; a wrong format is missing", () => {
    expect(text(html(all()))).toContain("held-out all: NOT MET");
    expect(load("heldOut", JSON.stringify({ format: "biosentry-held-out/2" })).state).toBe("invalid");
    expect(load("heldOut", JSON.stringify({ format: "biosentry-held-out/1", confidence: { all: { verdict: "GUARANTEED" } } })).state).toBe("invalid");
    expect(text(html(TODAY))).toContain("held-out: not on main yet");
  });
  it("registry: the licence may be not stated", () => {
    expect(text(html(all()))).toContain("not stated");
  });
  it("pipeline: NEWS2 and SpO2 are exempt from the no-digit rule in any case", () => {
    const e = exp();
    (e.pipeline.body.stages[0] as { in: string }).in = "news2 and SpO2 and NEWS2";
    expect(load("pipeline", JSON.stringify(e.pipeline)).state).toBe("ok");
    (e.pipeline.body.stages[0] as { in: string }).in = "news3";
    expect(load("pipeline", JSON.stringify(e.pipeline)).state).toBe("invalid");
  });
});

// ---- hostile files ----

describe("hostile files", () => {
  const E = (name: keyof ReturnType<typeof exp>) => exp()[name] as never as Record<string, unknown>;
  const cases: [string, Kind, string][] = [];
  const add = (name: string, kind: Kind, doc: unknown | string) => cases.push([name, kind, typeof doc === "string" ? doc : JSON.stringify(doc)]);
  const kinds: [keyof ReturnType<typeof exp>, Kind][] = [["pipeline", "pipeline"], ["evaluations", "evaluations"], ["simulator", "simulator"], ["registry", "registry"], ["research-agent", "agent"]];
  for (const [name, kind] of kinds) {
    const bump = (d: Record<string, unknown>) => ({ ...d, format: String(d.format).replace(/\d$/, (n) => String(Number(n) + 1)) });
    add(`${name}: format off by one`, kind, bump(E(name)));
    add(`${name}: wrong section`, kind, { ...E(name), section: "other" });
    add(`${name}: synthetic false`, kind, { ...E(name), provenance: { ...(E(name).provenance as object), synthetic: false } });
    add(`${name}: validated true`, kind, { ...E(name), provenance: { ...(E(name).provenance as object), validated: true } });
    add(`${name}: 262145 bytes`, kind, JSON.stringify(E(name)) + " ".repeat(262145));
    add(`${name}: a 10 MB string`, kind, JSON.stringify({ ...E(name), x: "a".repeat(10_000_000) }));
    add(`${name}: depth 11`, kind, { ...E(name), x: JSON.parse("[".repeat(11) + "]".repeat(11)) });
    add(`${name}: 1e999`, kind, JSON.stringify({ ...E(name), x: "@@" }).replace('"@@"', "1e999"));
    add(`${name}: __proto__ holds the envelope`, kind, `{"__proto__": ${JSON.stringify(E(name))}}`);
    add(`${name}: a string over the cap`, kind, { ...E(name), x: "a".repeat(2001) });
  }
  const sim = (f: (b: Record<string, any>) => void) => {
    const e = exp().simulator;
    f(e.body as Record<string, any>);
    return e;
  };
  add("rate as a string", "evaluations", (() => { const e = exp().evaluations; (e.body.rules![0].new_alert as { rate: unknown }).rate = "0.5"; return e; })());
  add("100000 rows", "simulator", sim((b) => (b.realism.rows = new Array(100000).fill(0))));
  add("a printed field 1e-7", "simulator", JSON.stringify(sim((b) => (b.compare.pooled[0].baseline = 1e-7))));
  add("verdict FAIL", "simulator", sim((b) => (b.realism.rows[0].verdict = "FAIL")));
  add("outcome label in lower case", "simulator", sim((b) => (b.outcome.label = "model assumption")));
  add("empty sensitivity", "simulator", sim((b) => (b.outcome.sensitivity = [])));
  add("outcome assumption over 1000", "simulator", sim((b) => (b.outcome.assumption = "a".repeat(1001))));
  add("pipeline in with a digit", "pipeline", (() => { const e = exp().pipeline; (e.body.stages[0] as { in: string }).in = "7 vitals"; return e; })());
  add("13 stages", "pipeline", (() => { const e = exp().pipeline; e.body.stages = Array.from({ length: 13 }, () => e.body.stages[0]); return e; })());
  add("registry path not null", "registry", (() => { const e = exp().registry; (e.body.datasets[0] as { path: unknown }).path = "x"; return e; })());
  add("three scores.runs", "agent", (() => { const e = exp()["research-agent"]; const s = e.body.scores!; s.runs = [s.runs[0], s.runs[1], s.runs[1]] as never; return e; })());
  add("agent answer of 21 lines", "agent", (() => { const e = exp()["research-agent"]; e.body.questions[0].answer = Array(21).fill("x"); return e; })());
  add("outcome not paired with its cost: a missing alerts", "simulator", sim((b) => delete b.outcome.difference.alerts));
  add("policy wrong name", "policy", { ...(dir()["repo/models/tier_b/reward_policy/policy.json"] as object), name: "other" });
  add("manifest bad run_id", "manifest", (() => { const m = dir()["repo/models/manifest.json"] as { models: { run_id: unknown }[] }; m.models[1].run_id = "../x"; return m; })());
  add("calibration q as a string", "calibration", (() => ({ ...(dir()["repo/models/tier_c/confidence_check/calibration.json"] as object), q: "0.5" }))());

  it.each(cases)("%s is invalid", (name, kind, raw) => {
    // calibration and policy take the expected variant or name; the rest ignore it
    const expect_ = kind === "calibration" ? "all" : kind === "policy" ? "tier_b/reward_policy" : "";
    expect(load(kind, raw.replace('"@@4.0"', "4.0").replace('"@@0.019854247570037842"', "0.019854247570037842"), expect_).state, name).toBe("invalid");
  });

  it("keeps 1e-05 in an unread field valid", () => {
    const raw = allFiles()["repo/models/tier_b/baseline/params.json"];
    expect(raw).toContain("1e-05");
    expect(load("baseline", raw).state).toBe("ok");
  });

  it("prints a direct number as written even in exponent form", () => {
    const r = load("calibration", JSON.stringify({ ...(dir()["repo/models/tier_c/confidence_check/calibration.json"] as object), t: "@@" }).replace('"@@"', "1e-05").replace(/"@@([^"]*)"/, "$1"), "all");
    expect(r.state === "ok" && r.view.cells[3]).toBe("1e-05");
  });

  it("escapes markup in every text field", () => {
    const evil = "<img src=x onerror=alert(1)> javascript:alert(1) <script>";
    const files = all();
    // keep the words the checks need; hostile text goes in free-text fields
    const e = exp();
    e.simulator.body.realism!.rows[0] = { check: evil, signal: evil, statistic: evil, sim: evil, real: evil, tolerance: evil, verdict: "pass", real_data: evil };
    e.simulator.body.compare!.notes = [evil];
    e.simulator.body.outcome!.assumption = evil;
    e.simulator.body.outcome!.notes = [evil];
    e.registry.body.datasets[0].name = evil;
    e["research-agent"].body.questions[0].question = evil;
    e["research-agent"].body.questions[0].answer = [evil];
    e["research-agent"].body.proposals[0].conclusion = evil;
    e.evaluations.body.context!.tuning = evil;
    e.pipeline.body.stages[0].name = evil;
    for (const [n, d] of Object.entries(e)) files[`${n}.json`] = JSON.stringify(d);
    const h = html(files);
    expect(h).toContain("&lt;img");
    for (const bad of ["<img", "<script", 'href="javascript']) expect(h).not.toContain(bad);
  });
});

describe("SectionBoundary", () => {
  it("catches with getDerivedStateFromError and renders could not show", () => {
    expect(SectionBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const b = new SectionBoundary({ title: "Pipeline", children: "body" });
    b.state = { failed: true };
    const h = renderToStaticMarkup(<>{b.render()}</>);
    expect(h).toContain("could not show");
    expect(h).toContain("synthetic, not validated");
  });
});

describe("the page's source", () => {
  const files = (d: URL): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(new URL(`${e.name}/`, d)) : [new URL(e.name, d).pathname]));
  it("has no markup injection, link, fetch, eval or rounding", () => {
    const own = [...files(new URL("./", import.meta.url)), new URL("../nav.tsx", import.meta.url).pathname].filter((f) => !/\.test\./.test(f));
    expect(own.length).toBeGreaterThan(3);
    for (const f of own) {
      const src = readFileSync(f, "utf8");
      for (const w of ["dangerouslySetInnerHTML", "innerHTML", "style=", "src=", "fetch(", "eval(", "toFixed", "localStorage"]) expect(src, `${f}: ${w}`).not.toContain(w);
      expect(src.replace(/href="#(simulation|analytics)"/g, "")).not.toContain("href=");
    }
  });
});

describe("words a page must not hold", () => {
  it("rendered text, from fixtures and today's copies, has no banned claim", () => {
    for (const files of [all(), TODAY]) expect(BANNED.test(text(html(files)))).toBe(false);
  });
});
