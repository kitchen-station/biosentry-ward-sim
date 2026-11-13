import { describe, expect, it } from "vitest";
import { AHEAD_MS, MAX_FRAME_S, createViewClock, frameDt, frameTicks, shownClock } from "./clock";
import { createSim, setSpeed, step, type Speed } from "./sim/sim";
import { createSyntheticSource, FIXTURE_SEED } from "./sim/source";

const fresh = () => {
  const src = createSyntheticSource(FIXTURE_SEED, true);
  return { s: createSim(src), src };
};

/** The page's frame loop: the same time handling as App.tsx, with a synthetic frame clock. */
function runPage(speed: Speed, frameMs: number[]) {
  const { s, src } = fresh();
  setSpeed(s, speed);
  const t0 = s.clockS;
  let spare = 0;
  for (const ms of frameMs) {
    const [n, left] = frameTicks(spare, frameDt(ms));
    spare = left;
    for (let i = 0; i < n; i++) step(s, src);
  }
  return s.clockS - t0;
}

describe("the engine factor", () => {
  it.each([1, 10, 60] as Speed[])("60 steps at %ix add exactly that many sim seconds", (speed) => {
    const { s, src } = fresh();
    setSpeed(s, speed);
    const t0 = s.clockS;
    for (let i = 0; i < 60; i++) step(s, src);
    expect(s.clockS - t0).toBeCloseTo(speed, 9);
  });
});

describe("the standalone frame loop at 60x", () => {
  const frames = (fps: number, seconds: number) => Array.from({ length: fps * seconds }, () => 1000 / fps);
  it.each([120, 60, 30, 4, 1])("60 wall seconds at %i fps give 3600 sim seconds (within one tick)", (fps) => {
    const got = runPage(60, frames(fps, 60));
    expect(got).toBeGreaterThan(3600 - 1.1);
    expect(got).toBeLessThanOrEqual(3600 + 1e-6);
  });
  it("one 500 ms hitch loses nothing", () => {
    const f = frames(60, 60);
    f.splice(0, 30, 500); // 30 frames (500 ms) become one 500 ms frame
    expect(runPage(60, f)).toBeGreaterThan(3600 - 1.1);
  });
  it("a 12 s stall gives exactly 5 s of catch-up", () => {
    expect(frameDt(12_000)).toBe(MAX_FRAME_S);
    expect(MAX_FRAME_S).toBe(5);
  });
  it("the first frame after a hidden spell adds 0, however long", () => {
    for (const ms of [100, 5000, 3_600_000]) expect(frameDt(ms, true)).toBe(0);
    expect(frameDt(100, false)).toBeCloseTo(0.1);
  });
});

describe("the viewer clock", () => {
  it("runs the last read on at its speed", () => {
    expect(shownClock(100, 60, 0, 1000, false)).toBe(160);
  });
  it("is frozen when stopped or at speed 0", () => {
    expect(shownClock(100, 60, 0, 1000, true)).toBe(100);
    expect(shownClock(100, 0, 0, 1000, false)).toBe(100);
  });
  it("never runs more than AHEAD_MS past the read", () => {
    expect(shownClock(100, 60, 0, 10_000, false)).toBe(100 + (60 * AHEAD_MS) / 1000);
  });
  it("does not run before its read", () => {
    expect(shownClock(100, 60, 5000, 1000, false)).toBe(100);
  });

  it("reads every 2 s, sampled at 60 fps for 60 s: about 3600 s, no step above 2 sim s", () => {
    const c = createViewClock();
    let prev = 0;
    let maxStep = 0;
    let shown = 0;
    for (let ms = 0; ms <= 60_000; ms += 1000 / 60) {
      if (ms % 2000 < 1000 / 60) c.take(Math.floor(ms / 2000) * 120, 60, false, ms);
      shown = c.read(ms);
      maxStep = Math.max(maxStep, shown - prev);
      prev = shown;
    }
    expect(shown).toBeGreaterThan(3600 - 60);
    expect(shown).toBeLessThan(3600 + 60);
    expect(maxStep).toBeLessThan(2.5);
  });
  it("a late read behind the shown value does not pull the clock back", () => {
    const c = createViewClock();
    c.take(600, 60, false, 0);
    c.read(2000); // 720
    c.take(660, 60, false, 2000); // the new read is behind what was shown but not lower than the last read
    expect(c.read(2000)).toBe(720);
  });
  it("a restart (a lower clock) starts again from the new read", () => {
    const c = createViewClock();
    c.take(5000, 60, false, 0);
    c.read(2000);
    c.take(5, 60, false, 2000);
    expect(c.read(2000)).toBe(5);
  });
  it("down() freezes it and the next take resumes", () => {
    const c = createViewClock();
    c.take(100, 60, false, 0);
    c.down();
    expect(c.read(2000)).toBe(100);
    c.take(220, 60, false, 2000);
    expect(c.read(3000)).toBe(220); // it moves toward 280 at most twice the speed
  });

  it("a pause snaps to the read and stays", () => {
    const c = createViewClock();
    c.take(1000, 60, false, 0);
    c.read(2500);
    c.take(1030, 0, false, 2500);
    expect(c.read(2500)).toBe(1030);
    expect(c.read(60_000)).toBe(1030);
  });
  it("an end snaps to the read and stays", () => {
    const c = createViewClock();
    c.take(1000, 60, false, 0);
    c.read(2500);
    c.take(1100, 60, true, 2500);
    expect(c.read(60_000)).toBe(1100);
  });
  it("60x to 1x never stalls longer than 2 s of wall time", () => {
    const c = createViewClock();
    c.take(1000, 60, false, 0);
    c.read(2900); // shown about 1174
    c.take(1120, 1, false, 3000);
    let v = c.read(3000);
    expect(v).toBe(1120);
    let still = 0;
    let worst = 0;
    for (let ms = 3000; ms < 60_000; ms += 100) {
      if (ms % 2000 === 0) c.take(1120 + (ms - 3000) / 1000, 1, false, ms); // the runner keeps publishing at 1x
      const n = c.read(ms);
      still = n > v ? 0 : still + 0.1;
      worst = Math.max(worst, still);
      v = n;
    }
    expect(worst).toBeLessThan(2);
  });
  it("an older answer that lands late is ignored", () => {
    const c = createViewClock();
    c.take(1000, 60, false, 0);
    c.read(0);
    c.take(1120, 60, false, 2000);
    const before = c.read(2000);
    c.take(1000, 60, false, 2100); // older, lower by 120
    expect(c.read(2100)).toBeGreaterThanOrEqual(before);
  });
  it("a clock 600 s or more lower is a restart", () => {
    const c = createViewClock();
    c.take(5000, 60, false, 0);
    c.read(0);
    c.take(4400, 60, false, 2000);
    expect(c.read(2000)).toBe(4400);
  });
  it("a gap over 10 wall seconds snaps", () => {
    const c = createViewClock();
    c.take(0, 60, false, 0);
    c.read(0);
    c.take(5000, 60, false, 1000); // 4940 s ahead, far over 600
    expect(c.read(1000)).toBe(5000);
  });

  it("models the watching poll: no step above 4 sim s, never back, ends near the runner", () => {
    const runner = (ms: number) => 60 * Math.floor(ms / 1000);
    const published = (ms: number) => runner(Math.floor(ms / 2000) * 2000);
    const c = createViewClock();
    let nextRead = 0;
    let i = 0;
    const pending: { at: number; clock: number }[] = [];
    let prev = 0;
    let maxStep = 0;
    let shown = 0;
    const FRAME = 1000 / 60;
    for (let ms = 0; ms <= 600_000; ms += FRAME) {
      if (ms >= nextRead && pending.length === 0) {
        const latency = 50 + ((i++ * 97) % 251); // 50 to 300 ms
        pending.push({ at: ms + latency, clock: published(ms + latency) });
      }
      if (pending.length && ms >= pending[0].at) {
        const r = pending.shift()!;
        c.take(r.clock, 60, false, r.at);
        nextRead = r.at + 2000;
      }
      shown = c.read(ms);
      maxStep = Math.max(maxStep, shown - prev);
      expect(shown).toBeGreaterThanOrEqual(prev);
      prev = shown;
    }
    expect(maxStep).toBeLessThan(4);
    expect(Math.abs(runner(600_000) - shown)).toBeLessThan(130);
  });
});
