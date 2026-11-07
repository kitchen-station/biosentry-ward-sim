// NEWS2 (RCP 2017), ported from BioSentry's removed Tier A scorer. Deterministic and pure.
// Every input is required: a missing or impossible input abstains, nothing is imputed.

export type Acvpu = "A" | "C" | "V" | "P" | "U";
export type Risk = "low" | "low_medium" | "medium" | "high";
export type Problem = "missing" | "implausible";

interface Band {
  low: number | null; // inclusive; null = unbounded below
  high: number | null; // inclusive; null = unbounded above
  score: number;
  label: string;
  onOxygen?: boolean; // undefined = any
}

const band = (
  low: number | null,
  high: number | null,
  score: number,
  label: string,
  onOxygen?: boolean,
): Band => ({ low, high, score, label, onOxygen });

const RESPIRATORY_RATE = [
  band(null, 8, 3, "≤8"),
  band(9, 11, 1, "9-11"),
  band(12, 20, 0, "12-20"),
  band(21, 24, 2, "21-24"),
  band(25, null, 3, "≥25"),
];
const SPO2_SCALE_1 = [
  band(null, 91, 3, "≤91"),
  band(92, 93, 2, "92-93"),
  band(94, 95, 1, "94-95"),
  band(96, null, 0, "≥96"),
];
// Scale 2 is for confirmed hypercapnic respiratory failure, on a clinician's recorded decision.
const SPO2_SCALE_2 = [
  band(null, 83, 3, "≤83"),
  band(84, 85, 2, "84-85"),
  band(86, 87, 1, "86-87"),
  band(88, 92, 0, "88-92"),
  band(93, null, 0, "≥93 on air", false),
  band(93, 94, 1, "93-94 on oxygen", true),
  band(95, 96, 2, "95-96 on oxygen", true),
  band(97, null, 3, "≥97 on oxygen", true),
];
const SYSTOLIC_BP = [
  band(null, 90, 3, "≤90"),
  band(91, 100, 2, "91-100"),
  band(101, 110, 1, "101-110"),
  band(111, 219, 0, "111-219"),
  band(220, null, 3, "≥220"),
];
const HEART_RATE = [
  band(null, 40, 3, "≤40"),
  band(41, 50, 1, "41-50"),
  band(51, 90, 0, "51-90"),
  band(91, 110, 1, "91-110"),
  band(111, 130, 2, "111-130"),
  band(131, null, 3, "≥131"),
];
const TEMPERATURE = [
  band(null, 35.0, 3, "≤35.0"),
  band(35.1, 36.0, 1, "35.1-36.0"),
  band(36.1, 38.0, 0, "36.1-38.0"),
  band(38.1, 39.0, 1, "38.1-39.0"),
  band(39.1, null, 2, "≥39.1"),
];

const SINGLE_PARAMETER_TRIGGER = 3;
const MEDIUM_FROM = 5;
const HIGH_FROM = 7;

const PHYSICAL_MAX = 1000;
const SPO2_MAX = 100;
// Exactly 0 is real for heart rate (asystole) and respiratory rate (apnoea), but for these
// three it is what a zero-fill looks like, so it abstains instead of scoring 3.
const ZERO_IS_NOT_A_READING = new Set(["spo2", "temperature", "systolic_bp"]);

export interface News2Inputs {
  respiratory_rate: number | null;
  spo2: number | null;
  spo2_scale: 1 | 2 | null;
  supplemental_o2: boolean | null;
  systolic_bp: number | null;
  heart_rate: number | null;
  consciousness: Acvpu | null;
  temperature: number | null;
}

export type InputName = keyof News2Inputs;

export interface InputProblem {
  input: InputName;
  problem: Problem;
}

export interface ParameterScore {
  parameter: InputName;
  value: string;
  unit: string;
  band: string;
  score: number;
}

export interface News2Score {
  kind: "score";
  total: number;
  risk: Risk;
  parameters: ParameterScore[];
  singleThrees: InputName[];
  totalReason: string;
  triggerReason: string | null;
  reasons: string[];
}

export interface News2Abstained {
  kind: "abstained";
  problems: InputProblem[];
}

export type News2Result = News2Score | News2Abstained;

const LABELS: Record<InputName, string> = {
  respiratory_rate: "respiratory rate",
  spo2: "SpO2",
  spo2_scale: "SpO2 scale",
  supplemental_o2: "supplemental oxygen",
  systolic_bp: "systolic BP",
  heart_rate: "heart rate",
  consciousness: "level of consciousness",
  temperature: "temperature",
};
const UNITS: Partial<Record<InputName, string>> = {
  respiratory_rate: "/min",
  spo2: "%",
  systolic_bp: " mmHg",
  heart_rate: "/min",
  temperature: " °C",
};

/** Round the decimal as written, half-up: 36.05 -> 36.1, 8.5 -> 9. Inputs are non-negative. */
export function roundHalfUp(value: number, places: number): number {
  const text = String(value);
  if (text.includes("e")) return Math.round(value * 10 ** places) / 10 ** places;
  return Number(`${Math.round(Number(`${text}e${places}`))}e-${places}`);
}

function bandFor(bands: Band[], value: number, onOxygen: boolean): Band {
  const matches = bands.filter(
    (b) =>
      (b.low === null || value >= b.low) &&
      (b.high === null || value <= b.high) &&
      (b.onOxygen === undefined || b.onOxygen === onOxygen),
  );
  if (matches.length !== 1) throw new Error(`${matches.length} NEWS2 bands match ${value}`);
  return matches[0];
}

function usable(
  name: InputName,
  value: number | null,
  problems: InputProblem[],
): number | null {
  if (value === null || !Number.isFinite(value)) {
    problems.push({ input: name, problem: "missing" });
    return null;
  }
  const belowFloor = ZERO_IS_NOT_A_READING.has(name) ? value <= 0 : value < 0;
  if (belowFloor || value > PHYSICAL_MAX || (name === "spo2" && value > SPO2_MAX)) {
    problems.push({ input: name, problem: "implausible" });
    return null;
  }
  return value;
}

const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function totalBand(total: number): string {
  if (total >= HIGH_FROM) return `≥${HIGH_FROM}`;
  if (total >= MEDIUM_FROM) return `${MEDIUM_FROM}-${HIGH_FROM - 1}`;
  return `0-${MEDIUM_FROM - 1}`;
}

/** Score one set of observations, or abstain naming exactly what blocks it. */
export function scoreNews2(inputs: News2Inputs): News2Result {
  const problems: InputProblem[] = [];
  const rr = usable("respiratory_rate", inputs.respiratory_rate, problems);
  const spo2 = usable("spo2", inputs.spo2, problems);
  const sbp = usable("systolic_bp", inputs.systolic_bp, problems);
  const hr = usable("heart_rate", inputs.heart_rate, problems);
  const temp = usable("temperature", inputs.temperature, problems);
  const { spo2_scale: scale, supplemental_o2: onO2, consciousness: level } = inputs;
  if (scale === null) problems.push({ input: "spo2_scale", problem: "missing" });
  if (onO2 === null) problems.push({ input: "supplemental_o2", problem: "missing" });
  if (level === null) problems.push({ input: "consciousness", problem: "missing" });
  if (
    rr === null || spo2 === null || sbp === null || hr === null || temp === null ||
    scale === null || onO2 === null || level === null
  ) {
    const order = Object.keys(LABELS) as InputName[];
    return {
      kind: "abstained",
      problems: [...problems].sort((a, b) => order.indexOf(a.input) - order.indexOf(b.input)),
    };
  }

  const rows: ParameterScore[] = [];
  const banded = (name: InputName, bands: Band[], raw: number, places: number) => {
    const value = roundHalfUp(raw, places);
    const hit = bandFor(bands, value, onO2);
    rows.push({
      parameter: name,
      value: value.toFixed(places),
      unit: UNITS[name] ?? "",
      band: hit.label,
      score: hit.score,
    });
  };

  banded("respiratory_rate", RESPIRATORY_RATE, rr, 0);
  banded("spo2", scale === 1 ? SPO2_SCALE_1 : SPO2_SCALE_2, spo2, 0);
  const oxygen = onO2 ? "oxygen" : "air";
  rows.push({
    parameter: "supplemental_o2",
    value: oxygen,
    unit: "",
    band: oxygen,
    score: onO2 ? 2 : 0,
  });
  banded("systolic_bp", SYSTOLIC_BP, sbp, 0);
  banded("heart_rate", HEART_RATE, hr, 0);
  const alert = level === "A";
  rows.push({
    parameter: "consciousness",
    value: level,
    unit: "",
    band: alert ? "Alert" : "new confusion, V, P or U",
    score: alert ? 0 : 3,
  });
  banded("temperature", TEMPERATURE, temp, 1);

  const total = rows.reduce((sum, r) => sum + r.score, 0);
  const singleThrees = rows
    .filter((r) => r.score === SINGLE_PARAMETER_TRIGGER)
    .map((r) => r.parameter);
  const risk: Risk =
    total >= HIGH_FROM
      ? "high"
      : total >= MEDIUM_FROM
        ? "medium"
        : singleThrees.length > 0
          ? "low_medium"
          : "low";

  const reasons = rows
    .filter((r) => r.score > 0)
    .map(
      (r) =>
        `${sentenceCase(LABELS[r.parameter])} ${r.value}${r.unit}: ${r.band} scores ${r.score}`,
    );
  const totalReason = `Total ${total} (${totalBand(total)}): ${risk.replace("_", "-")}`;
  reasons.push(totalReason);
  let triggerReason: string | null = null;
  if (singleThrees.length > 0) {
    const names = singleThrees.map((n) => LABELS[n]).join(", ");
    triggerReason = `Single parameter at ${SINGLE_PARAMETER_TRIGGER}: ${names}`;
    reasons.push(triggerReason);
  }

  return {
    kind: "score",
    total,
    risk,
    parameters: rows,
    singleThrees,
    totalReason,
    triggerReason,
    reasons,
  };
}
