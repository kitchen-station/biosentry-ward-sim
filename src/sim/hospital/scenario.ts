// A scenario is a small JSON; anything it leaves out comes from params.ts. The text is untrusted: every key and number
// is checked, and a refusal is one line that never echoes more than a short, cleaned fragment.
import { PARAMS, UNITS } from "./params";

export type UnitScenario = { beds: number; stretchers: number; nurses: number };
export type ConfigurableUnit = "ICU" | "MED3A" | "MED3B" | "SURG5A";
export interface Scenario {
  name: string;
  note: string;
  arrivalsPerDay: number;
  startOccupancy: number;
  transferOutAfterH: number;
  er: { bays: number; nurses: number; doctorsDay: number; doctorsNight: number };
  units: Record<ConfigurableUnit, UnitScenario>;
}

export class ScenarioError extends Error {}

export const MAX_BYTES = 16 * 1024;
export const MAX_NOTE = 200;
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Trust-boundary caps, [min, max]. source: judgement (ours, not from a Philippine source); counts must be whole numbers. */
export const RANGES = {
  beds: [1, 200], stretchers: [0, 50], nurses: [1, 20], doctors: [1, 10],
  arrivalsPerDay: [1, 500], startOccupancy: [0, 1.5], transferOutAfterH: [1, 720],
} as const;

// The default scenario is the "typical" column: the reported Philippine public reality.
const row = (id: string) => UNITS.find((u) => u.id === id)!;
function defaults(): Scenario {
  const unit = (id: ConfigurableUnit): UnitScenario => {
    const u = row(id);
    return { beds: u.beds.value, stretchers: u.stretchers.value, nurses: u.nurses.typical.value };
  };
  return {
    name: "custom",
    note: "",
    arrivalsPerDay: PARAMS.arrivals.perDay.typical.value,
    startOccupancy: PARAMS.startOccupancy.typical.value,
    transferOutAfterH: PARAMS.transferOutAfterH.value,
    er: {
      bays: row("ER").beds.value, nurses: row("ER").nurses.typical.value,
      doctorsDay: PARAMS.erDoctors.day.typical.value, doctorsNight: PARAMS.erDoctors.night.typical.value,
    },
    units: { ICU: unit("ICU"), MED3A: unit("MED3A"), MED3B: unit("MED3B"), SURG5A: unit("SURG5A") },
  };
}

// Control, format (bidirectional, zero-width, soft hyphen, BOM), line and paragraph separators, and lone surrogates.
const HOSTILE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
const hostile = (text: string) => [...text].some((ch) => HOSTILE.test(ch));
// Hostile characters become "?"; at most 40 code points are kept.
const clean = (text: string) => [...text].slice(0, 40).map((ch) => (HOSTILE.test(ch) ? "?" : ch)).join("");

function fail(message: string): never {
  throw new ScenarioError(message);
}

type Json = Record<string, unknown>;
function object(value: unknown, path: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${path}: must be an object`);
  return value as Json;
}

function refuseUnknown(obj: Json, allowed: readonly string[], path: string) {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) fail(`${path}: unknown key "${clean(key)}"`);
}

function number(value: unknown, path: string, [min, max]: readonly [number, number], whole = true): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (whole && !Number.isInteger(value)) || value < min || value > max) {
    fail(`${path}: must be ${whole ? "a whole number" : "a number"} from ${min} to ${max}`);
  }
  return value + 0; // -0 becomes 0
}

/** Takes a section's numbers from the file, else from the default. */
function fill<T extends Record<string, number>>(base: T, input: unknown, path: string, rules: { [K in keyof T]: [readonly [number, number], boolean?] }): T {
  if (input === undefined) return { ...base };
  const obj = object(input, path);
  refuseUnknown(obj, Object.keys(base), path);
  const out = { ...base };
  for (const key of Object.keys(base) as (keyof T & string)[]) {
    if (obj[key] !== undefined) out[key] = number(obj[key], `${path}.${key}`, rules[key][0], rules[key][1] ?? true) as T[typeof key];
  }
  return out;
}

export function parseScenario(text: string): Scenario {
  if (typeof text !== "string") fail("scenario: must be text");
  if (new TextEncoder().encode(text).length > MAX_BYTES) fail(`scenario: file is over ${MAX_BYTES / 1024} KB`);
  let raw: unknown; // a key repeated in the file: the last one wins (JSON.parse), and only the surviving value is checked
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("scenario: not valid JSON"); // the parser's own message quotes the text, so it is not passed on
  }
  const top = object(raw, "scenario");
  refuseUnknown(top, ["name", "note", "arrivalsPerDay", "startOccupancy", "transferOutAfterH", "er", "units"], "scenario");
  const base = defaults();

  if (top.name !== undefined && (typeof top.name !== "string" || !NAME.test(top.name))) {
    fail("scenario.name: must match ^[a-z0-9][a-z0-9_-]{0,31}$");
  }
  // The note is later written into results files, so it is plain text: no control, direction, zero-width or line-separator characters.
  if (top.note !== undefined && (typeof top.note !== "string" || top.note.length > MAX_NOTE || hostile(top.note))) {
    fail(`scenario.note: must be plain text of at most ${MAX_NOTE} characters, with no control, direction or zero-width characters`);
  }

  const R = RANGES;
  const er = fill(base.er, top.er, "scenario.er", {
    bays: [R.beds], nurses: [R.nurses], doctorsDay: [R.doctors], doctorsNight: [R.doctors],
  });

  const unitsIn = top.units === undefined ? {} : object(top.units, "scenario.units");
  if ("W4" in unitsIn) fail("scenario.units.W4: W4 is not configurable (its map, roster and bed labels are fixed by the ward and the API)");
  refuseUnknown(unitsIn, Object.keys(base.units), "scenario.units");
  const units = {} as Scenario["units"];
  for (const id of Object.keys(base.units) as ConfigurableUnit[]) {
    const given = unitsIn[id];
    if (id === "ICU" && typeof given === "object" && given !== null && Object.hasOwn(given, "stretchers")) {
      fail("scenario.units.ICU.stretchers: the ICU has no corridor stretchers (a critical care bed cannot be a stretcher)");
    }
    units[id] = fill(base.units[id], unitsIn[id], `scenario.units.${id}`, { beds: [R.beds], stretchers: [R.stretchers], nurses: [R.nurses] });
  }

  return {
    name: (top.name as string | undefined) ?? base.name,
    note: (top.note as string | undefined) ?? base.note,
    arrivalsPerDay: top.arrivalsPerDay === undefined ? base.arrivalsPerDay : number(top.arrivalsPerDay, "scenario.arrivalsPerDay", R.arrivalsPerDay),
    startOccupancy: top.startOccupancy === undefined ? base.startOccupancy : number(top.startOccupancy, "scenario.startOccupancy", R.startOccupancy, false),
    transferOutAfterH: top.transferOutAfterH === undefined ? base.transferOutAfterH : number(top.transferOutAfterH, "scenario.transferOutAfterH", R.transferOutAfterH, false),
    er,
    units,
  };
}
