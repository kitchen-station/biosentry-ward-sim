import { describe, expect, it } from "vitest";
import dohStandard from "../../../scenarios/hospital/doh-standard.json?raw";
import surge from "../../../scenarios/hospital/surge.json?raw";
import typical from "../../../scenarios/hospital/typical.json?raw";
import { PARAMS, UNITS } from "./params";
import { POISSON_MAX_RATE } from "./rng";
import { MAX_BYTES, MAX_NOTE, parseScenario, RANGES, ScenarioError, type Scenario } from "./scenario";

const units = (ward: number, surgery: number, icu: number): Scenario["units"] => ({
  ICU: { beds: 10, stretchers: 0, nurses: icu },
  MED3A: { beds: 30, stretchers: 8, nurses: ward },
  MED3B: { beds: 30, stretchers: 8, nurses: ward },
  SURG5A: { beds: 24, stretchers: 6, nurses: surgery },
});

// Design section 5, written out by hand so a wrong file cannot agree with itself.
const EXPECTED: Record<string, Scenario> = {
  "doh-standard": {
    name: "doh-standard", note: "DOH staffing standard: wards 1:12, ICU 1:3; arrivals sized for about 87-89% medicine occupancy",
    arrivalsPerDay: 40, startOccupancy: 0.85, transferOutAfterH: 72,
    er: { bays: 10, nurses: 3, doctorsDay: 3, doctorsNight: 2 }, units: units(3, 2, 4),
  },
  typical: {
    name: "typical", note: "Reported PH public reality: wards 1:15-1:20, occupancy above 100%",
    arrivalsPerDay: 60, startOccupancy: 1, transferOutAfterH: 72,
    er: { bays: 10, nurses: 2, doctorsDay: 2, doctorsNight: 2 }, units: units(2, 1, 3),
  },
  surge: {
    name: "surge", note: "Typical staffing with arrivals x1.5 (a judgement)",
    arrivalsPerDay: 90, startOccupancy: 1, transferOutAfterH: 72,
    er: { bays: 10, nurses: 2, doctorsDay: 2, doctorsNight: 2 }, units: units(2, 1, 3),
  },
};
const FILES: Record<string, string> = { "doh-standard": dohStandard, typical, surge };

describe("starter scenarios", () => {
  for (const [name, text] of Object.entries(FILES)) {
    it(`${name} parses and equals the design's table`, () => {
      expect(parseScenario(text)).toEqual(EXPECTED[name]);
    });
  }

  it("keeps each starter's staffing equal to its column in params.ts", () => {
    const row = (id: string) => UNITS.find((u) => u.id === id)!;
    for (const [name, kind] of [["doh-standard", "standard"], ["typical", "typical"], ["surge", "surge"]] as const) {
      const s = parseScenario(FILES[name]);
      expect(s.units.ICU.nurses).toBe(row("ICU").nurses[kind].value);
      expect(s.units.MED3A.nurses).toBe(row("MED3A").nurses[kind].value);
      expect(s.units.SURG5A.nurses).toBe(row("SURG5A").nurses[kind].value);
      expect(s.er.nurses).toBe(row("ER").nurses[kind].value);
      expect(s.er.doctorsDay).toBe(PARAMS.erDoctors.day[kind].value);
      expect(s.er.doctorsNight).toBe(PARAMS.erDoctors.night[kind].value);
      expect(s.arrivalsPerDay).toBe(PARAMS.arrivals.perDay[kind].value);
      expect(s.startOccupancy).toBe(PARAMS.startOccupancy[kind].value);
    }
  });
});

describe("defaults", () => {
  it("fills every key a scenario leaves out, so naming only arrivalsPerDay gives the typical hospital", () => {
    expect(parseScenario('{"arrivalsPerDay": 75}')).toEqual({ ...EXPECTED.typical, name: "custom", note: "", arrivalsPerDay: 75 });
    expect(parseScenario("{}")).toEqual({ ...EXPECTED.typical, name: "custom", note: "" });
  });

  it("changes only the named key inside a section", () => {
    const s = parseScenario('{"er":{"bays":12},"units":{"ICU":{"beds":14}}}');
    expect(s.er).toEqual({ ...EXPECTED.typical.er, bays: 12 });
    expect(s.units.ICU).toEqual({ ...EXPECTED.typical.units.ICU, beds: 14 });
    expect(s.units.MED3A).toEqual(EXPECTED.typical.units.MED3A);
  });

  it("accepts the edges of every range", () => {
    const text = JSON.stringify({
      arrivalsPerDay: 500, startOccupancy: 1.5, transferOutAfterH: 720,
      er: { bays: 200, nurses: 20, doctorsDay: 10, doctorsNight: 1 },
      units: { ICU: { beds: 1, nurses: 1 }, SURG5A: { beds: 200, stretchers: 50 }, MED3A: { stretchers: 0 } },
    });
    expect(parseScenario(text).units.ICU).toEqual({ beds: 1, stretchers: 0, nurses: 1 });
    expect(parseScenario(text).units.SURG5A).toEqual({ beds: 200, stretchers: 50, nurses: 1 });
    expect(parseScenario('{"startOccupancy":0,"arrivalsPerDay":1,"transferOutAfterH":1}').startOccupancy).toBe(0);
  });
});

const REFUSED: [string, string, string][] = [
  ["an unknown top-level key", '{"colour":"red"}', 'scenario: unknown key "colour"'],
  ["an unknown key in er", '{"er":{"chairs":3}}', 'scenario.er: unknown key "chairs"'],
  ["an unknown key in a unit", '{"units":{"ICU":{"windows":3}}}', 'scenario.units.ICU: unknown key "windows"'],
  ["an unknown unit", '{"units":{"MORGUE":{"beds":3}}}', 'scenario.units: unknown key "MORGUE"'],
  ["a negative bed count", '{"units":{"MED3A":{"beds":-1}}}', "scenario.units.MED3A.beds: must be a whole number from 1 to 200"],
  ["zero beds", '{"units":{"MED3A":{"beds":0}}}', "from 1 to 200"],
  ["too many beds", '{"units":{"MED3A":{"beds":201}}}', "from 1 to 200"],
  ["a fractional bed count", '{"units":{"MED3A":{"beds":2.5}}}', "must be a whole number"],
  ["a number as a string", '{"units":{"MED3A":{"beds":"30"}}}', "scenario.units.MED3A.beds: must be a whole number from 1 to 200"],
  ["a string arrivals rate", '{"arrivalsPerDay":"60"}', "scenario.arrivalsPerDay: must be a whole number from 1 to 500"],
  ["a null", '{"startOccupancy":null}', "scenario.startOccupancy: must be a number from 0 to 1.5"],
  ["too many stretchers", '{"units":{"SURG5A":{"stretchers":51}}}', "from 0 to 50"],
  ["no nurses", '{"units":{"SURG5A":{"nurses":0}}}', "from 1 to 20"],
  ["too many nurses", '{"er":{"nurses":21}}', "scenario.er.nurses: must be a whole number from 1 to 20"],
  ["no doctors", '{"er":{"doctorsDay":0}}', "scenario.er.doctorsDay: must be a whole number from 1 to 10"],
  ["too many doctors", '{"er":{"doctorsNight":11}}', "from 1 to 10"],
  ["no arrivals", '{"arrivalsPerDay":0}', "from 1 to 500"],
  ["too many arrivals", '{"arrivalsPerDay":501}', "from 1 to 500"],
  ["a start occupancy over 1.5", '{"startOccupancy":1.6}', "from 0 to 1.5"],
  ["a negative start occupancy", '{"startOccupancy":-0.1}', "from 0 to 1.5"],
  ["a transfer-out time of 0", '{"transferOutAfterH":0}', "from 1 to 720"],
  ["a transfer-out time over 720", '{"transferOutAfterH":721}', "from 1 to 720"],
  ["a number too large for JSON doubles", '{"arrivalsPerDay":1e999}', "from 1 to 500"],
  ["stretchers under the ICU", '{"units":{"ICU":{"stretchers":0}}}', "scenario.units.ICU.stretchers: the ICU has no corridor stretchers"],
  ["constructor at the top", '{"constructor":1}', 'scenario: unknown key "constructor"'],
  ["prototype at the top", '{"prototype":1}', 'scenario: unknown key "prototype"'],
  ["constructor in er", '{"er":{"constructor":1}}', 'scenario.er: unknown key "constructor"'],
  ["prototype in er", '{"er":{"prototype":1}}', 'scenario.er: unknown key "prototype"'],
  ["constructor as a unit", '{"units":{"constructor":{}}}', 'scenario.units: unknown key "constructor"'],
  ["prototype as a unit", '{"units":{"prototype":{}}}', 'scenario.units: unknown key "prototype"'],
  ["constructor in a unit", '{"units":{"MED3A":{"constructor":1}}}', 'scenario.units.MED3A: unknown key "constructor"'],
  ["prototype in a unit", '{"units":{"SURG5A":{"prototype":1}}}', 'scenario.units.SURG5A: unknown key "prototype"'],
  ["W4 under units", '{"units":{"W4":{"beds":30}}}', "scenario.units.W4: W4 is not configurable"],
  ["an upper-case name", '{"name":"Typical"}', "scenario.name: must match"],
  ["a name with a space", '{"name":"a b"}', "scenario.name: must match"],
  ["an empty name", '{"name":""}', "scenario.name: must match"],
  ["a 33-character name", `{"name":"${"a".repeat(33)}"}`, "scenario.name: must match"],
  ["a name that is not text", '{"name":5}', "scenario.name: must match"],
  ["an over-long note", `{"note":"${"x".repeat(MAX_NOTE + 1)}"}`, `at most ${MAX_NOTE} characters`],
  ["a note that is not text", '{"note":["x"]}', "scenario.note: must be plain text"],
  ["er that is not an object", '{"er":5}', "scenario.er: must be an object"],
  ["units that is a list", '{"units":[]}', "scenario.units: must be an object"],
  ["a unit that is null", '{"units":{"ICU":null}}', "scenario.units.ICU: must be an object"],
  ["a list at the top", "[]", "scenario: must be an object"],
  ["text that is not JSON", "{nope", "scenario: not valid JSON"],
];

describe("refusals", () => {
  for (const [what, text, message] of REFUSED) {
    it(`refuses ${what} with one clear line`, () => {
      let error: unknown;
      try {
        parseScenario(text);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ScenarioError);
      const line = (error as Error).message;
      expect(line).toContain(message);
      expect(line).not.toMatch(/[\r\n]/);
    });
  }

  it("refuses a file over 16 KB, even when it is valid JSON", () => {
    const big = `${" ".repeat(MAX_BYTES)}{}`;
    expect(() => parseScenario(big)).toThrow("scenario: file is over 16 KB");
    expect(() => parseScenario(`${" ".repeat(MAX_BYTES - 2)}{}`)).not.toThrow();
  });

  it("counts bytes, not characters, against the 16 KB", () => {
    const wide = `{"note":"${"é".repeat(MAX_NOTE)}"}`; // fine: 200 characters
    expect(() => parseScenario(wide)).not.toThrow();
    expect(() => parseScenario(`{"note":"${"é".repeat(MAX_BYTES / 2)}"}`)).toThrow("16 KB");
  });

  // Each of these is a character an earlier version of clean() let through (and the first two are the usual suspects).
  const HOSTILE_CHARS = "\u202e\n\u2028\u2029\u200b\u200c\u200d\u2060\ufeff\u00ad\ud800";
  const BAD = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ud800-\udfff]/;

  it("never lets a hostile key reach a message raw", () => {
    const hostile = `x${HOSTILE_CHARS}y${"a".repeat(100)}`;
    const cases = [
      { [hostile]: 1 },
      { er: { [hostile]: 1 } },
      { units: { [hostile]: {} } },
      { units: { ICU: { [hostile]: 1 } } },
    ];
    for (const c of cases) {
      let line = "";
      try {
        parseScenario(JSON.stringify(c));
      } catch (e) {
        line = (e as Error).message;
      }
      expect(line).toContain("unknown key");
      expect(line).not.toMatch(BAD);
      expect(line).not.toContain("a".repeat(41));
      expect(line).toContain(`x${"?".repeat(11)}y`);
      expect(line.length).toBeLessThan(120);
    }
  });

  it("refuses a note with any control, direction, zero-width or line-separator character", () => {
    for (const ch of HOSTILE_CHARS) {
      const text = JSON.stringify({ note: `a${ch}b` });
      expect(() => parseScenario(text), JSON.stringify(ch)).toThrow("scenario.note: must be plain text");
    }
    expect(() => parseScenario('{"note":"tab\\there"}')).toThrow("plain text");
    expect(parseScenario('{"note":"Plain, with punctuation: 1:15 (x1.5)."}').note).toBe("Plain, with punctuation: 1:15 (x1.5).");
    expect(parseScenario(`{"note":"${"n".repeat(MAX_NOTE)}"}`).note).toHaveLength(MAX_NOTE);
  });

  it("turns -0 into 0", () => {
    const s = parseScenario('{"startOccupancy":-0,"er":{"bays":10},"units":{"MED3A":{"stretchers":-0}}}');
    expect(Object.is(s.startOccupancy, 0)).toBe(true);
    expect(Object.is(s.units.MED3A.stretchers, 0)).toBe(true);
  });

  it("lets the last of a repeated key win", () => {
    expect(parseScenario('{"arrivalsPerDay":10,"arrivalsPerDay":20}').arrivalsPerDay).toBe(20);
    expect(parseScenario('{"arrivalsPerDay":"x","arrivalsPerDay":20}').arrivalsPerDay).toBe(20);
    expect(() => parseScenario('{"arrivalsPerDay":20,"arrivalsPerDay":"x"}')).toThrow("scenario.arrivalsPerDay");
  });

  it("never echoes the note or the name", () => {
    for (const text of [
      `{"note":"SECRET${"x".repeat(MAX_NOTE)}"}`,
      '{"note":{"SECRET":1}}',
      '{"name":"SECRET NAME"}',
      '{"SECRET":1,"note":"SECRET"}',
    ]) {
      let line = "";
      try {
        parseScenario(text);
      } catch (e) {
        line = (e as Error).message;
      }
      expect(line.length).toBeGreaterThan(0);
      if (!text.startsWith('{"SECRET"')) expect(line).not.toContain("SECRET");
    }
  });

  it("refuses __proto__ as a key without polluting anything", () => {
    expect(() => parseScenario('{"__proto__":{"beds":1}}')).toThrow('unknown key "__proto__"');
    expect(({} as Record<string, unknown>).beds).toBeUndefined();
  });
});

type Tree = unknown;
const SOURCES = ["cited", "unverified", "judgement", "w4_code"];
/** Everything wrong with a tree of defaults: a leaf is an object with a `value`, and every leaf needs a source and a note. */
function problems(tree: Tree, path = "params"): string[] {
  if (typeof tree !== "object" || tree === null) return [`${path}: a bare value with no source`];
  if (Array.isArray(tree)) return tree.flatMap((x, i) => problems(x, `${path}[${i}]`));
  const o = tree as Record<string, unknown>;
  if (!("value" in o)) return Object.entries(o).flatMap(([k, v]) => problems(v, `${path}.${k}`));
  const { source, note } = o as { source?: string; note?: string };
  const out: string[] = [];
  if (!source || !SOURCES.includes(source)) out.push(`${path}: no valid source`);
  if (typeof note !== "string" || !note.trim()) return [...out, `${path}: no note`];
  if ((source === "cited" || source === "unverified") && !/https?:\/\/\S+/.test(note)) out.push(`${path}: ${source} without a URL`);
  if (source === "judgement" && !/better:/i.test(note)) out.push(`${path}: judgement that does not say what would replace it`);
  if (source === "w4_code" && !/W4 code/.test(note)) out.push(`${path}: w4_code that does not say so`);
  return out;
}

function leaves(tree: Tree, found: { source: string }[] = []) {
  if (Array.isArray(tree)) tree.forEach((x) => leaves(x, found));
  else if (typeof tree === "object" && tree !== null) {
    if ("value" in tree) found.push(tree as unknown as { source: string });
    else Object.values(tree).forEach((x) => leaves(x, found));
  }
  return found;
}

describe("params", () => {
  it("gives every default a source, a note, a URL when published, and a better source when ours", () => {
    const unitValues = UNITS.map(({ id, name, floor, ...tagged }) => tagged); // id, name and floor are structure, not defaults
    expect(problems({ PARAMS, unitValues }, "p")).toEqual([]);
    expect(leaves({ PARAMS, unitValues }).length).toBeGreaterThan(100);
  });

  it("would fail on a value with no source or an empty note", () => {
    expect(problems({ a: 5 })).toHaveLength(1);
    expect(problems({ a: { value: 5 } })).not.toEqual([]);
    expect(problems({ a: { value: 5, source: "cited", note: "" } })).not.toEqual([]);
    expect(problems({ a: { value: 5, source: "cited", note: "no link" } })).not.toEqual([]);
    expect(problems({ a: { value: 5, source: "judgement", note: "just because" } })).not.toEqual([]);
    expect(problems({ a: { value: 5, source: "guess", note: "x https://x.org better:" } })).not.toEqual([]);
  });

  it("holds the units of section 1", () => {
    expect(UNITS.map((u) => [u.id, u.floor, u.beds.value, u.stretchers.value, u.residents.value])).toEqual([
      ["ER", 0, 10, 0, 0], ["MORGUE", 0, 6, 0, 0], ["ICU", 2, 10, 0, 1], ["MED3A", 3, 30, 8, 1],
      ["MED3B", 1, 30, 8, 1], ["W4", 4, 20, 0, 0], ["SURG5A", 5, 24, 6, 1],
    ]);
    const inpatient = UNITS.filter((u) => !["ER", "MORGUE"].includes(u.id)).reduce((a, u) => a + u.beds.value, 0);
    expect(inpatient).toBe(114);
    expect(UNITS.find((u) => u.id === "W4")!.nurses.typical.source).toBe("w4_code");
  });

  it("fits the two read facts about medicine stays, from the stored parameters", () => {
    const { medianDays, sigma, normalGroupMedianDays, shareAtLeast14Days } = PARAMS.stay.medicine;
    const mu = Math.log(medianDays.value);
    // Normal CDF (Abramowitz-Stegun 7.1.26, error 1.5e-7).
    const cdf = (z: number) => {
      const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
      const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
      const erf = 1 - poly * Math.exp(-(z * z) / 2);
      return z >= 0 ? 0.5 + erf / 2 : 0.5 - erf / 2;
    };
    const F = (days: number) => cdf((Math.log(days) - mu) / sigma.value);
    expect(1 - F(14)).toBeCloseTo(shareAtLeast14Days.value, 2);
    let lo = 0.1, hi = 14; // median of the stays under 14 days: F(x) = F(14) / 2
    for (let i = 0; i < 60; i += 1) {
      const mid = (lo + hi) / 2;
      if (F(mid) < F(14) / 2) lo = mid;
      else hi = mid;
    }
    expect(Math.abs(lo - normalGroupMedianDays.value)).toBeLessThan(0.02);
  });

  it("stores each decision delay's median as its mean x exp(-sigma^2 / 2), the value lognormal() takes", () => {
    const { sigma, meanH, medianH } = PARAMS.decisionDelay;
    for (const t of ["emergent", "urgent", "non_urgent"] as const) {
      expect(Math.abs(meanH[t].value * Math.exp(-(sigma.value ** 2) / 2) - medianH[t].value)).toBeLessThan(0.001);
    }
  });

  it("keeps the worst accepted hourly arrival rate under the Poisson cap, which a block rate would break", () => {
    const worstShare = Math.max(...PARAMS.arrivals.blockShares.value);
    const hourly = (RANGES.arrivalsPerDay[1] * worstShare) / 8;
    expect(hourly).toBeCloseTo(26.5, 1);
    expect(hourly).toBeLessThan(POISSON_MAX_RATE);
    expect(RANGES.arrivalsPerDay[1] * worstShare).toBeGreaterThan(POISSON_MAX_RATE);
  });

  it("keeps the design's people values", () => {
    const p = PARAMS.people;
    expect([p.maleShare.value, p.ageMean.value, p.ageSd.value, p.ageRange.value, p.cardiacAgeRange.value, p.namePool.value]).toEqual([0.479, 50.1, 16.7, [18, 95], [45, 84], { surnames: 80, givenPerSex: 40 }]);
    expect([PARAMS.warmUpDays.value, PARAMS.w4.attendings.value]).toEqual([3, 2]);
  });

  it("is internally consistent with the design's arithmetic", () => {
    const sum = (o: Record<string, { value: number } | unknown>, keys: string[]) =>
      keys.reduce((a, k) => a + (o[k] as { value: number }).value, 0);
    const groups = ["cardiac", "stroke", "hypertensive", "respiratory", "infection", "trauma", "minor"];
    expect(sum(PARAMS.complaint, groups)).toBeCloseTo(1, 9);
    expect(sum(PARAMS.triage, ["emergent", "urgent", "non_urgent"])).toBeCloseTo(1, 9);
    expect(PARAMS.arrivals.blockShares.value.reduce((a, x) => a + x, 0)).toBeCloseTo(1, 2);
    const admit = groups.reduce((a, g) => a + (PARAMS.complaint as Record<string, { value: number }>)[g].value * (PARAMS.admitRate as Record<string, { value: number }>)[g].value, 0);
    expect(admit).toBeCloseTo(0.283, 3);
    expect(Math.abs(admit - PARAMS.anchors.erAdmitShare.value)).toBeLessThan(0.01);
    const erDeath = PARAMS.triage.emergent.value * PARAMS.death.erPhase.emergent.value + PARAMS.triage.urgent.value * PARAMS.death.erPhase.urgent.value;
    expect(Math.abs(erDeath - PARAMS.death.erOverall.value)).toBeLessThan(0.002);
    const { medianDays, sigma } = PARAMS.icuStay;
    expect(Math.abs(medianDays.value * Math.exp(sigma.value ** 2 / 2) - PARAMS.icuStay.meanDays.value)).toBeLessThan(0.05);
    expect(Math.abs(Math.log(10.5 / 2) / 1.349 - PARAMS.stay.stroke.sigma.value)).toBeLessThan(0.005);
  });
});

// A grep, not a type: it catches a clock or an unseeded draw wherever it is written under src/sim.
describe("determinism by grep", () => {
  const files = import.meta.glob(["/src/sim/**/*.ts", "!/src/sim/**/*.test.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const BANNED: [string, RegExp][] = [
    ["Math.random", /Math\s*\.\s*random/],
    ["Date.now", /Date\s*\.\s*now/],
    ["new Date", /new\s+Date\b/],
    ["Date()", /(?<![\w.$])Date\s*\(/],
    ["crypto.getRandomValues", /crypto\s*\.\s*getRandomValues/],
    ["crypto.randomUUID", /crypto\s*\.\s*randomUUID/],
    ["performance.now", /performance\s*\.\s*now/],
  ];
  // sync.ts stamps the API outbox with the real time when a run starts; it is not part of the seeded ward.
  // Exactly this one line, once: a second copy of it is reported like any other hit.
  const ALLOWED: Record<string, string[]> = { "/src/sim/sync.ts": ["origin = new Date().toISOString();"] };

  const hits = () =>
    Object.entries(files).flatMap(([file, text]) => {
      const unused = [...(ALLOWED[file] ?? [])];
      return text.split("\n").flatMap((line, n) => {
        const found = BANNED.filter(([, re]) => re.test(line)).map(([name]) => `${file}:${n + 1}: ${name}`);
        const at = unused.indexOf(line.trim());
        if (found.length && at >= 0) {
          unused.splice(at, 1);
          return [];
        }
        return found;
      });
    });

  it("scans the sim's source files, hospital files among them", () => {
    expect(Object.keys(files).length).toBeGreaterThan(10);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["/src/sim/hospital/rng.ts", "/src/sim/hospital/params.ts", "/src/sim/source.ts"]));
    expect(files["/src/sim/sync.ts"]).toContain("origin = new Date().toISOString();"); // the allowance still points at a real line
  });

  it("finds no clock and no unseeded random under src/sim", () => {
    expect(hits()).toEqual([]);
  });
});
