import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { setSpeed, step } from "../sim";
import { createSyntheticSource, FIXTURE_SEED } from "../source";
import { createHospitalSim } from "./attach";
import { parseScenario } from "./scenario";
import { CAPS, createVitals, feedVitals, summary } from "./vitals";

// Its own file so vitest runs it in a worker of its own: ten simulated days take about 25 s with the engine, more on a busy machine.
describe("long vitals run", () => {
  it("stays under every cap over 10 simulated days, and only people with a recorded onset have an episode", { timeout: 300_000 }, () => {
    const typical = parseScenario(readFileSync("scenarios/hospital/typical.json", "utf8"));
    const src = createSyntheticSource(FIXTURE_SEED, true);
    const s = createHospitalSim(src, typical, 101);
    setSpeed(s, 60);
    const h = s.hospital!;
    const v = createVitals();
    let peak = 0;
    for (let i = 0; i < 10 * 1440 * 60; i += 1) {
      step(s, src);
      feedVitals(v, h, s.clockS);
      if (i % 600 === 0) peak = Math.max(peak, v.live.size);
      if (i % 3600 === 0 && v.finished.length > CAPS.finished) throw new Error("finished over the cap");
    }
    const sum = summary(v);
    console.log(`LONG SUMMARY ${JSON.stringify({ ...sum, peakLive: peak, people: h.people.length, cap: h.peopleCap })}`);
    expect(sum.maxBins).toBeLessThanOrEqual(CAPS.bins);
    expect(sum.maxScores).toBeLessThanOrEqual(CAPS.scores);
    expect(sum.finished).toBeLessThanOrEqual(CAPS.finished);
    expect(peak).toBeLessThanOrEqual(h.peopleCap);
    expect(sum.gaps).toBe(0);
    expect(sum.episodes).toBeGreaterThan(0);
    expect(sum.generatorEpisodesCleared).toBeGreaterThan(0);
    for (const pv of v.live.values()) {
      const q = h.people.find((x) => x.id === pv.id)!;
      expect(pv.episode?.startMin ?? null).toBe(q.course?.onsetMin ?? null);
    }
  });
});
