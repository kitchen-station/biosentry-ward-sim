import { beforeAll, describe, expect, it } from "vitest";
import { clampCam, fitCam } from "../camera";
import { floorSummary } from "../building";
import { floorOf } from "../hospital-panels";
import { createHospitalSim } from "../sim/hospital/attach";
import { parseScenario } from "../sim/hospital/scenario";
import { BEDS } from "../sim/map";
import { createSim, step } from "../sim/sim";
import { createSyntheticSource, FIXTURE_SEED } from "../sim/source";
import typical from "../../scenarios/hospital/typical.json?raw";
import { backingFor, createRenderer, iso, LOGICAL_H, LOGICAL_W, onSlab } from "./draw";
import { BUILDING, ease, lift, litCount, segments, storeyAt, storeyLit, STOREY } from "./facade";
import { FLOORS } from "./floors";
import { floorScene, slabTag } from "./scene";
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
  it("are repainted only when their scene or a drawer's blink changed; W4's when a quarter-second turns", () => {
    const made: { calls: { n: number }; canvas: HTMLCanvasElement }[] = [];
    const real = document.createElement;
    Object.assign(document, { createElement: () => (made.push(counting()), made[made.length - 1].canvas) });
    try {
      const s = createHospitalSim(createSyntheticSource(FIXTURE_SEED, true), parseScenario(typical), 101);
      s.speed = 0; // paused: staff and movers hold still, so a ghost repaints only for its scene or blink
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
      expect(painted(12, 0)).toEqual(FLOORS.map(() => false)); // nothing changed, not even the quarter-second
      const src = createSyntheticSource(FIXTURE_SEED, true);
      const m = s.hospital!.lastMinute;
      s.speed = 60;
      while (s.hospital!.lastMinute === m) step(s, src);
      s.speed = 0;
      expect(painted(FLOORS.length, 0)).toEqual(others); // a new minute: each once; W4's waits for its quarter-second
      expect(painted(FLOORS.length, 0)).toEqual(FLOORS.map(() => false));
      expect(painted(1, 0.25)).toEqual(FLOORS.map((_, i) => i === w4));
      st.redraw();
      expect(painted(FLOORS.length, 0)).toEqual(FLOORS.map((_, i) => others[i] || i === w4));
    } finally {
      Object.assign(document, { createElement: real });
    }
  });
});

describe("W4's ghost", () => {
  it("is repainted only when a 4 Hz or 3 Hz blink turns, with the time summed; focused, W4 is live every frame and its ghost untouched", () => {
    const made: { calls: { n: number }; canvas: HTMLCanvasElement }[] = [];
    const real = document.createElement;
    Object.assign(document, { createElement: () => (made.push(counting()), made[made.length - 1].canvas) });
    try {
      const s = createHospitalSim(createSyntheticSource(FIXTURE_SEED, true), parseScenario(typical), 101);
      let view = 3;
      const st = createStackRenderer(counting().canvas, () => view);
      const ghost = made.filter((c) => c.canvas.width === LOGICAL_W * 2 && c.canvas.height === LOGICAL_H * 2)[slabIndex(4)];
      st.resize(656, 382, 1);
      s.speed = 1;
      let repaints = 0;
      for (let i = 0; i < 120; i += 1) {
        const before = ghost.calls.n;
        st.frame(s, null, null, 1 / 60, i / 60);
        if (ghost.calls.n > before) repaints += 1;
      }
      expect(repaints).toBeGreaterThanOrEqual(11);
      expect(repaints).toBeLessThanOrEqual(12); // 2 s: the first frame, then six a second (quarters and thirds, which meet on the second)
      // A trolley waits for W4's next paint, then is launched: the queue drains within a quarter-second.
      const bed = BEDS[0].label;
      s.moves.push({ bed, kind: "in" } as (typeof s.moves)[number]);
      for (let i = 0; i < 16; i += 1) st.frame(s, null, null, 1 / 60, 2 + i / 60);
      expect(s.moves).toEqual([]);
      view = 4;
      const before = ghost.calls.n;
      for (let i = 0; i < 30; i += 1) {
        s.moves.push({ bed, kind: "in" } as (typeof s.moves)[number]);
        st.frame(s, null, null, 1 / 60, 3 + i / 60);
        expect(s.moves).toEqual([]); // live: launched the frame it arrives
      }
      expect(ghost.calls.n).toBe(before);
    } finally {
      Object.assign(document, { createElement: real });
    }
  });
});

describe("moving people and the frame skipping", () => {
  it("a running hospital repaints its ghosts for their moving staff, a paused one only W4's, and the closed building not at all", () => {
    const made: { calls: { n: number }; canvas: HTMLCanvasElement }[] = [];
    const real = document.createElement;
    Object.assign(document, { createElement: () => (made.push(counting()), made[made.length - 1].canvas) });
    try {
      const s = createHospitalSim(createSyntheticSource(FIXTURE_SEED, true), parseScenario(typical), 101);
      let view: number | null = 3;
      const st = createStackRenderer(counting().canvas, () => view);
      const ghosts = made.filter((c) => c.canvas.width === LOGICAL_W * 2 && c.canvas.height === LOGICAL_H * 2);
      st.resize(656, 382, 1);
      const run = (seconds: number, t0: number) => {
        const before = ghosts.map((g) => g.calls.n);
        for (let i = 0; i < seconds * 60; i += 1) st.frame(s, null, null, 1 / 60, t0 + i / 60);
        return ghosts.map((g, i) => g.calls.n > before[i]);
      };
      run(2, 0);
      s.speed = 0;
      expect(run(1, 2)).toEqual(FLOORS.map((_, i) => i === slabIndex(4))); // paused: nothing but W4's moves
      const calls = () => ghosts.map((g) => g.calls.n);
      s.speed = 1;
      const [a, b] = [calls(), (run(1, 3), calls())];
      const floor = slabIndex(1); // MEDICINE has staff
      expect(b[floor]).toBeGreaterThan(a[floor]);
      s.speed = 0;
      view = null;
      run(3, 4);
      s.speed = 1;
      const quiet = Array.from({ length: 120 }, (_, i) => st.frame(s, null, null, 1 / 60, 8 + i / 60));
      expect(quiet.some(Boolean)).toBe(false);
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

// A context that writes down what it is asked to do; a canvas argument is named by its place in `made`.
type Rec = { log: string[]; canvas: HTMLCanvasElement };
function recorder(made: Rec[]): Rec {
  const log: string[] = [];
  const fmt = (v: unknown) => (typeof v === "number" ? String(Math.round(v * 1e6) / 1e6) : v && typeof v === "object" ? `c${made.findIndex((m) => m.canvas === v)}` : JSON.stringify(v));
  const ctx = new Proxy({}, {
    get: (_t, k: string) => (k === "measureText" ? () => ({ width: 1 }) : (...a: unknown[]) => (log.push(`${k}(${a.map(fmt).join(",")})`), { data: new Uint8ClampedArray(4) })),
    set: (_t, k: string, v) => (log.push(`${k}=${fmt(v)}`), true),
  });
  return { log, canvas: { getContext: () => ctx, style: {}, width: 0, height: 0 } as unknown as HTMLCanvasElement };
}

/** A paused hospital open on a floor at 1000 x 382 (no baked picture is that size), settled, every ghost painted. */
function openStack(view: () => number, test: (o: ReturnType<typeof setup>) => void) {
  const real = document.createElement;
  const made: Rec[] = [];
  Object.assign(document, { createElement: () => (made.push(recorder(made)), made[made.length - 1].canvas) });
  try {
    test(setup(made, view));
  } finally {
    Object.assign(document, { createElement: real });
  }
}
function setup(made: Rec[], view: () => number) {
  const s = createHospitalSim(createSyntheticSource(FIXTURE_SEED, true), parseScenario(typical), 101);
  s.speed = 0;
  const main = recorder(made);
  const st = createStackRenderer(main.canvas, view);
  const ghosts = made.filter((c) => c.canvas.width === LOGICAL_W * 2 && c.canvas.height === LOGICAL_H * 2);
  st.resize(1000, 382, 1);
  for (let i = 0; i < 120; i += 1) st.frame(s, null, null, 1 / 60, 0);
  const layers = made.filter((c) => c.canvas.width === 1000 && c.canvas.height === 382);
  const name = (c: Rec) => `c${made.indexOf(c)}`;
  /** Which of the two layers this frame recomposed, and whether it painted. */
  const frame = (now = 0, selected: string | null = null, hovered: string | null = null, dt = 1 / 60) => {
    const before = layers.map((l) => l.log.length);
    const drew = st.frame(s, selected, hovered, dt, now);
    return { layers: layers.map((l, i) => l.log.length > before[i]), drew };
  };
  return { s, st, main, ghosts, layers, name, frame };
}

describe("the open stack's two layers", () => {
  let view = 3;
  it("put together the picture a direct paint gives: same order, alphas, offsets and smoothing", () =>
    openStack(() => 3, ({ st, main, layers, ghosts, name, frame }) => {
      expect(layers.length).toBe(2);
      const clear = () => [main, ...layers].forEach((c) => (c.log.length = 0));
      st.redraw();
      clear();
      frame(0.1);
      const [L0, L1] = layers.map((l) => [...l.log]);
      const I = "setTransform(1,0,0,1,0,0)";
      const world = main.log[2];
      expect(world).toMatch(/^setTransform\(/);
      expect(main.log.slice(0, 2)).toEqual([I, `drawImage(${name(layers[0])},0,0)`]);
      expect(main.log.slice(-2)).toEqual([I, `drawImage(${name(layers[1])},0,0)`]);
      expect(L0.slice(0, 5)).toEqual([I, 'fillStyle="#2A2036"', "fillRect(0,0,1000,382)", world, "imageSmoothingEnabled=false"]);
      expect(L1.slice(0, 4)).toEqual([I, "clearRect(0,0,1000,382)", world, "imageSmoothingEnabled=false"]);
      const ghost = (i: number, alpha: number) => ["save()", `globalAlpha=${alpha}`, `translate(0,${slabTop(i)})`, `drawImage(${name(ghosts[i])},0,0,${LOGICAL_W},${LOGICAL_H})`, "restore()"];
      expect(L0.slice(5)).toEqual([0, 1, 2].flatMap((i) => ghost(i, 0.35)));
      expect(L1.slice(4)).toEqual([4, 5].flatMap((i) => ghost(i, 0.15)));
      const live = main.log.slice(2, -2); // a copy: the world transform, then the focused floor
      // The same frame painted directly (the zoom eases, so the layers are not used): the same calls, but for the camera.
      st.zoomAt(1.5, 500, 191, false);
      clear();
      frame(0.1);
      expect(layers.every((l) => l.log.length === 0)).toBe(true);
      const cam = (log: string[]) => log.map((x) => (x.startsWith("setTransform(") && x !== I ? "T" : x));
      expect(cam(main.log)).toEqual(cam([...L0, ...live.slice(2), ...L1.slice(4)]));
    }));

  it("are recomposed only when a ghost they hold was repainted, the focus, the camera or the canvas changed, or redraw", () =>
    openStack(() => view, ({ s, st, frame }) => {
      const quiet = Array.from({ length: 30 }, () => frame(0).layers);
      expect(quiet.flat().some(Boolean)).toBe(false); // nothing changed: neither
      // A ghost repainted: the next minute, each ghost once within a round of frames, and the layer holding it.
      const src = createSyntheticSource(FIXTURE_SEED, true);
      const m = s.hospital!.lastMinute;
      s.speed = 60;
      while (s.hospital!.lastMinute === m) step(s, src);
      s.speed = 0;
      const round = Array.from({ length: FLOORS.length }, () => frame(0).layers);
      expect([round.some((r) => r[0]), round.some((r) => r[1])]).toEqual([true, true]);
      expect(frame(0).layers).toEqual([false, false]);
      // W4's ghost (above 3F) at its quarter-second: the front layer only.
      expect(frame(0.25).layers).toEqual([false, true]);
      // The camera: an instant zoom, then a pan.
      st.zoomAt(2, 500, 191, true);
      expect(frame(0.25).layers).toEqual([true, true]);
      expect(frame(0.25).layers).toEqual([false, false]);
      st.pan(-20, 0);
      expect(frame(0.25).layers).toEqual([true, true]);
      expect(frame(0.25).layers).toEqual([false, false]);
      // A resize, even to the same size, and redraw.
      st.resize(1000, 382, 1);
      expect(frame(0.25).layers).toEqual([true, true]);
      expect(frame(0.25).layers).toEqual([false, false]);
      st.redraw();
      expect(frame(0.25).layers.every(Boolean)).toBe(true);
      // The focus: 5F has every other floor below it, and nothing above.
      view = 5;
      const moved = Array.from({ length: 300 }, () => frame(0.25).layers);
      expect(moved.some((r) => r[0])).toBe(true);
      expect(frame(0.25).layers).toEqual([false, false]);
    }));

  it("a steady running floor recomposes a layer no more often than the ghosts it holds are repainted", () =>
    openStack(() => 3, ({ s, ghosts, frame }) => {
      s.speed = 1;
      const repaints = [0, 0];
      const recomposed = [0, 0];
      for (let i = 0; i < 180; i += 1) {
        const before = ghosts.map((g) => g.log.length);
        const r = frame(1 + i / 60).layers;
        ghosts.forEach((g, k) => { if (g.log.length > before[k] && k !== slabIndex(3)) repaints[k < slabIndex(3) ? 0 : 1] += 1; });
        r.forEach((x, k) => (recomposed[k] += x ? 1 : 0));
      }
      expect(recomposed[0]).toBeGreaterThan(0);
      expect(recomposed[0]).toBeLessThanOrEqual(repaints[0]);
      expect(recomposed[1]).toBeLessThanOrEqual(repaints[1]);
      expect(recomposed[0] + recomposed[1]).toBeLessThanOrEqual((4 * 4 + 7) * 3); // four ghosts at most four times a second, W4 at most seven, 3 s
    }));
});

describe("an open floor paints only when what it shows changed", () => {
  it("paused and settled, a frame repeats the last: hover, selection, a resize, redraw and W4's quarter-second paint again", () =>
    openStack(() => 3, ({ st, frame }) => {
      const drew = (now = 0, selected: string | null = null, hovered: string | null = null) => frame(now, selected, hovered).drew;
      expect([drew(), drew(), drew()]).toEqual([false, false, false]);
      // An id with no place leaves the camera still, so only `selected` in the key makes this paint.
      expect([drew(0, "no-such-id"), drew(0, "no-such-id"), drew()]).toEqual([true, false, true]);
      expect([drew(0, null, "unit:MED3A"), drew(0, null, "unit:MED3A"), drew(0, null, null), drew()]).toEqual([true, false, true, false]);
      const sel = Array.from({ length: 300 }, () => drew(0, "unit:MED3A")); // the camera eases onto it, then rests
      expect(sel[0]).toBe(true);
      expect(sel.slice(-10)).toEqual(Array(10).fill(false));
      expect(drew(0, null)).toBe(true);
      Array.from({ length: 300 }, () => drew());
      expect(drew()).toBe(false);
      st.resize(1000, 382, 1);
      expect([drew(), drew()]).toEqual([true, false]);
      st.redraw(); // every ghost is repainted again, one a frame, and each repaint shows
      const again = Array.from({ length: FLOORS.length + 1 }, () => drew());
      expect(again[0]).toBe(true);
      expect(again.slice(-1)).toEqual([false]);
      expect([drew(0.25), drew(0.25), drew(0.3)]).toEqual([true, false, false]); // W4's ghost, above, repainted once
    }));

  it("a running hospital paints every frame; W4 focused is never skipped, paused or not", () => {
    openStack(() => 3, ({ s, frame }) => {
      s.speed = 1;
      expect(Array.from({ length: 60 }, () => frame(0).drew).every(Boolean)).toBe(true); // the clock moves the staff
      s.speed = 0;
    });
    openStack(() => 4, ({ frame }) => {
      expect(Array.from({ length: 60 }, () => frame(0).drew).every(Boolean)).toBe(true);
    });
  });

  it("a full drawer's blink on the focused floor paints the frame it turns, live", () =>
    openStack(() => 0, ({ s, st, main, frame }) => {
      const src = createSyntheticSource(FIXTURE_SEED, true);
      s.speed = 60;
      const gf = FLOORS[slabIndex(0)];
      while (!floorScene(s.hospital!, gf).drawers.some((d) => d.full)) step(s, src);
      s.speed = 0;
      for (let i = 0; i < 300; i += 1) st.frame(s, null, null, 1 / 60, 0.1); // the new minute settles
      expect(frame(0.1).drew).toBe(false);
      // The blink turns on the half-second; the drawer's light is cream for one of every six.
      const cream = (now: number) => {
        main.log.length = 0;
        const drew = frame(now).drew;
        return drew && main.log.includes('fillStyle="#FFF8E7"');
      };
      const turns = [0.6, 1.1, 1.6, 2.1, 2.6, 3.1].map(cream);
      expect(turns.some(Boolean)).toBe(true);
      expect(frame(3.1).drew).toBe(false);
    }));
});
