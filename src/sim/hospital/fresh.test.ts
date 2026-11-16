/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadWard, saveWard } from "../persist";
import { createSim, minuteOf, setSpeed, step } from "../sim";
import { createSyntheticSource, FIXTURE_SEED } from "../source";
import { refuseHospitalState, refuseWardState } from "./attach";
import { freshHospital, HOSPITAL_SCENARIOS, RUNNER_SEED } from "./fresh";

const RUN = { runId: null, origin: "", cursor: 0, commandCursor: 0 };

describe("the runner's hospital: a new one, a saved one, and the mode check", () => {
  it("starts the typical hospital by default, at the speed asked for, with W4's 12 drawn from the seed", () => {
    const { s } = freshHospital(10);
    expect(s.hospital).toBeDefined();
    expect(s.hospital!.seed).toBe(RUNNER_SEED);
    expect(s.speed).toBe(10);
    expect(s.patients).toHaveLength(12);
    const names = (x: { s: { patients: { name: string }[] } }) => x.s.patients.map((p) => p.name);
    const fixture = createSim(createSyntheticSource(FIXTURE_SEED, true)).patients.map((p) => p.name);
    expect(names(freshHospital(10))).toEqual(names(freshHospital(10))); // the same every start
    expect(names(freshHospital(10))).not.toEqual(fixture); // not the 12 hand-written pitch patients
    expect(names(freshHospital(10, "pitch"))).toEqual(fixture); // they stay a named scenario
  });

  it("takes the page's named scenarios, and refuses a name it does not know", () => {
    expect(HOSPITAL_SCENARIOS).toEqual(["typical", "pitch", "calm", "surge", "more-nurses", "critical"]);
    for (const id of HOSPITAL_SCENARIOS) expect(freshHospital(60, id).s.hospital).toBeDefined();
    expect(() => freshHospital(60, "nope")).toThrow(/Unknown hospital scenario "nope"/);
    const head = readFileSync("src/headless.ts", "utf8");
    expect(head).toContain('const scenario = process.env.WARD_SCENARIO ?? "typical";');
    expect(head.match(/freshHospital\((speed|s\.speed), scenario\)/g)).toHaveLength(2); // a new run and a reset
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
