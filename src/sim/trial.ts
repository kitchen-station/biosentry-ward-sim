// A headless trial: one scenario, one seed, a number of days, run with no API and no wall clock.
// Pure: strings in, strings out. src/trial.ts does the argument parsing and the file writing.
// Format: the trial results contract, version 1. The ground truth (episodes.csv) is written only here.

import { BEDS } from "./map";
import { roundHalfUp } from "./news2";
import { createSim, setSpeed, signalQuality, STAFF, step, vitalQuality, type Speed, type Stay } from "./sim";
import { createSyntheticSource, VITALS } from "./source";

/** Fixed: outcomes depend on speed (staff walk at most 6x), and the manifest records it. */
export const TRIAL_SPEED: Speed = 60;
export const MAX_SCENARIO_BYTES = 16 * 1024;
export const FORMAT_VERSION = 1;
const BIN_MIN = 15;

export class TrialRefusal extends Error {}
const refuse = (message: string): never => {
  throw new TrialRefusal(message);
};

const roleCount = (role: string) => STAFF.filter((m) => m[3] === role).length;
// Version 1 accepts only today's ward W4. Beds and staff come from the sim; the occupancy and the case mix are
// constants in src/sim/source.ts that are not exported (OCCUPANCY, CASE_MIX), so the test pins OCCUPANCY.
export const SCENARIO_V1 = {
  format_version: FORMAT_VERSION,
  staffing: { staff_nurses: roleCount("rn"), charge_nurses: roleCount("charge_rn"), physicians: roleCount("md") },
  beds: BEDS.length,
  arrivals: { occupancy_target: 0.75 },
  case_mix: "w4-default",
};

export interface Scenario {
  format_version: 1;
  name: string;
  staffing: { staff_nurses: number; charge_nurses: number; physicians: number };
  beds: number;
  arrivals: { occupancy_target: number };
  case_mix: string;
}

// Capped so a refusal stays one short line however large the offending value is.
// Control, DEL, C1 and bidirectional override characters are replaced: they can rewrite a terminal or reorder a line.
const show = (v: unknown) => {
  const text = (JSON.stringify(v) ?? String(v)).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c\u2028\u2029\ufeff]/g, "?");
  return text.length > 40 ? `${text.slice(0, 40)}...` : text;
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function exactKeys(path: string, value: unknown, keys: string[]): Record<string, unknown> {
  if (!isObject(value)) return refuse(`scenario: "${path}" must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) refuse(`scenario: unknown key ${show(key)}${path === "scenario" ? "" : ` in "${path}"`}`);
  for (const key of keys) if (!(key in value)) refuse(`scenario: missing key "${key}"${path === "scenario" ? "" : ` in "${path}"`}`);
  return value;
}

function expectValue(key: string, got: unknown, want: unknown) {
  if (got !== want) refuse(`scenario: "${key}" must be ${show(want)} in format version 1 (today's ward W4), got ${show(got)}`);
}

/** Parses and checks a scenario file's text. Refuses with one line; returns the object in the contract's key order. */
export function parseScenario(text: string): Scenario {
  if (new TextEncoder().encode(text).length > MAX_SCENARIO_BYTES) refuse(`scenario: file is over ${MAX_SCENARIO_BYTES} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse("scenario: not valid JSON");
  }
  const top = exactKeys("scenario", raw, ["format_version", "name", "staffing", "beds", "arrivals", "case_mix"]);
  expectValue("format_version", top.format_version, SCENARIO_V1.format_version);
  // A name ends up in manifest.json, which may hold no free text: ids and fixed words only.
  if (typeof top.name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(top.name)) {
    refuse('scenario: "name" must be 1 to 32 characters of a-z, 0-9, "-" or "_"');
  }
  const staffing = exactKeys("staffing", top.staffing, ["staff_nurses", "charge_nurses", "physicians"]);
  for (const key of ["staff_nurses", "charge_nurses", "physicians"] as const) {
    expectValue(`staffing.${key}`, staffing[key], SCENARIO_V1.staffing[key]);
  }
  expectValue("beds", top.beds, SCENARIO_V1.beds);
  const arrivals = exactKeys("arrivals", top.arrivals, ["occupancy_target"]);
  expectValue("arrivals.occupancy_target", arrivals.occupancy_target, SCENARIO_V1.arrivals.occupancy_target);
  expectValue("case_mix", top.case_mix, SCENARIO_V1.case_mix);
  return {
    format_version: 1,
    name: top.name as string,
    staffing: { ...SCENARIO_V1.staffing },
    beds: SCENARIO_V1.beds,
    arrivals: { ...SCENARIO_V1.arrivals },
    case_mix: SCENARIO_V1.case_mix,
  };
}

export const COHORT_HEADER =
  "patient,minute,heart_rate,respiratory_rate,spo2,temperature,systolic,diastolic,bp_minute,consciousness,on_oxygen,spo2_scale,coverage,ranked,news2";
export const EPISODES_HEADER = "patient,admit_minute,leave_minute,outcome,episode_kind,episode_start,ramp_minutes,af_start,af_end,persistent_af";
export type TrialFiles = Record<"manifest.json" | "cohort.csv" | "episodes.csv" | "summary.json", string>;

interface Truth {
  kind: string | null;
  start: number | null;
  ramp: number | null;
  afStart: number | null;
  afEnd: number | null;
  persistentAf: boolean;
}

// The empty field for an absent value; String(n) for a number, as the contract says.
const cell = (v: number | string | null | undefined) => (v === null || v === undefined ? "" : String(v));

export function runTrial(o: { scenario: Scenario; seed: number; days: number; scenarioSha256: string; simCommit: string; nodeMajor: number }): TrialFiles {
  const { seed, days } = o;
  const endMin = days * 1440;
  const src = createSyntheticSource(seed, true);
  const s = createSim(src);
  setSpeed(s, TRIAL_SPEED);

  // A stay is held by reference, so it survives the sim's cap of 500 finished stays (a 60-day trial admits about 200).
  const stays = new Map<string, Stay>();
  const truth = new Map<string, Truth>();
  const lastBin = new Map<string, number>();
  const cohort = [COHORT_HEADER];

  // The generator draws a stay's episode at admission; read it while the patient is still in the ward.
  const readTruth = () => {
    const ids = s.patients.map((p) => p.id);
    const saved = src.save!(ids);
    for (const id of ids) {
      const t = saved.streams[id] as { episode: { kind: string } | null; injectAt: number | null; rampMin: number; afFrom: number | null; afUntil: number };
      const episode = t.episode !== null && t.injectAt !== null;
      truth.set(id, {
        kind: episode ? t.episode!.kind : null,
        start: episode ? t.injectAt : null,
        ramp: episode ? t.rampMin : null,
        afStart: t.afFrom,
        afEnd: t.afFrom === null ? null : t.afUntil,
        persistentAf: saved.af.includes(id),
      });
    }
  };
  const register = () => {
    for (const p of s.patients) if (!stays.has(p.id)) stays.set(p.id, p.stay);
    readTruth();
  };
  register();

  let admitted = s.flow.admitted;
  let truthBin = -1;
  // A patient's sample for a minute lands up to 5 s per bed after it (Patient.offsetS).
  const scanWindowS = 60 + 5 * BEDS.length;
  while (s.clockS < endMin * 60) {
    step(s, src);
    if (s.flow.admitted !== admitted) {
      admitted = s.flow.admitted;
      register();
    }
    const intoBin = s.clockS % (BIN_MIN * 60);
    if (intoBin > scanWindowS) continue;
    const bin = Math.floor(s.clockS / (BIN_MIN * 60));
    if (bin !== truthBin) {
      truthBin = bin;
      readTruth(); // again each bin, so a later change is not missed
    }
    for (const p of s.patients) {
      // The tick right after a patient's sample for a bin minute, so the row holds what the scorer used.
      const minute = p.nextMinute - p.rules.sampleEveryMin;
      if (minute % BIN_MIN !== 0 || minute <= 0 || minute >= endMin || lastBin.get(p.id) === minute) continue;
      lastBin.set(p.id, minute);
      const device = VITALS.map((v) => {
        const held = p.held[v];
        // Rounded as record() in sim.ts rounds what it sends to the API; the scorer rounds the same way.
        return vitalQuality(p, v, minute) === "missing" || held === null ? "" : String(roundHalfUp(held, v === "temperature" ? 1 : 0));
      });
      const d = p.decision;
      cohort.push(
        [
          p.id,
          minute,
          ...device,
          cell(p.bp?.systolic),
          cell(p.bp?.diastolic),
          cell(p.bp ? p.bpAt : null),
          p.consciousness,
          p.onOxygen ? 1 : 0,
          p.spo2Scale,
          cell(signalQuality(p)),
          d.kind === "ranked" ? 1 : 0,
          d.kind === "ranked" ? d.news2.total : "",
        ].join(","),
      );
    }
  }
  readTruth();

  const episodes = [EPISODES_HEADER];
  let withEpisode = 0;
  let patientMin = 0;
  for (const [id, stay] of stays) {
    const t = truth.get(id)!;
    if (t.kind !== null) withEpisode += 1;
    patientMin += (stay.outMin ?? endMin) - stay.inMin;
    episodes.push(
      [id, stay.inMin, cell(stay.outMin), cell(stay.outcome), cell(t.kind), cell(t.start), cell(t.ramp), cell(t.afStart), cell(t.afEnd), t.persistentAf ? 1 : 0].join(","),
    );
  }

  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
  return {
    "manifest.json": json({
      format_version: FORMAT_VERSION,
      synthetic: true,
      seed,
      days,
      speed: TRIAL_SPEED,
      scenario: o.scenario,
      scenario_sha256: o.scenarioSha256,
      sim_commit: o.simCommit,
      node_major: o.nodeMajor,
      bin_minutes: BIN_MIN,
      patients: stays.size,
      episodes: withEpisode,
    }),
    "cohort.csv": `${cohort.join("\n")}\n`,
    "episodes.csv": `${episodes.join("\n")}\n`,
    "summary.json": json({
      admitted: s.flow.admitted,
      discharged: s.flow.discharged,
      higher_care: s.flow.transferred,
      turned_away: s.flow.turnedAway,
      patient_days: round(patientMin / 1440, 3),
      // The twelve patients already on the ward at minute 0 have no episode and are not admissions.
      episodes_per_admission: s.flow.admitted ? round(withEpisode / s.flow.admitted, 4) : 0,
    }),
  };
}
