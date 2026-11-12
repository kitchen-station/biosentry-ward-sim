import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { floorSummary } from "../building";
import { HospitalPanel, noticedLateLine, overdueLine, ROUNDS_CAPTION } from "../hospital-panels";
import { createHospitalSim } from "../sim/hospital/attach";
import { overdueRounds } from "../sim/hospital/step";
import { parseScenario } from "../sim/hospital/scenario";
import { createSyntheticSource, FIXTURE_SEED } from "../sim/source";
import typical from "../../scenarios/hospital/typical.json?raw";
import { FLOORS } from "./floors";
import { floorScene, LATE_MARK_MIN } from "./scene";
import { createStackRenderer, slabIndex } from "./stack";

function world() {
  const h = createHospitalSim(createSyntheticSource(FIXTURE_SEED, true), parseScenario(typical), 101).hospital!;
  h.lastMinute = 2000;
  const p = h.people.find((x) => x.unit === "MED3A" && x.where === "bed")!;
  return { h, p };
}
const med = FLOORS[slabIndex(3)];
const bedOf = (h: ReturnType<typeof world>["h"], p: { n: number }) => floorScene(h, med).beds.find((b) => b.id === `h:${p.n}`)!;
const course = (noticedMin: number | null) => ({ atMin: 1000, excessU: 1, onsetMin: 1000, noticedMin, unnoticedMin: null, escalated: false, excess: false });

describe("overdue rounds on the floor and the panel", () => {
  it("the unit marker and panel line carry exactly overdueRounds' figures", () => {
    const { h, p } = world();
    p.obsDueMin = 2000 - 440; // 7 h 20 min
    for (const q of h.people) if (q.unit === "MED3A" && q !== p && q.obsDueMin !== null) q.obsDueMin = 5000;
    const o = overdueRounds(h, "MED3A", 2000)!;
    expect(o).toEqual({ count: 1, longestMin: 440 });
    expect(floorScene(h, med).overdue.find((m) => m.id === "unit:MED3A")!.text).toBe("1 late");
    const census = floorSummary(h).flatMap((f) => f.units).find((u) => u.id === "MED3A")!.census;
    expect(overdueLine(h, "MED3A", census)).toBe(`Rounds overdue: 1 of ${census} patients. Longest wait: 7 h 20 min.`);
    expect(overdueLine(h, "ICU", 5)).toBeNull();
    expect(overdueLine(h, "W4", 5)).toBeNull();
    const html = renderToStaticMarkup(<HospitalPanel h={h} id="unit:MED3A" onSelect={() => {}} floors={floorSummary(h)} />);
    expect(html).toContain("Rounds overdue: 1 of");
    expect(html).toContain(ROUNDS_CAPTION);
  });
  it("no marker when nothing is overdue", () => {
    const { h } = world();
    for (const q of h.people) if (q.unit === "MED3A" && q.obsDueMin !== null) q.obsDueMin = 5000;
    expect(floorScene(h, med).overdue.some((m) => m.id === "unit:MED3A")).toBe(false);
  });
});

describe("the noticed-late mark", () => {
  it("shows after a late notice, for 6 sim hours, then goes", () => {
    const { h, p } = world();
    p.course = course(1000 + 151);
    h.lastMinute = 1151;
    expect(bedOf(h, p).late).toBe(true);
    h.lastMinute = 1151 + LATE_MARK_MIN - 1;
    expect(bedOf(h, p).late).toBe(true);
    h.lastMinute = 1151 + LATE_MARK_MIN;
    expect(bedOf(h, p).late).toBe(false);
    expect(noticedLateLine(p)).toBe("Deterioration noticed 2 h 31 min after it began, at the next observation round."); // the panel line stays
  });
  it("a prompt notice shows nothing", () => {
    const { h, p } = world();
    p.course = course(1030);
    h.lastMinute = 1040;
    expect(bedOf(h, p).late).toBe(false);
    expect(noticedLateLine(p)).toBeNull();
  });
  it("an onset not yet noticed shows nothing in the scene, the panel or a hit", () => {
    const { h, p } = world();
    const before = JSON.stringify(floorScene(h, med));
    p.course = course(null);
    expect(JSON.stringify(floorScene(h, med))).toBe(before);
    expect(noticedLateLine(p)).toBeNull();
    const html = renderToStaticMarkup(<HospitalPanel h={h} id={`h:${p.n}`} onSelect={() => {}} floors={floorSummary(h)} />);
    expect(html).not.toMatch(/deteriorat/i);
  });
});

describe("marks do not break the frame skip", () => {
  it("a closed building with marks drawn paints nothing on an unchanged frame", () => {
    const calls = { n: 0 };
    const ctx = new Proxy({}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 1 }) : () => ((calls.n += 1), { data: new Uint8ClampedArray(4) })), set: () => ((calls.n += 1), true) });
    Object.assign(globalThis, { document: { createElement: () => ({ getContext: () => ctx, style: {}, width: 0, height: 0 }) }, ImageData: class {} });
    const s = createHospitalSim(createSyntheticSource(FIXTURE_SEED, true), parseScenario(typical), 101);
    const p = s.hospital!.people.find((x) => x.unit === "MED3A" && x.where === "bed")!;
    p.obsDueMin = -500;
    p.course = { ...course(-10), onsetMin: -200 };
    s.hospital!.lastMinute = 60;
    expect(bedOf(s.hospital!, p).late).toBe(true);
    const st = createStackRenderer({ getContext: () => ctx, style: {}, width: 0, height: 0 } as unknown as HTMLCanvasElement, () => null);
    st.resize(656, 382, 1);
    expect(st.frame(s, null, null, 0.016, 0)).toBe(true);
    expect([st.frame(s, null, null, 0.016, 0), st.frame(s, null, null, 0.016, 0)]).toEqual([false, false]);
  });
});
