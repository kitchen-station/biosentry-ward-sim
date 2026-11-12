// "What is real here": plain data for the panel. Each row names where it comes from in the repo (`ref`, "file: symbol").
// A shown number is imported from the code, never retyped; src/real.test.ts checks every ref and number.
import { PARAMS, UNITS } from "./sim/hospital/params";

export type Bucket = "real" | "judgement" | "not_modelled";
export interface RealRow {
  bucket: Bucket;
  thing: string;
  value?: string;
  why: string;
  ref: string;
  /** The number behind `value`, taken from PARAMS or UNITS. The test compares it with the code. */
  num?: number;
  /** `num` is a share, shown as a percent. */
  pct?: boolean;
}

export const BUCKETS: { id: Bucket; title: string }[] = [
  { id: "real", title: "From real data or a published source" },
  { id: "judgement", title: "Our judgement" },
  { id: "not_modelled", title: "Not modelled" },
];

export const SYNTHETIC_LINE = "Every patient is synthetic. No real patient data is in this app.";

const percent = (n: number) => `${Math.round(n * 1000) / 10}%`;
const medicine = UNITS.find((u) => u.id === "MED3A")!;

export const ROWS: RealRow[] = [
  { bucket: "real", thing: "How vital signs drift, move together and differ between patients", value: "fitted on 885 ICU stays",
    why: "eICU-CRD Demo, adult, alive, awake. Minute-to-minute noise for heart rate, breathing and oxygen is from BIDMC. ICU data, not ward data.",
    ref: 'src/sim/calibration.json: "stays": 885' },
  { bucket: "real", thing: "Size and speed of a deterioration episode", value: "three kinds, fitted on the same ICU stays",
    why: "Respiratory, fast heart rate, low blood pressure. The rule that counts as an episode is our definition; no open data labels deterioration.",
    ref: "src/sim/source.ts: pickEpisode" },
  { bucket: "real", thing: "Temperature during deterioration", value: "does not rise",
    why: "Ward studies (Churpek 2012, 2015) find it does not separate patients who go on to arrest from others.",
    ref: "README.md: Temperature does not rise in an episode" },
  { bucket: "real", thing: "Patch data gaps", value: "one about every 146 minutes",
    why: "ViSi Mobile ward pilot. The 4-hour cap on a gap is our judgement.",
    ref: "src/sim/source.ts: MEAN_MINUTES_BETWEEN_DROPOUTS = 146" },
  { bucket: "real", thing: "NEWS2 scoring", value: "Royal College of Physicians chart",
    why: "Ported from BioSentry and checked against its fixture at minute 0.",
    ref: "src/sim/news2.ts: scoreNews2" },
  { bucket: "real", thing: "How often a high-risk patient is observed outside W4 and the ICU", value: `every ${PARAMS.obs.intervalMin.watch.value} minutes`,
    why: "NEWS2 chart 4: at least hourly for a score of 5 or more. No Philippine standard was found.",
    ref: "src/sim/hospital/params.ts: obs.intervalMin.watch", num: PARAMS.obs.intervalMin.watch.value },
  { bucket: "real", thing: "Time for one set of observations", value: `${PARAMS.obs.roundMin.value} minutes`,
    why: "Dall'Ora 2021, 16 English wards. England, not the Philippines.",
    ref: "src/sim/hospital/params.ts: obs.roundMin", num: PARAMS.obs.roundMin.value },
  { bucket: "real", thing: "Emergency room arrivals by shift", value: `${percent(PARAMS.arrivals.blockShares.value[1])} in the 14:00 to 22:00 block`,
    why: "Table from a private Philippine emergency department. How many arrive per day is ours (see below).",
    ref: "src/sim/hospital/params.ts: arrivals.blockShares", num: PARAMS.arrivals.blockShares.value[1], pct: true },

  { bucket: "judgement", thing: "Share of a nurse's time spent on observation rounds", value: percent(PARAMS.obs.shareOfNurseTime.value),
    why: "Our judgement; the late-rounds result depends strongly on it. No source for this share was found.",
    ref: "src/sim/hospital/params.ts: obs.shareOfNurseTime", num: PARAMS.obs.shareOfNurseTime.value, pct: true },
  { bucket: "judgement", thing: "Emergency room arrivals per day, typical hospital", value: `${PARAMS.arrivals.perDay.typical.value}`,
    why: "Set so medicine wards land inside the crowding range reported for large public hospitals. Our bed counts feed into it.",
    ref: "src/sim/hospital/params.ts: arrivals.perDay.typical", num: PARAMS.arrivals.perDay.typical.value },
  { bucket: "judgement", thing: "Nurses on a medicine ward, typical hospital", value: `${medicine.nurses.typical.value} per shift`,
    why: "A published DOH ward standard exists. We picked a count that lands near reported ratios. The ward's bed count is also ours.",
    ref: "src/sim/hospital/params.ts: UNITS.MED3A.nurses.typical", num: medicine.nurses.typical.value },
  { bucket: "judgement", thing: "Mix of deterioration kinds", value: "55% breathing, 20% fast heart rate, 25% low blood pressure",
    why: "No published split exists. Raw ICU counts would make low blood pressure half of all events.",
    ref: "src/sim/source.ts: respiratory: 0.55, tachycardic: 0.2, hypotensive: 0.25" },
  { bucket: "judgement", thing: "Temperature noise", value: "0.1 °C",
    why: "About the thermometer's resolution. No open minute-level source.",
    ref: "src/sim/source.ts: TEMPERATURE_NOISE = 0.1" },
  { bucket: "judgement", thing: "Chance an emergent emergency room patient dies there", value: percent(PARAMS.death.erPhase.emergent.value),
    why: `The overall emergency room death rate (${percent(PARAMS.death.erOverall.value)}) is from one Philippine hospital. How it splits by triage level is ours.`,
    ref: "src/sim/hospital/params.ts: death.erPhase.emergent", num: PARAMS.death.erPhase.emergent.value, pct: true },

  { bucket: "not_modelled", thing: "Whether crowding or late rounds change who dies", why: "Deaths are drawn in advance for each person. Crowding and late rounds do not change them.",
    ref: "docs/hospital-trial-format.md: Deaths are pre-drawn fates" },
  { bucket: "not_modelled", thing: "Care outside W4 beyond observation rounds", why: "Staffing outside W4 drives observation rounds only. It does not model treatment.",
    ref: "docs/hospital-trial-format.md: staffing outside W4 drives observation rounds only" },
  { bucket: "not_modelled", thing: "Infection with fever or low temperature", why: "Not an episode kind yet.",
    ref: "README.md: Infection is not modelled" },
  { bucket: "not_modelled", thing: "Real ward patients", why: "No open ward-level dataset was found. Real ward patients may be steadier than ICU-based vitals.",
    ref: "README.md: No ward data" },
];
