// Replays real ICU stays through the sim. The data file is built by scripts/extract-eicu.mjs.
// All minutes are relative to the replay start, on a 5-minute grid.

import { SEATS, type Charted, type Cuff, type GateRules, type PatientSeed, type VitalsSource } from "./source";

type Point = [number, number];

export interface ReplayStay {
  id: string;
  dx: string;
  age: string;
  sex: string;
  unit: string;
  to: string;
  durationMin: number;
  hr: Point[];
  rr: Point[];
  spo2: Point[];
  temp: Point[];
  bp: [number, number, number][];
  o2: Point[];
  gcs: Point[];
}

export interface ReplayFile {
  dataset: string;
  licence: string;
  stays: ReplayStay[];
}

// Demo rules, measured against the eICU demo. Monitors keep the 8-of-15 rule, scaled to 5-minute
// data. Temperature is charted about every 3.4 hours, so it holds 8 hours.
const REPLAY_RULES: GateRules = {
  sampleEveryMin: 5,
  warmupMin: 480,
  minValid: { heart_rate: 2, respiratory_rate: 2, spo2: 2, temperature: 1 },
  degradedAfter: { heart_rate: 15, respiratory_rate: 15, spo2: 15, temperature: 480 },
  notRankedAfter: { heart_rate: 30, respiratory_rate: 30, spo2: 30, temperature: 480 },
  charted: ["temperature"],
};

const latest = <T extends number[]>(series: T[], minute: number) =>
  series.findLast((point) => point[0] <= minute) ?? null;

const at = (series: Point[], minute: number) =>
  series.find((point) => point[0] === minute)?.[1] ?? null;

export function createReplaySource(file: ReplayFile): VitalsSource {
  const stays = new Map(file.stays.map((stay) => [stay.id, stay]));
  const stay = (id: string) => stays.get(id)!;

  const charted = (id: string, minute: number): Charted => {
    const s = stay(id);
    const bp = latest(s.bp, minute);
    return {
      bp: bp && { systolic: bp[1], diastolic: bp[2] },
      bpAt: bp?.[0] ?? null,
      onOxygen: latest(s.o2, minute)?.[1] === 1,
      // ponytail: GCS 15 = Alert, lower = new confusion. Overstates confusion under sedation.
      consciousness: (latest(s.gcs, minute)?.[1] ?? 15) >= 15 ? "A" : "C",
    };
  };

  return {
    synthetic: false,
    rules: REPLAY_RULES,
    durationMin: Math.min(...file.stays.map((s) => s.durationMin)),

    seeds: (): PatientSeed[] =>
      file.stays.map((s, i) => {
        const chart = charted(s.id, 0);
        return {
          id: s.id,
          name: `Stay ${s.id}`,
          age: s.age,
          sex: s.sex,
          context: s.dx,
          story: `${s.unit}, later discharged to ${s.to}`,
          ...SEATS[i],
          trend: "insufficient",
          history: {
            heart_rate: Array(12).fill(null),
            respiratory_rate: Array(12).fill(null),
            spo2: Array(12).fill(null),
            temperature: Array(12).fill(null),
          },
          bp: chart.bp,
          consciousness: chart.consciousness,
          onOxygen: chart.onOxygen,
          spo2Scale: 1, // eICU records no scale; Scale 1 is the default for everyone without a decision
          patch: true,
          signalLostMin: 0,
        };
      }),

    read(id, minute) {
      const s = stay(id);
      const reading = {
        heart_rate: at(s.hr, minute),
        respiratory_rate: at(s.rr, minute),
        spo2: at(s.spo2, minute),
        temperature: at(s.temp, minute),
      };
      return Object.values(reading).every((v) => v === null) ? null : reading;
    },

    cuff(id, minute): Cuff | null {
      return charted(id, minute).bp;
    },

    charted,
  };
}
