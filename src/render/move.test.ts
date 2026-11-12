import { beforeAll, describe, expect, it } from "vitest";
import { floorOf } from "../hospital-panels";
import { createHospitalSim } from "../sim/hospital/attach";
import { parseScenario } from "../sim/hospital/scenario";
import { step } from "../sim/sim";
import { createSyntheticSource, FIXTURE_SEED } from "../sim/source";
import typical from "../../scenarios/hospital/typical.json?raw";
import { FLOORS } from "./floors";
import { figureOf, LIFT, newMovers, route, walkerTile, type Place } from "./move";
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
    const run = () => newMovers(new Map([["h:1", a]]), new Map([["h:1", b]]), 10, () => false);
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
    expect(newMovers(new Map([["h:1", place(1, [2, 1])]]), new Map(), 0, () => true)[0].legs.map((l) => l.path.at(-1))).toEqual([LIFT]);
    expect(newMovers(new Map([["h:1", place(1, [2, 1])]]), new Map(), 0, () => false)).toEqual([]); // unseen in a room: not walked
    const many = new Map(Array.from({ length: 31 }, (_, i) => [`h:${i}`, place(1, [2, 1])]));
    expect(newMovers(many, new Map(), 0, () => true)).toEqual([]);
  });
});

describe("the camera follows a person across floors", () => {
  it("floorOf says the floor they leave by while they walk, then the new floor; Back and Escape stop the follow", () => {
    const s = createHospitalSim(createSyntheticSource(FIXTURE_SEED, true), parseScenario(typical), 101);
    const src = createSyntheticSource(FIXTURE_SEED, true);
    const st = createStackRenderer(document.createElement("canvas"), () => 0);
    st.resize(656, 382, 1);
    st.frame(s, null, null, 1, 0);
    const h = s.hospital!;
    const where = () => new Map(h.people.map((p) => [`h:${p.n}`, floorOf(h, `h:${p.n}`)]));
    let before = where();
    let found: { id: string; from: number; to: number } | null = null;
    for (let i = 0; i < 4000 && !found; i += 1) {
      s.speed = 60;
      const m = h.lastMinute;
      while (h.lastMinute === m) step(s, src);
      s.speed = 1;
      const now = where();
      for (const [id, to] of now) {
        const from = before.get(id);
        if (from !== undefined && from !== null && to !== null && from !== to && st.floorOf!(s, id) !== null) found = { id, from, to };
      }
      st.frame(s, null, null, 0.016, i);
      if (!found) before = now;
    }
    expect(found).not.toBeNull();
    const { id, from, to } = found!;
    st.frame(s, id, null, 0.016, 0);
    expect(st.floorOf!(s, id)).toBe(from); // still on the floor they leave by
    for (let t = 0; t < 40 && st.floorOf!(s, id) === from; t += 1) st.frame(s, id, null, 0.5, t);
    expect(st.floorOf!(s, id)).toBe(to);
    // Following ends as the level table says: Escape drops the selection and keeps the floor.
    expect(nextLevel({ view: to, selected: id }, "escape")).toEqual({ view: to, selected: null });
  });
});
