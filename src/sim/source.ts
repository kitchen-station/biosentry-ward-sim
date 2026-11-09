// The vitals source: the one seam a real dataset replaces. Everything below VitalsSource is the
// synthetic implementation, a live version of BioSentry's removed batch generator.

import { BEDS } from "./map";
import type { Acvpu } from "./news2";
import fixture from "./synthetic.json";
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
  /** Replay length in minutes. Synthetic runs forever. */
  readonly durationMin?: number;
  seeds(): PatientSeed[];
  /** One sample. Minute 0 is the start, negatives are warm-up. Called in order, every sampleEveryMin. */
  read(patientId: string, minute: number): DeviceReading | null;
  /** What a blood pressure cuff would read now. */
  cuff(patientId: string, minute: number): Cuff | null;
  /** Replay only: what the chart says now. */
  charted?(patientId: string, minute: number): Charted;
  /** Synthetic only: start a deterioration. A replay source leaves this out. */
  inject?(patientId: string, minute: number): void;
  /** Synthetic only: start an AF episode. Returns its length in minutes. */
  startAf?(patientId: string, minute: number): number;
  /** Synthetic only: whether the rhythm is AF now. */
  irregularAt?(patientId: string, minute: number): boolean;
  /** Patient flow: a new patient for a free bed, or null when the ward is full. */
  admit?(minute: number, occupied: { bed: string; rn: string; md: string }[]): PatientSeed | null;
  /** Patient flow: chance of an admission in one minute. */
  admissionChance?: number;
  /** Patient flow: when a patient already on the ward at the start is due to leave. */
  dueForInitialPatient?(): number;
  /** Patient flow: a uniform random number, separate from any patient's readings. */
  flowRandom?(): number;
}

const perVital = <T,>(value: T) =>
  Object.fromEntries(VITALS.map((v) => [v, value])) as Record<Vital, T>;

// MIN_VALID_PER_BIN and STALE_AFTER_S from BioSentry. The 30-minute cutoff is a demo value.
const SYNTHETIC_RULES: GateRules = {
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
// shortcut: no open dataset gives minute-level temperature noise, keep BioSentry's value until one does.
const TEMPERATURE_NOISE = 0.02;
const noiseOf = (v: Vital) => fit.vitals[v].noise ?? TEMPERATURE_NOISE;
// HR and RR: van Goor 2022, COVID ward patches, recovered group. No ward source for the rest.
const CIRCADIAN_AMPLITUDE: Record<Vital, number> = {
  heart_rate: 6.9,
  respiratory_rate: 1.0,
  spo2: 0,
  temperature: 0.12,
};
const MEAN_MINUTES_BETWEEN_DROPOUTS = 150;

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

// shortcut: too few eICU episodes chart temperature, keep the demo's rise until a source has it.
const INJECT_TEMPERATURE = 0.6;

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

// Twenty patients shared by the dashboard's two staff nurses, with the charge nurse watching the list.
export const WARD_SIZE = 20;
const staffNurse = (i: number) => (i % 2 === 0 ? "rn-delacruz" : "rn-reyes");

// Demo patients beyond the fixture's twelve. Values sit inside the NEWS2 zero bands, away from
// the edges, so they stay low risk and quiet: a typical ward, not a crisis.
const EXTRA: [string, string, number, string, string, string, Record<Vital, number>, Cuff][] = [
  ["p-013", "Ramos, Teresa", 71, "F", "Heart failure, stable on oral diuretics", "stable, discharge planned for tomorrow", { heart_rate: 76, respiratory_rate: 16, spo2: 97, temperature: 36.7 }, { systolic: 126, diastolic: 74 }],
  ["p-014", "Navarro, Eduardo", 64, "M", "Unstable angina, now pain-free", "stable on medical therapy, awaiting angiography", { heart_rate: 68, respiratory_rate: 15, spo2: 98, temperature: 36.6 }, { systolic: 134, diastolic: 80 }],
  ["p-015", "Castillo, Rosario", 58, "F", "Hypertension, medication review", "stable, blood pressure now controlled", { heart_rate: 72, respiratory_rate: 16, spo2: 98, temperature: 36.8 }, { systolic: 142, diastolic: 86 }],
  ["p-016", "Domingo, Felipe", 77, "M", "Syncope, telemetry for rhythm", "stable, no events overnight", { heart_rate: 64, respiratory_rate: 15, spo2: 97, temperature: 36.5 }, { systolic: 128, diastolic: 70 }],
  ["p-017", "Salazar, Gloria", 69, "F", "NSTEMI, day 3", "stable, mobilising", { heart_rate: 80, respiratory_rate: 17, spo2: 97, temperature: 36.9 }, { systolic: 122, diastolic: 72 }],
  ["p-018", "Pascual, Ricardo", 55, "M", "Atypical chest pain, troponin negative", "stable, for discharge after review", { heart_rate: 70, respiratory_rate: 14, spo2: 99, temperature: 36.6 }, { systolic: 130, diastolic: 78 }],
  ["p-019", "Aguilar, Corazon", 82, "F", "Heart failure with preserved EF", "stable, mild ankle swelling", { heart_rate: 78, respiratory_rate: 17, spo2: 96, temperature: 36.7 }, { systolic: 138, diastolic: 76 }],
  ["p-020", "Fernandez, Manuel", 60, "M", "Post-PCI, day 1", "stable, groin site clean", { heart_rate: 66, respiratory_rate: 15, spo2: 98, temperature: 36.8 }, { systolic: 124, diastolic: 74 }],
];

// Patients are grouped the way a ward places them: the sickest at admission in the
// high-dependency bay opposite the station, the rest in single-sex bays, a few in side rooms.
const BED_OF: Record<string, string> = {
  "p-001": "H1", "p-002": "H2", "p-003": "H3", "p-006": "H4",
  "p-008": "A1", "p-009": "A2", "p-011": "A3", "p-013": "A4", "p-015": "A5", "p-017": "A6",
  "p-007": "B1", "p-010": "B2", "p-012": "B3", "p-014": "B4", "p-016": "B5", "p-018": "B6",
  "p-004": "S1", "p-005": "S2", "p-019": "S3", "p-020": "S4",
};

const ORDER = [...[...fx.ranked, ...fx.unscored].map((row) => row.id), ...EXTRA.map(([id]) => id)];

/** The twenty occupied beds and who covers them, in seed order: fixture patients, then demo ones. */
export const SEATS = ORDER.map((id, i) => ({
  bed: BED_OF[id],
  rn: assignee(id, "rn") ?? staffNurse(i),
  md: assignee(id, "md") ?? DEMO_PHYSICIAN[id] ?? (i % 2 === 0 ? "md-santos" : "md-aquino"),
}));

/** Beds for patients with no fixed bed: the first four to high dependency, then by sex. */
export function allocateBeds(sexes: string[]): { bed: string; rn: string; md: string }[] {
  const free = (prefix: string) => BEDS.filter((b) => b.label.startsWith(prefix)).map((b) => b.label);
  const pools: Record<string, string[]> = { H: free("H"), F: free("A"), M: free("B"), S: free("S") };
  const any = () => pools.S.shift() ?? pools.F.shift() ?? pools.M.shift() ?? pools.H.shift();
  return sexes.map((sex, i) => {
    const bed = (i < 4 ? pools.H.shift() : pools[sex]?.shift()) ?? any();
    if (!bed) throw new Error(`No free bed for patient ${i + 1}; the ward has ${BEDS.length}`);
    return { bed, rn: staffNurse(i), md: i % 2 === 0 ? "md-santos" : "md-aquino" };
  });
}

// Spreads patients across the fitted quantiles without using up the vitals' random stream.
const ectopyOf = (id: string) => fit.rhythm.ectopyPerHour[(ORDER.indexOf(id) * 7) % 20];

const quiet = (value: number) => Array<number | null>(12).fill(value);

function extraSeeds(): PatientSeed[] {
  return EXTRA.map(([id, name, age, sex, context, story, vitals, bp]) => ({
    id,
    name,
    age,
    sex,
    context,
    story: `At 15:00: ${story} (demo patient, not in the BioSentry fixture)`,
    ...SEATS[ORDER.indexOf(id)],
    trend: "stable",
    history: {
      heart_rate: quiet(vitals.heart_rate),
      respiratory_rate: quiet(vitals.respiratory_rate),
      spo2: quiet(vitals.spo2),
      temperature: quiet(vitals.temperature),
    },
    bp,
    consciousness: "A",
    onOxygen: false,
    spo2Scale: 1,
    patch: true,
    signalLostMin: 0,
    irregular: false,
    ectopyPerHour: ectopyOf(id),
  }));
}

function fixtureSeeds(): PatientSeed[] {
  const seeds = [...fx.ranked, ...fx.unscored].map((row, i): PatientSeed => ({
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
  return [...seeds, ...extraSeeds()];
}

function presentValue<T>(m: Measured | undefined): T | null {
  return m?.data.present ? (m.data.value as T) : null;
}

function anchorsFromFixture(): Record<string, { vitals: Record<Vital, number>; cuff: Cuff }> {
  const rows = [...fx.ranked, ...fx.unscored];
  const out: Record<string, { vitals: Record<Vital, number>; cuff: Cuff }> = {};
  for (const row of rows) {
    const vitals = {} as Record<Vital, number>;
    for (const v of VITALS) {
      vitals[v] = presentValue<number>(row.vitals[v]) ?? DEMO_BASELINE[row.id]?.[v] ?? NaN;
    }
    const cuff = presentValue<Cuff>(row.vitals.blood_pressure) ?? DEMO_CUFF[row.id];
    out[row.id] = { vitals, cuff };
  }
  for (const [id, , , , , , vitals, cuff] of EXTRA) out[id] = { vitals: { ...vitals }, cuff };
  return out;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

export function createSyntheticSource(seed: number, flow = false): VitalsSource {
  const afPatients = new Set(AF_PATIENTS);
  const anchors = anchorsFromFixture();
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
  const flowRng = mulberry32(seed ^ 0x51ed270b);
  let admitted = 0;

  function admit(minute: number, occupied: { bed: string; rn: string; md: string }[]): PatientSeed | null {
    const taken = new Set(occupied.map((o) => o.bed));
    const sex = flowRng() < 0.5 ? "F" : "M";
    const free = (prefix: string) => BEDS.filter((b) => b.label.startsWith(prefix) && !taken.has(b.label));
    const onOxygen = flowRng() < EVER_ON_OXYGEN;
    const bed = [...(onOxygen ? free("H") : []), ...free(sex === "F" ? "A" : "B"), ...free("S"), ...free("H")][0];
    if (!bed) return null;

    admitted += 1;
    const id = `n-${String(admitted).padStart(4, "0")}`;
    const { condition, stayMin } = drawStayMin(flowRng);
    const systolic = drawFrom(fit.baseline.systolic, flowRng);
    const vitals: Record<Vital, number> = {
      heart_rate: drawFrom(fit.baseline.heart_rate, flowRng),
      respiratory_rate: drawFrom(fit.baseline.respiratory_rate, flowRng),
      spo2: drawFrom(fit.baseline.spo2, flowRng),
      temperature: drawFrom(fit.baseline.temperature, flowRng),
    };
    const cuff = { systolic: Math.round(systolic), diastolic: Math.round(Math.max(40, systolic - drawFrom(fit.baseline.pulsePressure, flowRng))) };
    anchors[id] = { vitals, cuff };
    const stream: Stream = {
      rng: mulberry32(seed + (ORDER.length + admitted) * 0x9e3779b1),
      spread: 1,
      latent: 0,
      wander: { heart_rate: 0, respiratory_rate: 0, spo2: 0, temperature: 0 },
      gapLeft: 0,
      injectAt: null,
      episode: null,
      rampMin: 1,
      bpRng: mulberry32(seed ^ ((ORDER.length + admitted) * 0x85ebca6b)),
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
    return {
      id,
      name: `${pick(SURNAMES)}, ${pick(GIVEN[sex])}`,
      age: 45 + Math.floor(flowRng() * 40), // shortcut: no ward age data fitted, a plain adult cardiology range
      sex,
      bed: bed.label,
      context: condition.context,
      story: `New admission, ${condition.story} (synthetic patient)`,
      rn: fewer("rn", "rn-delacruz", "rn-reyes"),
      md: fewer("md", "md-santos", "md-aquino"),
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
      ectopyPerHour: fit.rhythm.ectopyPerHour[Math.floor(flowRng() * 20)],
      dueMin: dueAt(minute, stayMin, flowRng),
      oxygenUntilMin: onOxygen ? minute + stayMin * OXYGEN_SHARE_OF_STAY : undefined,
    };
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
    const size = v === "temperature" ? INJECT_TEMPERATURE : (s.episode?.[v] ?? 0);
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
          CIRCADIAN_AMPLITUDE[v] * Math.sin((2 * Math.PI * (minute / 60)) / 24) +
          s.wander[v] +
          fit.vitals[v].loading * s.spread * s.latent +
          noise * gaussian(s.rng);
        const [low, high] = CLAMPS[v];
        out[v] = Math.min(high, Math.max(low, value));
      }
      if (s.gapLeft === 0 && s.rng() < 1 / MEAN_MINUTES_BETWEEN_DROPOUTS) {
        s.gapLeft = 1 + Math.floor(s.rng() * 4); // 1 to 4 minutes of lost contact
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
      return {
        systolic: Math.round(base.systolic + systolicMove + (s.episode?.systolic ?? 0) * ramp),
        diastolic: Math.round(
          base.diastolic +
            bp.diastolicPerSystolic * systolicMove +
            bp.diastolicNoise * gaussian(s.bpRng) +
            (s.episode?.diastolic ?? 0) * ramp,
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
  };
}
