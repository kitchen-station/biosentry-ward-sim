import { beforeAll, describe, expect, it } from "vitest";
import { clampCam, fitCam } from "../camera";
import { floorSummary } from "../building";
import { floorOf } from "../hospital-panels";
import { createHospitalSim } from "../sim/hospital/attach";
import { parseScenario } from "../sim/hospital/scenario";
import { createSim, step } from "../sim/sim";
import { createSyntheticSource, FIXTURE_SEED } from "../sim/source";
import typical from "../../scenarios/hospital/typical.json?raw";
import { backingFor, createRenderer, iso, LOGICAL_H, LOGICAL_W, onSlab } from "./draw";
import { BUILDING, ease, lift, litCount, segments, storeyAt, storeyLit, STOREY } from "./facade";
import { FLOORS } from "./floors";
import { slabTag } from "./scene";
import { CAMERA_AT, createStackRenderer, GAP, nextLevel, OPEN_S, slabIndex, slabTop, storeyY, WORLD_H, type Level, type LevelEvent } from "./stack";

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
    expect(["queue:ER", "morgue", "unit:ER", "unit:ICU", "unit:MED3B", "unit:MED3A", "hbed:SURG5A:2", "unit:W4"].map((id) => floorOf(h, id))).toEqual([0, 0, 0, 2, 1, 3, 5, 4]);
    const p = h.people.find((x) => x.unit === "ICU")!;
    expect(floorOf(h, `h:${p.n}`)).toBe(2);
    expect(floorOf(h, "h:999999")).toBeNull();
  });
});

describe("the stack's geometry and camera", () => {
  it("stacks GF to 5F bottom up, every floor 36 x 18", () => {
    expect(FLOORS.map((f) => f.floor)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const f of FLOORS) expect([f.map.length, ...new Set(f.map.map((r) => r.length))]).toEqual([18, 36]);
    expect([slabTop(slabIndex(5)), slabTop(slabIndex(4)), slabTop(slabIndex(0))]).toEqual([0, GAP, 5 * GAP]);
    expect(WORLD_H).toBe(LOGICAL_H + 5 * GAP);
  });

  it("clampCam with a wider view centres the axis the map fits on, and lets the stack zoom out below 0.5", () => {
    expect(clampCam({ zoom: 1, x: 100, y: 100 }, 656, 382, 900, 382)).toEqual({ zoom: 1, x: 328, y: 191 });
    expect(clampCam({ zoom: 2, x: 100, y: 100 }, 656, 382, 900, 382)).toEqual({ zoom: 2, x: 225, y: 100 });
    expect(clampCam({ zoom: 0.3, x: 0, y: 0 }, 656, 1182, 656, 382, 0.3)).toEqual({ zoom: 0.3, x: 328, y: 591 });
    expect(clampCam({ zoom: 0.3, x: 0, y: 0 }, 656, 1182).zoom).toBe(0.5);
  });
});

// The landing camera at the ward-only stage size: the closed building fitted with a margin. Points as BUILDING gives them
// (GF's floor at 0); the camera's own offset, slabTop(0), cancels out.
const LANDING = Math.min(656 / (720 * 1.12), 382 / (573 * 1.12));
const landing = (wx: number, wy: number): [number, number] => [328 + (wx - 316) * LANDING, 191 + (wy - 112.5) * LANDING];

describe("the closed building and its opening", () => {
  it("storeys sit on each other with no gap when closed; open, they are the old stack exactly; eased and monotone between", () => {
    expect(STOREY).toBe(36);
    expect(FLOORS.map((_, i) => storeyY(i, 0))).toEqual([1000, 964, 928, 892, 856, 820]);
    for (let i = 0; i < FLOORS.length - 1; i += 1) expect(storeyY(i, 0) - STOREY).toBe(storeyY(i + 1, 0)); // a ceiling is the next floor
    expect(FLOORS.map((_, i) => storeyY(i, 1))).toEqual(FLOORS.map((_, i) => slabTop(i)));
    expect(storeyY(0, 0.5)).toBe(1000); // GF stays put
    expect(storeyY(5, 0.5)).toBe((820 + 0) / 2);
    expect(ease(0.1)).toBeLessThan(0.1);
    expect(ease(0.9)).toBeGreaterThan(0.9);
    for (let i = 1; i < FLOORS.length; i += 1) {
      let last = Infinity;
      for (let q = 0; q <= 1.0001; q += 0.02) {
        expect(storeyY(i, q)).toBeLessThanOrEqual(last); // only ever upward
        last = storeyY(i, q);
      }
    }
    expect(BUILDING(FLOORS.length)).toEqual({ x0: -44, x1: 676, y0: -174, y1: 399, w: 720, h: 573 }); // GF's floor at 0
    expect([OPEN_S, CAMERA_AT]).toEqual([0.6, 0.6]);
  });

  it("closed, a storey covers the top of the one below: the visible one wins", () => {
    const [x, y] = iso(18, 18);
    for (let i = 0; i < FLOORS.length; i += 1) {
      expect(storeyAt(x, y + lift(i) - STOREY + 1, FLOORS.length)).toBe(i);
      expect(storeyAt(x, y + lift(i) - STOREY - 1, FLOORS.length)).toBe(Math.min(i + 1, FLOORS.length - 1)); // 5F: its roof
      const [cx, cy] = iso(18, 9);
      // A top's centre is under the storeys stacked on it; six high, GF's lies below 5F's front faces, so 4F's cover it.
      expect(storeyAt(cx, cy + lift(i) - STOREY, FLOORS.length)).toBe(i === 0 ? FLOORS.length - 2 : FLOORS.length - 1);
    }
    expect(storeyAt(...iso(18, 18.5), FLOORS.length)).toBe(-1); // the pavement in front
  });

  it("ribbon segments light from occupancy, deterministically", () => {
    expect(segments(3).map((x) => x.face)).toEqual(["south", "south", "south", "south", "south", "east", "east", "east"]);
    expect(segments(0).length).toBe(5); // GF's doors take three of the south segments
    expect([0, 30, 60, 75].map((census) => litCount(census, 60, 8))).toEqual([0, 4, 8, 8]);
    expect(litCount(5, 0, 8)).toBe(0);
    expect(storeyLit(3, null)).toBe(0);
  });

  it("the signs say slabTag's live line", () => {
    const texts: string[] = [];
    const rec = new Proxy({}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 1 }) : k === "fillText" ? (t: string) => void texts.push(t) : () => ({ data: new Uint8ClampedArray(4) })), set: () => true });
    const s = createHospitalSim(createSyntheticSource(FIXTURE_SEED, true), parseScenario(typical), 101);
    const st = createStackRenderer({ getContext: () => rec, style: {}, width: 0, height: 0 } as unknown as HTMLCanvasElement, () => null);
    st.resize(656, 382, 1);
    st.frame(s, null, null, 0.016, 0);
    const floors = floorSummary(s.hospital!);
    expect(texts).toEqual(expect.arrayContaining([...FLOORS.map((f) => slabTag(f, floors)), "ENTRANCE", "EMERGENCY"]));
  });

  it("no hit while it opens or closes; then the old stack's hits, or the building's", () => {
    const src = createSyntheticSource(FIXTURE_SEED, true);
    const s = createSim(src);
    let view: number | null = null;
    const st = createStackRenderer(canvas(), () => view);
    st.resize(656, 382, 1);
    st.frame(s, null, null, 0.016, 0);
    const grid = () => {
      const ids = new Set<string | null>();
      for (let y = 0; y < 382; y += 4) for (let x = 0; x < 656; x += 4) ids.add(st.hit(s, x, y));
      return [...ids];
    };
    view = 3;
    for (let i = 0; i < 5; i += 1) {
      st.frame(s, null, null, 0.1, 1 + i * 0.1);
      expect(grid(), `opening, frame ${i}`).toEqual([""]);
    }
    for (let i = 0; i < 200; i += 1) st.frame(s, null, null, 0.05, 2 + i * 0.05);
    const label = iso((11 + 19 + 1) / 2, (1 + 6 + 1) / 2); // BAY 2's label, Medicine 3A
    expect(st.hit(s, label[0], label[1])).toBe("unit:MED3A");
    view = 5; // floor to floor: the stack stays open, the focus moves
    st.frame(s, null, null, 0.016, 20);
    expect(grid()).not.toEqual([""]);
    view = null;
    st.frame(s, null, null, 0.1, 21);
    expect(grid()).toEqual([""]);
    for (let i = 0; i < 200; i += 1) st.frame(s, null, null, 0.05, 22 + i * 0.05);
    expect(grid().every((id) => id === null || id.startsWith("floor:"))).toBe(true);
  });
});

describe("the backing store", () => {
  it("is the whole device-pixel scale nearest the screen's, at least 1", () => {
    expect(backingFor(Math.min(1060 / LOGICAL_W, 786 / LOGICAL_H), 2)).toBe(3); // was 4 (rounded up from 3.23)
    expect(backingFor(1, 1)).toBe(1);
    expect(backingFor(0.3, 1)).toBe(1);
    const [a, b] = [canvas(), canvas()];
    createStackRenderer(a, () => null).resize(1060, 786, 2);
    createRenderer(b).resize(1060, 786, 2);
    expect([a.width, a.height, b.width, b.height]).toEqual([1968, 1459, 3 * LOGICAL_W, 3 * LOGICAL_H]); // was 2624 x 1946
    createStackRenderer(a, () => null).resize(656, 382, 1);
    expect([a.width, a.height]).toEqual([656, 382]);
  });
});

// A context that counts what it is asked to do, so a test sees whether a frame painted.
function counting() {
  const calls = { n: 0 };
  const ctx = new Proxy({}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 1 }) : () => ((calls.n += 1), { data: new Uint8ClampedArray(4) })), set: () => ((calls.n += 1), true) });
  return { calls, canvas: { getContext: () => ctx, style: {}, width: 0, height: 0 } as unknown as HTMLCanvasElement };
}

describe("the closed building paints only when what it shows changed", () => {
  const hospital = () => createHospitalSim(createSyntheticSource(FIXTURE_SEED, true), parseScenario(typical), 101);
  const nextMinute = (s: ReturnType<typeof hospital>) => {
    const src = createSyntheticSource(FIXTURE_SEED, true);
    const m = s.hospital!.lastMinute;
    s.speed = 60;
    while (s.hospital!.lastMinute === m) step(s, src);
  };

  it("an unchanged frame paints nothing; hover, a new minute, a resize, redraw and reset paint the next", () => {
    const s = hospital();
    const { calls, canvas: c } = counting();
    const st = createStackRenderer(c, () => null);
    st.resize(656, 382, 1);
    const paints = (hovered: string | null = null) => {
      const before = calls.n;
      const drew = st.frame(s, null, hovered, 0.016, 0);
      expect(calls.n > before).toBe(drew);
      return drew;
    };
    expect(paints()).toBe(true); // the first frame
    expect([paints(), paints(), paints()]).toEqual([false, false, false]);
    expect([paints("floor:3"), paints("floor:3"), paints("floor:2"), paints(null), paints(null)]).toEqual([true, false, true, true, false]);
    nextMinute(s);
    expect([paints(), paints()]).toEqual([true, false]);
    st.resize(656, 382, 1); // the same size still wipes the canvas
    expect([paints(), paints()]).toEqual([true, false]);
    st.resize(700, 382, 1);
    expect([paints(), paints()]).toEqual([true, false]);
    st.redraw();
    expect([paints(), paints()]).toEqual([true, false]);
    st.reset();
    expect([paints(), paints()]).toEqual([true, false]);
  });

  it("a skipped frame still drops W4's trolleys, and a moving camera or the opening paints every frame", () => {
    const s = hospital();
    let view: number | null = null;
    const { canvas: c } = counting();
    const st = createStackRenderer(c, () => view);
    st.resize(656, 382, 1);
    st.frame(s, null, null, 0.016, 0);
    s.speed = 1;
    s.moves.push({ bed: "A1", kind: "in" } as (typeof s.moves)[number]);
    expect(st.frame(s, null, null, 0.016, 0)).toBe(false);
    expect(s.moves).toEqual([]);
    view = 3;
    const opening = Array.from({ length: 60 }, (_, i) => st.frame(s, null, null, 0.016, i * 0.016));
    expect(opening.every(Boolean)).toBe(true); // open never skips
    view = null;
    const closing = Array.from({ length: 600 }, (_, i) => st.frame(s, null, null, 0.016, 2 + i * 0.016));
    const firstSkip = closing.indexOf(false);
    expect(firstSkip).toBeGreaterThan(OPEN_S / 0.016); // painted all the way through the closing and the camera's easing
    expect(closing.slice(0, firstSkip).every(Boolean)).toBe(true);
    // Then at rest: the camera's last thousandths of a pixel may cross a rounding step once or twice, then nothing.
    expect(closing.slice(firstSkip).filter(Boolean).length).toBeLessThanOrEqual(3);
    expect(closing.slice(300).some(Boolean)).toBe(false);
  });
});

describe("the open stack's ghosts", () => {
  it("are repainted only when their scene or a drawer's blink changed; W4's, which moves, every frame", () => {
    const made: { calls: { n: number }; canvas: HTMLCanvasElement }[] = [];
    const real = document.createElement;
    Object.assign(document, { createElement: () => (made.push(counting()), made[made.length - 1].canvas) });
    try {
      const s = createHospitalSim(createSyntheticSource(FIXTURE_SEED, true), parseScenario(typical), 101);
      const st = createStackRenderer(counting().canvas, () => 3);
      const ghosts = made.filter((c) => c.canvas.width === LOGICAL_W * 2 && c.canvas.height === LOGICAL_H * 2);
      expect(ghosts.length).toBe(FLOORS.length);
      st.resize(656, 382, 1);
      const counts = () => ghosts.map((g) => g.calls.n);
      const painted = (frames: number, now: number) => {
        const before = counts();
        for (let i = 0; i < frames; i += 1) st.frame(s, null, null, 0.016, now);
        return counts().map((n, i) => n > before[i]);
      };
      const w4 = slabIndex(4);
      const others = FLOORS.map((_, i) => i !== w4 && i !== slabIndex(3));
      painted(12, 0); // the first frame paints every ghost; let the opening settle too
      expect(painted(12, 0)).toEqual(FLOORS.map((_, i) => i === w4)); // nothing changed: only W4's ghost
      const src = createSyntheticSource(FIXTURE_SEED, true);
      const m = s.hospital!.lastMinute;
      s.speed = 60;
      while (s.hospital!.lastMinute === m) step(s, src);
      s.speed = 0;
      expect(painted(FLOORS.length, 0)).toEqual(FLOORS.map((_, i) => others[i] || i === w4)); // a new minute: each once
      expect(painted(FLOORS.length, 0)).toEqual(FLOORS.map((_, i) => i === w4));
      st.redraw();
      expect(painted(FLOORS.length, 0)).toEqual(FLOORS.map((_, i) => others[i] || i === w4));
    } finally {
      Object.assign(document, { createElement: real });
    }
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

  it("closed, picks the storey under the pointer; open on a floor, its ghosts take no clicks", () => {
    const s = ward();
    let view: number | null = null;
    const st = createStackRenderer(canvas(), () => view);
    st.resize(656, 382, 1);
    st.frame(s, null, null, 0.016, 0);
    const [mx, my] = iso(18, 18); // the middle of each storey's long south face
    for (const [i, f] of FLOORS.entries()) expect(st.hit(s, ...landing(mx, my + lift(i) - STOREY / 2))).toBe(`floor:${f.floor}`);
    const [sx, sy] = iso(34.5, 18); // the signs' column: each anchor, 5 screen px up into the tag
    for (const [i, f] of FLOORS.entries()) {
      const [x, y] = landing(sx, sy + lift(i) - 8);
      expect(st.hit(s, x, y - 5)).toBe(`floor:${f.floor}`);
    }
    expect(st.hit(s, 2, 2)).toBeNull(); // the stage's corner
    const seen = new Set<string | null>();
    for (let y = 0; y < 382; y += 3) for (let x = 0; x < 656; x += 3) seen.add(st.hit(s, x, y));
    expect([...seen].sort()).toEqual([null, ...FLOORS.map((f) => `floor:${f.floor}`)].sort()); // nothing inside the building
    // Focus 3F: its own label hits, 4F's middle (a ghost above it) is outside, the empty floor is "".
    view = 3;
    st.reset();
    st.frame(s, null, null, 0.016, 0);
    const label = iso((11 + 19 + 1) / 2, (1 + 6 + 1) / 2); // BAY 2's label, Medicine 3A
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
    expect(stack.userZoom()).toBeCloseTo(LANDING);
    stack.zoomAt(2, 0, 0, true); // the building has one zoom
    expect(stack.userZoom()).toBeCloseTo(LANDING);
    expect(fitCam(LOGICAL_W, LOGICAL_H).zoom).toBe(1);
  });
});
