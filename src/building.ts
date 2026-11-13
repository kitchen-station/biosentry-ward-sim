// The hospital around W4, summed up per floor and unit. floorSummary is the only place the numbers are computed, so the
// panels, the floor rail's names and the stack agree.
import { PARAMS, type Group, type Triage, type UnitId } from "./sim/hospital/params";
import type { Hospital, Person } from "./sim/hospital/types";

export const GROUP_COLOURS: Record<Group, string> = {
  cardiac: "#FF6B6B", stroke: "#6C8EF5", hypertensive: "#FFA07A", respiratory: "#4ECDC4",
  infection: "#6BCF7F", trauma: "#FFD93D", minor: "#A899B5",
};
export const TRIAGE_COLOURS: Record<Triage, string> = { emergent: "#FF6B6B", urgent: "#FFD93D", non_urgent: "#6BCF7F" };
const TRIAGE_RANK: Record<Triage, number> = { emergent: 0, urgent: 1, non_urgent: 2 };

// sel: what a click selects (a W4 patient keeps the ward's own id); slot: the bed slot, or W4's bed index.
export interface Cell { group: Group; initials: string; sel: string; slot: number; risk?: string | null; dead?: boolean; icu?: boolean } // risk: NEWS2 risk, null = not ranked, undefined = none shown (intensive care, bodies)
export interface UnitSummary {
  id: UnitId; name: string; beds: (Cell | null)[]; stretchers: (Cell | null)[]; over: Cell[]; // over: ER trolleys, morgue overflow
  census: number; bodies: number; nurses: number; occupancyPct: number | null; ratio: number | null;
  queue: Triage[]; consult: number; workup: number; boarders: { to: string; hours: number }[]; // ER only
  waiting: Cell[]; boarderCells: Cell[]; // ER only: the same people as queue and boarders, in the same order
}
export interface FloorSummary {
  floor: number; label: string; name: string; units: UnitSummary[];
  census: number; capacity: number; occupancyPct: number | null; nurses: number; ratio: number | null;
  baysUsed: number; erCount: number; // GF: people holding a bay, and everyone in the ER including the waiting room
  boarders: number;            // GF: everyone boarding in the ER; upper floors: boarding people who want a bed here
  deathsToday: number | null;  // GF only (house-wide): a body's own floor is not kept once it reaches the morgue
  awaitingMorgue: number;
}

/** ICU-indicated and no ICU bed: only once the person is admitted and boarding or placed. Before the decision it is a pre-drawn fate. */
export const icuFlag = (p: Person) => p.admit && p.icuIndicated && p.unit !== "ICU" && (p.where === "boarding" || p.where === "bed" || p.where === "stretcher");
/** The waiting room in the order doctors take it: triage first, then arrival time, then arrival number. */
export const seeingOrder = (h: Hospital): Person[] =>
  h.people.filter((p) => p.where === "waiting").sort((a, b) => TRIAGE_RANK[a.triage] - TRIAGE_RANK[b.triage] || a.arrivedMin - b.arrivedMin || a.n - b.n);

const initialsOf = (name: string) => name.split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
const cellOf = (p: Person, risk: Record<string, string | null>, slot = p.slot ?? 0): Cell => {
  const c: Cell = { group: p.group, initials: initialsOf(p.name), slot, sel: p.unit === "W4" && p.w4Id !== null ? p.w4Id : `h:${p.n}` };
  if (p.w4Id !== null) c.risk = Object.hasOwn(risk, p.w4Id) ? risk[p.w4Id] : null;
  else if (Object.hasOwn(risk, c.sel)) c.risk = risk[c.sel]; // outside W4: by click key `h:${n}` (vitals engine; no intensive care)
  if (p.where === "awaiting_morgue") c.dead = true; // still holds its bed until the body leaves
  else if (icuFlag(p)) c.icu = true;
  return c;
};
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : null);
const ratioOf = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10) / 10 : null);
const FLOOR_NAMES: Record<number, string> = { 0: "Ground floor" };

/** Every number the strips and boards show. `w4Risk`: NEWS2 risk by W4 patient id, and by `h:${n}` for people outside W4; null when not ranked. */
export function floorSummary(h: Hospital, w4Risk: Record<string, string | null> = {}): FloorSummary[] {
  const START = PARAMS.clock.startMinuteOfDay.value;
  const day = (m: number) => Math.floor((m + START) / 1440);
  const today = day(Math.max(0, h.lastMinute));
  const bodies = (p: Person) => p.where === "awaiting_morgue" || p.where === "morgue";
  // gone holds released bodies (the morgue frees drawers), so a death earlier today may live only there.
  const deaths = [...h.people, ...h.gone].filter((p) => bodies(p) && p.dieMin !== null && day(p.dieMin) === today).length;
  const inEr = (p: Person) => p.where === "waiting" || p.where === "consult" || p.where === "workup" || p.where === "boarding";

  const units = h.units.map((u): UnitSummary => {
    const here = h.people.filter((p) => p.unit === u.id);
    const placed = here.filter((p) => p.slot !== null).sort((a, b) => a.slot! - b.slot!);
    const stay = u.id === "ER" ? here.filter(inEr) : u.id === "MORGUE" ? here.filter((p) => p.where === "morgue") : here.filter((p) => (p.slot !== null || p.w4Id !== null) && p.where !== "awaiting_morgue"); // bodies are not patients
    const slots = (lo: number, hi: number) => Array.from({ length: hi - lo }, (_, i) => { const p = placed.find((x) => x.slot === lo + i); return p ? cellOf(p, w4Risk) : null; });
    const w4 = u.id === "W4" ? here.map((p, i) => cellOf(p, w4Risk, i)) : null;
    const er = u.id === "ER";
    const waiting = er ? seeingOrder(h) : [];
    const lastMin = Math.max(0, h.lastMinute);
    return {
      id: u.id, name: u.name,
      beds: w4 ? Array.from({ length: u.beds }, (_, i) => w4[i] ?? null) : slots(0, u.beds), // W4's own bed labels are not in the hospital's slots
      stretchers: slots(u.beds, u.beds + u.stretchers),
      over: placed.filter((p) => p.slot! >= u.beds + u.stretchers).map((p) => cellOf(p, w4Risk)),
      census: stay.length, bodies: here.filter((p) => p.where === "awaiting_morgue").length, nurses: u.nurses,
      occupancyPct: pct(stay.length, u.beds), ratio: ratioOf(stay.length, u.nurses),
      queue: waiting.map((p) => p.triage),
      consult: here.filter((p) => p.where === "consult").length, workup: here.filter((p) => p.where === "workup").length,
      boarders: here.filter((p) => p.where === "boarding").map((p) => ({ to: p.wants ?? "?", hours: Math.floor((lastMin - p.sinceMin) / 60) })),
      waiting: waiting.map((p) => cellOf(p, w4Risk)), boarderCells: here.filter((p) => p.where === "boarding").map((p) => cellOf(p, w4Risk)),
    };
  });

  const floors = [...new Set(h.units.map((u) => u.floor))].sort((a, b) => b - a);
  return floors.map((floor): FloorSummary => {
    const us = units.filter((u) => h.units.find((x) => x.id === u.id)!.floor === floor);
    const care = us.filter((u) => u.id !== "MORGUE"); // the morgue has no nurses and no beds to fill
    const er = us.find((u) => u.id === "ER");
    const census = care.reduce((n, u) => n + u.census, 0);
    const capacity = care.reduce((n, u) => n + u.beds.length, 0);
    const nurses = care.reduce((n, u) => n + u.nurses, 0);
    const wanted = new Set<string>(us.map((u) => u.id));
    const boarders = floor === 0
      ? us.find((u) => u.id === "ER")?.boarders.length ?? 0
      : h.people.filter((p) => p.where === "boarding" && p.wants !== null && wanted.has(p.wants)).length;
    return {
      floor, label: floor === 0 ? "GF" : `${floor}F`, name: FLOOR_NAMES[floor] ?? `Floor ${floor}`, units: us,
      census, capacity, occupancyPct: pct(census, capacity), nurses, ratio: ratioOf(census, nurses),
      boarders, deathsToday: floor === 0 ? deaths : null,
      baysUsed: er ? er.beds.filter(Boolean).length : 0, erCount: er ? er.census : 0,
      awaitingMorgue: h.people.filter((p) => p.where === "awaiting_morgue" && (floor === 0 || us.some((u) => u.id === p.unit))).length, // GF: house-wide
    };
  });
}

/** A floor's spoken summary: starts with the visible label. */
export function floorName(f: FloorSummary): string {
  if (f.floor === 0) {
    const er = f.units.find((u) => u.id === "ER")!;
    return `${f.label}: ${er.name}, ${er.queue.length} waiting, ${f.boarders} boarding`;
  }
  return `${f.label}: ${f.units.map((u) => u.name).join(" and ")}, ${f.census} patients, ${f.occupancyPct ?? 0}% of beds occupied, ${f.boarders} boarding in ER for here`;
}

const cellTitle = (c: Cell, monitored: boolean) => (c.dead ? "died, awaiting transfer to the morgue" : c.icu ? `${c.initials}, ${c.group}: ICU-indicated, no ICU bed was free` : monitored ? `${c.initials}, ${c.risk ? `NEWS2 risk ${c.risk}` : "not ranked"}` : `${c.initials}, ${c.group}`);

/** "Bed 12", "Stretcher 3", "Bay 2", "Trolley 1", "Drawer 4": what a slot is called in its unit. */
export function slotName(id: UnitId, beds: number, stretchers: number, slot: number): string {
  if (slot < beds) return `${id === "ER" ? "Bay" : id === "MORGUE" ? "Drawer" : "Bed"} ${slot + 1}`;
  if (id === "ER") return `Trolley ${slot - beds + 1}`;
  return slot < beds + stretchers ? `Stretcher ${slot - beds + 1}` : `Overflow ${slot - beds - stretchers + 1}`;
}
export const cellLabel = (u: UnitSummary, c: Cell | null, slot: number, monitored: boolean) =>
  `${slotName(u.id, u.beds.length, u.stretchers.length, slot)}, ${u.name}: ${c ? cellTitle(c, monitored) : "empty"}`;
