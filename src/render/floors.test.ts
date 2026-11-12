import { beforeAll, describe, expect, it } from "vitest";
import { clampCam } from "../camera";
import { floorSummary, icuFlag, seeingOrder } from "../building";
import { floorOf } from "../hospital-panels";
import { createHospitalSim } from "../sim/hospital/attach";
import { UNITS, type UnitId } from "../sim/hospital/params";
import { parseScenario } from "../sim/hospital/scenario";
import type { Person, Triage } from "../sim/hospital/types";
import type { Tile } from "../sim/map";
import { createSyntheticSource, FIXTURE_SEED } from "../sim/source";
import typical from "../../scenarios/hospital/typical.json?raw";
import surge from "../../scenarios/hospital/surge.json?raw";
import doh from "../../scenarios/hospital/doh-standard.json?raw";
import { createFloor, iso, onSlab, roomCentre } from "./draw";
import { FLOORS, W4, type FloorSpec } from "./floors";
import { floorScene, MAX_QUEUE, slabTag, type Scene } from "./scene";
import { createStackRenderer, slabIndex } from "./stack";

beforeAll(() => {
  const ctx = new Proxy({}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 1 }) : () => ({ data: new Uint8ClampedArray(4) })), set: () => true });
  const fake = () => ({ getContext: () => ctx, style: {}, width: 0, height: 0 });
  Object.assign(globalThis, { document: { createElement: fake }, ImageData: class {} });
});
const canvas = () => document.createElement("canvas");
const HOSPITAL = FLOORS.filter((f) => f !== W4);
const at = (spec: FloorSpec, [x, y]: Tile) => spec.map[y]?.[x];
const key = ([x, y]: Tile) => `${x},${y}`;
const row = (id: UnitId) => UNITS.find((u) => u.id === id)!;
const scenarios = [typical, surge, doh].map(parseScenario);

describe("the floor maps", () => {
  it.each(HOSPITAL.map((f) => [f.short, f] as const))("%s is well formed", (_, spec) => {
    expect([spec.map.length, ...new Set(spec.map.map((r) => r.length))]).toEqual([18, 36]);
    expect(spec.map[0]).toBe("#".repeat(36));
    expect(spec.map[17]).toBe("#".repeat(36));
    expect(spec.map.slice(8, 10)).toEqual(W4.map.slice(8, 10).map((r) => r.replace(/[^#P+]/g, "."))); // W4's corridor and lift doors
    // Every bed tile belongs to exactly one bed, and every bed sits on bed tiles.
    const tiles = spec.beds.flatMap((b) => [b.head, b.foot]).map(key);
    expect(new Set(tiles).size).toBe(tiles.length);
    const drawn = spec.map.flatMap((r, y) => [...r].map((c, x) => (c === "b" ? `${x},${y}` : null))).filter(Boolean);
    expect([...tiles].sort()).toEqual([...drawn].sort());
    for (const plan of spec.units!) {
      const u = row(plan.unit);
      if (plan.unit === "MORGUE") {
        expect(plan.drawers!.length).toBe(6);
        expect(plan.drawers!.every((t) => at(spec, t) === "M")).toBe(true);
      } else expect(plan.beds.length).toBe(u.beds.value);
      expect(plan.beds.map((b) => b.label)).toEqual(plan.beds.map((_, i) => `${plan.unit}:${i}`));
      const most = Math.max(u.stretchers.value, ...scenarios.map((s) => (s.units as Record<string, { stretchers?: number }>)[plan.unit]?.stretchers ?? 0));
      expect(plan.spots.length).toBeGreaterThanOrEqual(most);
      for (const t of [...plan.spots, ...plan.staff, plan.more]) expect(at(spec, t)).toBe(".");
      expect(new Set(plan.spots.map(key)).size).toBe(plan.spots.length);
    }
    for (const s of scenarios) {
      for (const [id, u] of Object.entries(s.units)) {
        const plan = spec.units!.find((p) => p.unit === id);
        if (plan) expect(plan.beds.length).toBe(u.beds);
      }
      if (spec.floor === 0) expect(spec.units![0].beds.length).toBe(s.er.bays);
    }
  });

  it("GF has 10 ER bays, 6 drawers, 30 corridor trolley spots and room for 40 in the waiting room", () => {
    const gf = FLOORS[slabIndex(0)];
    expect(gf.units!.find((u) => u.unit === "ER")!.beds.length).toBe(10);
    expect(gf.units!.find((u) => u.unit === "ER")!.spots.length).toBe(30);
    expect(gf.units!.find((u) => u.unit === "MORGUE")!.drawers!.length).toBe(6);
    const { chairs, standing } = gf.queue!;
    expect(chairs.length).toBe(21);
    expect(chairs.every((t) => at(gf, t) === "c")).toBe(true);
    expect(standing.every((t) => at(gf, t) === ".")).toBe(true);
    expect(chairs.length + standing.length).toBeGreaterThanOrEqual(MAX_QUEUE);
    expect(new Set([...chairs, ...standing].map(key)).size).toBe(chairs.length + standing.length);
    const waiting = gf.rooms.find((r) => r.label === "WAITING")!;
    expect([...chairs, ...standing].every(([x, y]) => x >= waiting.x0 && x <= waiting.x1 && y >= waiting.y0 && y <= waiting.y1)).toBe(true);
  });

  it("six floors bottom up, each with its units", () => {
    expect(FLOORS.map((f) => [f.floor, f === W4 ? ["W4"] : f.units!.map((u) => u.unit)])).toEqual([
      [0, ["ER", "MORGUE"]], [1, ["MED3B"]], [2, ["ICU"]], [3, ["MED3A"]], [4, ["W4"]], [5, ["SURG5A"]],
    ]);
    for (const u of UNITS) expect(FLOORS[slabIndex(u.floor)].floor, u.id).toBe(u.floor);
    expect([row("MED3B").name, row("MED3A").name, FLOORS[1].name, FLOORS[3].name]).toEqual(["Medicine 1A", "Medicine 3A", "MEDICINE 1A", "MEDICINE 3A"]);
  });

  // The monitored ward's standard: beds never side by side, a trolley's aisle (two clear tiles) beyond every foot,
  // every bed and stretcher reachable from the corridor, no stretcher across a door.
  it.each(HOSPITAL.map((f) => [f.short, f.floor, f] as const))("%s (%iF) is spaced like W4", (_, __, spec) => {
    const beds = new Set(spec.beds.flatMap((b) => [b.head, b.foot]).map(key));
    for (const t of beds) {
      const [x, y] = t.split(",").map(Number);
      expect([beds.has(key([x - 1, y])), beds.has(key([x + 1, y]))], `${spec.short} bed tile ${t} has a bed beside it`).toEqual([false, false]);
    }
    for (const b of spec.beds) {
      const d = b.north ? 1 : -1;
      expect([1, 2].map((k) => at(spec, [b.foot[0], b.foot[1] + d * k])), `${spec.short} ${b.label}'s aisle`).toEqual([".", "."]);
    }
    const open = (t: Tile) => [".", "+"].includes(at(spec, t) ?? "#");
    const seen = new Set([key([35, 8])]); // the lift, on the corridor
    const queue: Tile[] = [[35, 8]];
    while (queue.length) {
      const [x, y] = queue.shift()!;
      for (const n of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as Tile[]) if (open(n) && !seen.has(key(n))) seen.add(key(n)) && queue.push(n);
    }
    for (const b of spec.beds) expect(seen.has(key([b.foot[0], b.foot[1] + (b.north ? 1 : -1)])), `${spec.short} ${b.label} from the lift`).toBe(true);
    for (const room of spec.rooms.filter((r) => r.floor === "station")) {
      const inside = [...seen].some((k) => { const [x, y] = k.split(",").map(Number); return x >= room.x0 && x <= room.x1 && y >= room.y0 && y <= room.y1; });
      expect(inside, `${spec.short} ${room.label} from the lift`).toBe(true);
    }
    for (const p of spec.units!) for (const t of p.spots) expect([at(spec, [t[0], t[1] - 1]), at(spec, [t[0], t[1] + 1])], `${spec.short} spot ${t} at a door`).not.toContain("+");
  });

  it("every bed's nurse stand and every spot reaches the lift", () => {
    for (const spec of HOSPITAL) {
      const open = (x: number, y: number) => [".", "+"].includes(spec.map[y]?.[x] ?? "#");
      const seen = new Set([key([35, 8])]);
      const queue: Tile[] = [[35, 8]];
      while (queue.length) {
        const [x, y] = queue.shift()!;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const n: Tile = [x + dx, y + dy];
          if (open(...n) && !seen.has(key(n))) seen.add(key(n)) && queue.push(n);
        }
      }
      for (const b of spec.beds) expect(seen.has(key([b.foot[0], b.foot[1] + (b.north ? 1 : -1)])), `${spec.short} ${b.label}`).toBe(true);
      for (const p of spec.units!) for (const t of [...p.spots, ...p.staff]) expect(seen.has(key(t)), `${spec.short} ${t}`).toBe(true);
    }
  });
});

/** A hospital at minute 0 from the typical scenario, with a hand-built cast added. */
function hospital() {
  const s = createHospitalSim(createSyntheticSource(FIXTURE_SEED, true), parseScenario(typical), 101);
  const h = s.hospital!;
  const base = h.people[0];
  let n = 900000;
  const add = (patch: Partial<Person>) => {
    n += 1;
    const p: Person = { ...base, id: `h-${n}`, n, name: `Zed Q${n}`, admit: false, icuIndicated: false, w4Id: null, wants: null, slot: null, ...patch };
    h.people.push(p);
    return p;
  };
  const triages: Triage[] = ["non_urgent", "emergent", "urgent"];
  const queue = Array.from({ length: 45 }, (_, i) => add({ unit: "ER", where: "waiting", triage: triages[i % 3], arrivedMin: -(i * 7) % 50 }));
  // Free a ward bed, a ward stretcher and drawers to put the cast in known places.
  const free = (unit: UnitId, slot: number) => h.people.filter((p) => p.unit === unit && p.slot === slot).forEach((p) => (p.slot = null, p.unit = "ER", p.where = "waiting"));
  [["MED3A", 3], ["MED3A", 31], ["SURG5A", 2], ["MED3B", 0], ["MED3B", 1], ["MORGUE", 1], ["MORGUE", 7], ["ER", 12], ["ER", 50]].forEach(([u, k]) => free(u as UnitId, k as number));
  h.people.filter((p) => p.where === "waiting" && !queue.includes(p)).forEach((p) => h.people.splice(h.people.indexOf(p), 1));
  const cast = {
    bed: add({ unit: "MED3A", where: "bed", slot: 3 }),
    stretcher: add({ unit: "MED3A", where: "stretcher", slot: 31 }),
    body: add({ unit: "SURG5A", where: "awaiting_morgue", slot: 2, admit: true, icuIndicated: true }),
    icu: add({ unit: "MED3B", where: "bed", slot: 0, admit: true, icuIndicated: true }),
    notAdmitted: add({ unit: "MED3B", where: "bed", slot: 1, admit: false, icuIndicated: true }),
    drawer: add({ unit: "MORGUE", where: "morgue", slot: 1 }),
    overflow: add({ unit: "MORGUE", where: "morgue", slot: 7 }),
    trolley: add({ unit: "ER", where: "boarding", slot: 12, wants: "MED3A", admit: true }),
    beyond: add({ unit: "ER", where: "workup", slot: 50 }),
  };
  return { s, h, queue, cast };
}
const sceneOf = (h: ReturnType<typeof hospital>["h"], floor: number) => floorScene(h, FLOORS[slabIndex(floor)]);

describe("from the hospital to what is drawn", () => {
  it("puts each person in their own bed, stretcher, trolley, chair or drawer, with building.ts's marks", () => {
    const { h, cast } = hospital();
    const med = sceneOf(h, 3);
    const med1 = sceneOf(h, 1);
    const spec = FLOORS[slabIndex(3)];
    expect([med.beds.length, med1.beds.length]).toEqual([30, 30]);
    expect(med.beds.find((b) => b.slot === "hbed:MED3A:3")!.id).toBe(`h:${cast.bed.n}`);
    const st = med.spots.find((p) => p.id === `h:${cast.stretcher.n}`)!;
    expect(st.tile).toEqual(spec.units![0].spots[1]); // slot 31 = stretcher 2
    expect(med1.beds.find((b) => b.slot === "hbed:MED3B:0")!.cell!.icu).toBe(true);
    expect(icuFlag(cast.icu)).toBe(true);
    expect(med1.beds.find((b) => b.slot === "hbed:MED3B:1")!.cell!.icu).toBeUndefined(); // the ICU mark only once admitted
    // Every bed shows its occupant, or is empty and selects the bed itself.
    for (const b of [...med.beds, ...med1.beds]) {
      const p = h.people.find((x) => x.unit === b.bed.zone && x.slot === Number(b.slot.split(":")[2]));
      expect(b.id).toBe(p ? `h:${p.n}` : b.slot);
      expect(b.cell === null).toBe(!p);
    }
    const surg = sceneOf(h, 5).beds.find((b) => b.slot === "hbed:SURG5A:2")!;
    expect([surg.id, surg.cell!.dead, surg.cell!.icu]).toEqual([`h:${cast.body.n}`, true, undefined]); // a body is a body, not an ICU case
    expect(sceneOf(h, 2).beds.length).toBe(10);
    expect(sceneOf(h, 3).staff.length).toBe(h.units.filter((u) => u.floor === 3).reduce((n, u) => n + u.nurses, 0));
  });

  it("GF: the queue in seeing order, 21 seated, 40 drawn then +N; trolleys by slot; drawers and morgue overflow", () => {
    const { h, cast } = hospital();
    const gf = sceneOf(h, 0);
    const spec = FLOORS[slabIndex(0)];
    const order = seeingOrder(h);
    expect(order.length).toBe(45);
    expect(gf.queue.map((q) => q.id)).toEqual(order.slice(0, 40).map((p) => `h:${p.n}`));
    expect(gf.queue.filter((q) => q.seated).length).toBe(21);
    expect(gf.queue[0].colour).toBe("#FF6B6B"); // emergent first
    expect(gf.more).toContainEqual({ id: "queue:ER", tile: spec.queue!.more, text: "+5" });
    expect(gf.more).toContainEqual({ id: "unit:ER", tile: spec.units![0].more, text: "+1" }); // slot 50 has no corridor spot
    expect(gf.spots.find((p) => p.id === `h:${cast.trolley.n}`)!.tile).toEqual(spec.units![0].spots[2]);
    expect(gf.beds.length).toBe(10);
    expect(gf.drawers.map((d) => d.full)).toEqual(gf.drawers.map((_, i) => h.people.some((p) => p.unit === "MORGUE" && p.slot === i)));
    expect(gf.drawers[1].id).toBe(`h:${cast.drawer.n}`);
    expect(gf.drawers.filter((d) => !d.full).every((d) => d.id === "morgue")).toBe(true);
    const over = gf.spots.find((p) => p.id === `h:${cast.overflow.n}`)!;
    expect([over.unit, over.tile]).toEqual(["MORGUE", spec.units![1].spots[1]]);
  });

  it("the slab tags say one short live line", () => {
    const { h } = hospital();
    const floors = floorSummary(h);
    const tags = FLOORS.map((f) => slabTag(f, floors));
    const med = floors.find((f) => f.floor === 3)!;
    expect(tags[slabIndex(0)]).toBe("GF ER 45 waiting");
    expect(tags[slabIndex(3)]).toBe(`3F MEDICINE ${med.census}/30`);
    expect(tags[slabIndex(1)]).toBe(`1F MEDICINE ${floors.find((f) => f.floor === 1)!.census}/30`);
    expect(tags[slabIndex(2)]).toMatch(/^2F ICU \d+\/10$/);
    expect(tags[slabIndex(5)]).toMatch(/^5F SURGERY \d+\/24$/);
    expect(slabTag(FLOORS[slabIndex(3)], null)).toBe("3F MEDICINE 3A"); // no hospital: the name only
  });
});

describe("hits on a focused floor", () => {
  /** Every clickable thing of a scene but the labels, with a logical point on it. */
  type Thing = [id: string, at: [number, number], kind: string];
  function things(f: ReturnType<typeof createFloor>, scene: Scene): Thing[] {
    const out: Thing[] = [];
    for (const b of scene.beds) out.push([b.id, f.focusPoint(scene, b.id)!, b.cell ? "occupied bed" : "empty bed"]);
    for (const p of scene.spots) out.push([p.id, f.focusPoint(scene, p.id)!, `${p.unit} spot`]);
    for (const q of scene.queue) out.push([q.id, f.focusPoint(scene, q.id)!, q.seated ? "seated" : "standing"]);
    for (const d of scene.drawers) out.push([d.id, f.focusPoint(scene, d.slot)!, d.full ? "full drawer" : "empty drawer"]);
    for (const m of scene.staff) {
      const [x, y] = iso(m.tile[0] + 0.5, m.tile[1] + 0.5);
      out.push([m.id, [x, y - 10], "nurse"]);
    }
    for (const m of scene.more) {
      const [x, y] = iso(m.tile[0] + 0.5, m.tile[1] + 0.5);
      out.push([m.id, [x, y - 8], "+N"]);
    }
    return out;
  }

  it.each([0, 1, 2, 3, 5])("%iF: every bed, occupant, stretcher, trolley, queue figure, drawer, nurse and label, at zoom 1 and zoomed in", (floor) => {
    const { s, h } = hospital();
    const spec = FLOORS[slabIndex(floor)];
    const scene = sceneOf(h, floor);
    const f = createFloor(spec);
    const st = createStackRenderer(canvas(), () => floor);
    st.resize(656, 382, 1);
    st.frame(s, null, null, 0.016, 0);
    const all = things(f, scene);
    expect(all.length).toBeGreaterThan(10);
    for (const [id, [x, y]] of all) expect(st.hit(s, x, y), `${id} at zoom 1`).toBe(id);
    // A label's text can sit under a tag or a person, who then takes the click there; some of the text must still be its own.
    for (const r of spec.rooms) {
      if (!r.sel || (r.sel === "queue:ER" && scene.queue.length >= 30)) continue; // the waiting room's label is under its crowd
      const [cx, cy] = roomCentre(r);
      const own: [number, number][] = [];
      for (let dy = -5; dy <= 5; dy += 1) for (let dx = -r.label.length * 2; dx <= r.label.length * 2; dx += 1) if (st.hit(s, cx + dx, cy + dy) === r.sel) own.push([cx + dx, cy + dy]);
      expect(own.length, `${r.label}`).toBeGreaterThan(0);
      all.push([r.sel, own[Math.floor(own.length / 2)], "label"]);
    }
    // Zoomed onto one thing of each kind (labels included): the camera eases in on it and hit() follows.
    const firsts = all.filter((t, i) => all.findIndex((u) => u[2] === t[2]) === i);
    expect(firsts.map((t) => t[2]).sort()).toEqual(expect.arrayContaining(floor === 0
      ? ["ER spot", "MORGUE spot", "empty drawer", "full drawer", "label", "nurse", "occupied bed", "seated", "standing", "+N"]
      : ["label", "nurse", "occupied bed"]));
    for (const [id, [x, y]] of firsts) {
      for (let i = 0; i < 300; i += 1) st.frame(s, id, null, 0.05, i);
      const [fx, fy] = f.focusPoint(scene, id) ?? [328, 191];
      const cam = clampCam({ zoom: 2.4, x: fx, y: fy }, 656, 382, 656, 382);
      expect(st.hit(s, (x - cam.x) * 2.4 + 328, (y - cam.y) * 2.4 + 191), `${id} zoomed`).toBe(id);
    }
  });

  it("a focused floor's hits all belong to it; its ghosts take no clicks", () => {
    const { s, h } = hospital();
    for (const floor of [0, 1, 2, 3, 5]) {
      const st = createStackRenderer(canvas(), () => floor);
      st.resize(656, 382, 1);
      st.frame(s, null, null, 0.016, 0);
      for (let y = 0; y < 382; y += 4) {
        for (let x = 0; x < 656; x += 4) {
          const id = st.hit(s, x, y);
          if (!onSlab(x, y)) expect(id).toBeNull();
          else if (id) expect(floorOf(h, id), id).toBe(floor);
        }
      }
    }
  }, 30_000);
});
