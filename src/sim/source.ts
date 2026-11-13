// The vitals source: the one seam a real dataset replaces. Everything below VitalsSource is the
// synthetic implementation, a live version of BioSentry's removed batch generator.

import { BEDS } from "./map";
import type { Acvpu } from "./news2";
import fixture from "./synthetic.json";
import calibration from "./calibration.json";
import fit from "./fitted.json";

export const VITALS = ["heart_rate", "respiratory_rate", "spo2", "temperature"] as const;
export type Vital = (typeof VITALS)[number];
export type DeviceReading = Record<Vital, number | null>;
export interface Cuff {
  systolic: number;
  diastolic: number;
}

/** How the quality gate treats this source. Times are minutes, minValid is samples per 15 minutes. */
export interface GateRules {
  sampleEveryMin: number;
  warmupMin: number;
  minValid: Record<Vital, number>;
  degradedAfter: Record<Vital, number>;
  notRankedAfter: Record<Vital, number>;
  charted: Vital[]; // arrives irregularly, so an empty sample is not a rejection
}

/** Everything the sim needs to put one patient in a bed. */
export interface PatientSeed {
  id: string;
  name: string;
  age: number | string;
  sex: string;
  bed: string;
  context: string;
  story: string;
  rn: string;
  md: string;
  listMd: string | null;
  trend: "rising" | "falling" | "stable" | "insufficient";
  history: Record<Vital, (number | null)[]>;
  bp: Cuff | null;
  consciousness: Acvpu;
  onOxygen: boolean;
  spo2Scale: 1 | 2;
  patch: boolean;
  signalLostMin: number;
  irregular: boolean; // atrial fibrillation: the illustrative ECG drops the P wave
  ectopyPerHour: number; // premature beats on the strip, 0 where a source has no rhythm data
  dueMin?: number; // patient flow: the minute the patient is due to leave
  oxygenUntilMin?: number; // patient flow: the minute oxygen comes off
}

/** What is already known of a patient admitted from outside the sim. It replaces what admit would draw. */
export type GivenSeed = Partial<PatientSeed> & Pick<PatientSeed, "id" | "bed">;
/** A hospital person admitted to W4 (hospital mode): who they are replaces what admit draws, after every draw is made. */
export interface Person { name: string; age: number; sex: "F" | "M" }

/** Nurse-charted state at a minute. Each value holds until the next entry. */
export interface Charted {
  bp: Cuff | null;
  bpAt: number | null;
  onOxygen: boolean;
  consciousness: Acvpu;
}

export interface VitalsSource {
  readonly synthetic: boolean;
  readonly rules: GateRules;
  /** Run length in minutes. Synthetic runs forever. */
  readonly durationMin?: number;
  seeds(): PatientSeed[];
  /** One sample. Minute 0 is the start, negatives are warm-up. Called in order, every sampleEveryMin. */
  read(patientId: string, minute: number): DeviceReading | null;
  /** What a blood pressure cuff would read now. */
  cuff(patientId: string, minute: number): Cuff | null;
  /** Real data only: what the chart says now. */
  charted?(patientId: string, minute: number): Charted;
  /** Synthetic only: start a deterioration. A real-data source leaves this out. */
  inject?(patientId: string, minute: number): void;
  /** Synthetic only: start an AF episode. Returns its length in minutes. */
  startAf?(patientId: string, minute: number): number;
  /** Synthetic only: whether the rhythm is AF now. */
  irregularAt?(patientId: string, minute: number): boolean;
  /** Patient flow: a new patient for a free bed, or null when the ward is full. `given` names the patient and the bed. */
  admit?(minute: number, occupied: { bed: string; rn: string; md: string }[], given?: GivenSeed, person?: Person): PatientSeed | null;
  /** Patient flow: chance of an admission in one minute. */
  admissionChance?: number;
  /** Patient flow: when a patient already on the ward at the start is due to leave. */
  dueForInitialPatient?(): number;
  /** Patient flow: a uniform random number, separate from any patient's readings. */
  flowRandom?(): number;
  /** Synthetic only: the source's state for these patients as plain JSON, for createSyntheticSource to restore. */
  save?(patientIds: string[]): SavedSource;
}

/** A synthetic source between runs. A generator is saved as its one number of state. */
export interface SavedSource {
  seed: number;
  flow: boolean;
  flowRng: number;
  admitted: number;
  af: string[];
  anchors: Record<string, { vitals: Record<Vital, number>; cuff: Cuff }>; // admitted patients only: the fixture's are derived
  streams: Record<string, object>;
}

const perVital = <T,>(value: T) =>
  Object.fromEntries(VITALS.map((v) => [v, value])) as Record<Vital, T>;

// MIN_VALID_PER_BIN and STALE_AFTER_S from BioSentry. The 30-minute cutoff is a demo value.
export const SYNTHETIC_RULES: GateRules = {
  sampleEveryMin: 1,
  warmupMin: 60,
  minValid: perVital(8),
  degradedAfter: perVital(15),
  notRankedAfter: perVital(30),
  charted: [],
};

// Fitted to real data by scripts/fit-generator.mjs. Clamps and circadian size stay as BioSentry set them.
export const CLAMPS: Record<Vital, [number, number]> = {
  heart_rate: [30, 200],
  respiratory_rate: [6, 40],
  spo2: [78, 100],
  temperature: [34.5, 40.5],
};
// shortcut: judgement, SD 0.1 C (thermometer resolution); no open minute-level source (see docs/realism.md).
const TEMPERATURE_NOISE = 0.1;
const noiseOf = (v: Vital) => fit.vitals[v].noise ?? TEMPERATURE_NOISE;
// HR and RR: van Goor 2022, COVID ward patches, recovered group. No ward source for the rest.
const CIRCADIAN_AMPLITUDE: Record<Vital, number> = {
  heart_rate: 6.9,
  respiratory_rate: 1.0,
  spo2: 0,
  temperature: 0.12,
};
/** Published size, peak hour fitted from eICU (PR 6). Zero at minute 0 so the fixture's values hold. */
function circadian(v: Vital, minute: number) {
  if (v === "temperature" || v === "spo2") return CIRCADIAN_AMPLITUDE[v] * Math.sin((2 * Math.PI * (minute / 60)) / 24);
  const peak = calibration.vitals[v].circadianPeak;
  const at = (clock: number) => Math.cos((2 * Math.PI * (clock - peak)) / 24);
  return CIRCADIAN_AMPLITUDE[v] * (at(15 + minute / 60) - at(15));
}

// ViSi Mobile ward pilot: 306 artefacts in 742.8 hours, over 74% under 5 minutes, about 7% over an hour.
const MEAN_MINUTES_BETWEEN_DROPOUTS = 146;
function drawGapMin(rng: () => number) {
  const u = rng();
  if (u < 0.74) return 1 + Math.floor(rng() * 5);
  if (u < 0.93) return 5 + Math.floor(rng() * 55);
  return 60 + Math.floor(rng() * 180); // shortcut: 4-hour cap is judgement, published gaps reach 24 hours
}

const AF_PATIENTS = new Set(["p-009"]);

// Only p-001 is still moving at as_of. End minus start of its scripted six hours.
const SLOPE: Record<string, Partial<Record<Vital, number>>> = {
  "p-001": { heart_rate: 16, respiratory_rate: 3, spo2: -3, temperature: 0.2 },
};

// Demo values: the fixture has no reading for these, so the demo invents them.
const DEMO_CUFF: Record<string, Cuff> = { "p-004": { systolic: 128, diastolic: 76 } };
const DEMO_BASELINE: Record<string, Record<Vital, number>> = {
  "p-005": { heart_rate: 84, respiratory_rate: 18, spo2: 97, temperature: 36.7 },
};

interface Measured {
  data: { present: boolean; value?: unknown };
}
interface FixtureRow {
  id: string;
  name: string;
  age: number;
  sex: string;
  bed: string;
  admitting_context: string;
  trend: PatientSeed["trend"];
  vitals: Record<string, Measured>;
  vital_trends: Record<Vital, (number | null)[]>;
}

const fx = fixture as unknown as {
  ranked: FixtureRow[];
  unscored: FixtureRow[];
  labels: Record<string, { story: string }>;
  clinicians: Record<string, { role: string; patients: string[] }>;
  seed: number;
};

export const FIXTURE_SEED = fx.seed;

const SIGNAL_LOST_MIN: Record<string, number> = { "p-011": 20 };
const NO_PATCH = new Set(["p-005"]);
// Demo values: the fixture assigns these two patients no physician.
const DEMO_PHYSICIAN: Record<string, string> = { "p-004": "md-santos", "p-005": "md-aquino" };

const assignee = (id: string, role: string) =>
  Object.entries(fx.clinicians).find(([, c]) => c.role === role && c.patients.includes(id))?.[0];

const ROWS = [...fx.ranked, ...fx.unscored];

/** The twelve occupied beds and who covers them, in fixture order. */
const SEATS = ROWS.map((row) => ({
  bed: row.bed,
  rn: assignee(row.id, "rn")!,
  md: assignee(row.id, "md") ?? DEMO_PHYSICIAN[row.id],
  listMd: assignee(row.id, "md") ?? null,
}));

// Spreads patients across the fitted quantiles without using up the vitals' random stream.
const ectopyOf = (id: string) => ectopyAt(((ROWS.findIndex((row) => row.id === id) * 7) % 20) / 20);

// shortcut: MIT-BIH is a small Holter sample, so about 9% of patients get its frequent-ectopy half, per a
// published 9% with PVC burden over 5%; replace with a ward rate if one appears.
function ectopyAt(u: number) {
  const table = fit.rhythm.ectopyPerHour;
  return u < 0.91 ? table[Math.floor((u / 0.91) * 10)] : table[11 + Math.floor(((u - 0.91) / 0.09) * 9)];
}

const quiet = (value: number) => Array<number | null>(12).fill(value);

function fixtureSeeds(): PatientSeed[] {
  return ROWS.map((row, i): PatientSeed => ({
    id: row.id,
    name: row.name,
    age: row.age,
    sex: row.sex,
    context: row.admitting_context,
    story: `At 15:00: ${fx.labels[row.id].story}`,
    ...SEATS[i],
    trend: row.trend,
    history: structuredClone(row.vital_trends), // the sim appends to these; the fixture stays put
    bp: presentValue<Cuff>(row.vitals.blood_pressure),
    consciousness: presentValue<Acvpu>(row.vitals.consciousness) ?? "A",
    onOxygen: presentValue<boolean>(row.vitals.supplemental_o2) ?? false,
    spo2Scale: presentValue<1 | 2>(row.vitals.spo2_scale) ?? 1,
    patch: !NO_PATCH.has(row.id),
    signalLostMin: SIGNAL_LOST_MIN[row.id] ?? 0,
    irregular: AF_PATIENTS.has(row.id),
    ectopyPerHour: ectopyOf(row.id),
  }));
}

function presentValue<T>(m: Measured | undefined): T | null {
  return m?.data.present ? (m.data.value as T) : null;
}

function anchorsFromFixture(): Record<string, { vitals: Record<Vital, number>; cuff: Cuff }> {
  const out: Record<string, { vitals: Record<Vital, number>; cuff: Cuff }> = {};
  for (const row of ROWS) {
    const vitals = {} as Record<Vital, number>;
    for (const v of VITALS) {
      vitals[v] = presentValue<number>(row.vitals[v]) ?? DEMO_BASELINE[row.id]?.[v] ?? NaN;
    }
    const cuff = presentValue<Cuff>(row.vitals.blood_pressure) ?? DEMO_CUFF[row.id];
    out[row.id] = { vitals, cuff };
  }
  return out;
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** The whole state. mulberry32(state()) continues the same sequence. */
  next.state = () => a;
  return next;
}

function gaussian(rng: () => number) {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** One Ornstein-Uhlenbeck (AR(1)) step with stationary standard deviation `sd`. */
function ou(previous: number, tau: number, sd: number, rng: () => number) {
  const phi = Math.exp(-1 / tau);
  return phi * previous + sd * Math.sqrt(1 - phi * phi) * gaussian(rng);
}

type Episode = (typeof fit.deterioration)[number];
const injectRamp = (minute: number, start: number | null, rampMin: number) =>
  start === null || minute <= start ? 0 : Math.min(1, ((minute - start) / rampMin) ** 2);

// shortcut: a judgement mix, since no published respiratory/circulatory split exists; replace if one appears.
// Raw eICU counts are not used: ICU cuff falls from sedation and drugs would make hypotension half of events.
const EPISODE_MIX: Record<string, number> = { respiratory: 0.55, tachycardic: 0.2, hypotensive: 0.25 };

function pickEpisode(rng: () => number) {
  let at = rng();
  return fit.deterioration.find((e) => (at -= EPISODE_MIX[e.kind]) < 0) ?? fit.deterioration[0];
}

// Excludes each end of the table, which holds monitor artefact and censored records.
const drawFrom = (table: number[], rng: () => number) => table[1 + Math.floor(rng() * (table.length - 2))];
// Keeps a reading inside the 1st to 99th percentile of real diastolic/systolic ratios.
function diastolicWithin(systolic: number, diastolic: number) {
  const [low, high] = fit.bloodPressure.diastolicRatioRange;
  return Math.round(Math.min(systolic * high, Math.max(systolic * low, diastolic)));
}

const wanderSd = (v: Vital) => Math.sqrt(Math.max(0, fit.vitals[v].sd ** 2 - fit.vitals[v].loading ** 2));

const DAY_MIN = 1440;
const START_CLOCK_MIN = 15 * 60; // the sim starts at 15:00

// Philippine length of stay in days, lognormal from PhilHealth medians and spreads.
// shortcut: the mix between conditions is a judgement, no published whole-ward case mix exists.
const CASE_MIX = [
  { share: 0.35, mu: 1.386, sigma: 0.88, context: "Heart failure, on IV diuretics", story: "admitted with breathlessness" },
  { share: 0.45, mu: 1.386, sigma: 0.51, context: "Acute coronary syndrome, medical management", story: "admitted with chest pain" },
  { share: 0.2, mu: 1.099, sigma: 1.19, context: "Coronary disease, post procedure", story: "admitted for a coronary procedure" },
];
const OCCUPANCY = 0.75; // Philippine Heart Center 73-76%
const MEAN_STAY_DAYS = CASE_MIX.reduce((n, c) => n + c.share * Math.exp(c.mu + c.sigma ** 2 / 2), 0);
const ADMISSIONS_PER_MIN = (OCCUPANCY * BEDS.length) / MEAN_STAY_DAYS / DAY_MIN;
const MAX_STAY_DAYS = 30;
const EVER_ON_OXYGEN = 0.39; // Pimentel 2019: 38-40% of admissions
const OXYGEN_SHARE_OF_STAY = 0.32; // tuned so the running ward gives Pimentel's 18-19% of observation sets
const PRE_EXISTING_AF = 0.08; // cardiac cohorts, 7.6-9.9%
const NEW_ONSET_AF = 0.05; // ACS cohorts, about 5.3%
const DETERIORATES = 0.061; // Churpek 2016: ward arrest, ICU transfer or ward death per admission
const SURNAMES = ["Ocampo", "Lim", "Bautista", "Rivera", "Tolentino", "Gonzales", "Mercado", "Flores", "Santiago", "Cruz", "Valdez", "Soriano"];
const GIVEN: Record<string, string[]> = {
  F: ["Luz", "Carmen", "Nenita", "Imelda", "Josefina", "Remedios"],
  M: ["Ramon", "Antonio", "Danilo", "Ernesto", "Rogelio", "Alfredo"],
};

/** The real clock hour of a discharge: about 15% before noon, median near 15:00. */
function dueAt(minute: number, stayMin: number, rng: () => number) {
  const hour = rng() < 0.15 ? 8 + rng() * 4 : 12 + rng() * 7;
  // Nearest day, not the day it falls on: rounding down would cut every stay by half a day.
  const due = Math.round((minute + stayMin) / DAY_MIN) * DAY_MIN + hour * 60 - START_CLOCK_MIN;
  return due > minute ? due : due + DAY_MIN;
}

function drawStayMin(rng: () => number) {
  let at = rng();
  const c = CASE_MIX.find((x) => (at -= x.share) < 0) ?? CASE_MIX[0];
  return { condition: c, stayMin: Math.min(MAX_STAY_DAYS, Math.exp(c.mu + c.sigma * gaussian(rng))) * DAY_MIN };
}

export function createSyntheticSource(seed: number, flow = false, saved?: SavedSource): VitalsSource {
  const afPatients = new Set(AF_PATIENTS);
  const anchors = anchorsFromFixture();
  const fixtureAnchors = new Set(Object.keys(anchors));
  const streams = Object.fromEntries(
    Object.keys(anchors).map((id, i) => [
      id,
      {
        rng: mulberry32(seed + (i + 1) * 0x9e3779b1),
        spread: 1,
        latent: 0,
        wander: { heart_rate: 0, respiratory_rate: 0, spo2: 0, temperature: 0 } as Record<Vital, number>,
        gapLeft: 0,
        injectAt: null as number | null,
        episode: null as Episode | null,
        rampMin: 1,
        bpRng: mulberry32(seed ^ ((i + 1) * 0x85ebca6b)),
        bpDrift: 0,
        bpAt: null as number | null,
        afFrom: null as number | null,
        afUntil: 0,
      },
    ]),
  );
  type Stream = (typeof streams)[string];
  const setSpread = (s: Stream) => {
    s.spread = Math.exp(fit.patientSpreadLog * gaussian(s.rng) - fit.patientSpreadLog ** 2); // keeps the mean variance
  };
  Object.values(streams).forEach(setSpread);
  type SavedStream = Omit<Stream, "rng" | "bpRng"> & { rng: number; bpRng: number };
  for (const [id, stream] of Object.entries((saved?.streams ?? {}) as Record<string, SavedStream>)) {
    streams[id] = { ...stream, rng: mulberry32(stream.rng), bpRng: mulberry32(stream.bpRng) };
  }
  Object.assign(anchors, saved?.anchors);
  saved?.af.forEach((id) => afPatients.add(id));
  const flowRng = mulberry32(saved?.flowRng ?? seed ^ 0x51ed270b);
  let admitted = saved?.admitted ?? 0;

  function admit(minute: number, occupied: { bed: string; rn: string; md: string }[], given?: GivenSeed, person?: Person): PatientSeed | null {
    const taken = new Set(occupied.map((o) => o.bed));
    const drawnSex = flowRng() < 0.5 ? "F" : "M";
    const sex = person?.sex ?? drawnSex; // a hospital person keeps their sex, which picks the bay; every draw is still made, in order
    const free = (zone: string) => BEDS.filter((b) => b.zone === zone && !taken.has(b.label));
    const onOxygen = flowRng() < EVER_ON_OXYGEN;
    const bed = given
      ? BEDS.find((b) => b.label === given.bed && !taken.has(b.label))
      : [...(onOxygen ? free("H") : []), ...free(sex === "F" ? "A" : "B"), ...free("S"), ...free("H")][0];
    if (!bed) return null;

    admitted += 1;
    const id = given?.id ?? `n-${String(admitted).padStart(4, "0")}`; // a given patient still uses up a number: it seeds their stream
    const { condition, stayMin } = drawStayMin(flowRng);
    const systolic = drawFrom(fit.baseline.systolic, flowRng);
    const vitals: Record<Vital, number> = {
      heart_rate: drawFrom(fit.baseline.heart_rate, flowRng),
      respiratory_rate: drawFrom(fit.baseline.respiratory_rate, flowRng),
      spo2: drawFrom(fit.baseline.spo2, flowRng),
      temperature: drawFrom(fit.baseline.temperature, flowRng),
    };
    const cuff = { systolic: Math.round(systolic), diastolic: diastolicWithin(systolic, systolic - drawFrom(fit.baseline.pulsePressure, flowRng)) };
    anchors[id] = { vitals, cuff };
    const stream: Stream = {
      rng: mulberry32(seed + (ROWS.length + admitted) * 0x9e3779b1),
      spread: 1,
      latent: 0,
      wander: { heart_rate: 0, respiratory_rate: 0, spo2: 0, temperature: 0 },
      gapLeft: 0,
      injectAt: null,
      episode: null,
      rampMin: 1,
      bpRng: mulberry32(seed ^ ((ROWS.length + admitted) * 0x85ebca6b)),
      bpDrift: 0,
      bpAt: null,
      afFrom: null,
      afUntil: 0,
    };
    setSpread(stream);
    streams[id] = stream;

    const irregular = flowRng() < PRE_EXISTING_AF;
    if (irregular) afPatients.add(id);
    else if (flowRng() < NEW_ONSET_AF) {
      stream.afFrom = minute + flowRng() * stayMin;
      stream.afUntil = stream.afFrom + drawFrom(fit.rhythm.afEpisodeMinutes, flowRng);
    }
    if (flowRng() < DETERIORATES) {
      stream.injectAt = minute + flowRng() * stayMin;
      stream.episode = pickEpisode(flowRng);
      stream.rampMin = drawFrom(stream.episode.rampMinutes, flowRng);
    }

    const count = (key: "rn" | "md", who: string) => occupied.filter((o) => o[key] === who).length;
    const fewer = (key: "rn" | "md", a: string, b: string) => (count(key, a) <= count(key, b) ? a : b);
    const pick = <T,>(xs: T[]) => xs[Math.floor(flowRng() * xs.length)];
    const md = fewer("md", "md-santos", "md-aquino");
    const drawn: PatientSeed = {
      id,
      name: `${pick(SURNAMES)}, ${pick(GIVEN[sex])}`,
      age: 45 + Math.floor(flowRng() * 40), // shortcut: no ward age data fitted, a plain adult cardiology range
      sex,
      bed: bed.label,
      context: condition.context,
      story: `New admission, ${condition.story} (synthetic patient)`,
      rn: fewer("rn", "rn-delacruz", "rn-reyes"),
      md,
      listMd: md,
      trend: "insufficient",
      history: {
        heart_rate: quiet(vitals.heart_rate),
        respiratory_rate: quiet(vitals.respiratory_rate),
        spo2: quiet(vitals.spo2),
        temperature: quiet(vitals.temperature),
      },
      bp: cuff,
      consciousness: "A",
      onOxygen,
      spo2Scale: 1,
      patch: true,
      signalLostMin: 0,
      irregular,
      ectopyPerHour: ectopyAt(flowRng()),
      dueMin: dueAt(minute, stayMin, flowRng),
      oxygenUntilMin: onOxygen ? minute + stayMin * OXYGEN_SHARE_OF_STAY : undefined,
    };
    return { ...(given ? { ...drawn, ...given } : drawn), ...person };
  }

  const flowParts: Partial<VitalsSource> = flow
    ? {
        admit,
        admissionChance: ADMISSIONS_PER_MIN,
        flowRandom: flowRng,
        // Part-way through a stay already under way.
        dueForInitialPatient: () => dueAt(0, drawStayMin(flowRng).stayMin * flowRng(), flowRng),
      }
    : {};
  const inAf = (id: string, minute: number) => {
    const s = streams[id];
    return afPatients.has(id) || (s.afFrom !== null && minute >= s.afFrom && minute < s.afUntil);
  };
  const injected = (id: string, v: Vital, minute: number) => {
    const s = streams[id];
    // The fit has no temperature entry for any kind, so temperature does not move in an episode.
    const size = (s.episode as Partial<Record<Vital, number>> | null)?.[v] ?? 0;
    return size * injectRamp(minute, s.injectAt, s.rampMin);
  };

  return {
    ...flowParts,
    synthetic: true,
    rules: SYNTHETIC_RULES,
    seeds: fixtureSeeds,

    read(id, minute) {
      const anchor = anchors[id].vitals;
      if (minute <= 0) return { ...anchor }; // t=0 parity with the fixture holds by construction
      const s = streams[id];
      s.latent = ou(s.latent, fit.latentTauMin, 1, s.rng);
      const af = inAf(id, minute);
      const out = {} as DeviceReading;
      for (const v of VITALS) {
        s.wander[v] = ou(s.wander[v], fit.vitals[v].tauMin, wanderSd(v) * s.spread, s.rng);
        const noise = v === "heart_rate" && af ? Math.hypot(noiseOf(v), fit.rhythm.afMinuteHrSd) : noiseOf(v);
        // A persistent-AF patient's anchor is already their AF rate.
        const afRate = v === "heart_rate" && af && !afPatients.has(id) ? anchor[v] * (fit.rhythm.afRateRatio - 1) : 0;
        const value =
          anchor[v] +
          ((SLOPE[id]?.[v] ?? 0) * 2 * Math.min(minute, 180)) / 360 +
          injected(id, v, minute) +
          afRate +
          circadian(v, minute) +
          s.wander[v] +
          fit.vitals[v].loading * s.spread * s.latent +
          noise * gaussian(s.rng);
        const [low, high] = CLAMPS[v];
        out[v] = Math.min(high, Math.max(low, value));
      }
      if (s.gapLeft === 0 && s.rng() < 1 / MEAN_MINUTES_BETWEEN_DROPOUTS) {
        s.gapLeft = drawGapMin(s.rng);
      }
      if (s.gapLeft > 0) {
        s.gapLeft -= 1;
        return null;
      }
      return out;
    },

    cuff(id, minute) {
      const base = anchors[id].cuff;
      const s = streams[id];
      const bp = fit.bloodPressure;
      // A separate generator, so when a nurse takes a cuff reading cannot change the vitals that follow.
      const gap = s.bpAt === null ? Infinity : Math.max(0, minute - s.bpAt);
      const phi = Math.exp(-gap / bp.tauMin);
      s.bpDrift = phi * s.bpDrift + bp.sd * s.spread * Math.sqrt(1 - phi * phi) * gaussian(s.bpRng);
      s.bpAt = minute;
      const ramp = injectRamp(minute, s.injectAt, s.rampMin);
      const systolicMove = s.bpDrift + bp.noise * gaussian(s.bpRng);
      const systolic = Math.round(base.systolic + systolicMove + (s.episode?.systolic ?? 0) * ramp);
      return {
        systolic,
        diastolic: diastolicWithin(
          systolic,
          base.diastolic + bp.diastolicPerSystolic * systolicMove + bp.diastolicNoise * gaussian(s.bpRng) + (s.episode?.diastolic ?? 0) * ramp,
        ),
      };
    },

    inject(id, minute) {
      const s = streams[id];
      if (s.injectAt === null || s.injectAt > minute) s.injectAt = minute; // a click overrides a scheduled event
      if (!s.episode) {
        s.episode = pickEpisode(s.rng);
        s.rampMin = drawFrom(s.episode.rampMinutes, s.rng);
      }
    },

    startAf(id, minute) {
      const s = streams[id];
      const length = drawFrom(fit.rhythm.afEpisodeMinutes, s.rng);
      s.afFrom = minute;
      s.afUntil = minute + length;
      return length;
    },

    irregularAt: inAf,

    save: (ids) => ({
      seed,
      flow,
      flowRng: flowRng.state(),
      admitted,
      af: ids.filter((id) => afPatients.has(id)),
      anchors: Object.fromEntries(ids.filter((id) => !fixtureAnchors.has(id)).map((id) => [id, anchors[id]])),
      streams: Object.fromEntries(
        ids.map((id): [string, SavedStream] => {
          const s = streams[id];
          return [id, { ...s, wander: { ...s.wander }, rng: s.rng.state(), bpRng: s.bpRng.state() }];
        }),
      ),
    }),
  };
}
