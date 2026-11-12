// What a hospital floor shows this minute: who is in which bed, stretcher, trolley, chair or drawer, and the "+N"s.
// Pure: the hospital state in, tiles and ids out. The cells (initials, group, dead, icu) are building.ts's own, so the
// floor and the panels follow the same rules. Outside W4 nothing drawn suggests a clinical score.
import { floorSummary, TRIAGE_COLOURS, type Cell, type FloorSummary } from "../building";
import type { Bed, Tile } from "../sim/map";
import type { UnitId } from "../sim/hospital/params";
import type { Hospital } from "../sim/hospital/types";
import type { FloorSpec } from "./floors";

export interface Placed { id: string; slot: string; tile: Tile; cell: Cell } // slot: the place's own id, `hbed:<unit>:<slot>`
export interface Scene {
  beds: { bed: Bed; id: string; slot: string; cell: Cell | null }[]; // every authorised bed with a tile
  spots: (Placed & { unit: UnitId })[]; // stretchers, ER trolleys (boarders among them), morgue overflow
  queue: (Placed & { seated: boolean; colour: string })[]; // seeing order
  drawers: { id: string; slot: string; tile: Tile; full: boolean }[];
  staff: { id: string; tile: Tile; i: number }[];
  more: { id: string; tile: Tile; text: string }[];
}

export const MAX_QUEUE = 40;
export const EMPTY: Scene = { beds: [], spots: [], queue: [], drawers: [], staff: [], more: [] };

/** The scene of one floor. `floors` is floorSummary(h), passed in so a frame computes it once for all floors. */
export function floorScene(h: Hospital | undefined, spec: FloorSpec, floors: FloorSummary[] = h ? floorSummary(h) : []): Scene {
  if (!h || !spec.units) return EMPTY;
  const scene: Scene = { beds: [], spots: [], queue: [], drawers: [], staff: [], more: [] };
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
      } else if (slot < plan.beds.length) scene.beds.push({ bed: plan.beds[slot], id: cell?.sel ?? slotId(slot), slot: slotId(slot), cell });
      else if (cell) extra += 1;
    });
    for (const cell of [...u.stretchers, ...u.over]) {
      if (!cell) continue;
      const tile = plan.spots[cell.slot - u.beds.length]; // a slot keeps its spot while others come and go
      if (tile) scene.spots.push({ id: cell.sel, slot: slotId(cell.slot), tile, cell, unit: plan.unit });
      else extra += 1;
    }
    if (extra > 0) scene.more.push({ id: plan.unit === "MORGUE" ? "morgue" : `unit:${plan.unit}`, tile: plan.more, text: `+${extra}` });
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
