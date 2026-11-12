// Display-only motion for the floors other than W4: staff pace small loops, and a person who changes place is walked or
// wheeled there (to the lift and out of it when the floor changes) instead of teleporting. Pure: scenes and the stack's
// clock in, positions out. Nothing here touches the sim or draws a random number: variety comes from ids and the clock.
import { GROUP_COLOURS, type Cell } from "../building";
import type { Tile } from "../sim/map";
import { TROLLEY_TILES_PER_S } from "./draw";
import { FLOORS } from "./floors";
import type { Scene } from "./scene";

export const LIFT: Tile = [34, 8]; // the corridor tile before the east doors, on every floor
const WALK_TILES_PER_S = 3.5;
const SNAP_OVER = 30; // more changes than this in one minute (a skip, a restart) are not walked
const DOORS = new Set([".", "+"]);

/** Where one person is drawn this minute: floor index into FLOORS. */
export interface Place { floor: number; tile: Tile; cell: Cell | null; queued: boolean; colour: string | null; body: boolean }
/** A person on their way, over one or two floors; `t0` is the clock when they set off. */
export interface Mover { id: string; legs: { floor: number; path: Tile[] }[]; t0: number; cell: Cell; walk: boolean; body: boolean; colour: string }
/** What a floor paints for a mover now. */
export interface Figure { id: string; floor: number; tile: Tile; cell: Cell; walk: boolean; body: boolean; colour: string }

export function placesOf(scenes: Scene[]): Map<string, Place> {
  const out = new Map<string, Place>();
  scenes.forEach((sc, floor) => {
    for (const b of sc.beds) if (b.cell) out.set(b.id, { floor, tile: b.bed.head, cell: b.cell, queued: false, colour: null, body: !!b.cell.dead });
    for (const p of sc.spots) out.set(p.id, { floor, tile: p.tile, cell: p.cell, queued: false, colour: null, body: !!p.cell.dead || p.unit === "MORGUE" });
    for (const q of sc.queue) out.set(q.id, { floor, tile: q.tile, cell: q.cell, queued: true, colour: q.colour, body: false });
    for (const d of sc.drawers) if (d.full) out.set(d.id, { floor, tile: d.tile, cell: null, queued: false, colour: null, body: true });
  });
  return out;
}

/** Breadth-first path over a floor's walkable tiles (".", "+"); a start or end that is furniture (a bed, a chair) is
 * joined to the nearest walkable tile within two. shortcut: no path (a sealed room) draws a straight line. */
export function route(map: string[], from: Tile, to: Tile): Tile[] {
  const ok = (x: number, y: number) => DOORS.has(map[y]?.[x] ?? "#");
  const near = (t: Tile): Tile => {
    for (let r = 0; r <= 2; r += 1)
      for (let dy = -r; dy <= r; dy += 1)
        for (const dx of [-(r - Math.abs(dy)), r - Math.abs(dy)]) if (ok(t[0] + dx, t[1] + dy)) return [t[0] + dx, t[1] + dy];
    return t;
  };
  const [a, b] = [near(from), near(to)];
  const key = ([x, y]: Tile) => y * 36 + x;
  const came = new Map<number, Tile | null>([[key(a), null]]);
  const queue: Tile[] = [a];
  for (let i = 0; i < queue.length && !came.has(key(b)); i += 1) {
    const [x, y] = queue[i];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n: Tile = [x + dx, y + dy];
      if (ok(n[0], n[1]) && !came.has(key(n))) {
        came.set(key(n), [x, y]);
        queue.push(n);
      }
    }
  }
  if (!came.has(key(b))) return [from, to];
  const path: Tile[] = [];
  for (let t: Tile | null = b; t; t = came.get(key(t)) ?? null) path.unshift(t);
  return [from, ...path, to];
}

/** The movers a change of places makes. `leaves(id)`: gone from the house or up to W4, so walked out by the lift. */
export function newMovers(prev: Map<string, Place>, now: Map<string, Place>, clock: number, leaves: (id: string) => boolean): Mover[] {
  const out: Mover[] = [];
  for (const [id, a] of prev) {
    const b = now.get(id);
    if (b ? b.floor === a.floor && b.tile[0] === a.tile[0] && b.tile[1] === a.tile[1] : !leaves(id)) continue; // there still, or unseen in a room
    const legs = !b ? [{ floor: a.floor, path: route(FLOORS[a.floor].map, a.tile, LIFT) }]
      : b.floor === a.floor ? [{ floor: a.floor, path: route(FLOORS[a.floor].map, a.tile, b.tile) }]
      : [{ floor: a.floor, path: route(FLOORS[a.floor].map, a.tile, LIFT) }, { floor: b.floor, path: route(FLOORS[b.floor].map, LIFT, b.tile) }];
    const cell = b?.cell ?? a.cell ?? { group: "minor", initials: "", sel: id, slot: 0 };
    out.push({ id, legs, t0: clock, cell, walk: a.queued || !b, body: !!(b?.body || a.body), colour: a.colour ?? GROUP_COLOURS[cell.group] });
  }
  return out.length > SNAP_OVER ? [] : out;
}

/** Where a mover is at `clock`; null once arrived. */
export function figureOf(m: Mover, clock: number): Figure | null {
  let d = (clock - m.t0) * (m.walk ? WALK_TILES_PER_S : TROLLEY_TILES_PER_S);
  for (const { floor, path } of m.legs) {
    const n = path.length - 1;
    if (d < n) {
      const j = Math.floor(d);
      const [ax, ay] = path[j];
      const [bx, by] = path[j + 1];
      return { id: m.id, floor, tile: [ax + (bx - ax) * (d - j), ay + (by - ay) * (d - j)], cell: m.cell, walk: m.walk, body: m.body, colour: m.colour };
    }
    d -= n;
  }
  return null;
}

const hash = (s: string) => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
const LOOP: Tile[] = [[0, 0], [1, 0], [1, 1], [0, 1]];

/** A staff member's tile: a step to the next corner of a small loop round their post every four seconds, after a start
 * delay from their id, so a floor's staff are never in step. */
export function walkerTile(map: string[], home: Tile, who: string, clock: number): Tile {
  const pts = LOOP.map(([dx, dy]): Tile => [home[0] + dx, home[1] + dy]).filter((p, i) => i === 0 || DOORS.has(map[p[1]]?.[p[0]] ?? "#"));
  const u = Math.max(0, clock - (hash(who) % 8)) / 4;
  const k = Math.floor(u);
  const w = Math.max(0, (u - k - 0.75) * 4); // dwell three quarters of the beat, walk the last
  const [a, b] = [pts[k % pts.length], pts[(k + 1) % pts.length]];
  return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
}

/** The scene as drawn now: staff on their loops, and anyone still on their way kept out of their destination. */
export function animate(scene: Scene, map: string[], moving: Set<string>, clock: number): Scene {
  if (scene.staff.length === 0 && moving.size === 0) return scene;
  return {
    ...scene,
    beds: scene.beds.map((b) => (b.cell && moving.has(b.cell.sel) ? { ...b, cell: null } : b)),
    spots: scene.spots.filter((p) => !moving.has(p.id)),
    queue: scene.queue.filter((q) => !moving.has(q.id)),
    drawers: scene.drawers.map((d) => (d.full && moving.has(d.id) ? { ...d, full: false } : d)),
    staff: scene.staff.map((m) => ({ ...m, tile: walkerTile(map, m.tile, `${m.id}:${m.i}`, clock) })),
  };
}
