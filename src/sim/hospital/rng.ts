// Named random streams for the hospital layer. A stream is one number of state, so it can live in saved JSON.
// Each stream is seeded by its own name, so drawing from one never advances another: a person's draws do not change
// when a unit is added or a rate changes, whatever else is drawn first.
// shortcut: every stream is a different offset on the one 2^32-state mulberry32 cycle, so two streams can overlap;
// an exact seed collision among 3,000 persons has probability about 1e-3 per run. Upgrade to a generator with 128 bits
// of state before year-long runs.

/** FNV-1a, 32 bit, over UTF-16 code units. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** The first state of the stream `name` under the master `seed`. */
export const streamSeed = (seed: number, name: string): number => fnv1a(`${seed}:${name}`);

/** Pure form: one mulberry32 step (the arithmetic of `mulberry32` in source.ts). Returns [draw in [0,1), new state]. */
export function next(state: number): [number, number] {
  const a = (state + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, a];
}

export interface Rng {
  (): number;
  /** The whole state: `rngFrom(r.state())` continues the same sequence. */
  state(): number;
}

/** Closure form over the same arithmetic. */
export function rngFrom(state: number): Rng {
  let s = state >>> 0;
  const draw = (() => {
    const [value, after] = next(s);
    s = after;
    return value;
  }) as Rng;
  draw.state = () => s;
  return draw;
}

export const stream = (seed: number, name: string): Rng => rngFrom(streamSeed(seed, name));

export const uniform = (rng: () => number, lo: number, hi: number) => lo + (hi - lo) * rng();

/** One draw. `1 - u` is in (0, 1], so the log is never of 0. */
export const exponential = (rng: () => number, mean: number) => -mean * Math.log(1 - rng());

/** Box-Muller with no cached spare: always exactly two draws, so the stream position never depends on parity. */
export function normal(rng: () => number, mean: number, sd: number) {
  const u1 = 1 - rng();
  const u2 = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** `median` is exp(mu), not the mean; the mean is median * exp(sigma^2 / 2). */
export const lognormal = (rng: () => number, median: number, sigma: number) =>
  median * Math.exp(sigma * normal(rng, 0, 1));

/** Index of the pick, one draw. A zero weight is never picked. */
export function weightedPick(rng: () => number, weights: readonly number[]): number {
  const total = weights.reduce((a, w) => a + w, 0);
  if (!(total > 0) || weights.some((w) => !(w >= 0))) throw new RangeError("weights must be non-negative with a positive sum");
  let at = rng() * total;
  for (let i = 0; i < weights.length; i += 1) {
    at -= weights[i];
    if (at < 0) return i;
  }
  return weights.findLastIndex((w) => w > 0); // rounding left a sliver past the end
}

// shortcut: Knuth's product method, exact but it takes about `rate` draws; a rate above 50 is refused,
// split a long interval into shorter ones (or switch method) if one is ever needed. Arrivals must be drawn per hour or
// finer: the worst accepted hourly rate is 26.5, but an 8-hour block would be 212.
export const POISSON_MAX_RATE = 50;
export function poisson(rng: () => number, rate: number): number {
  if (!(rate >= 0 && rate <= POISSON_MAX_RATE)) throw new RangeError("poisson rate must be from 0 to 50");
  const limit = Math.exp(-rate);
  let count = 0;
  for (let p = rng(); p > limit; p *= rng()) count += 1;
  return count;
}
