// The vitals source: the one seam a real dataset replaces. Everything below VitalsSource is the
// synthetic implementation, a live version of BioSentry's removed batch generator.

import type { Acvpu } from "./news2";
import fixture from "./synthetic.json";

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

// Generator constants, unchanged from BioSentry.
export const CLAMPS: Record<Vital, [number, number]> = {
  heart_rate: [30, 200],
  respiratory_rate: [6, 40],
  spo2: [78, 100],
  temperature: [34.5, 40.5],
};
const COUPLING: Record<Vital, number> = {
  heart_rate: 1.2,
  respiratory_rate: 0.35,
  spo2: -0.25,
  temperature: 0.03,
};
const MEASUREMENT_NOISE: Record<Vital, number> = {
  heart_rate: 0.8,
  respiratory_rate: 0.4,
  spo2: 0.25,
  temperature: 0.02,
};
const CIRCADIAN_AMPLITUDE: Record<Vital, number> = {
  heart_rate: 2.0,
  respiratory_rate: 0.3,
  spo2: 0,
  temperature: 0.12,
};
const AF_IRREGULARITY_BPM = 6;
const MEAN_MINUTES_BETWEEN_DROPOUTS = 150;

// Scales the slow wander down. Fixture values sit on NEWS2 band edges, so a full-size wander
// churns the ranking. sim.test.ts pins the resulting score-change rate.
const LIVE_WANDER = 0.35;

const WANDER_NOISE: Record<Vital, number> = {
  heart_rate: 2.5,
  respiratory_rate: 0.6,
  spo2: 0.4,
  temperature: 0.05,
};
const HR_NOISE: Record<string, number> = {
  "p-001": 3.0,
  "p-002": 1.5,
  "p-006": 2.0,
  "p-009": 3.5,
  "p-011": 1.5,
};
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

const INJECT: Record<Vital | "systolic", number> = {
  heart_rate: 30,
  respiratory_rate: 8,
  spo2: -6,
  temperature: 0.6,
  systolic: -30,
};
const INJECT_MINUTES = 90;

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
export const SEATS = ROWS.map((row) => ({
  bed: row.bed,
  rn: assignee(row.id, "rn")!,
  md: assignee(row.id, "md") ?? DEMO_PHYSICIAN[row.id],
  listMd: assignee(row.id, "md") ?? null,
}));

/** Seats for a replay: the first four patients take the first four (high dependency), the rest a seat of their sex. */
export function allocateBeds(sexes: string[]): (typeof SEATS)[number][] {
  const free = SEATS.map((_, k) => k);
  return sexes.map((sex, i) => {
    if (free.length === 0) throw new Error(`No free bed for patient ${i + 1}; the ward has ${SEATS.length}`);
    const at = i < 4 ? 0 : Math.max(0, free.findIndex((k) => ROWS[k].sex === sex));
    return SEATS[free.splice(at, 1)[0]];
  });
}

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

const injectRamp = (minute: number, start: number | null) =>
  start === null || minute <= start ? 0 : Math.min(1, ((minute - start) / INJECT_MINUTES) ** 2);

export function createSyntheticSource(seed: number): VitalsSource {
  const anchors = anchorsFromFixture();
  const streams = Object.fromEntries(
    Object.keys(anchors).map((id, i) => [
      id,
      {
        rng: mulberry32(seed + (i + 1) * 0x9e3779b1),
        latent: 0,
        wander: { heart_rate: 0, respiratory_rate: 0, spo2: 0, temperature: 0 } as Record<Vital, number>,
        gapLeft: 0,
        injectAt: null as number | null,
      },
    ]),
  );

  return {
    synthetic: true,
    rules: SYNTHETIC_RULES,
    seeds: fixtureSeeds,

    read(id, minute) {
      const anchor = anchors[id].vitals;
      if (minute <= 0) return { ...anchor }; // t=0 parity with the fixture holds by construction
      const s = streams[id];
      s.latent = ou(s.latent, 45, LIVE_WANDER, s.rng);
      const out = {} as DeviceReading;
      for (const v of VITALS) {
        const wanderSd = (v === "heart_rate" ? (HR_NOISE[id] ?? 2.5) : WANDER_NOISE[v]) * LIVE_WANDER;
        s.wander[v] = ou(s.wander[v], 20, wanderSd, s.rng);
        const noise =
          v === "heart_rate" && AF_PATIENTS.has(id)
            ? Math.hypot(MEASUREMENT_NOISE[v], AF_IRREGULARITY_BPM)
            : MEASUREMENT_NOISE[v];
        const value =
          anchor[v] +
          ((SLOPE[id]?.[v] ?? 0) * 2 * Math.min(minute, 180)) / 360 +
          INJECT[v] * injectRamp(minute, s.injectAt) +
          CIRCADIAN_AMPLITUDE[v] * Math.sin((2 * Math.PI * (minute / 60)) / 24) +
          s.wander[v] +
          COUPLING[v] * s.latent +
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
      const drop = INJECT.systolic * injectRamp(minute, streams[id].injectAt);
      return {
        systolic: Math.round(base.systolic + drop),
        diastolic: Math.round(base.diastolic + drop * 0.6),
      };
    },

    inject(id, minute) {
      streams[id].injectAt ??= minute;
    },
  };
}
