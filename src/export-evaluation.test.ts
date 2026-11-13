/// <reference types="node" />
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import fixtureJson from "./export-evaluation.fixture.json";
import { buildSimulator, checkArgs, compareBlocks, decode, OUTCOME_LABEL, Refusal, writeJson } from "./export-evaluation";
import { checkOut, formatRealism, readCompare, realismBlock, wardRows, type Row, type WardStats } from "./realism";

// The compare.json the simulator wrote (20 seeds, 30 days, --outcome-model), cut: no seed_<n> entries, one pairing line.
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fixture = fixtureJson as J;
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
const SOURCE = "npm run compare -- --seed 1 --seeds 20 --days 30 --baseline rule=news2_total_ge_5 --change rule=news2_chart_trigger --outcome-model --out trials/compare-outcome";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DATE = "2026-11-13";
const NODE = fixture.node_major as number;

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
const A1: Row = { check: "A1", signal: "heart rate", statistic: "sd, 5-min reads", sim: "12.34", real: "12.00", tolerance: "ratio 0.75-1.25", inside: true, data: "eICU held-out hospitals" };
const B3: Row = { check: "B3", signal: "blood pressure (diastolic)", statistic: "fitted from eICU; not tested", sim: "-", real: "-", tolerance: "-", inside: null, data: "none" };
const ROWS = [A1, B3, ...wardRows(INSIDE)]; // 9 of the D and E rows are UNEXPECTED here
const realism = realismBlock(ROWS);

const mutate = (f: (c: J) => void) => {
  const c = structuredClone(fixture);
  f(c);
  return JSON.stringify(c);
};
const build = (compare = JSON.stringify(fixture), source = SOURCE, block = realism) => buildSimulator({ realism: block, compare, date: DATE, commit: COMMIT, source, nodeMajor: NODE });
const file = () => JSON.parse(build()) as J;
const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(Refusal);
    return (e as Error).message;
  }
  throw new Error("did not refuse");
};
const numbers = (x: unknown): number[] => (typeof x === "number" ? [x] : x && typeof x === "object" ? Object.values(x).flatMap(numbers) : []);

const INT_POOLED = ["alerts", "episodes_evaluated", "episodes_with_new_alert", "episodes_no_new_alert", "episodes_alerting_any_bin", "alerts_outside_episode_windows", "bins", "bins_alerting"];
const INT_PAIRED = ["episodes_with_new_alert_under_both", "change_earlier", "same_bin", "change_later"];

describe("the mapping", () => {
  it("writes the envelope", () => {
    const f = file();
    expect(Object.keys(f)).toEqual(["body", "format", "notes", "provenance", "section"]);
    expect(f.format).toBe("biosentry-evaluation/3");
    expect(f.section).toBe("simulator");
    expect(f.provenance).toEqual({
      repo: "kitchen-station/biosentry-ward-sim", commit: COMMIT, source: [SOURCE, "npm run realism"],
      exporter: { name: "npm run export:evaluation", version: "1" }, date: DATE, synthetic: true, validated: false,
      data: "biosentry-ward-sim ward W4 runs and realism checks", seeds: [{ role: "compare", seeds: fixture.seeds }],
    });
    expect(f.notes).toEqual(["realism: the rows and footer of npm run realism, run by this export at provenance.commit; its seeds are fixed in src/realism.ts and are not listed in seeds"]);
    expect(f.body.node_major).toBe(NODE);
  });

  it("maps compare: rows, order and kinds, each number copied from its path", () => {
    const c = file().body.compare;
    expect(c).toEqual({
      mode: "w4_seeds", seeds: fixture.seeds, days: 30, baseline: "news2_total_ge_5", change: "news2_chart_trigger", pairing_status: fixture.pairing.status,
      pooled: Object.keys(fixture.arms.baseline.pooled).map((m) => ({
        metric: m, baseline: fixture.arms.baseline.pooled[m], change: fixture.arms.change.pooled[m], difference: fixture.difference.pooled[m], kind: INT_POOLED.includes(m) ? "int" : "d4",
      })),
      spread: Object.keys(fixture.spread).map((m) => ({ metric: m, ...fixture.spread[m] })),
      paired: Object.keys(fixture.paired_episodes).map((m) => ({ metric: m, value: fixture.paired_episodes[m], kind: INT_PAIRED.includes(m) ? "int" : "d4" })),
      notes: fixture.notes,
    });
    expect(c.pooled).toHaveLength(12);
    expect(c.pooled.filter((r: J) => r.kind === "int")).toHaveLength(8);
    expect(c.spread).toHaveLength(4);
    expect(c.paired).toHaveLength(9);
    expect(c.pooled[1]).toEqual({ metric: "alerts_per_patient_per_12h_shift", baseline: 0.3483, change: 0.4119, difference: 0.0636, kind: "d4" });
  });

  it("copies the outcome block key for key, and writes null without it", () => {
    expect(file().body.outcome).toEqual({ ...fixture.outcome_model, seeds: fixture.seeds });
    const text = mutate((c) => delete c.outcome_model);
    expect(JSON.parse(build(text, SOURCE.replace(" --outcome-model", ""))).body.outcome).toBeNull();
  });

  it("holds the realism cells and footer exactly as the table prints them", () => {
    const lines = formatRealism(ROWS).text.split("\n");
    const { rows, notes } = file().body.realism;
    expect(rows).toHaveLength(ROWS.length);
    const cells = lines.slice(1, 1 + rows.length).map((l) => l.split(" | ").map((c) => c.trim()));
    expect(rows.map((r: J) => [r.check, r.signal, r.statistic, r.sim, r.real, r.tolerance, r.verdict, r.real_data])).toEqual(cells);
    expect(notes).toEqual(lines.slice(-7));
    expect(notes).toHaveLength(7);
  });

  it("writes the UNEXPECTED rows with their verdict", () => {
    const rows = file().body.realism.rows as J[];
    expect(rows.filter((r) => r.verdict === "UNEXPECTED").map((r) => r.check)).toEqual([...Array(7).fill("D3"), "E1", "E2"]);
    expect(realism.ok).toBe(false);
  });

  it("holds no number that is not in compare.json", () => {
    const known = new Set(numbers(fixture));
    for (const n of numbers(file())) expect(known.has(n), String(n)).toBe(true);
  });
});

describe("formatting and determinism", () => {
  it("sorts every object's keys, indents by one and ends with one newline", () => {
    const text = build();
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.split("\n")[1]).toMatch(/^ "/);
    expect(writeJson(JSON.parse(text))).toBe(text);
    const sorted = (x: unknown): boolean => (Array.isArray(x) ? x.every(sorted) : x && typeof x === "object" ? Object.keys(x).every((k, i, ks) => i === 0 || ks[i - 1] < k) && Object.values(x).every(sorted) : true);
    expect(sorted(JSON.parse(text))).toBe(true);
    expect(new TextEncoder().encode(text).length).toBeLessThan(262144);
  });

  it("gives the same bytes twice, with no clock and no path", () => {
    const a = build();
    expect(build()).toBe(a);
    expect(a).not.toMatch(/\d\d:\d\d:\d\d/);
    expect(a).not.toMatch(/\/Users|\/private|\/home\/|\/tmp\/|\/var\/|[A-Za-z]:\\/);
    expect(read("./export-evaluation.ts")).not.toMatch(/Date\.now|new Date\(\)/);
  });

  it("copies compare's own rounding: 0.47 stays 0.47", () => {
    expect(build()).toContain('"baseline": 0.47');
  });
});

describe("pins", () => {
  it("the label is the one compare.ts uses", () => {
    expect(read("./compare.ts")).toContain('const OUTCOME_LABEL = "MODEL ASSUMPTION, not evidence about patients";');
    expect(OUTCOME_LABEL).toBe("MODEL ASSUMPTION, not evidence about patients");
  });

  it("export-evaluation.ts has no runtime import from src/", () => {
    const imports = read("./export-evaluation.ts").split("\n").filter((l) => /^import /.test(l));
    expect(imports).toEqual(['import type { RealismBlock } from "./realism";']);
  });
});

describe("refusals", () => {
  const args = ["--compare", "c.json", "--date", DATE, "--commit", COMMIT, "--source", SOURCE, "--out", "o.json"];
  const USAGE = 'usage: export:evaluation -- --compare FILE --date YYYY-MM-DD --commit HEX40 --source "LINE" --out FILE';
  const without = (flag: string) => args.filter((_, i, a) => a[i] !== flag && a[i - 1] !== flag);
  const withValue = (flag: string, value: string) => args.map((a, i) => (args[i - 1] === flag ? value : a));

  it("takes every flag once and returns the values", () => {
    expect(checkArgs(args)).toEqual({ compare: "c.json", date: DATE, commit: COMMIT, source: SOURCE, out: "o.json" });
  });

  it("usage: a flag missing, repeated, unknown or without a value", () => {
    for (const bad of [[], without("--out"), [...args, "--out", "p.json"], [...args, "--x", "1"], [...args.slice(0, -1)], [...args.slice(0, -2), "--out", "--date"]]) {
      expect(refusal(() => checkArgs(bad))).toBe(USAGE);
    }
  });

  it("date, commit and the start of the source", () => {
    for (const d of ["2026-02-30", "2026-1-1", "13-11-2026", "2026-11-13T00"]) expect(refusal(() => checkArgs(withValue("--date", d)))).toBe("--date must be a real date, YYYY-MM-DD");
    for (const c of [COMMIT.toUpperCase(), COMMIT.slice(1), `${COMMIT}0`, "g".repeat(40)]) expect(refusal(() => checkArgs(withValue("--commit", c)))).toBe("--commit must be 40 lower-case hex characters");
    expect(refusal(() => checkArgs(withValue("--source", "npm run realism")))).toBe('--source must be the compare command line, starting with "npm run compare -- "');
  });

  it("the source must say what compare.json says", () => {
    const swap = (a: string, b: string) => SOURCE.replace(a, b);
    const cases: [string, string][] = [
      ["--seed", swap("--seed 1 ", "--seed 2 ")], ["--seeds", swap("--seeds 20", "--seeds 21")], ["--days", swap("--days 30", "--days 31")],
      ["--baseline", swap("rule=news2_total_ge_5", "rule=news2_total_ge_7")], ["--change", swap("rule=news2_chart_trigger", "rule=other")],
      ["--outcome-model", swap(" --outcome-model", "")],
    ];
    for (const [flag, source] of cases) expect(refusal(() => build(JSON.stringify(fixture), source))).toBe(`--source does not match compare.json: ${flag}`);
    expect(refusal(() => build(mutate((c) => delete c.outcome_model)))).toBe("--source does not match compare.json: --outcome-model");
    // seeds that do not run on from --seed are not what that command line makes
    expect(refusal(() => build(mutate((c) => (c.seeds[19] = 99))))).toBe("--source does not match compare.json: --seeds");
  });

  it("the source must be a line compare would accept: its flags, each once", () => {
    const NOT = "--source is not a compare command line: a flag is unknown, repeated, missing or has no value";
    expect(refusal(() => build(undefined, SOURCE.replace(" --out trials/compare-outcome", ""))), "no --out").toBe(NOT);
    for (const extra of [" --seeds 5", " --hospital x", " --ward W5", " --outcome-model", " --days", " stray"]) expect(refusal(() => build(undefined, SOURCE + extra)), extra).toBe(NOT);
    expect(refusal(() => compareBlocks(JSON.stringify(fixture), "npm run realism", NODE))).toBe("--source is not a compare command line");
  });

  it("--out and --compare, on the file system", () => {
    expect(refusal(() => checkOut("--out", "src/realism.ts"))).toBe("--out exists");
    expect(refusal(() => checkOut("--out", "src/nowhere/o.json"))).toBe("--out: parent folder does not exist");
    expect(refusal(() => checkOut("--out", "src/realism.ts/o.json"))).toBe("--out: parent is not a folder");
    const dir = mkdtempSync(join(tmpdir(), "export-test-"));
    try {
      symlinkSync(join(dir, "nowhere"), join(dir, "dangling"));
      expect(refusal(() => checkOut("--out", join(dir, "dangling")))).toBe("--out exists");
      expect(() => checkOut("--out", join(dir, "new.json"))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true });
    }
    expect(() => checkOut("--out", "src/new-file.json")).not.toThrow();
    expect(refusal(() => readCompare("src/nowhere.json"))).toBe('--compare: cannot read "src/nowhere.json"');
    expect(refusal(() => readCompare(`src/${"x".repeat(60)}.json`))).toBe(`--compare: cannot read "src/${"x".repeat(36)}"`);
    expect(refusal(() => readCompare("src"))).toBe("--compare: not a regular file");
    expect(refusal(() => readCompare("src/export-evaluation.fixture.json", 10))).toBe("--compare: over 1024 KB");
    expect(readCompare("src/export-evaluation.fixture.json")).toBe(read("./export-evaluation.fixture.json"));
    expect(refusal(() => decode(new Uint8Array([0xff, 0xfe])))).toBe("--compare: not valid UTF-8 JSON");
    expect(refusal(() => build("{"))).toBe("--compare: not valid UTF-8 JSON");
    expect(refusal(() => build("[]"))).toBe("--compare: not valid UTF-8 JSON");
  });

  it("compare.json: the top level", () => {
    expect(refusal(() => build(mutate((c) => (c.compare_format = 2))))).toBe("--compare: compare_format must be 1");
    expect(refusal(() => build(mutate((c) => (c.synthetic = false))))).toBe("--compare: synthetic must be true");
    expect(refusal(() => build(mutate((c) => (c.mode = "w4"))))).toBe('--compare: mode must be "w4_seeds" (made with --seeds)');
    expect(refusal(() => build(mutate((c) => (c.change.kind = "config"))))).toBe('--compare: change.kind must be "rule"');
    expect(refusal(() => buildSimulator({ realism, compare: JSON.stringify(fixture), date: DATE, commit: COMMIT, source: SOURCE, nodeMajor: NODE + 1 }))).toBe(`Node ${NODE + 1} differs from compare.json node_major ${NODE}`);
  });

  it("compare.json: a missing, unknown or mistyped key", () => {
    expect(refusal(() => build(mutate((c) => delete c.spread)))).toBe("--compare: spread is missing");
    expect(refusal(() => build(mutate((c) => delete c.spread.lead_median_minutes)))).toBe("--compare: spread.lead_median_minutes is missing");
    expect(refusal(() => build(mutate((c) => (c.arms.change.pooled.new_metric = 1))))).toBe("--compare: arms.change.pooled.new_metric is an unknown key");
    expect(refusal(() => build(mutate((c) => delete c.difference.pooled.bins)))).toBe("--compare: difference.pooled.bins is missing");
    expect(refusal(() => build(mutate((c) => delete c.outcome_model.parameter.anchor_tag)))).toBe("--compare: outcome_model.parameter.anchor_tag is missing");
    expect(refusal(() => build(mutate((c) => (c.outcome_model.arms.change.extra = 1))))).toBe("--compare: outcome_model.arms.change.extra is an unknown key");
    expect(refusal(() => build(mutate((c) => (c.baseline = 5))))).toBe("--compare: baseline is not text");
    expect(refusal(() => build(mutate((c) => (c.outcome_model.assumption = null))))).toBe("--compare: outcome_model.assumption is not text");
    expect(refusal(() => build(mutate((c) => (c.notes = "x"))))).toBe("--compare: notes is not a list");
    expect(refusal(() => build(mutate((c) => (c.outcome_model.sensitivity.reverse()))))).toBe("--compare: outcome_model.sensitivity must hold zero, half, central, double in that order");
  });

  it("compare.json: a number of the wrong kind is refused, never re-rounded", () => {
    expect(refusal(() => build(mutate((c) => (c.arms.baseline.pooled.alerts_per_patient_per_12h_shift = 0.34831))))).toBe("--compare: arms.baseline.pooled.alerts_per_patient_per_12h_shift is not a d4 number");
    expect(refusal(() => build(mutate((c) => (c.arms.baseline.pooled.alerts = 5334.5))))).toBe("--compare: arms.baseline.pooled.alerts is not an int");
    expect(refusal(() => build(mutate((c) => (c.difference.pooled.bins = null))))).toBe("--compare: difference.pooled.bins is not an int");
    expect(refusal(() => build(mutate((c) => (c.spread.sd = 1))))).toMatch(/is an unknown key/);
    expect(refusal(() => build(mutate((c) => (c.spread.lead_median_minutes.seeds_with_value = 1.5))))).toBe("--compare: spread.lead_median_minutes.seeds_with_value is not an int");
    expect(refusal(() => build(mutate((c) => (c.paired_episodes.mean = -16.12501))))).toBe("--compare: paired_episodes.mean is not a d4 number");
    expect(refusal(() => build(mutate((c) => (c.outcome_model.parameter.value = 1.02001))))).toBe("--compare: outcome_model.parameter.value is not a d4 number");
    expect(refusal(() => build(mutate((c) => (c.outcome_model.paired_episodes.change_later = 0.5))))).toBe("--compare: outcome_model.paired_episodes.change_later is not an int");
    expect(refusal(() => build(mutate((c) => (c.seeds[2] = 3.5))))).toBe("--compare: seeds[2] is not an int");
    // past 2^53 the parsed number is no longer the one in the file; a huge d4 would be written in exponent form
    expect(refusal(() => build(JSON.stringify(fixture).replace(/("alerts":)\d+/, "$19007199254740993")))).toMatch(/pooled\.alerts is not an int$/);
    expect(refusal(() => build(mutate((c) => (c.arms.baseline.pooled.alerts = 1e300))))).toBe("--compare: arms.baseline.pooled.alerts is not an int");
    expect(refusal(() => build(mutate((c) => (c.paired_episodes.mean = 1e300))))).toBe("--compare: paired_episodes.mean is not a d4 number");
    expect(build(mutate((c) => (c.arms.baseline.pooled.lead_median_minutes = null)))).toContain('"baseline": null');
  });

  it("compare.json: the label", () => {
    for (const label of ["model assumption", OUTCOME_LABEL.slice(0, -1), `${OUTCOME_LABEL} `, OUTCOME_LABEL.toLowerCase()]) {
      expect(refusal(() => build(mutate((c) => (c.outcome_model.label = label)))), label).toBe(`--compare: outcome_model.label is not "${OUTCOME_LABEL}"`);
    }
  });

  it("caps: at the cap passes, one over refuses", () => {
    const at = (f: (c: J) => void) => build(mutate(f));
    const note = (n: number) => (c: J) => (c.notes = Array(n).fill("x"));
    expect(() => at(note(20))).not.toThrow();
    expect(refusal(() => at(note(21)))).toBe("notes: 21 items, the cap is 20");
    const long = (n: number) => (c: J) => (c.notes[0] = "x".repeat(n));
    expect(() => at(long(1200))).not.toThrow();
    expect(refusal(() => at(long(1201)))).toBe("notes[0]: 1201 characters, the cap is 1200");
    const text = (key: string) => (n: number) => (c: J) => (c.outcome_model[key] = "x".repeat(n));
    expect(() => at(text("assumption")(1000))).not.toThrow();
    expect(refusal(() => at(text("assumption")(1001)))).toBe("outcome_model.assumption: 1001 characters, the cap is 1000");
    expect(() => at(text("recognition_rule")(1000))).not.toThrow();
    expect(refusal(() => at(text("recognition_rule")(1001)))).toMatch(/recognition_rule: 1001 characters/);
    const reference = (n: number) => (c: J) => (c.outcome_model.parameter.reference = "x".repeat(n));
    expect(() => at(reference(1200))).not.toThrow();
    expect(refusal(() => at(reference(1201)))).toBe("outcome_model.parameter.reference: 1201 characters, the cap is 1200");
    const onotes = (n: number) => (c: J) => (c.outcome_model.notes = Array(n).fill("x"));
    expect(() => at(onotes(20))).not.toThrow();
    expect(refusal(() => at(onotes(21)))).toBe("outcome_model.notes: 21 items, the cap is 20");
    // 100 seeds, with a source that says so
    const seeds = (n: number) => ({ text: mutate((c) => (c.seeds = Array.from({ length: n }, (_, i) => i + 1))), source: SOURCE.replace("--seeds 20", `--seeds ${n}`) });
    expect(() => build(seeds(100).text, seeds(100).source)).not.toThrow();
    expect(refusal(() => build(seeds(101).text, seeds(101).source))).toBe("seeds: 101 items, the cap is 100");
  });

  it("caps on the realism side and the file", () => {
    const row = realism.rows[0];
    const rows = (n: number) => ({ ...realism, rows: Array(n).fill(row) });
    expect(() => build(undefined, SOURCE, rows(200))).not.toThrow();
    expect(refusal(() => build(undefined, SOURCE, rows(201)))).toBe("body.realism.rows: 201 items, the cap is 200");
    expect(refusal(() => build(undefined, SOURCE, { ...realism, notes: Array(11).fill("x") }))).toBe("body.realism.notes: 11 items, the cap is 10");
    const padded = (n: number) => ({ ...realism, rows: [{ ...row, statistic: "x".repeat(n) }, ...realism.rows.slice(1)] });
    const base = new TextEncoder().encode(build(undefined, SOURCE, padded(0))).length;
    expect(new TextEncoder().encode(build(undefined, SOURCE, padded(262144 - base))).length).toBe(262144);
    expect(refusal(() => build(undefined, SOURCE, padded(262144 - base + 1)))).toBe("the file is 262145 bytes, the cap is 262144");
  });

  it("banned phrases and absolute paths, in any case and in every string", () => {
    const note = (s: string) => build(mutate((c) => (c.notes[0] = s)));
    for (const p of ["AI predicts deterioration", "reinforcement learning", "self-learning", "conformal guarantee", "fewer false alarms than NEWS2"]) {
      expect(refusal(() => note(`a ${p.toUpperCase()} b`))).toBe(`banned phrase "${p.toLowerCase()}" in body.compare.notes[0]`);
    }
    expect(refusal(() => note("a validated model"))).toBe('banned phrase "validated" in body.compare.notes[0]');
    expect(refusal(() => build(mutate((c) => (c.outcome_model.notes[1] = "Validated"))))).toBe('banned phrase "validated" in body.outcome.notes[1]');
    expect(() => note("synthetic, not validated")).not.toThrow();
    expect(() => note("Not Validated")).not.toThrow();
    expect(refusal(() => build(undefined, SOURCE, { ...realism, notes: ["self-learning"] }))).toBe('banned phrase "self-learning" in body.realism.notes[0]');
    for (const p of ["/Users/a", "/private/x", "/home/a", "/tmp/a", "/var/a", "/opt/x", "/Volumes/x/y", "~/x", "~user/x", "`/Users/a`", "[/Users/a]", ",/tmp/x", ";/etc/x", "</tmp/x>", "|/tmp/x", "file:///Users/a/x", "\\\\server\\share", "C:\\a"]) expect(refusal(() => note(`see ${p}`)), p).toBe("an absolute path in body.compare.notes[0]");
    expect(refusal(() => note("/etc/x at the start"))).toBe("an absolute path in body.compare.notes[0]");
    for (const ok of ["trials/tmp/x", "src/sim/fitted.json", "doi:10.1186/s13054-021-03650-1", "173 / 632", "https://doi.org/10.1186/x"]) expect(() => note(`see ${ok}`), ok).not.toThrow();
    // the source is scanned with the compare-side checks, before the slow run
    expect(refusal(() => compareBlocks(JSON.stringify(fixture), SOURCE.replace("trials/compare-outcome", "/opt/c"), NODE))).toBe("an absolute path in --source");
    expect(refusal(() => compareBlocks(JSON.stringify(fixture), SOURCE.replace("trials/compare-outcome", "~/c"), NODE))).toBe("an absolute path in --source");
    expect(refusal(() => compareBlocks(JSON.stringify(fixture), SOURCE.replace("trials/compare-outcome", "validated"), NODE))).toBe('banned phrase "validated" in --source');
  });

  it("compareBlocks checks before the slow run", () => {
    expect(refusal(() => compareBlocks(JSON.stringify(fixture), SOURCE, NODE + 1))).toMatch(/^Node /);
  });
});
