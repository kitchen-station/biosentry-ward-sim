// An illustrative ECG strip drawn from the heart rate. It is not data and nothing analyses it.
// Beat timing comes from labelled real ECGs (fitted.json); the waveform shape is drawn.

import fit from "./sim/fitted.json";

const SECONDS = 4;
const RATE = 80; // points per second

/** Millivolt-ish shape of one beat, by seconds since the beat started. */
function beat(t: number, pWave: boolean, premature: boolean) {
  if (premature) return 1.1 * Math.exp(-(((t - 0.15) / 0.05) ** 2)) - 0.45 * Math.exp(-(((t - 0.36) / 0.09) ** 2));
  const bump = (centre: number, width: number, height: number) =>
    height * Math.exp(-(((t - centre) / width) ** 2));
  return (
    (pWave ? bump(0.04, 0.025, 0.12) : 0) +
    bump(0.13, 0.008, -0.12) +
    bump(0.15, 0.01, 1) +
    bump(0.17, 0.01, -0.25) +
    bump(0.38, 0.05, 0.28)
  );
}

/** A repeatable pseudo-random number for a beat, so the AF rhythm does not flicker. */
const jitter = (n: number) => {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x) - 0.5;
};

export function EcgStrip({
  hr,
  clockS,
  irregular,
  ectopyPerHour,
  width = 300,
  height = 56,
}: {
  hr: number | null;
  clockS: number;
  irregular: boolean;
  ectopyPerHour: number;
  width?: number;
  height?: number;
}) {
  const mid = height * 0.62;
  let points: string;
  if (hr === null) {
    points = `0,${mid} ${width},${mid}`;
  } else {
    const period = 60 / hr;
    const start = clockS - SECONDS;
    // Beat start times covering the window. AF: irregular intervals, no P wave, a little fibrillation.
    const beats: { at: number; premature: boolean }[] = [];
    const rrTable = irregular ? fit.rhythm.afRrRatio : fit.rhythm.sinusRrRatio;
    for (let n = Math.floor(start / period) - 2; n * period < clockS + period; n += 1) {
      const premature = !irregular && jitter(n + 0.37) + 0.5 < ectopyPerHour / (hr * 60);
      // Each beat moves on its own, so an interval differs by two draws: 0.71 keeps the fitted spread.
      const ratio = rrTable[1 + Math.floor((jitter(n) + 0.5) * (rrTable.length - 2))];
      const shift = premature ? (fit.rhythm.pvcCouplingRatio - 1) * period : (ratio - 1) * period * 0.71;
      beats.push({ at: n * period + shift, premature });
    }
    const out: string[] = [];
    for (let i = 0; i <= SECONDS * RATE; i += 1) {
      const t = start + i / RATE;
      const last = beats.filter((b) => b.at <= t).at(-1) ?? { at: t, premature: false };
      const fib = irregular ? 0.035 * Math.sin(t * 2 * Math.PI * 6.3) : 0;
      const y = mid - (beat(t - last.at, !irregular, last.premature) + fib) * height * 0.5;
      out.push(`${((i / (SECONDS * RATE)) * width).toFixed(1)},${y.toFixed(1)}`);
    }
    points = out.join(" ");
  }
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="ecg" aria-hidden="true">
      <polyline points={points} fill="none" stroke="var(--ink-900)" strokeWidth={1.5} />
    </svg>
  );
}
