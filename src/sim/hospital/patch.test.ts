import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { setSpeed, step } from "../sim";
import { createSyntheticSource, FIXTURE_SEED } from "../source";
import { createHospitalSim } from "./attach";
import { parseScenario } from "./scenario";
import { createVitals, feedVitals } from "./vitals";

vi.setConfig({ testTimeout: 120_000 });

// Owner decision patch-1 (2026-11-17): everyone gets the patch on admission and on every transfer, in every unit
// (the ER and the ICU too, where there is no bedside telemetry). Only surgery and recovery would be left out, and the
// hospital has neither as a unit: SURG5A is a surgical ward and is patched like the rest.
it("every hospital person has the patch, in every unit, before and after a move", () => {
  const src = createSyntheticSource(FIXTURE_SEED, true);
  const s = createHospitalSim(src, parseScenario(readFileSync("scenarios/hospital/typical.json", "utf8")), 7);
  setSpeed(s, 60);
  const v = createVitals();
  const units = new Set<string>();
  const moved = new Set<string>(); // people seen in more than one unit
  const first = new Map<string, string>();
  for (let i = 0; i < 4000; i += 1) {
    step(s, src);
    feedVitals(v, s.hospital!, s.clockS);
    for (const pv of v.live.values()) {
      units.add(pv.unit);
      expect(pv.p.patch, `${pv.id} in ${pv.unit}`).toBe(true);
      if (first.get(pv.id) && first.get(pv.id) !== pv.unit) moved.add(pv.id);
      first.set(pv.id, first.get(pv.id) ?? pv.unit);
    }
  }
  expect(units.size).toBeGreaterThan(2);
  expect(moved.size).toBeGreaterThan(0);
});
