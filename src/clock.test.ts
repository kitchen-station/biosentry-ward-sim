import { describe, expect, it } from "vitest";
import { AHEAD_MS, createViewClock, frameDt, frameTicks, shownClock } from "./clock";
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
  it.each([30, 60, 120])("60 wall seconds at %i fps give 3600 sim seconds (within one tick)", (fps) => {
    expect(runPage(60, frames(fps, 60))).toBeGreaterThan(3600 - 1.1);
    expect(runPage(60, frames(fps, 60))).toBeLessThanOrEqual(3600);
  });
  it("one 500 ms frame loses 250 ms of wall time, 15 sim seconds: the known cap", () => {
    const f = frames(60, 60);
    f.splice(0, 30, 500); // 30 frames (500 ms) become one 500 ms frame
    expect(runPage(60, f)).toBeGreaterThan(3585 - 1.1);
    expect(runPage(60, f)).toBeLessThanOrEqual(3585);
  });
  it("frameDt caps at a quarter second", () => {
    expect(frameDt(100)).toBeCloseTo(0.1);
    expect(frameDt(9000)).toBe(0.25);
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
    c.take(600, 60, false, 0);
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
    expect(c.read(3000)).toBe(280);
  });
});
