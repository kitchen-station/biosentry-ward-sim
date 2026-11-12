import { describe, expect, it } from "vitest";
import { createSyntheticSource, FIXTURE_SEED } from "./source";

// The fit has no temperature change for any episode kind (no source finds temperature rising before ward
// deterioration, see README sources), so once an episode is fully in the mean change must be about 0.
describe("temperature in a deterioration episode", () => {
  it("does not move on average from before the episode to after it is fully in", () => {
    const AT = 400; // past the fixture patients' 180-minute baseline slope
    const FULL = AT + 2700; // the longest fitted ramp is 2580 minutes
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const changes: number[] = [];
    for (let seed = FIXTURE_SEED; seed < FIXTURE_SEED + 30; seed += 1) {
      const src = createSyntheticSource(seed);
      const ids = src.seeds().map((p) => p.id);
      const before: Record<string, number[]> = Object.fromEntries(ids.map((id) => [id, []]));
      const after: Record<string, number[]> = Object.fromEntries(ids.map((id) => [id, []]));
      for (let minute = 1; minute <= FULL + 120; minute += 1) {
        if (minute === AT) for (const id of ids) src.inject!(id, minute);
        for (const id of ids) {
          const t = src.read(id, minute)?.temperature;
          if (t == null) continue;
          if (minute > AT - 120 && minute <= AT) before[id].push(t);
          if (minute > FULL) after[id].push(t);
        }
      }
      for (const id of ids) if (before[id].length && after[id].length) changes.push(mean(after[id]) - mean(before[id])); // a patch dropout can empty a window
    }
    expect(changes.length).toBeGreaterThan(300);
    expect(Math.abs(mean(changes))).toBeLessThan(0.08);
  }, 120_000);
});
