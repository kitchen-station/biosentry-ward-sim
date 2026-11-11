import { describe, expect, it } from "vitest";
import { mulberry32 } from "../source";
import { exponential, fnv1a, lognormal, next, normal, poisson, rngFrom, stream, streamSeed, uniform, weightedPick } from "./rng";

const N = 100_000;
const draws = (n: number, f: () => number) => Array.from({ length: n }, f);
const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
const variance = (xs: number[]) => {
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) ** 2));
};

describe("fnv1a and stream names", () => {
  it("matches the published FNV-1a 32-bit test vectors", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(fnv1a("foobar")).toBe(0xbf9cf968);
  });

  it("seeds a stream from the seed and its name", () => {
    expect(streamSeed(101, "person:5")).toBe(fnv1a("101:person:5"));
    expect(streamSeed(101, "person:5")).not.toBe(streamSeed(101, "person:6"));
    expect(streamSeed(101, "arrivals")).not.toBe(streamSeed(102, "arrivals"));
  });
});

describe("streams", () => {
  const take = (r: () => number, n = 6) => draws(n, r);

  it("gives the same stream for the same seed and a different one for another seed", () => {
    expect(take(stream(7, "arrivals"))).toEqual(take(stream(7, "arrivals")));
    expect(take(stream(7, "arrivals"))).not.toEqual(take(stream(8, "arrivals")));
    expect(take(stream(7, "arrivals"))).not.toEqual(take(stream(7, "person:1")));
  });

  it("gives person 5 the same draws whatever else was drawn, in either order of use", () => {
    const a = { arrivals: stream(9, "arrivals"), p5: stream(9, "person:5"), p6: stream(9, "person:6") };
    const first = [take(a.p5, 3), take(a.arrivals, 4), take(a.p6, 2), take(a.p5, 3)];
    const b = { arrivals: stream(9, "arrivals"), p5: stream(9, "person:5"), p6: stream(9, "person:6") };
    const second = [take(b.p6, 2), take(b.p5, 3), take(b.arrivals, 4), take(b.p5, 3)];
    expect([...first[0], ...first[3]]).toEqual([...second[1], ...second[3]]);
    expect(first[2]).toEqual(second[0]);
    expect(first[1]).toEqual(second[2]);
  });

  it("agrees between the pure form, the closure form and mulberry32", () => {
    const seed = streamSeed(1, "person:1");
    const closure = rngFrom(seed);
    const reference = mulberry32(seed);
    let state = seed;
    for (let i = 0; i < 1000; i += 1) {
      const [value, after] = next(state);
      state = after;
      const c = closure();
      expect(value).toBe(c);
      expect(value).toBe(reference());
      expect(state).toBe(closure.state());
      expect(state).toBe(reference.state());
    }
  });

  it("continues from a saved state number", () => {
    const r = stream(3, "arrivals");
    take(r, 10);
    const saved = JSON.parse(JSON.stringify(r.state())) as number;
    expect(take(rngFrom(saved), 5)).toEqual(take(r, 5));
  });
});

describe("distributions, 100,000 draws from a fixed seed", () => {
  const r = () => stream(2026, "distributions");

  it("uniform stays in range with the right mean", () => {
    const xs = draws(N, uniform.bind(null, r(), 5, 9));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(5);
    expect(Math.max(...xs)).toBeLessThan(9);
    expect(mean(xs)).toBeCloseTo(7, 1);
  });

  it("exponential has its mean and is never negative or infinite", () => {
    const g = r();
    const xs = draws(N, () => exponential(g, 6));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(Math.max(...xs))).toBe(true);
    expect(Math.abs(mean(xs) - 6)).toBeLessThan(0.1);
  });

  it("normal has its mean and sd, and always uses two draws", () => {
    const g = r();
    const xs = draws(N, () => normal(g, 10, 2));
    expect(Math.abs(mean(xs) - 10)).toBeLessThan(0.05);
    expect(Math.abs(Math.sqrt(variance(xs)) - 2)).toBeLessThan(0.05);
    const a = rngFrom(5);
    normal(a, 0, 1);
    const b = rngFrom(5);
    b();
    b();
    expect(a.state()).toBe(b.state());
  });

  it("lognormal has its median and the mean median * exp(sigma^2 / 2), and is positive", () => {
    const g = r();
    const xs = draws(N, () => lognormal(g, 4, 0.67));
    expect(Math.min(...xs)).toBeGreaterThan(0);
    const sorted = [...xs].sort((a, b) => a - b);
    expect(Math.abs(sorted[N / 2] - 4)).toBeLessThan(0.08);
    expect(Math.abs(mean(xs) - 4 * Math.exp(0.67 ** 2 / 2))).toBeLessThan(0.1);
  });

  it("weightedPick follows the weights, never picks a zero weight, and refuses bad weights", () => {
    const g = r();
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < N; i += 1) counts[weightedPick(g, [0.2, 0, 0.5, 0.3])] += 1;
    expect(counts[1]).toBe(0);
    expect(Math.abs(counts[0] / N - 0.2)).toBeLessThan(0.01);
    expect(Math.abs(counts[2] / N - 0.5)).toBeLessThan(0.01);
    expect(Math.abs(counts[3] / N - 0.3)).toBeLessThan(0.01);
    expect(weightedPick(() => 0.999999999999, [1, 0])).toBe(0); // the end of the range never lands on a zero weight
    expect(weightedPick(() => 0, [0, 1])).toBe(1);
    expect(() => weightedPick(g, [0, 0])).toThrow(RangeError);
    expect(() => weightedPick(g, [1, -1, 3])).toThrow(RangeError);
    expect(() => weightedPick(g, [1, NaN])).toThrow(RangeError);
  });

  it("poisson has mean and variance equal to the rate, and refuses a bad rate", () => {
    for (const rate of [0.05, 0.3, 4, 30]) {
      const g = r();
      const xs = draws(N, () => poisson(g, rate));
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
      expect(xs.every(Number.isInteger)).toBe(true);
      expect(Math.abs(mean(xs) - rate)).toBeLessThan(0.02 * Math.max(1, rate));
      expect(Math.abs(variance(xs) - rate)).toBeLessThan(0.05 * Math.max(1, rate));
    }
    expect(poisson(r(), 0)).toBe(0);
    expect(() => poisson(r(), -1)).toThrow(RangeError);
    expect(() => poisson(r(), 51)).toThrow(RangeError);
    expect(() => poisson(r(), NaN)).toThrow(RangeError);
  });
});
