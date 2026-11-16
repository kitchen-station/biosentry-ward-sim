// What an observation chart draws behind one vital: the NEWS2 score bands, a fixed axis and its unit. Pure data.
//
// Bands: Royal College of Physicians, NEWS2 observation chart (Chart 3, 2022): one band per parameter, each range
// shaded by its score, key 0 none, 1 yellow, 2 orange, 3 red.
// https://www.rcp.ac.uk/media/eczf5mvm/news2-chart-3_news-observation-chart_2022_0_0.pdf
// The numbers here are not a second copy to keep in step by hand: a test scores every value on each axis with the
// scorer (src/sim/news2.ts, whose bands must not change) and requires the same score.
//
// Ours, not the RCP's: the fixed axis ranges (so small noise never fills the chart, and two charts of one vital compare),
// the tick places, and SpO2 on scale 1 only (a patient on scale 2 is scored by the scorer, but this axis shows scale 1).
export type ObsVital = "respiratory_rate" | "spo2" | "systolic_bp" | "heart_rate" | "temperature";

/** `upTo`: the highest value in this band (inclusive), at the precision the score is taken at. The last band has none. */
interface Edge { upTo: number | null; score: 0 | 1 | 2 | 3 }
export interface ObsSpec {
  label: string; unit: string;
  /** The axis, fixed. */
  lo: number; hi: number;
  /** The precision a value is scored at: 1, or 0.1 for temperature. */
  step: number;
  /** Bands from the bottom of the axis up. */
  bands: Edge[];
}

export const OBS: Record<ObsVital, ObsSpec> = {
  // The order of the RCP chart: respirations, SpO2, blood pressure, pulse, temperature.
  respiratory_rate: { label: "Respirations", unit: "breaths/min", lo: 4, hi: 36, step: 1, bands: [{ upTo: 8, score: 3 }, { upTo: 11, score: 1 }, { upTo: 20, score: 0 }, { upTo: 24, score: 2 }, { upTo: null, score: 3 }] },
  spo2: { label: "SpO2 (scale 1)", unit: "%", lo: 82, hi: 100, step: 1, bands: [{ upTo: 91, score: 3 }, { upTo: 93, score: 2 }, { upTo: 95, score: 1 }, { upTo: null, score: 0 }] },
  systolic_bp: { label: "Systolic BP", unit: "mmHg", lo: 70, hi: 230, step: 1, bands: [{ upTo: 90, score: 3 }, { upTo: 100, score: 2 }, { upTo: 110, score: 1 }, { upTo: 219, score: 0 }, { upTo: null, score: 3 }] },
  heart_rate: { label: "Pulse", unit: "beats/min", lo: 30, hi: 160, step: 1, bands: [{ upTo: 40, score: 3 }, { upTo: 50, score: 1 }, { upTo: 90, score: 0 }, { upTo: 110, score: 1 }, { upTo: 130, score: 2 }, { upTo: null, score: 3 }] },
  temperature: { label: "Temperature", unit: "°C", lo: 34, hi: 41, step: 0.1, bands: [{ upTo: 35.0, score: 3 }, { upTo: 36.0, score: 1 }, { upTo: 38.0, score: 0 }, { upTo: 39.0, score: 1 }, { upTo: null, score: 2 }] },
};

/** The RCP key. 0 has no colour. */
export const SCORE_COLOUR: Record<1 | 2 | 3, string> = { 1: "#FFD93D", 2: "#FFA07A", 3: "#FF6B6B" };

/** The score band a value falls in, as this axis draws it. */
export function obsScore(vital: ObsVital, value: number): 0 | 1 | 2 | 3 {
  for (const b of OBS[vital].bands) if (b.upTo === null || value <= b.upTo) return b.score;
  return 0;
}

/** The bands as spans of the axis: a band ends half a step above its highest value, where the next begins. */
export function obsSpans(vital: ObsVital): { from: number; to: number; score: 0 | 1 | 2 | 3 }[] {
  const { lo, hi, step, bands } = OBS[vital];
  let from = lo;
  return bands.map((b) => {
    const to = b.upTo === null ? hi : Math.min(hi, b.upTo + step / 2);
    const span = { from, to, score: b.score };
    from = to;
    return span;
  });
}

/** The NEWS2 total's own bands (RCP: 5 or 6 is a medium score, 7 or more is high). The scorer's risk word is checked against these in a test. */
export const TOTAL = { lo: 0, hi: 20, mediumFrom: 5, highFrom: 7 };

/** Numbers behind a chart, for the reader. Ours, not a NEWS2 practice: the count, the last value, the lowest, the highest and the middle one. */
export function summarise(values: (number | null | "skip")[]): { count: number; last: number | null; min: number | null; max: number | null; median: number | null } {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (v.length === 0) return { count: 0, last: null, min: null, max: null, median: null };
  const s = [...v].sort((a, b) => a - b);
  const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { count: v.length, last: v[v.length - 1], min: s[0], max: s[s.length - 1], median: mid };
}

/** How long a series sat in each band: the readings in the band times the minutes one reading stands for. Ours, not a NEWS2 practice. */
export function timeInBands(values: (number | null | "skip")[], stepMin: number, bandOf: (v: number) => string, names: readonly string[]): { band: string; minutes: number }[] {
  const count = new Map<string, number>(names.map((n) => [n, 0]));
  for (const v of values) if (typeof v === "number" && Number.isFinite(v)) count.set(bandOf(v), (count.get(bandOf(v)) ?? 0) + 1);
  return names.map((band) => ({ band, minutes: (count.get(band) ?? 0) * stepMin }));
}
/** The band names of a vital's score and of the NEWS2 total, as the large view prints them. */
export const SCORE_BANDS = ["score 0", "score 1", "score 2", "score 3"] as const;
export const TOTAL_BANDS = ["0 to 4", "5 or 6", "7 or more"] as const;
export const totalBand = (total: number) => (total >= TOTAL.highFrom ? TOTAL_BANDS[2] : total >= TOTAL.mediumFrom ? TOTAL_BANDS[1] : TOTAL_BANDS[0]);
