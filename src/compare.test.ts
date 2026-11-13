import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compare, compareHospital, compareW4, pairEvents, parseRule, Refusal, rescore, w4Arm } from "./compare";
import { parseScenario } from "./sim/hospital/scenario";
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
    expect(Object.keys(j)).toEqual(["compare_format", "synthetic", "mode", "seed", "days", "node_major", "baseline", "change", "pairing", "arms", "difference", "notes"]);
    expect(Object.keys(j.arms)).toEqual(["baseline", "change"]);
    // Checked by hand against this trial's cohort.csv and episodes.csv with the research package's rules.
    expect(j.arms.baseline).toMatchObject({
      alerts: 30, alerts_per_patient_per_12h_shift: 0.4103, episodes_evaluated: 1, episodes_with_new_alert: 1,
      alerts_outside_episode_windows: 29, lead_minutes: [-16.3637], lead_median_minutes: -16.3637, bins: 3498, bins_alerting: 840,
    });
    expect(j.arms.change).toMatchObject({ alerts: 32, alerts_outside_episode_windows: 31, bins: 3498, bins_alerting: 979 });
    expect(j.difference).toMatchObject({ alerts: 2, bins_alerting: 139, lead_minutes: null });
    expect(j.pairing.status).toBe("one cohort for both arms");
    expect(j.notes[0]).toMatch(/^the outcome of a warning is not modelled on W4: /);
    expect(first["compare.txt"].trimEnd().endsWith("synthetic, not validated")).toBe(true);
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
      ["n-1", "10", "", "", "respiratory", "100", "60"], // window 100 to 280: alerting at 270, but no new alert
      ["n-2", "10", "", "", "respiratory", "200", "100"], // fully in at 300, new alert at 285: lead 15
      ["p-1", "0", "", "", "respiratory", "50", "60"], // a starting patient is not evaluated
    ];
    expect(w4Arm(rowsBy, hit, episodes, 2.5, 1)).toEqual({
      alerts: 5, alerts_per_patient: 1.6667, alerts_per_patient_per_12h_shift: 1,
      episodes_evaluated: 2, episodes_with_new_alert: 1, episodes_with_new_alert_share: 0.5,
      episodes_alerting_any_bin: 2, episodes_alerting_any_bin_share: 1,
      alerts_outside_episode_windows: 4, lead_minutes: [15], lead_median_minutes: 15, bins: 39, bins_alerting: 6, // 18 + 19 + 2 rows
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

describe("hospital compare", () => {
  it("is byte-identical on a rerun", { timeout: 120_000 }, () => {
    const a = args(101, 1, SCEN, `nurses=${DOH}`);
    const files = compare(a).files;
    expect(compare(a).files).toEqual(files);
    const j = JSON.parse(files["compare.json"]);
    expect(j.change.name).toBe("nurses");
    expect(j.change.fields.length).toBeGreaterThan(0);
    expect(j.pairing.status).toMatch(/^(partly paired \(same residents, arrival clock and people; events differ from minute \d+\)|same residents, arrival clock and people; no event differs)$/);
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
    expect(same.same_people).toBe(true);
    expect(same.status).toBe("same residents, arrival clock and people; no event differs");
    expect(same.lines[0]).toBe("same people at every arrival minute (2 arrivals)");
    expect(same.lines.join("\n")).toContain("offset from the admit decision equal for 1 courses seen in both arms; 0 have no admit decision");
    const swapped = [...base.slice(0, 3), "50,1000009,,ER,arrive,b,no,1"];
    const p = pairEvents(ev(...base), ev(...swapped), ["1"], ["1"]);
    expect(p.same_people).toBe(false);
    expect(p.status).toBe("partly paired (same residents and arrival clock; the people differ; events differ from minute 50)");
    expect(p.lines[0]).toContain("from minute 50 the person at 1 of 2 arrivals differs");
    expect(p.lines).toContain("outcomes after minute 50 differ by design; cohorts are not identical after it");
  });

  it("refuses a shifted arrival and a changed course offset", () => {
    const shifted = [base[0], base[1], base[2], "51,1000002,,ER,arrive,b,no,1"];
    expect(() => pairEvents(ev(...base), ev(...shifted), ["1"], ["1"])).toThrow(/^pairing broken: arrival minutes differ from minute 50$/);
    const moved = [base[0], base[1], "91,1000001,,MED3A,deteriorate,,no,1", base[3]];
    expect(() => pairEvents(ev(...base), ev(...moved), ["1"], ["1"])).toThrow(Refusal);
    expect(() => pairEvents(ev(...base), ev(...base), ["1"], ["2"])).toThrow(Refusal);
  });
});

describe("refusals", () => {
  const cases = (): Record<string, string[]> => ({
    "no flags": [],
    "unknown flag": [...w4(60), "--extra", "1"],
    "repeated flag": [...w4(60), "--seed", "1"],
    "two changes": [...w4(60), "--change", "rule=news2_total_ge_3"],
    "bad seed": ["--seed", "-1", ...w4(60).slice(2)],
    "bad days": args(4, 61, "rule=news2_total_ge_5", "rule=news2_chart_trigger"),
    "mixed": args(4, 60, "rule=news2_total_ge_5", `nurses=${DOH}`),
    "unknown rule": args(4, 60, "rule=news2_total_ge_5", "rule=nope"),
    "rule out of range": args(4, 60, "rule=news2_total_ge_5", "rule=news2_total_ge_21"),
    "same rule": args(4, 60, "rule=news2_total_ge_5", "rule=news2_total_ge_5"),
    "unknown group": args(4, 60, SCEN, `colour=${DOH}`),
    "unpaired group": args(4, 60, SCEN, `beds=${DOH}`),
    "missing file": args(4, 60, "no-such.json", `nurses=${DOH}`),
    "same values": args(4, 60, SCEN, `nurses=${SCEN}`),
  });

  it("each leaves --out absent, writes nothing, and returns at once even for 60 days", () => {
    const before = readdirSync(root);
    for (const [name, a] of Object.entries(cases())) {
      const t = Date.now();
      expect(() => compare(a), name).toThrow(Refusal);
      expect(Date.now() - t, name).toBeLessThan(2000);
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
