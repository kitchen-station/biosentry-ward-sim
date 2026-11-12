import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scoreNews2 } from "./news2";
import { STAFF } from "./sim";
import fixture from "./synthetic.json";
import {
  COHORT_HEADER,
  EPISODES_HEADER,
  parseScenario,
  runTrial,
  SCENARIO_V1,
  TRIAL_SPEED,
  TrialRefusal,
  type TrialFiles,
} from "./trial";

const text = readFileSync("scenarios/default.json", "utf8");
const scenario = parseScenario(text);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const trial = (seed: number, days: number) => runTrial({ scenario, seed, days, scenarioSha256: "0".repeat(64), simCommit: "test", nodeMajor: 24 });
const hashes = (f: TrialFiles) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, sha(v)]));
const rows = (csv: string) => csv.trimEnd().split("\n").slice(1).map((l) => l.split(","));

// Copied from src/sim/source.ts (SURNAMES and GIVEN are not exported); a test below keeps the copy from going stale.
const SURNAMES = ["Ocampo", "Lim", "Bautista", "Rivera", "Tolentino", "Gonzales", "Mercado", "Flores", "Santiago", "Cruz", "Valdez", "Soriano"];
const GIVEN = ["Luz", "Carmen", "Nenita", "Imelda", "Josefina", "Remedios", "Ramon", "Antonio", "Danilo", "Ernesto", "Rogelio", "Alfredo"];
const words = (names: string[]) => names.flatMap((r) => r.split(/[ ,.]+/)).filter((w) => w.length > 2);
// The fixture's patients and the staff come from the sim's own data, not from a copy.
const fixtureNames = words([...(fixture as { ranked: { name: string }[] }).ranked, ...(fixture as { unscored: { name: string }[] }).unscored].map((r) => r.name));
const staffNames = words(STAFF.map((m) => m[1]));

describe("scenario", () => {
  it("accepts scenarios/default.json, which holds exactly today's values", () => {
    expect(JSON.parse(text)).toEqual({ ...SCENARIO_V1, name: "default" });
    expect(SCENARIO_V1.beds).toBe(20);
    expect(SCENARIO_V1.staffing).toEqual({ staff_nurses: 2, charge_nurses: 1, physicians: 2 });
  });

  it("keeps the copied name lists equal to the lists in source.ts", () => {
    const source = readFileSync("src/sim/source.ts", "utf8");
    const quoted = (block: string) => [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(quoted(/const SURNAMES = \[(.*?)\];/s.exec(source)![1])).toEqual(SURNAMES);
    expect(quoted(/const GIVEN[^=]*= \{(.*?)\};/s.exec(source)![1])).toEqual(GIVEN);
  });

  it("pins the occupancy constant that source.ts does not export", () => {
    expect(readFileSync("src/sim/source.ts", "utf8")).toContain("const OCCUPANCY = 0.75;");
  });

  const edit = (f: (o: any) => void) => {
    const o = JSON.parse(text);
    f(o);
    return JSON.stringify(o);
  };
  const refused: [string, string, RegExp][] = [
    ["malformed JSON", "{ nope", /not valid JSON/],
    ["not an object", "[]", /must be an object/],
    ["oversized file", `${text.slice(0, -2)}${" ".repeat(16 * 1024)}}`, /over 16384 bytes/],
    ["unknown top key", edit((o) => (o.extra = 1)), /unknown key "extra"/],
    ["unknown nested key", edit((o) => (o.staffing.interns = 1)), /unknown key "interns" in "staffing"/],
    ["__proto__ key", text.replace("{", '{"__proto__": 1,'), /unknown key "__proto__"/],
    ["missing key", edit((o) => delete o.beds), /missing key "beds"/],
    ["version 2", edit((o) => (o.format_version = 2)), /"format_version" must be 1/],
    ["more beds", edit((o) => (o.beds = 30)), /"beds" must be 20.*got 30/],
    ["more nurses", edit((o) => (o.staffing.staff_nurses = 3)), /"staffing.staff_nurses"/],
    ["other occupancy", edit((o) => (o.arrivals.occupancy_target = 0.9)), /"arrivals.occupancy_target" must be 0.75/],
    ["other case mix", edit((o) => (o.case_mix = "icu")), /"case_mix"/],
    ["a value of the wrong type", edit((o) => (o.beds = "20")), /"beds"/],
    ["a name that is free text", edit((o) => (o.name = "Dr. Cruz")), /"name"/],
  ];
  it.each(refused)("refuses %s with one line", (_label, body, pattern) => {
    let error: unknown;
    try {
      parseScenario(body);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TrialRefusal);
    expect((error as Error).message).toMatch(pattern);
    expect((error as Error).message).not.toContain("\n");
  });

  it("keeps the last of a repeated key, and checks that one", () => {
    expect(() => parseScenario(text.replace('"beds": 20', '"beds": 20, "beds": 30'))).toThrow(/"beds" must be 20.*got 30/);
    expect(parseScenario(text.replace('"beds": 20', '"beds": 30, "beds": 20')).beds).toBe(20);
  });

  it("accepts and refuses names by the pattern", () => {
    const named = (name: string) => parseScenario(edit((o) => (o.name = name)));
    for (const ok of ["a", "default", "x-1_y", "0abc", "a".repeat(32)]) expect(named(ok).name).toBe(ok);
    for (const bad of ["", "Default", "-a", "_a", "a b", "a,b", "é", "a\n", "a".repeat(33), "=cmd"]) expect(() => named(bad)).toThrow(/"name"/);
  });

  it("echoes no control, DEL, C1 or direction character from the file", () => {
    const hostile = "x\u009by\u202ez\u007fw\u2066v\u0007u\u200e\u200f\u061c\u2028\u2029\ufeff";
    for (const body of [edit((o) => (o[hostile] = 1)), edit((o) => (o.beds = hostile)), edit((o) => (o.staffing[hostile] = 1))]) {
      let line = "";
      try {
        parseScenario(body);
      } catch (e) {
        line = (e as Error).message;
      }
      expect(line).toContain("?");
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c\u2028\u2029\ufeff]/);
    }
  });
});

describe("trial", () => {
  const two = trial(1, 2); // about 1 s
  const three = trial(7, 3); // about 1.5 s

  it("is byte-identical for the same seed and scenario, and differs for another seed", () => {
    expect(hashes(trial(1, 2))).toEqual(hashes(two));
    for (const name of ["cohort.csv", "episodes.csv"] as const) expect(sha(trial(2, 2)[name])).not.toBe(sha(two[name]));
  }, 60_000); // two full trials: about 2 s alone, over the default 5 s on a busy machine

  it("writes the contract's headers, line ends and manifest", () => {
    const m = JSON.parse(two["manifest.json"]);
    expect(m).toMatchObject({ format_version: 1, synthetic: true, seed: 1, days: 2, speed: TRIAL_SPEED, bin_minutes: 15, sim_commit: "test", node_major: 24 });
    expect(Object.keys(m)).toEqual(["format_version", "synthetic", "seed", "days", "speed", "scenario", "scenario_sha256", "sim_commit", "node_major", "bin_minutes", "patients", "episodes"]);
    expect(m.scenario).toEqual(scenario);
    expect(two["cohort.csv"].split("\n")[0]).toBe(COHORT_HEADER);
    expect(two["episodes.csv"].split("\n")[0]).toBe(EPISODES_HEADER);
    for (const f of Object.values(two)) {
      expect(f.endsWith("\n")).toBe(true);
      expect(f).not.toMatch(/\r| \n/);
    }
    expect(m.patients).toBe(rows(two["episodes.csv"]).length);
  });

  it("holds the inputs the scorer used: every row re-scores to its news2, on 15-minute bins inside the stay", () => {
    const stays = new Map(rows(three["episodes.csv"]).map((r) => [r[0], r]));
    const body = rows(three["cohort.csv"]);
    expect(body.length).toBeGreaterThan(1000);
    for (const [id, minute, hr, rr, spo2, temp, sys, , , acvpu, o2, scale, , ranked, news2] of body) {
      const m = Number(minute);
      expect(m % 15).toBe(0);
      expect(m).toBeGreaterThan(0);
      expect(m).toBeLessThan(3 * 1440);
      const stay = stays.get(id)!;
      expect(m).toBeGreaterThanOrEqual(Number(stay[1]));
      if (stay[2] !== "") expect(m).toBeLessThanOrEqual(Number(stay[2]));
      const n = (v: string) => (v === "" ? null : Number(v));
      const r = scoreNews2({
        respiratory_rate: n(rr),
        spo2: n(spo2),
        spo2_scale: Number(scale) as 1 | 2,
        supplemental_o2: o2 === "1",
        systolic_bp: n(sys),
        heart_rate: n(hr),
        consciousness: acvpu as "A",
        temperature: n(temp),
      });
      expect(ranked).toBe(r.kind === "score" ? "1" : "0");
      expect(news2).toBe(r.kind === "score" ? String(r.total) : "");
    }
    // Both kinds of row occur, so the check above is not vacuous.
    expect(body.some((r) => r[13] === "1")).toBe(true);
    // bp_minute is the minute the cuff reading was taken: never after the row, empty exactly when there is no pressure.
    for (const r of body) expect(r[6] === "" ? r[8] === "" : Number(r[8]) <= Number(r[1])).toBe(true);
  });

  it("starts no field with = + or @, and no text field with -", () => {
    const check = (csv: string, textColumns: number[]) => {
      for (const row of rows(csv)) {
        row.forEach((f, i) => {
          expect(f).not.toMatch(/^[=+@]/);
          if (textColumns.includes(i)) expect(f).not.toMatch(/^-/);
        });
      }
    };
    check(three["cohort.csv"], [0, 9]); // patient, consciousness
    check(three["episodes.csv"], [0, 3, 4]); // patient, outcome, episode_kind
  });

  it("starts no field with = + or @, and no text field with -", () => {
    const check = (csv: string, textColumns: number[]) => {
      for (const row of rows(csv)) {
        row.forEach((f, i) => {
          expect(f).not.toMatch(/^[=+@]/);
          if (textColumns.includes(i)) expect(f).not.toMatch(/^-/);
        });
      }
    };
    check(three["cohort.csv"], [0, 9]); // patient, consciousness
    check(three["episodes.csv"], [0, 3, 4]); // patient, outcome, episode_kind
  });

  it("writes ground truth for every patient, with the fixture's persistent AF patient marked", () => {
    const eps = rows(three["episodes.csv"]);
    expect(eps.find((r) => r[0] === "p-009")![9]).toBe("1");
    expect(eps.every((r) => r.length === 10 && (r[3] === "" || ["discharged", "higher_care"].includes(r[3])))).toBe(true);
    const s = JSON.parse(three["summary.json"]);
    expect(s.admitted).toBe(eps.filter((r) => r[0].startsWith("n-")).length);
    expect(s.discharged + s.higher_care).toBe(eps.filter((r) => r[3] !== "").length);
  });

  it("contains no patient or clinician name", () => {
    const all = Object.values(three).join("\n");
    for (const name of [...SURNAMES, ...GIVEN, ...fixtureNames, ...staffNames]) expect(all).not.toContain(name);
    expect(fixtureNames.length).toBeGreaterThan(5);
    expect(staffNames.length).toBeGreaterThan(3);
  });

  it("finishes a 30-day trial", { timeout: 60_000 }, () => { // about 15 s
    const f = trial(3, 30);
    expect(JSON.parse(f["manifest.json"]).days).toBe(30);
    expect(Math.max(...rows(f["cohort.csv"]).map((r) => Number(r[1])))).toBeLessThan(30 * 1440);
  });
});
