import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compare, compareHospital, compareW4, compareW4Seeds, pairedDiffs, pairedOf, pairEvents, pooledMedian, parseRule, Refusal, rescore, spreadOf, w4Arm } from "./compare";
import { parseScenario } from "./sim/hospital/scenario";
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

describe("W4 compare", () => {
  let first: ReturnType<typeof compare>["files"];
  beforeAll(() => { first = compare(w4()).files; }, 120_000);

  it("is byte-identical on a rerun, keeps its keys in order, and holds no path or name", { timeout: 120_000 }, () => {
    expect(compare(w4()).files).toEqual(first);
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

describe("hospital compare", () => {
  it("is byte-identical on a rerun", { timeout: 120_000 }, () => {
    const a = args(101, 1, SCEN, `nurses=${DOH}`);
    const files = compare(a).files;
    expect(compare(a).files).toEqual(files);
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
