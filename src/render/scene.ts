// What a hospital floor shows this minute: who is in which bed, stretcher, trolley, chair or drawer, and the "+N"s.
// Pure: the hospital state in, tiles and ids out. The cells (initials, group, dead, icu) are building.ts's own, so the
// floor and the panels follow the same rules. A cell outside W4 and intensive care may carry a NEWS2 risk (from the vitals engine, display only); the waiting room keeps its triage colours.
import { floorSummary, TRIAGE_COLOURS, type Cell, type FloorSummary } from "../building";
import type { Bed, Tile } from "../sim/map";
import type { UnitId } from "../sim/hospital/params";
import { noticedLateMin, overdueRounds } from "../sim/hospital/step";
import type { Hospital } from "../sim/hospital/types";
import type { FloorSpec } from "./floors";

export interface Placed { id: string; slot: string; tile: Tile; cell: Cell } // slot: the place's own id, `hbed:<unit>:<slot>`
export interface Scene {
  beds: { bed: Bed; id: string; slot: string; cell: Cell | null; late: boolean }[]; // every authorised bed with a tile; late: its patient's deterioration was noticed late, within LATE_MARK_MIN
  spots: (Placed & { unit: UnitId })[]; // stretchers, ER trolleys (boarders among them), morgue overflow
  queue: (Placed & { seated: boolean; colour: string })[]; // seeing order
  drawers: { id: string; slot: string; tile: Tile; full: boolean }[];
  staff: { id: string; tile: Tile; i: number }[];
  more: { id: string; tile: Tile; text: string }[];
  overdue: { id: string; tile: Tile; text: string }[]; // one marker per unit with a round overdue now
}
export const LATE_MARK_MIN = 360; // a "noticed late" mark stays 6 sim hours from the notice

export const MAX_QUEUE = 40;
export const EMPTY: Scene = { beds: [], spots: [], queue: [], drawers: [], staff: [], more: [], overdue: [] };

/** The scene of one floor. `floors` is floorSummary(h), passed in so a frame computes it once for all floors. */
export function floorScene(h: Hospital | undefined, spec: FloorSpec, floors: FloorSummary[] = h ? floorSummary(h) : []): Scene {
  if (!h || !spec.units) return EMPTY;
  const scene: Scene = { beds: [], spots: [], queue: [], drawers: [], staff: [], more: [], overdue: [] };
  const minute = Math.max(0, h.lastMinute);
  // Noticed late and still fresh. Only a notice that has happened is here: an onset nobody has noticed leaves no trace.
  // shortcut: the sim keeps course.noticedMin, not a "noticed at" event time on the person; the notice minute is the same number.
  const fresh = new Set(h.people.filter((p) => p.course?.noticedMin != null && minute - p.course.noticedMin < LATE_MARK_MIN && noticedLateMin(p) !== null).map((p) => `h:${p.n}`));
  const summary = floors.find((f) => f.floor === spec.floor);
  for (const plan of spec.units) {
    const u = summary?.units.find((x) => x.id === plan.unit);
    const unit = h.units.find((x) => x.id === plan.unit);
    if (!u || !unit) continue;
    const slotId = (slot: number) => `hbed:${plan.unit}:${slot}`;
    let extra = 0;
    // shortcut: maps fit the shipped scenarios' bed counts; a scenario with more beds than tiles shows the rest as "+N"
    u.beds.forEach((cell, slot) => {
      if (plan.drawers) {
        if (slot < plan.drawers.length) scene.drawers.push({ id: cell?.sel ?? "morgue", slot: slotId(slot), tile: plan.drawers[slot], full: cell !== null });
        else if (cell) extra += 1;
      } else if (slot < plan.beds.length) scene.beds.push({ bed: plan.beds[slot], id: cell?.sel ?? slotId(slot), slot: slotId(slot), cell, late: cell !== null && fresh.has(cell.sel) });
      else if (cell) extra += 1;
    });
    for (const cell of [...u.stretchers, ...u.over]) {
      if (!cell) continue;
      const tile = plan.spots[cell.slot - u.beds.length]; // a slot keeps its spot while others come and go
      if (tile) scene.spots.push({ id: cell.sel, slot: slotId(cell.slot), tile, cell, unit: plan.unit });
      else extra += 1;
    }
    if (extra > 0) scene.more.push({ id: plan.unit === "MORGUE" ? "morgue" : `unit:${plan.unit}`, tile: plan.more, text: `+${extra}` });
    const due = overdueRounds(h, plan.unit, minute); // once per unit per minute: this scene is made once a minute
    if (due && due.count > 0 && plan.staff[0]) scene.overdue.push({ id: `unit:${plan.unit}`, tile: plan.staff[0], text: `${due.count} late` });
    plan.staff.slice(0, unit.nurses).forEach((tile, i) => scene.staff.push({ id: `unit:${plan.unit}`, tile, i }));
  }
  const er = summary?.units.find((x) => x.id === "ER");
  if (spec.queue && er) {
    const { chairs, standing, more } = spec.queue;
    const places = [...chairs, ...standing].slice(0, MAX_QUEUE);
    er.waiting.forEach((cell, i) => {
      if (i < places.length) scene.queue.push({ id: cell.sel, slot: "queue:ER", tile: places[i], cell, seated: i < chairs.length, colour: TRIAGE_COLOURS[er.queue[i]] });
    });
    if (er.waiting.length > places.length) scene.more.push({ id: "queue:ER", tile: more, text: `+${er.waiting.length - places.length}` });
  }
  return scene;
}

/** The slab's tag in the stack: one short live line. */
export function slabTag(spec: FloorSpec, floors: FloorSummary[] | null): string {
  const label = spec.floor === 0 ? "GF" : `${spec.floor}F`;
  const f = floors?.find((x) => x.floor === spec.floor);
  if (!f) return `${label} ${spec.name}`;
  if (spec.floor === 0) return `${label} ${spec.short} ${f.units.find((u) => u.id === "ER")?.queue.length ?? 0} waiting`;
  return `${label} ${spec.short} ${f.census}/${f.capacity}`;
}
