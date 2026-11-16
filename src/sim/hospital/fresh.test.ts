import { describe, expect, it } from "vitest";
import { loadWard, saveWard } from "../persist";
import { createSim, minuteOf, setSpeed, step } from "../sim";
import { createSyntheticSource } from "../source";
import { refuseHospitalState, refuseWardState } from "./attach";
import { freshHospital } from "./fresh";

const RUN = { runId: null, origin: "", cursor: 0, commandCursor: 0 };

describe("the runner's hospital: a new one, a saved one, and the mode check", () => {
  it("starts as the page's Pitch ward at the speed asked for", () => {
    const { s } = freshHospital(10);
    expect(s.hospital).toBeDefined();
    expect(s.speed).toBe(10);
    expect(s.patients).toHaveLength(12);
  });

  it("a state file is refused by the other mode, and accepted by its own", () => {
    const h = freshHospital(60);
    const w = createSim(createSyntheticSource(101, true));
    expect(refuseHospitalState(h.s)).toMatch(/holds a hospital/);
    expect(refuseWardState(h.s)).toBeNull();
    expect(refuseWardState(w)).toMatch(/holds a ward/);
    expect(refuseHospitalState(w)).toBeNull();
  });

  it("saved at an odd second and loaded, it continues exactly as an uninterrupted run", () => {
    const a = freshHospital(60);
    const b = freshHospital(60);
    const split = 7 * 3600 + 23; // 60x: one step is one sim second
    for (let i = 0; i < split; i += 1) { step(a.s, a.src); step(b.s, b.src); }
    const loaded = loadWard(saveWard(b.s, b.src, RUN));
    expect(refuseWardState(loaded.s)).toBeNull();
    for (let i = split; i < 12 * 3600; i += 1) { step(a.s, a.src); step(loaded.s, loaded.src); }
    expect(saveWard(loaded.s, loaded.src, RUN)).toBe(saveWard(a.s, a.src, RUN));
    expect(minuteOf(a.s)).toBe(720);
    expect(a.s.hospital!.people.length).toBeGreaterThan(12); // the hospital really ran
  }, 120_000);

  it("a new hospital keeps its speed when a saved one is loaded at another", () => {
    const b = freshHospital(60);
    setSpeed(b.s, 10);
    expect(loadWard(saveWard(b.s, b.src, RUN)).s.speed).toBe(10);
  });
});
