import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compare, compareHospital, compareW4, compareW4Seeds, excessAt, pairedDiffs, pairedOf, pairEvents, pooledMedian, parseRule, recognition, Refusal, rescore, riskAt, spreadOf, w4Arm } from "./compare";
import { PARAMS } from "./sim/hospital/params";
import { parseScenario } from "./sim/hospital/scenario";
import { scoreNews2 } from "./sim/news2";
import { LIMITS } from "./sim/hospital/trial";
import { COHORT_HEADER, EPISODES_HEADER, runTrial, SCENARIO_V1 } from "./sim/trial";

const SCEN = "scenarios/hospital/typical.json";
const DOH = "scenarios/hospital/doh-standard.json";
let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "compare-")); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const args = (seed: number, days: number, baseline: string, change: string, out = join(root, "never")) =>
  ["--seed", String(seed), "--days", String(days), "--baseline", baseline, "--change", change, "--out", out];
const w4 = (days = 3) => args(4, days, "rule=news2_total_ge_5", "rule=news2_chart_trigger");
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

// Without --outcome-model every report must stay byte-identical to the one the code at f1c044a wrote.
// These are sha256 hashes taken at f1c044a, before compare.ts was changed, of compare.json and compare.txt for
//   a: --seed 4 --days 3, b: --seed 4 --seeds 2 --days 7 (both rule=news2_total_ge_5 against rule=news2_chart_trigger),
//   c: --seed 101 --days 1, typical.json against nurses=doh-standard.json.
// compare.json holds node_major, so its hash is over the text with that one line removed; compare.txt holds no Node version.
const PINS: Record<string, [string, string]> = {
  a: ["a33cccf5bc0a69e9daa4537f0073d5dd231cb57c4630bd9796c4df77a12620ea", "24f6d7e7a39236eaa2d201b10aca01307f6d7e3ab8a4b2632f4bfd0a00728f4d"],
  b: ["e9c631b3db74f2b7b8419b4e19e891598c677d269d20d4dba732e46691962342", "dc88618aeca746dc212d390cdbd4e46b3b45044807ee7dbeaea0407f1dd55dd6"],
  c: ["260e61180cda4b9f69d3775bf8b4d8e05ece3804f0a391e07195fbf4cedb3f25", "bb854b87274fd16ed3ecf7c56665d1dddc28441d37aa39a469171b9bbc41228f"],
};
const pinOf = (f: { "compare.json": string; "compare.txt": string }) => [sha(f["compare.json"].replace(/^ *"node_major": \d+,\n/m, "")), sha(f["compare.txt"])];

describe("W4 compare", () => {
  let first: ReturnType<typeof compare>["files"];
  beforeAll(() => { first = compare(w4()).files; }, 120_000);

  it("is byte-identical on a rerun, keeps its keys in order, and holds no path or name", { timeout: 120_000 }, () => {
    expect(compare(w4()).files).toEqual(first);
    expect(pinOf(first)).toEqual(PINS.a);
    const j = JSON.parse(first["compare.json"]);
    expect(Object.keys(j)).toEqual(["compare_format", "synthetic", "mode", "seed", "days", "node_major", "baseline", "change", "pairing", "arms", "difference", "paired_episodes", "notes"]);
    // Seed 4, 3 days: the one episode gets its first new alert in the same bin under both rules.
    expect(j.paired_episodes).toEqual({ episodes_with_new_alert_under_both: 1, change_earlier: 0, same_bin: 1, change_later: 0, min: 0, median: 0, max: 0, mean: 0, sd: null });
    expect(Object.keys(j.arms)).toEqual(["baseline", "change"]);
    // Checked by hand against this trial's cohort.csv and episodes.csv with the research package's rules.
    expect(j.arms.baseline).toMatchObject({
      alerts: 30, alerts_per_patient_per_12h_shift: 0.4103, episodes_evaluated: 1, episodes_with_new_alert: 1,
      alerts_outside_episode_windows: 29, lead_minutes: [-16.3637], lead_median_minutes: -16.3637, bins: 3498, bins_alerting: 840,
    });
    expect(j.arms.change).toMatchObject({ alerts: 32, alerts_outside_episode_windows: 31, bins: 3498, bins_alerting: 979 });
    expect(j.difference).toMatchObject({ alerts: 2, bins_alerting: 139, lead_minutes: null });
    expect(first["compare.txt"]).toContain("\nlead_minutes baseline: -16.3637\nlead_minutes change: -16.3637\n");
    expect(first["compare.txt"]).not.toMatch(/^lead_minutes {2,}/m); // a list is not a table row
    expect(j.pairing.status).toBe("one cohort for both arms");
    expect(j.notes[0]).toMatch(/^the outcome of a warning is not modelled on W4: /);
    expect(j.notes.at(-1)).toMatch(/^no outcome is given: /); // the single-seed report prints delays, so it says this too
    expect(first["compare.txt"].trimEnd().endsWith("synthetic, not validated")).toBe(true);
    expect(first["compare.txt"].split("\n")[0]).toBe("compare w4: seed 4, 3 days"); // the Node version is in the JSON only
    expect(j.node_major).toBe(Number(process.versions.node.split(".")[0]));
    for (const f of Object.values(first)) {
      expect(f).not.toContain(process.cwd());
      expect(f).not.toContain(".json\"");
      expect(f).not.toContain("scenarios/");
    }
  });

  it("pairs on the same cohort a direct trial writes", { timeout: 120_000 }, () => {
    const direct = runTrial({ scenario: { ...SCENARIO_V1, format_version: 1, name: "default" }, seed: 4, days: 3, scenarioSha256: "0".repeat(64), simCommit: "unknown", nodeMajor: Number(process.versions.node.split(".")[0]) });
    const line: string = JSON.parse(first["compare.json"]).pairing.lines[0];
    expect(line).toContain(`cohort.csv sha256 ${sha(direct["cohort.csv"])} and episodes.csv sha256 ${sha(direct["episodes.csv"])}`);
  });
});

describe("W4 alert rules, on hand-made rows", () => {
  const hit = parseRule("news2_total_ge_5");
  const patient = (id: string, hits: number[], minutes: number[]) => [id, minutes.map((minute) => ({ id, minute, total: hits.includes(minute) ? 5 : 0, escalated: false }))] as const;
  const every15 = (from: number, to: number) => Array.from({ length: (to - from) / 15 + 1 }, (_, i) => from + 15 * i);

  it("re-arms after 16 quiet bins, counts a gap as quiet, and measures the lead to fully in", () => {
    const rowsBy = new Map([
      patient("n-1", [30, 270], every15(15, 270)), // 15 quiet bins between: the second hit does not fire
      patient("n-2", [30, 285], every15(15, 285)), // 16 quiet bins between: it fires again
      patient("n-3", [30, 285], [30, 285]), // 16 missing bins between: it fires again
    ]);
    const episodes = [
      ["n-1", "10", "", "", "respiratory", "100", "50"], // window 100 to 270, its end included: alerting at 270, but no new alert
      ["n-2", "10", "", "", "respiratory", "200", "100"], // fully in at 300, new alert at 285: lead 15
      ["p-1", "0", "", "", "respiratory", "50", "60"], // a starting patient is not evaluated
    ];
    expect(w4Arm(rowsBy, hit, episodes, 2.5, 1)).toEqual({
      alerts: 5, alerts_per_patient: 1.6667, alerts_per_patient_per_12h_shift: 1,
      episodes_evaluated: 2, episodes_with_new_alert: 1, episodes_with_new_alert_share: 0.5,
      episodes_alerting_any_bin: 2, episodes_alerting_any_bin_share: 1,
      alerts_outside_episode_windows: 4, lead_minutes: [15], lead_median_minutes: 15, bins: 39, bins_alerting: 6, // 18 + 19 + 2 rows
      // n-2: first new alert 285, episode start 200: delay 85 (and 85 + lead 15 = ramp 100); n-1 has no new alert, so no delay and one episode counted in no_new_alert.
      delay_minutes: [85], delay_median_minutes: 85, episodes_no_new_alert: 1,
    });
  });

  it("refuses a cohort row that does not re-score to its own news2, and two runs that differ", () => {
    const row = "n-0001,15,80,16,97,37,120,80,10,A,0,1,100,1,";
    expect(rescore(`${COHORT_HEADER}\n${row}0\n`)).toEqual([{ id: "n-0001", minute: 15, total: 0, escalated: false }]);
    expect(() => rescore(`${COHORT_HEADER}\n${row}3\n`)).toThrow(/^pairing broken: a cohort row does not re-score to its news2$/);
    let n = 0;
    const drifting = () => ({ "manifest.json": "", "cohort.csv": `${COHORT_HEADER}\n${n++ ? `${row}0\n` : ""}`, "episodes.csv": `${EPISODES_HEADER}\n`, "summary.json": '{"patient_days":1}' });
    expect(() => compareW4(4, 1, "news2_total_ge_5", "news2_chart_trigger", drifting)).toThrow(/^pairing broken: two runs of the same seed differ$/);
  });
});

describe("W4 recognition delay and spread", () => {
  const hit = parseRule("news2_total_ge_5");
  const at = (id: string, minutes: number[]) => [id, minutes.map((minute) => ({ id, minute, total: 5, escalated: false }))] as const;

  it("delay is the first new alert minus start, and delay + lead is the ramp", () => {
    // e-1 starts 100, ramp 60, window 100..280; alert at 130: delay 30, lead 30. e-2 starts 100, ramp 40; alert at 100: delay 0, lead 40. e-3 has no row: no new alert.
    const rowsBy = new Map([at("e-1", [130]), at("e-2", [100])]);
    const eps = [["e-1", "10", "", "", "x", "100", "60"], ["e-2", "10", "", "", "x", "100", "40"], ["e-3", "10", "", "", "x", "100", "40"]];
    const first = new Map<string, number>();
    const arm = w4Arm(rowsBy, hit, eps, 1, 1, first);
    expect([...first]).toEqual([["e-1", 130], ["e-2", 100]]); // each episode's first new alert, for the paired figure
    expect(arm.delay_minutes).toEqual([0, 30]);
    expect(arm.lead_minutes).toEqual([30, 40]);
    expect(arm.delay_median_minutes).toBe(15);
    expect(arm.episodes_no_new_alert).toBe(1);
    expect(arm.episodes_evaluated - arm.episodes_with_new_alert).toBe(1);
  });

  it("spread: min, median, max, mean, sample sd; one value gives null sd; a null on either side is left out", () => {
    // differences 1, 2, 4, 9: min 1, median (2+4)/2 = 3, max 9, mean 16/4 = 4, sd = sqrt((9+4+0+25)/3) = sqrt(12.6667) = 3.5590
    expect(spreadOf([[0, 1], [1, 3], [2, 6], [0, 9]])).toEqual({ seeds_with_value: 4, min: 1, median: 3, max: 9, mean: 4, sd: 3.559 });
    expect(spreadOf([[1, 3]])).toEqual({ seeds_with_value: 1, min: null, median: null, max: null, mean: null, sd: null }); // one value is not a spread
    // pooled over episodes: 10, 20, 30, 40 gives 25; the median of the seeds' own medians would be 20
    expect(pooledMedian([[10], [20, 30, 40]])).toBe(25);
    expect(pooledMedian([[], []])).toBeNull();
    expect(spreadOf([[1, 3], [null, 5], [2, null], [0, 4]])).toMatchObject({ seeds_with_value: 2, min: 2, max: 4, mean: 3 });
    expect(spreadOf([[null, 1]])).toEqual({ seeds_with_value: 0, min: null, median: null, max: null, mean: null, sd: null });
  });

  it("paired: the same episode under both rules, change minus baseline", () => {
    // e-1: 130 then 100, so the change rule is 30 minutes earlier. e-2: same bin. e-3 alerted under one rule only: not paired.
    const d = pairedDiffs(new Map([["e-1", 130], ["e-2", 100], ["e-3", 200]]), new Map([["e-1", 100], ["e-2", 100], ["e-4", 50]]));
    expect(d).toEqual([-30, 0]);
    // -30, 0, 45: mean 5, sd = sqrt((35^2 + 5^2 + 40^2) / 2) = sqrt(1425) = 37.7492
    expect(pairedOf([...d, 45])).toEqual({ episodes_with_new_alert_under_both: 3, change_earlier: 1, same_bin: 1, change_later: 1, min: -30, median: 0, max: 45, mean: 5, sd: 37.7492 });
    expect(pairedOf([])).toEqual({ episodes_with_new_alert_under_both: 0, change_earlier: 0, same_bin: 0, change_later: 0, min: null, median: null, max: null, mean: null, sd: null });
  });

  const seeds = (k: number, out = join(root, "never")) => ["--seed", "4", "--seeds", String(k), "--days", "7", "--baseline", "rule=news2_total_ge_5", "--change", "rule=news2_chart_trigger", "--out", out];

  it("a 2-seed report is byte-identical on a rerun, keeps its key order, and names no outcome", { timeout: 240_000 }, () => {
    const files = compare(seeds(2)).files;
    expect(compare(seeds(2)).files).toEqual(files);
    expect(pinOf(files)).toEqual(PINS.b);
    const j = JSON.parse(files["compare.json"]);
    expect(Object.keys(j)).toEqual(["compare_format", "synthetic", "mode", "seed", "seeds", "days", "node_major", "baseline", "change", "pairing", "arms", "difference", "spread", "paired_episodes", "notes"]);
    expect(Object.keys(j.paired_episodes)).toEqual(["episodes_with_new_alert_under_both", "change_earlier", "same_bin", "change_later", "min", "median", "max", "mean", "sd"]);
    expect(files["compare.txt"]).toContain("\nsame episode under both rules: first new alert of the change rule minus the baseline rule's, in minutes (negative: the change rule warned earlier)\n");
    expect([j.mode, j.compare_format, j.seeds]).toEqual(["w4_seeds", 1, [4, 5]]);
    expect(Object.keys(j.arms.baseline)).toEqual(["pooled", "seed_4", "seed_5"]);
    expect(Object.keys(j.spread)).toEqual(["lead_median_minutes", "delay_median_minutes", "alerts_per_patient_per_12h_shift", "episodes_with_new_alert_share"]);
    expect(Object.keys(j.spread.lead_median_minutes)).toEqual(["seeds_with_value", "min", "median", "max", "mean", "sd"]);
    expect(j.pairing.status).toBe("one cohort for both arms, for each of 2 seeds");
    expect(j.arms.baseline.pooled.alerts).toBe(j.arms.baseline.seed_4.alerts + j.arms.baseline.seed_5.alerts);
    // The pooled burden uses every seed's patient days, so it lies between the two seeds' own figures.
    const burden = (k: string) => j.arms.baseline[k].alerts_per_patient_per_12h_shift as number;
    expect(burden("pooled")).toBeGreaterThan(Math.min(burden("seed_4"), burden("seed_5")));
    expect(burden("pooled")).toBeLessThan(Math.max(burden("seed_4"), burden("seed_5")));
    // The spread is of change minus baseline, the same sign as the difference rows.
    const d = [j.difference.seed_4.alerts_per_patient_per_12h_shift, j.difference.seed_5.alerts_per_patient_per_12h_shift] as number[];
    expect([j.spread.alerts_per_patient_per_12h_shift.min, j.spread.alerts_per_patient_per_12h_shift.max]).toEqual([Math.min(...d), Math.max(...d)]);
    expect(Math.min(...d)).not.toBe(-Math.max(...d));
    // Checked by hand from the trials' own files: seed 4 has two episodes alerted under both rules (n-0009: 8235 against 8310, n-0011: the same bin); seed 5 has none.
    expect(j.paired_episodes).toEqual({ episodes_with_new_alert_under_both: 2, change_earlier: 1, same_bin: 1, change_later: 0, min: -75, median: -37.5, max: 0, mean: -37.5, sd: 53.033 });
    expect(j.arms.baseline.seed_4.delay_median_minutes).toBe(256.6803);
    expect(j.arms.change.seed_4.delay_median_minutes).toBe(219.1803);
    expect(files["compare.txt"].split("\n")[0]).toBe("compare w4: seeds 4 to 5 (2 seeds), 7 days");
    expect(files["compare.txt"]).toContain("\nspread of the per-seed difference (change minus baseline)\n");
    for (const s of [4, 5]) expect(files["compare.txt"]).toMatch(new RegExp(`^  seed ${s}: cohort.csv sha256 [0-9a-f]{64}, episodes.csv sha256 [0-9a-f]{64}, equal on a second run$`, "m"));
    expect(j.notes.slice(-5, -1)).toEqual([expect.stringMatching(/^alert delay = /), expect.stringMatching(/^the paired figure is the same episode under both rules, /), expect.stringMatching(/^a rule that alerts more can show fewer new alerts /), expect.stringMatching(/^spread is across seeds: .* it says nothing when seeds_with_value is below 2/)]);
    expect(j.notes.at(-1)).toMatch(/^no outcome is given: /);
    expect(files["compare.txt"].trimEnd().endsWith("synthetic, not validated")).toBe(true);
    const keys = (v: unknown): string[] => (typeof v === "object" && v !== null ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);
    expect(keys(j).filter((k) => /death|mortal|surviv|outcome/i.test(k))).toEqual([]);
    // the other modes' reports have neither key
    expect(Object.keys(JSON.parse(compare(w4(1)).files["compare.json"]))).not.toContain("spread");
  });

  it("a stub trial: any seed's pairing failure refuses the whole run", () => {
    let n = 0;
    const drifting = (o: { seed: number }) => ({ "manifest.json": "", "cohort.csv": `${COHORT_HEADER}\n`, "episodes.csv": `${EPISODES_HEADER}\n${o.seed === 5 && n++ % 2 ? "x\n" : ""}`, "summary.json": '{"patient_days":1}' });
    expect(() => compareW4Seeds(4, 2, 1, "news2_total_ge_5", "news2_chart_trigger", drifting as never)).toThrow(/^pairing broken: two runs of the same seed differ$/);
  });

  it("each new refusal gives its line, writes nothing and returns at once", () => {
    const before = readdirSync(root);
    const cases: [RegExp, string[]][] = [
      [/^--seeds is for rule arms only$/, ["--seed", "4", "--seeds", "3", ...args(4, 60, SCEN, `nurses=${DOH}`).slice(2)]],
      [/^--seeds must be a whole number from 2 to 50$/, seeds(1)],
      [/^--seeds must be a whole number from 2 to 50$/, seeds(51)],
      [/^--seeds must be a whole number from 2 to 50$/, ["--seed", "4", "--seeds", "x", ...w4(60).slice(2)]],
      [/^--seed plus --seeds runs past 2147483647$/, ["--seed", "2147483647", "--seeds", "2", ...w4(60).slice(2)]],
      [/^usage: compare --seed N \[--seeds K\] /, [...seeds(2), "--seeds", "3"]],
    ];
    for (const [line, a] of cases) {
      const t = Date.now();
      expect(() => compare(a), String(line)).toThrow(Refusal);
      expect(() => compare(a), String(line)).toThrow(line);
      expect(Date.now() - t, String(line)).toBeLessThan(2000);
    }
    expect(readdirSync(root)).toEqual(before);
  });
});

describe("outcome model", () => {
  const never = parseRule("news2_total_ge_20");
  const ge5 = parseRule("news2_total_ge_5");
  const chart = parseRule("news2_chart_trigger");
  const rowsAt = (minutes: number[], total: number | null, escalated = false) => minutes.map((minute) => ({ id: "e", minute, total, escalated }));
  const every = (from: number, to: number) => Array.from({ length: (to - from) / 15 + 1 }, (_, i) => from + 15 * i);
  const ep = (admit: number, start: number, ramp: number, leave = "") => ["e", String(admit), leave, "", "x", String(start), String(ramp)];

  it("uses the cited round intervals of params.ts", () => {
    expect([PARAMS.obs.intervalMin.routine.value, PARAMS.obs.intervalMin.watch.value]).toEqual([240, 60]);
  });

  it("recognition: the earliest of a rule bin, the next round, leaving and the run end", () => {
    const r2 = rowsAt(every(100, 500), 2);
    expect(recognition([...rowsAt(every(100, 400), 0).map((r) => (r.minute === 235 ? { ...r, total: 5 } : r))], ge5, ep(100, 200, 60), 3)).toEqual({ minute: 235, how: "rule" }); // bin before the round (820)
    expect(recognition(r2, never, ep(100, 200, 60), 3)).toEqual({ minute: 340, how: "round" }); // score 2: admit + 240
    expect(recognition([...rowsAt(every(100, 340), 2), ...rowsAt([400], 5)], ge5, ep(100, 200, 400), 3)).toEqual({ minute: 340, how: "round" }); // rule bin after the round
    expect(recognition(rowsAt(every(100, 900), 0), never, ep(100, 200, 60), 3)).toEqual({ minute: 820, how: "round" }); // score 0: 12 h
    expect(recognition(rowsAt(every(100, 300), 7, true), never, ep(100, 200, 60), 3)).toEqual({ minute: 205, how: "round" }); // total 7: 15 min
    expect(recognition(rowsAt(every(100, 500), null), never, ep(100, 200, 60), 3)).toEqual({ minute: 340, how: "round" }); // NOT RANKED: 4 h
    expect(recognition(rowsAt(every(300, 500), 0), never, ep(100, 200, 60), 3)).toEqual({ minute: 340, how: "round" }); // before the first row: 4 h
    expect(recognition(rowsAt(every(200, 300), 2), never, ep(200, 200, 60), 3)).toEqual({ minute: 200, how: "round" }); // a round exactly at the start: delay 0
    expect(recognition(rowsAt(every(100, 500), 0), never, ep(100, 200, 60, "500"), 3)).toEqual({ minute: 500, how: "left" });
    expect(recognition(rowsAt(every(100, 500), 0), never, ep(100, 200, 60), 0.5)).toEqual({ minute: 720, how: "left" }); // the run ends first
  });

  it("monotone: a wider rule is never recognised later, even when re-arm gives it no new alert in the window", () => {
    // Rows from 600 on: the chart trigger is on throughout (so its alert fired at 600, before the window 1000..1180), ge_5 only at 1100.
    const rs = [...rowsAt(every(600, 1085), 3, true), ...rowsAt([1100], 5, true)];
    const e = ep(500, 1000, 60);
    const [fa, fb] = [new Map<string, number>(), new Map<string, number>()];
    const byPatient = new Map([["e", rs]]);
    expect(w4Arm(byPatient, ge5, [e], 1, 1, fa).episodes_with_new_alert).toBe(1);
    expect(w4Arm(byPatient, chart, [e], 1, 1, fb).episodes_with_new_alert).toBe(0);
    const [ra, rb] = [recognition(rs, ge5, e, 1), recognition(rs, chart, e, 1)];
    expect([ra, rb]).toEqual([{ minute: 1040, how: "round" }, { minute: 1005, how: "rule" }]);
    expect(excessAt(1, (rb.minute - 1000) / 60)).toBeLessThanOrEqual(excessAt(1, (ra.minute - 1000) / 60));
  });

  it("at an odds ratio of 1 the excess is exactly 0; the odds multiply by 1.02 per hour", () => {
    for (const d of [0, 0.25, 1, 4.5, 12]) expect(excessAt(0, d)).toBe(0);
    const odds = (p: number) => p / (1 - p);
    for (const [s, k] of [[1, 4], [2, 4]] as const) expect(Math.abs(odds(riskAt(s, 4)) / odds(riskAt(s, 0)) - 1.02 ** (s * k))).toBeLessThan(1e-12);
    expect(riskAt(1, 6.3)).toBeCloseTo(0.274, 12); // the cited cohort's figure at its median
    expect(excessAt(2, 4)).toBeGreaterThan(excessAt(1, 4));
  });

  // A stub trial, a different cohort for each seed from 4 to 23: each seed has two episodes where the chart trigger fires 1 h before ge_5, one patient who leaves first,
  // and n-0004, whose breathing scores a single 3 from admission: the chart trigger alerted long before the window, so in the
  // window it is true with no new alert, while ge_5 is never true and a round recognises the episode.
  const row = (id: string, minute: number, rr: number, hr: number) => {
    const r = scoreNews2({ respiratory_rate: rr, spo2: 97, spo2_scale: 1, supplemental_o2: false, systolic_bp: 120, heart_rate: hr, consciousness: "A", temperature: 37 });
    return `${id},${minute},${hr},${rr},97,37,120,80,10,A,0,1,100,1,${r.kind === "score" ? r.total : ""}`;
  };
  const stub = ((o: { seed: number }) => {
    const [c, e] = [[COHORT_HEADER], [EPISODES_HEADER]];
    for (const [id, admit, start] of [["n-0001", 20, 300 + 15 * (o.seed - 4)], ["n-0002", 100, 600], ["n-0003", 90, 400], ["n-0004", 100, 710]] as [string, number, number][]) {
      const leave = id === "n-0003" ? 430 : 1500; // n-0003 never deviates and leaves before its round
      e.push(`${id},${admit},${leave},,respiratory,${start},60,,,0`);
      for (let m = 105; m <= leave - 15; m += 15) {
        const dev = id !== "n-0003" && id !== "n-0004" && m >= start + 30 && m < start + 180;
        c.push(row(id, m, dev || id === "n-0004" ? 25 : 16, dev && id !== "n-0004" && m >= start + 90 ? 130 : 80));
      }
    }
    return { "manifest.json": "", "cohort.csv": `${c.join("\n")}\n`, "episodes.csv": `${e.join("\n")}\n`, "summary.json": '{"patient_days":3}' };
  }) as never;
  const run = () => compareW4Seeds(4, 20, 7, "news2_total_ge_5", "news2_chart_trigger", stub, true);
  const LABEL = "MODEL ASSUMPTION, not evidence about patients";

  it("20 seeds: the block, its order, the label twice, the zero row, and the wording", () => {
    const files = run();
    expect(run()).toEqual(files);
    const j = JSON.parse(files["compare.json"]);
    expect(Object.keys(j)).toEqual(["compare_format", "synthetic", "mode", "seed", "seeds", "days", "node_major", "baseline", "change", "pairing", "arms", "difference", "spread", "paired_episodes", "outcome_model", "notes"]);
    const o = j.outcome_model;
    expect(Object.keys(o)).toEqual(["label", "parameter", "assumption", "recognition_rule", "arms", "difference", "spread", "paired_episodes", "sensitivity", "notes"]);
    expect(o.label).toBe(LABEL);
    expect(o.arms.baseline).toMatchObject({ episodes_evaluated: 80, recognised_by_rule: 40, recognised_by_rule_without_new_alert: 0, recognised_by_round: 20, unrecognised_at_leave_or_run_end: 20 });
    // n-0004 under the chart trigger: recognised by a true bin although re-arm gave it no new alert in the window.
    expect(o.arms.change).toMatchObject({ episodes_evaluated: 80, recognised_by_rule: 60, recognised_by_rule_without_new_alert: 20, recognised_by_round: 0, unrecognised_at_leave_or_run_end: 20 });
    // The price of the wider rule is in the same table and in a note.
    expect([o.arms.baseline.alerts, o.arms.change.alerts]).toEqual([j.arms.baseline.pooled.alerts, j.arms.change.pooled.alerts]);
    expect([o.arms.baseline.bins_alerting, o.arms.change.bins_alerting]).toEqual([j.arms.baseline.pooled.bins_alerting, j.arms.change.pooled.bins_alerting]);
    expect(o.arms.change.bins_alerting).toBeGreaterThan(o.arms.baseline.bins_alerting);
    expect(o.notes.join("\n")).toContain(`that is the construction, not a finding. alerts and bins_alerting, change minus baseline, are ${o.difference.alerts} and ${o.difference.bins_alerting} (negative: the change rule alerts less); this block does not weigh them`);
    expect(o.recognition_rule).toMatch(/a perfect round, judgement/);
    expect(o.notes.join("\n")).toContain("applying it to every W4 episode are judgement, and every per-100 figure scales with it");
    expect(o.notes.join("\n")).toContain("in the hospital model W4 counts as monitored and is outside its late-recognition rule");
    // The rules the other way round: the narrower rule is the change, its difference is positive, and no note calls fewer alerts "extra" or the sign "by construction negative".
    const back = JSON.parse(compareW4Seeds(4, 20, 7, "news2_chart_trigger", "news2_total_ge_5", stub, true)["compare.json"]).outcome_model;
    expect(back.difference.modelled_excess_bad_outcomes_per_100_episodes).toBe(-o.difference.modelled_excess_bad_outcomes_per_100_episodes);
    expect(back.difference.modelled_excess_bad_outcomes_per_100_episodes).toBeGreaterThan(0);
    expect(back.difference.alerts).toBeLessThan(0);
    expect(back.notes.join("\n")).not.toMatch(/extra alerts|zero or negative/);
    expect(back.notes.join("\n")).toContain(`are ${back.difference.alerts} and ${back.difference.bins_alerting} (negative: the change rule alerts less)`);
    expect(o.notes.join("\n")).toContain("no patient changes: nobody dies on W4, no vital sign is altered and no recovery is drawn");
    expect(o.parameter).toMatchObject({ value: 1.02, tag: "cited", applied_to_tag: "judgement", interval_95: [1, 1.04], baseline_risk: 0.274, baseline_risk_at_hours: 6.3, anchor_tag: "judgement" });
    expect(o.arms.baseline.recognition_delay_mean_hours).toBeGreaterThan(o.arms.change.recognition_delay_mean_hours);
    expect(o.paired_episodes).toMatchObject({ episodes_paired: 80, change_earlier: 60, same_minute: 20, change_later: 0 });
    expect(o.arms.change.modelled_excess_bad_outcomes_per_100_episodes).toBeLessThan(o.arms.baseline.modelled_excess_bad_outcomes_per_100_episodes);
    expect(o.sensitivity.map((s: { assumption: string }) => s.assumption)).toEqual(["zero", "half", "central", "double"]);
    expect(o.sensitivity.map((s: { odds_ratio_per_hour: number }) => s.odds_ratio_per_hour)).toEqual([1, 1.01, 1.02, 1.0404]);
    const [zero, , central, double] = o.sensitivity;
    expect([zero.baseline, zero.change, zero.difference]).toEqual([0, 0, 0]);
    expect(central.difference).not.toBe(0);
    expect(Math.abs(double.difference)).toBeGreaterThan(Math.abs(central.difference));
    expect(central.difference).toBe(o.difference.modelled_excess_bad_outcomes_per_100_episodes);
    const txt = files["compare.txt"];
    expect(txt.split(LABEL).length - 1).toBeGreaterThanOrEqual(2);
    expect(txt).toContain(`\n${LABEL}\nparameter: 1.02, the odds ratio the cited paper gives for score-to-door time measured in hours, applied here to each hour of recognition delay (that transfer is judgement) [cited: Whebell SF et al., Crit Care 2021;25:226, doi:10.1186/s13054-021-03650-1: adjusted odds ratio 1.02 (95% CI 1.0-1.04) for the time from a first sustained NEWS of 7 or more (not falling below 5 before admission) to critical care admission, which the paper measures in hours (it does not print the words "per hour"); outcome hospital mortality, 27.4% of 632 patients, median time 6.3 h]\nunder the assumption that `);
    expect(txt).toContain("\noutcome model: spread of the per-seed difference (change minus baseline)\n");
    expect(txt).toContain(`\n${LABEL}: sensitivity to the odds ratio per hour`);
    expect(txt).toMatch(/^zero +1 +0 +0 +0$/m);
    // after the paired block, before the notes; the old "no outcome is given" note is replaced by the block's own
    expect(txt.indexOf("same episode under both rules")).toBeLessThan(txt.indexOf(LABEL));
    expect(txt.indexOf(LABEL)).toBeLessThan(txt.indexOf("\nnote: "));
    expect(txt.indexOf("note: W4 is a monitored ward")).toBeLessThan(txt.indexOf("note: nothing in the run responds to a warning"));
    expect(txt).not.toContain("the outcome of a warning is not modelled"); // it would contradict the block
    expect(txt).not.toContain("no outcome is given");
    expect(j.notes.join("\n")).not.toContain("no outcome is given");
    // no word that says or implies a patient died or was saved
    expect(files["compare.json"] + txt).not.toMatch(/\b(saved?|prevent\w*|would have|lives?)\b/i);
    const keys = (v: unknown): string[] => (typeof v === "object" && v !== null ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);
    expect(keys(j).filter((k) => /death|died|mortality/i.test(k))).toEqual([]);
    // the flagless report of the same runs has neither the key nor the block
    const plain = compareW4Seeds(4, 20, 7, "news2_total_ge_5", "news2_chart_trigger", stub);
    expect(plain["compare.json"]).not.toContain("outcome_model");
    expect(plain["compare.txt"]).not.toContain("MODEL ASSUMPTION");
    expect(JSON.parse(plain["compare.json"]).notes.at(-1)).toMatch(/^no outcome is given: /);
  });

  it("the exported function also refuses fewer than 20 seeds, too few evaluated episodes, and one cohort counted as many seeds", () => {
    expect(() => compareW4Seeds(4, 19, 7, "news2_total_ge_5", "news2_chart_trigger", stub, true)).toThrow(/^--outcome-model needs --seeds 20 or more \(one seed, or a few, is noise\)$/);
    const empty = (() => ({ "manifest.json": "", "cohort.csv": `${COHORT_HEADER}\n`, "episodes.csv": `${EPISODES_HEADER}\n`, "summary.json": '{"patient_days":1}' })) as never;
    expect(() => compareW4Seeds(4, 20, 7, "news2_total_ge_5", "news2_chart_trigger", empty, true)).toThrow(/^--outcome-model: only 0 episodes were evaluated in these seeds; it needs 30 or more \(use more seeds or more days\)$/);
    // One cohort offered as 20 seeds is one run, not 20.
    const same = ((o: { seed: number }) => (stub as (o: { seed: number }) => unknown)({ ...o, seed: 4 })) as never;
    expect(() => compareW4Seeds(4, 20, 7, "news2_total_ge_5", "news2_chart_trigger", same, true)).toThrow(/^--outcome-model: two seeds gave the same cohort, so they are not separate runs$/);
    expect(compareW4Seeds(4, 20, 7, "news2_total_ge_5", "news2_chart_trigger", empty)["compare.json"]).not.toContain("outcome_model"); // the plain report still works
  });

  it("each refusal gives its line, writes nothing and returns at once", () => {
    const before = readdirSync(root);
    const base = (k: number) => ["--seed", "4", "--seeds", String(k), "--days", "60", "--baseline", "rule=news2_total_ge_5", "--change", "rule=news2_chart_trigger", "--out", join(root, "never")];
    const cases: [RegExp, string[]][] = [
      [/^--outcome-model is for rule arms only$/, ["--outcome-model", ...args(4, 60, SCEN, `nurses=${DOH}`)]],
      [/^--outcome-model is for rule arms only$/, ["--outcome-model", "--seeds", "20", ...args(4, 60, SCEN, `nurses=${DOH}`)]],
      [/^--outcome-model needs --seeds 20 or more \(one seed, or a few, is noise\)$/, [...w4(60), "--outcome-model"]],
      [/^--outcome-model needs --seeds 20 or more \(one seed, or a few, is noise\)$/, [...base(19), "--outcome-model"]],
      [/^usage: compare --seed N \[--seeds K\] --days N --baseline B --change C --out DIR \[--outcome-model\]$/, [...base(20), "--outcome-model", "--outcome-model"]],
    ];
    for (const [line, a] of cases) {
      const t = Date.now();
      expect(() => compare(a), String(line)).toThrow(Refusal);
      expect(() => compare(a), String(line)).toThrow(line);
      expect(Date.now() - t, String(line)).toBeLessThan(2000);
    }
    expect(readdirSync(root)).toEqual(before);
  });
});

describe("hospital compare", () => {
  it("is byte-identical on a rerun", { timeout: 120_000 }, () => {
    const a = args(101, 1, SCEN, `nurses=${DOH}`);
    const files = compare(a).files;
    expect(compare(a).files).toEqual(files);
    expect(pinOf(files)).toEqual(PINS.c);
    const j = JSON.parse(files["compare.json"]);
    expect(j.change.name).toBe("nurses");
    expect(j.change.fields.length).toBeGreaterThan(0);
    expect(j.pairing.status).toMatch(/^(partly paired \(same minute-0 residents, arrival minutes and person at each arrival; event logs differ from minute \d+\)|same minute-0 residents, arrival minutes and person at each arrival; no event differs)$/);
    // The difference is change minus baseline: MED3A has 2 nurses in typical and 3 in doh-standard.
    expect([j.arms.baseline.hourly_means.MED3A.nurses, j.arms.change.hourly_means.MED3A.nurses, j.difference.hourly_means.MED3A.nurses]).toEqual([2, 3, 1]);
    expect(j.notes.join("\n")).toContain("not evidence about a real hospital");
    expect(j.notes.join("\n")).toContain(LIMITS);
    expect(files["compare.txt"]).toContain("\nsummary.all_days.recognition.excess_deaths_label baseline: model output under a judgement relation, not evidence\n");
    expect(Object.keys(j.arms.baseline.summary)).toEqual(["all_days", "after_warm_up"]);
    for (const f of Object.values(files)) expect(f).not.toContain("scenarios/");
  });

  it("refuses scenarios that differ outside the group", () => {
    const a = parseScenario(readFileSync(SCEN, "utf8"));
    const b = structuredClone(a);
    b.er.nurses += 1; // nurses group
    b.transferOutAfterH += 1; // another group
    expect(() => compareHospital(101, 1, a, b, "nurses")).toThrow(/^change: more than one thing differs \(transferOutAfterH\)$/);
  });
});

describe("pairing", () => {
  const head = "minute,person,w4_id,unit,kind,detail,news2_independent,visit\n";
  const ev = (...r: string[]) => `${head}${r.join("\n")}\n`;
  const base = ["5,1000001,,ER,arrive,a,no,1", "30,1000001,,ER,decide_admit,,no,1", "90,1000001,,MED3A,deteriorate,,no,1", "50,1000002,,ER,arrive,b,no,1"];

  it("accepts an equal pair, and a swapped person is not paired", () => {
    const same = pairEvents(ev(...base), ev(...base), ["1"], ["1"]);
    expect(same.same_person_at_each_arrival).toBe(true);
    expect(same.status).toBe("same minute-0 residents, arrival minutes and person at each arrival; no event differs");
    expect(same.lines[0]).toBe("the same person arrives at each of the 2 arrival minutes");
    expect(same.lines.join("\n")).toContain("courses seen in both arms: 1 with an equal offset from the admit decision, 0 with no admit decision");
    const swapped = [...base.slice(0, 3), "50,1000009,,ER,arrive,b,no,1"];
    const p = pairEvents(ev(...base), ev(...swapped), ["1"], ["1"]);
    expect(p.same_person_at_each_arrival).toBe(false);
    expect(p.status).toBe("partly paired (same minute-0 residents and arrival minutes; the person at some arrivals differs; event logs differ from minute 50)");
    expect(p.lines[0]).toContain("from minute 50 the person at 1 of 2 arrivals differs");
    expect(p.lines).toContain("outcomes after minute 50 differ by design; cohorts are not identical after it");
  });

  it("refuses a shifted arrival and a changed course offset", () => {
    const shifted = [base[0], base[1], base[2], "51,1000002,,ER,arrive,b,no,1"];
    expect(() => pairEvents(ev(...base), ev(...shifted), ["1"], ["1"])).toThrow(/^pairing broken: arrival minutes differ from minute 50$/);
    const moved = [base[0], base[1], "91,1000001,,MED3A,deteriorate,,no,1", base[3]];
    expect(() => pairEvents(ev(...base), ev(...moved), ["1"], ["1"])).toThrow(/^pairing broken: the course offset from the admit decision differs for person 1000001$/);
    const undecided = [base[0], base[2], base[3]];
    expect(() => pairEvents(ev(...base), ev(...undecided), ["1"], ["1"])).toThrow(/^pairing broken: person 1000001 has an admit decision in one arm only$/);
    expect(pairEvents(ev(...undecided), ev(...undecided), ["1"], ["1"]).lines[1]).toContain("0 with an equal offset from the admit decision, 1 with no admit decision in the run (not checked)");
    expect(() => pairEvents(ev(...base), ev(...base), ["1"], ["2"])).toThrow(/^pairing broken: the minute-0 residents differ$/);
  });
});

describe("refusals", () => {
  const cases = (): [RegExp, string[]][] => [
    [/^usage: compare /, []],
    [/^usage: compare /, [...w4(60), "--extra", "1"]],
    [/^usage: compare /, [...w4(60), "--seed", "1"]],
    [/^exactly one --change is allowed$/, [...w4(60), "--change", "rule=news2_total_ge_3"]],
    [/^--seed must be a whole number from 0 to 2147483647$/, ["--seed", "-1", ...w4(60).slice(2)]],
    [/^--days must be a whole number from 1 to 60$/, args(4, 61, "rule=news2_total_ge_5", "rule=news2_chart_trigger")],
    [/^--baseline and --change must both be rules or a scenario and a group$/, args(4, 60, "rule=news2_total_ge_5", `nurses=${DOH}`)],
    [/^rule: unknown "nope"; use /, args(4, 60, "rule=news2_total_ge_5", "rule=nope")],
    [/^rule: unknown "news2_total_ge_21"; use /, args(4, 60, "rule=news2_total_ge_5", "rule=news2_total_ge_21")],
    [/^change: same rule as the baseline$/, args(4, 60, "rule=news2_total_ge_5", "rule=news2_total_ge_5")],
    [/^change: unknown group "colour"; use /, args(4, 60, SCEN, `colour=${DOH}`)],
    [/^change: group beds is not paired /, args(4, 60, SCEN, `beds=${DOH}`)],
    [/^baseline: cannot read the scenario file "no-such.json"$/, args(4, 60, "no-such.json", `nurses=${DOH}`)],
    [/^change: group nurses has the same values in both files$/, args(4, 60, SCEN, `nurses=${SCEN}`)],
  ];

  it("each leaves --out absent, writes nothing, and returns at once even for 60 days", () => {
    const before = readdirSync(root);
    for (const [line, a] of cases()) {
      const t = Date.now();
      expect(() => compare(a), String(line)).toThrow(Refusal);
      expect(() => compare(a), String(line)).toThrow(line);
      expect(Date.now() - t, String(line)).toBeLessThan(2000);
    }
    expect(readdirSync(root)).toEqual(before);
    expect(existsSync(join(root, "never"))).toBe(false);
  });

  it("refuses an --out that exists or whose parent is missing or not a folder", () => {
    mkdirSync(join(root, "taken"));
    writeFileSync(join(root, "file"), "");
    for (const o of [join(root, "taken"), join(root, "nope", "x"), join(root, "file", "x")]) {
      expect(() => compare(args(4, 60, "rule=news2_total_ge_5", "rule=news2_chart_trigger", o))).toThrow(Refusal);
    }
  });
});

describe("command", () => {
  let bin: string;
  beforeAll(() => {
    execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--ssr", "src/compare.ts", "--outDir", join(root, "dist"), "--emptyOutDir", "--logLevel", "warn"], { stdio: "pipe" });
    bin = join(root, "dist", "compare.js");
  }, 120_000);
  const run = (a: string[]) => spawnSync(process.execPath, [bin, ...a], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });

  it("refuses with one line and exit 2, and runs a W4 compare from the bundle", { timeout: 120_000 }, () => {
    const r = run(w4().slice(0, -2));
    expect(r.status).toBe(2);
    expect(r.stderr.trimEnd().split("\n")).toHaveLength(1);
    const out = join(root, "cli");
    const ok = run(w4(1).slice(0, -1).concat(out));
    expect(ok.status).toBe(0);
    expect(readdirSync(out).sort()).toEqual(["compare.json", "compare.txt"]);
    expect(JSON.parse(readFileSync(join(out, "compare.json"), "utf8")).mode).toBe("w4");
  });
});
