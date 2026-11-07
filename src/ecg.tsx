// An illustrative ECG strip drawn from the heart rate. It is not data and nothing analyses it.

const SECONDS = 4;
const RATE = 80; // points per second

/** Millivolt-ish shape of one beat, by seconds since the beat started. */
function beat(t: number, pWave: boolean) {
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
  width = 300,
  height = 56,
}: {
  hr: number | null;
  clockS: number;
  irregular: boolean;
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
    const beats: number[] = [];
    for (let n = Math.floor(start / period) - 2; n * period < clockS + period; n += 1) {
      beats.push(n * period + (irregular ? jitter(n) * period * 0.45 : 0));
    }
    const out: string[] = [];
    for (let i = 0; i <= SECONDS * RATE; i += 1) {
      const t = start + i / RATE;
      const last = beats.filter((b) => b <= t).at(-1) ?? t;
      const fib = irregular ? 0.035 * Math.sin(t * 2 * Math.PI * 6.3) : 0;
      const y = mid - (beat(t - last, !irregular) + fib) * height * 0.5;
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
