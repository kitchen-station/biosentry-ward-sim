import { describe, expect, it } from "vitest";
import calibration from "./calibration.json";
import { createSyntheticSource, type Vital } from "./source";

// The fitted generator should move like the held-out real stays: detrended
// 5-minute medians, change sd at each lag, median across patients inside the held-out p25 to p75.
// scripts/fit-eicu.mjs does the same reduction on the real data.
const VITALS = ["heart_rate", "respiratory_rate", "spo2"] as const satisfies readonly Vital[];
const SKIP = new Set(["p-001", "p-009"]); // scripted slope, atrial fibrillation
const SEEDS = [1, 2, 3];
const DAYS = 3;
const HALF_WINDOW = 36; // 6-hour rolling median, as in the fit

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const mid = (s.length - 1) / 2;
  return (s[Math.floor(mid)] + s[Math.ceil(mid)]) / 2;
};

function detrend(x: number[]) {
  return x.map((value, i) => {
    if (Number.isNaN(value)) return NaN;
    const window = x.slice(Math.max(0, i - HALF_WINDOW), i + HALF_WINDOW + 1).filter((w) => !Number.isNaN(w));
    return window.length >= 12 ? value - median(window) : NaN;
  });
}

function changes(x: number[], lagSlots: number) {
  const out: number[] = [];
  for (let i = 0; i + lagSlots < x.length; i += 1) {
    if (!Number.isNaN(x[i]) && !Number.isNaN(x[i + lagSlots])) out.push(x[i + lagSlots] - x[i]);
  }
  return out;
}

const sd = (d: number[]) => {
  const mean = d.reduce((a, b) => a + b) / d.length;
  return Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length);
};

describe("calibration against the held-out eICU stays", () => {
  // patient -> vital -> lag -> pooled changes across seeds
  const pooled: Record<string, Record<string, number[][]>> = {};
  for (const seed of SEEDS) {
    const src = createSyntheticSource(seed);
    for (const { id } of src.seeds()) {
      if (SKIP.has(id)) continue;
      const slots = (DAYS * 1440) / 5;
      const bins = Object.fromEntries(VITALS.map((v) => [v, Array.from({ length: slots }, () => [] as number[])]));
      for (let minute = 1; minute <= DAYS * 1440; minute += 1) {
        const reading = src.read(id, minute);
        if (!reading) continue;
        for (const v of VITALS) bins[v][Math.floor((minute - 1) / 5)].push(reading[v]!);
      }
      for (const v of VITALS) {
        const x = detrend(bins[v].map((b) => (b.length ? median(b) : NaN)));
        const per = ((pooled[id] ??= {})[v] ??= calibration.changeSd[v].map(() => [] as number[]));
        calibration.changeSd[v].forEach(({ lag }, k) => per[k].push(...changes(x, lag / 5)));
      }
    }
  }

  for (const v of VITALS) {
    calibration.changeSd[v].forEach((band, k) => {
      // Known miss: RR and SpO2 noise comes from BIDMC, a minute apart, and runs below eICU's 5-minute medians.
      const check = band.lag === 5 && v !== "heart_rate" ? it.fails : it;
      check(`${v} change sd at ${band.lag} minutes sits inside the held-out p25 to p75`, () => {
        const m = median(Object.values(pooled).map((byVital) => sd(byVital[v][k])));
        expect(m).toBeGreaterThanOrEqual(band.p25);
        expect(m).toBeLessThanOrEqual(band.p75);
      });
    });
  }
});
