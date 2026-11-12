import { beforeAll, describe, expect, it } from "vitest";
import { clampCam, fitCam } from "../camera";
import { floorOf } from "../hospital-panels";
import { createHospitalSim } from "../sim/hospital/attach";
import { parseScenario } from "../sim/hospital/scenario";
import { createSim, step } from "../sim/sim";
import { createSyntheticSource, FIXTURE_SEED } from "../sim/source";
import typical from "../../scenarios/hospital/typical.json?raw";
import { createRenderer, iso, LOGICAL_H, LOGICAL_W, onSlab } from "./draw";
import { FLOORS } from "./floors";
import { createStackRenderer, GAP, nextLevel, slabIndex, slabTop, WORLD_H, type Level, type LevelEvent } from "./stack";

beforeAll(() => {
  // hit() reads only the camera; a 2D context that does nothing is enough.
  const ctx = new Proxy({}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 1 }) : () => ({ data: new Uint8ClampedArray(4) })), set: () => true });
  const fake = () => ({ getContext: () => ctx, style: {}, width: 0, height: 0 });
  Object.assign(globalThis, { document: { createElement: fake }, ImageData: class {} });
});
const canvas = () => document.createElement("canvas");

describe("the three levels", () => {
  const STACK: Level = { view: null, selected: null };
  const FLOOR: Level = { view: 3, selected: null };
  const THING: Level = { view: 4, selected: "W4-01" };
  // [from, event, to]: the design's table, row by row.
  const table: [Level, LevelEvent, Level][] = [
    [STACK, { slab: 3 }, { view: 3, selected: null }],
    [STACK, "outside", STACK],
    [STACK, "escape", STACK],
    [FLOOR, { rail: 5 }, { view: 5, selected: null }],
    [FLOOR, { thing: "unit:MED3A", floor: 3 }, { view: 3, selected: "unit:MED3A" }],
    [FLOOR, "empty", FLOOR],
    [FLOOR, "outside", STACK],
    [FLOOR, "escape", STACK],
    [THING, { rail: 2 }, { view: 2, selected: null }],
    [THING, { thing: "nurse-a", floor: 4 }, { view: 4, selected: "nurse-a" }],
    [THING, "empty", { view: 4, selected: null }],
    [THING, "outside", { view: 4, selected: null }],
    [THING, "escape", { view: 4, selected: null }],
    [THING, { rail: null }, STACK],
    [FLOOR, { rail: null }, STACK],
  ];
  it.each(table)("%o + %o", (from, e, to) => expect(nextLevel(from, e)).toEqual(to));
});

describe("floorOf", () => {
  it("puts W4 ids on 4F and hospital ids on their unit's floor", () => {
    const h = createHospitalSim(createSyntheticSource(FIXTURE_SEED, true), parseScenario(typical), 101).hospital!;
    expect(["W4-01", "nurse-a", "bed:A1", "gateway"].map((id) => floorOf(h, id))).toEqual([4, 4, 4, 4]);
    expect(["queue:ER", "morgue", "unit:ER", "unit:ICU", "unit:MED3B", "hbed:SURG5A:2", "unit:W4"].map((id) => floorOf(h, id))).toEqual([0, 0, 0, 2, 3, 5, 4]);
    const p = h.people.find((x) => x.unit === "ICU")!;
    expect(floorOf(h, `h:${p.n}`)).toBe(2);
    expect(floorOf(h, "h:999999")).toBeNull();
  });
});

describe("the stack's geometry and camera", () => {
  it("stacks GF to 5F bottom up, every floor 36 x 18", () => {
    expect(FLOORS.map((f) => f.floor)).toEqual([0, 2, 3, 4, 5]);
    for (const f of FLOORS) expect([f.map.length, ...new Set(f.map.map((r) => r.length))]).toEqual([18, 36]);
    expect([slabTop(slabIndex(5)), slabTop(slabIndex(4)), slabTop(slabIndex(0))]).toEqual([0, GAP, 4 * GAP]);
    expect(WORLD_H).toBe(LOGICAL_H + 4 * GAP);
  });

  it("clampCam with a wider view centres the axis the map fits on, and lets the stack zoom out below 0.5", () => {
    expect(clampCam({ zoom: 1, x: 100, y: 100 }, 656, 382, 900, 382)).toEqual({ zoom: 1, x: 328, y: 191 });
    expect(clampCam({ zoom: 2, x: 100, y: 100 }, 656, 382, 900, 382)).toEqual({ zoom: 2, x: 225, y: 100 });
    expect(clampCam({ zoom: 0.3, x: 0, y: 0 }, 656, 1182, 656, 382, 0.3)).toEqual({ zoom: 0.3, x: 328, y: 591 });
    expect(clampCam({ zoom: 0.3, x: 0, y: 0 }, 656, 1182).zoom).toBe(0.5);
  });
});

describe("stack hits", () => {
  const ward = () => {
    const src = createSyntheticSource(FIXTURE_SEED, true);
    const s = createSim(src);
    for (let i = 0; i < 600; i += 1) step(s, src);
    return s;
  };

  it("focused on 4F at the ward-only size, finds what the ward-only renderer finds wherever it is on the slab", () => {
    const s = ward();
    const r = createRenderer(canvas());
    const st = createStackRenderer(canvas(), () => 4);
    r.resize(656, 382, 1);
    st.resize(656, 382, 1);
    st.frame(s, null, null, 0.016, 0); // the first frame puts the camera on the floor
    let things = 0;
    for (let y = 0; y < 382; y += 2) {
      for (let x = 0; x < 656; x += 2) {
        const want = r.hit(s, x, y);
        if (want) things += 1;
        if (want) expect(onSlab(x, y)).toBe(true); // nothing W4 can hit lies off the slab
        expect(st.hit(s, x, y) || null).toBe(want);
        expect(st.hit(s, x, y) === null).toBe(!onSlab(x, y));
      }
    }
    expect(things).toBeGreaterThan(1000);
    // zoomed onto a thing, both cameras agree too
    const id = s.patients[0].id;
    for (let i = 0; i < 200; i += 1) {
      r.frame(s, id, null, 0.05, i);
      st.frame(s, id, null, 0.05, i);
    }
    for (const [x, y] of [[328, 191], [100, 300], [600, 50]]) expect(st.hit(s, x, y) || null).toBe(r.hit(s, x, y));
  });

  it("in the stack picks the topmost slab under the pointer; a focused floor's ghosts take no clicks", () => {
    const s = ward();
    let view: number | null = null;
    const st = createStackRenderer(canvas(), () => view);
    st.resize(656, 382, 1);
    st.frame(s, null, null, 0.016, 0);
    const z = Math.min(656 / LOGICAL_W, 382 / WORLD_H);
    const css = (wx: number, wy: number): [number, number] => [328 + (wx - LOGICAL_W / 2) * z, 191 + (wy - WORLD_H / 2) * z];
    const middle = iso(18, 9); // the floor diamond's centre
    for (const f of FLOORS) expect(st.hit(s, ...css(middle[0], middle[1] + slabTop(slabIndex(f.floor))))).toBe(`floor:${f.floor}`);
    expect(st.hit(s, 2, 2)).toBeNull(); // the stage's corner
    // Focus 3F: its own label hits, 4F's middle (a ghost above it) is outside, the empty floor is "".
    view = 3;
    st.reset();
    st.frame(s, null, null, 0.016, 0);
    const label = iso((1 + 34 + 1) / 2, (1 + 7 + 1) / 2); // MEDICINE 3A's label
    expect(st.hit(s, label[0], label[1])).toBe("unit:MED3A");
    expect(st.hit(s, ...iso(30, 14))).toBe("");
    expect(st.hit(s, 328, 2)).toBeNull(); // above the slab's back wall
  });

  it("FLOOR fits one floor like the ward-only view; zoom and pan stay on that floor", () => {
    const st = createStackRenderer(canvas(), () => 4);
    st.resize(1000, 382, 1);
    expect(st.userZoom()).toBe(1);
    expect(st.canPan()).toBe(false);
    st.zoomAt(2, 0, 0, true);
    expect(st.canPan()).toBe(true);
    st.fit();
    expect(st.userZoom()).toBe(1);
    const stack = createStackRenderer(canvas(), () => null);
    stack.resize(656, 382, 1);
    expect(stack.userZoom()).toBeCloseTo(382 / WORLD_H);
    stack.zoomAt(2, 0, 0, true); // the stack has one zoom
    expect(stack.userZoom()).toBeCloseTo(382 / WORLD_H);
    expect(fitCam(LOGICAL_W, LOGICAL_H).zoom).toBe(1);
  });
});
