import { beforeAll, describe, expect, it } from "vitest";
import { floorOf } from "../hospital-panels";
import { createHospitalSim } from "../sim/hospital/attach";
import { parseScenario } from "../sim/hospital/scenario";
import { step } from "../sim/sim";
import { createSyntheticSource, FIXTURE_SEED } from "../sim/source";
import typical from "../../scenarios/hospital/typical.json?raw";
import { FLOORS } from "./floors";
import { animate, figureOf, LIFT, newMovers, placesOf, route, walkerTile, type Place } from "./move";
import { floorScene } from "./scene";
import { iso } from "./draw";
import { createStackRenderer, nextLevel, slabIndex } from "./stack";

beforeAll(() => {
  const ctx = new Proxy({}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 1 }) : () => ({ data: new Uint8ClampedArray(4) })), set: () => true });
  Object.assign(globalThis, { document: { createElement: () => ({ getContext: () => ctx, style: {}, width: 0, height: 0 }) }, ImageData: class {} });
});

const MED = FLOORS[slabIndex(3)];
const place = (floor: number, tile: [number, number]): Place => ({ floor, tile, cell: { group: "cardiac", initials: "AB", sel: "h:1", slot: 0 }, queued: false, colour: null, body: false });

describe("movers", () => {
  it("a staff member's tile is the same for the same id and clock, differs between ids, and stays within a tile of the post", () => {
    const home: [number, number] = [13, 11];
    const at = (who: string, c: number) => walkerTile(MED.map, home, who, c);
    expect(at("unit:MED3A:0", 37.5)).toEqual(at("unit:MED3A:0", 37.5));
    expect(walkerTile(MED.map, home, "x", 0)).toEqual(home); // a new world starts at the posts
    const seen = Array.from({ length: 200 }, (_, i) => at("unit:MED3A:0", i / 2));
    expect(new Set(seen.map((t) => t.join())).size).toBeGreaterThan(3);
    expect(seen.every(([x, y]) => Math.abs(x - home[0]) <= 1 && Math.abs(y - home[1]) <= 1)).toBe(true);
    expect(Array.from({ length: 8 }, (_, i) => at(`unit:MED3A:${i}`, 20).join()).filter((v, i, a) => a.indexOf(v) === i).length).toBeGreaterThan(1);
  });

  it("a change of floor is walked to the lift, then out of it on the new floor; the path depends only on the places and the clock", () => {
    const a = place(0, [2, 1]);
    const b = place(1, [2, 1]);
    const run = () => newMovers(new Map([["h:1", a]]), new Map([["h:1", b]]), 10, () => false)!;
    expect(run()).toEqual(run());
    const [m] = run();
    expect(m.legs.map((l) => l.floor)).toEqual([0, 1]);
    expect(m.legs[0].path.at(-1)).toEqual(LIFT);
    expect(m.legs[1].path[0]).toEqual(LIFT);
    expect(figureOf(m, 10)).toMatchObject({ floor: 0, tile: [2, 1] });
    expect(figureOf(m, 10 + 1)!.floor).toBe(0);
    expect(figureOf(m, 10 + 30)).toBeNull();
    const mid = Array.from({ length: 300 }, (_, i) => figureOf(m, 10 + i / 10)).filter(Boolean);
    expect(mid.map((f) => f!.floor)).toEqual([...mid.map((f) => f!.floor)].sort()); // down the first floor, then the second
    expect(route(MED.map, [2, 1], [30, 16]).every(([x, y]) => Number.isInteger(x) && Number.isInteger(y))).toBe(true);
  });

  it("someone gone is walked out by the lift; more than 30 changes at once snap", () => {
    expect(newMovers(new Map([["h:1", place(1, [2, 1])]]), new Map(), 0, () => true)![0].legs.map((l) => l.path.at(-1))).toEqual([LIFT]);
    expect(newMovers(new Map([["h:1", place(1, [2, 1])]]), new Map(), 0, () => false)).toEqual([]); // unseen in a room: not walked
    const many = new Map(Array.from({ length: 31 }, (_, i) => [`h:${i}`, place(1, [2, 1])]));
    expect(newMovers(many, new Map(), 0, () => true)).toBeNull();
  });
});

const MINUTE = (s: ReturnType<typeof createHospitalSim>, src: ReturnType<typeof createSyntheticSource>) => {
  s.speed = 60;
  const m = s.hospital!.lastMinute;
  while (s.hospital!.lastMinute === m) step(s, src);
  s.speed = 1;
};

/** Runs a hospital with its stack open until someone changes floor; the renderer has just seen the move. */
function withAMove(view: () => number) {
  const s = createHospitalSim(createSyntheticSource(FIXTURE_SEED, true), parseScenario(typical), 101);
  const src = createSyntheticSource(FIXTURE_SEED, true);
  const st = createStackRenderer(document.createElement("canvas"), view);
  st.resize(656, 382, 1);
  st.frame(s, null, null, 1, 0);
  const h = s.hospital!;
  const where = () => new Map(h.people.map((p) => [`h:${p.n}`, floorOf(h, `h:${p.n}`)]));
  let before = where();
  for (let i = 0; i < 4000; i += 1) {
    MINUTE(s, src);
    const now = where();
    st.frame(s, null, null, 0.016, i);
    for (const [id, to] of now) {
      const from = before.get(id);
      if (from !== undefined && from !== null && to !== null && from !== to && st.floorOf!(s, id) === from) return { s, src, st, id, from, to };
    }
    before = now;
  }
  throw new Error("nobody changed floor");
}

describe("the camera follows a person across floors", () => {
  it("floorOf says the floor they leave by while they walk, then the new floor; Back and Escape stop the follow", () => {
    const { s, st, id, from, to } = withAMove(() => 0);
    st.frame(s, id, null, 0.016, 0);
    expect(st.floorOf!(s, id)).toBe(from); // still on the floor they leave by
    for (let t = 0; t < 40 && st.floorOf!(s, id) === from; t += 1) st.frame(s, id, null, 0.5, t);
    expect(st.floorOf!(s, id)).toBe(to);
    expect(nextLevel({ view: to, selected: id }, "escape")).toEqual({ view: to, selected: null }); // drops the selection, keeps the floor
  });
});

describe("hits on moving people", () => {
  it("a running hospital: a nurse is hit where she walks and a mover where they are, and a second move or a skip leaves no stale walk", () => {
    let view = 0;
    const { s, src, st, id, from } = withAMove(() => view);
    view = from;
    s.speed = 0; // freeze the clock after the move began; the camera settles on the floor
    for (let i = 0; i < 200; i += 1) st.frame(s, null, null, 0.05, i);
    const i = slabIndex(from);
    const spec = FLOORS[i];
    const fig = st.figures!(i).find((f) => f.id === id)!;
    const at = (t: [number, number], up: number): [number, number] => { const [x, y] = iso(t[0] + 0.5, t[1] + 0.5); return [x, y - up]; };
    expect(st.hit(s, ...at(fig.tile, fig.walk ? 10 : 3))).toBe(id);
    const sc = floorScene(s.hospital, spec);
    const n = sc.staff[0];
    expect(st.hit(s, ...at(walkerTile(spec.map, n.tile, `${n.id}:${n.i}`, st.clock!()), 10))).toBe(n.id);
    // The emptied bed is not the person: hits there give the bed.
    s.speed = 1;
    MINUTE(s, src);
    for (let k = 0; k < 10; k += 1) MINUTE(s, src); // a skip of minutes: no walk survives it
    st.frame(s, null, null, 0.016, 0);
    expect(FLOORS.every((_, k) => st.figures!(k).length === 0)).toBe(true);
  });
});

describe("move edge cases", () => {
  it("a second move starts where the first mover is; an unarrived patient's bed selects the bed; a body with no drawer goes to the morgue door", () => {
    const first = newMovers(new Map([["h:1", place(1, [2, 1])]]), new Map([["h:1", place(1, [22, 14])]]), 0, () => false)![0];
    const here = figureOf(first, 1)!;
    const second = newMovers(new Map([["h:1", place(1, [22, 14])]]), new Map([["h:1", place(1, [2, 11])]]), 1, () => false, () => here)![0];
    expect(second.legs[0].path[0]).toEqual([Math.round(here.tile[0]), Math.round(here.tile[1])]);
    const s = createHospitalSim(createSyntheticSource(FIXTURE_SEED, true), parseScenario(typical), 101);
    const med = FLOORS[slabIndex(3)];
    const scene = floorScene(s.hospital, med);
    const bed = scene.beds.find((b) => b.cell)!;
    const shown = animate(scene, med.map, new Set([bed.cell!.sel]), 0);
    const empty = shown.beds.find((b) => b.slot === bed.slot)!;
    expect([empty.cell, empty.id]).toEqual([null, bed.slot]);
    const body = { ...place(1, [2, 1]), body: true };
    const legs = newMovers(new Map([["h:1", body]]), new Map(), 0, () => true)![0].legs;
    expect(legs.map((l) => l.floor)).toEqual([1, 0]);
    expect(legs[1].path.at(-1)).toEqual([27, 7]);
    expect(placesOf([scene]).size).toBeGreaterThan(0);
  });
});
