import { describe, expect, it } from "vitest";
import { parseScenario, runTrial } from "./trial";
import { readFileSync } from "node:fs";

// Its own file so vitest runs it in a worker of its own: a 60-day trial takes about 45 s.
describe("long trial", () => {
  it("runs the longest allowed trial and draws episodes at about the cited 0.061 per admission", { timeout: 120_000 }, () => {
    const scenario = parseScenario(readFileSync("scenarios/default.json", "utf8"));
    const f = runTrial({ scenario, seed: 11, days: 60, scenarioSha256: "0".repeat(64), simCommit: "test", nodeMajor: 0 });
    const summary = JSON.parse(f["summary.json"]);
    const episodes = f["episodes.csv"].trimEnd().split("\n").slice(1).map((l) => l.split(",")).filter((r) => r[4] !== "");
    expect(summary.admitted).toBeGreaterThan(120);
    // One seed, so about 9 episodes: the bounds are 3 standard deviations of a draw at 0.061 either side.
    expect(summary.episodes_per_admission).toBeGreaterThan(0.02);
    expect(summary.episodes_per_admission).toBeLessThan(0.12);
    expect(episodes.length / summary.admitted).toBeCloseTo(summary.episodes_per_admission, 3);
    for (const r of episodes) {
      expect(["respiratory", "tachycardic", "hypotensive"]).toContain(r[4]);
      expect(Number(r[5])).toBeGreaterThan(0);
      expect(Number(r[6])).toBeGreaterThan(0);
    }
  });
});
