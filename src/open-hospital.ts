// The whole hospital without a token: the open answer of each unit (beds only: label, state, rank, band), put in the shape
// the building's drawing already reads. Pure: no DOM, no storage. fetch and timers come in as parameters.
//
// What is real here and what is not:
//  - Real, from the server: which beds are taken in each unit, and each bed's NEWS2 band and rank where the unit is ranked.
//  - Not from the server: where in the unit a bed is drawn. The open answer has no positions, so beds fill the unit's
//    drawn beds in the list's order (ranked first). Figures have no name, age, group or triage: one neutral look.
//  - Never drawn: nurses outside W4, the ER queue, the morgue. The open answer does not hold them.
import { fetchOpenUnits, fetchOpenWard, OPEN_POLL_MS, OPEN_WARD, type OpenBed, type OpenRequest, type OpenUnit, type OpenWard, type Timers } from "./open-view";
import { UNITS, type UnitId } from "./sim/hospital/params";
import { fnv1a } from "./sim/hospital/rng";
import type { Hospital, Person, Unit } from "./sim/hospital/types";
import type { RunUnit } from "./sim/hospital/units";

/**
 * The server's unit list (GET /open-view) as the page uses it: only the units the building draws, each on the floor the server
 * gives it (the page's own floor when the server says "not known"). A unit the page cannot draw is left out, not guessed at.
 */
export function drawnUnits(list: OpenUnit[]): RunUnit[] {
  const out: RunUnit[] = [];
  for (const u of list) {
    const own = UNITS.find((x) => x.id === u.id && x.id !== "MORGUE");
    if (own) out.push({ id: u.id, name: u.name, floor: u.floor ?? own.floor, kind: u.kind });
  }
  return out;
}
/** A unit that answered "gone" (404: the server's run does not hold it) is asked again only this often. */
export const OPEN_RETRY_MS = 60_000;
/** Until every unit has been asked once, the next one is asked this soon, so the building fills in about a second. */
export const OPEN_FIRST_MS = 200;

/** The last valid open answer of each unit that has one. */
export type OpenViews = Record<string, OpenWard>;

/** The id a W4 bed's stub patient carries in the drawn ward (src/open-view.ts toLive). */
const W4_STUB = "open-bed:";
/** A stable number for a bed outside W4: the drawing and the panels name it `h:${n}`. */
export const bedNumber = (unit: string, bed: string) => fnv1a(`${unit}/${bed}`) >>> 1;
export const bedSel = (unit: string, bed: string) => (unit === OPEN_WARD ? W4_STUB + bed : `h:${bedNumber(unit, bed)}`);

/** Ranked beds first, in rank order; then the rest by label. The order the panel lists and the drawing fills. */
export const inOrder = (beds: OpenBed[]): OpenBed[] =>
  [...beds].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.bed.localeCompare(b.bed, "en", { numeric: true }));

function person(unit: UnitId, b: OpenBed, slot: number | null): Person {
  const n = bedNumber(unit, b.bed);
  return {
    id: `open:${unit}:${b.bed}`, n, name: "", age: 0, sex: "F", group: "minor", complaint: "", triage: "non_urgent", look: [0, 0, 0],
    patienceMin: null, admit: true, icuU: 1, icuIndicated: false, decisionMin: 0, stayMin: 0, icuStayMin: 0, dischargeHour: 0,
    erDeathAfterMin: null, deathU: 1, deathF: 1,
    arrivedMin: 0, unit, where: "bed", sinceMin: 0, slot, wants: null, seenMin: null, decideMin: null, dueMin: null, dieMin: null,
    boardedMin: 0, w4Id: unit === "W4" ? W4_STUB + b.bed : null, fromW4: false, obsDueMin: null, obsLastMin: null, course: null, visit: 1, history: [],
  };
}

/** The hospital the building draws, made from the open answers. Units the server did not answer for are drawn empty. */
export function openHospital(views: OpenViews, minute: number): Hospital {
  const units: Unit[] = UNITS.filter((u) => u.id !== "MORGUE").map((u) => ({ id: u.id, name: u.name, floor: u.floor, beds: u.beds.value, stretchers: u.stretchers.value, nurses: 0, residents: 0, obsCredit: 0 }));
  const people = units.flatMap((u) => inOrder(views[u.id]?.beds ?? []).map((b, i) => person(u.id, b, u.id === "W4" ? null : i)));
  // shortcut: only the fields the drawing and floorSummary read (units, people, gone, lastMinute); revisit if they read more.
  return { seed: 0, units, people, gone: [], lastMinute: minute } as unknown as Hospital;
}

/** NEWS2 band by the drawing's key, for every bed outside W4: a band, null for not ranked, and no entry at all in a unit that is never scored. */
export function openRisk(views: OpenViews, units: RunUnit[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [unit, w] of Object.entries(views)) {
    const kind = units.find((u) => u.id === unit)?.kind;
    if (unit === OPEN_WARD || kind === undefined || kind === "unranked") continue; // a unit the list does not name gets no colour
    for (const b of w.beds) out[`h:${bedNumber(unit, b.bed)}`] = b.risk;
  }
  return out;
}

/** The unit and bed a selection means, or null: a bed row, a click on a bed in the drawing, or W4's own stub. */
export function openBedOf(views: OpenViews, sel: string | null, units: RunUnit[]): { unit: RunUnit; bed: OpenBed } | null {
  if (sel === null) return null;
  for (const unit of units) {
    const bed = views[unit.id]?.beds.find((b) => bedSel(unit.id, b.bed) === sel || (unit.id === OPEN_WARD && sel === `bed:${b.bed}`));
    if (bed) return { unit, bed };
  }
  return null;
}

/**
 * Asks the other units in turn, one request every OPEN_POLL_MS (sooner on the first round), so a visitor costs the server
 * one extra request per poll whatever the number of units. `onUnit(id, null)`: the unit is gone (it is asked again after OPEN_RETRY_MS). A unit
 * that is down keeps its last answer. Returns stop.
 */
export function startUnitsPoll(req: Omit<OpenRequest, "ward" | "signal"> & { units: string[]; onUnit: (unit: string, body: OpenWard | null) => void; now?: () => number }): () => void {
  const timers: Timers = req.timers ?? { setTimeout: (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: (h) => globalThis.clearTimeout(h as never) };
  const now = req.now ?? (() => Date.now());
  const notBefore = new Map<string, number>();
  const ctl = new AbortController();
  let off = false;
  let at = 0;
  let asked = 0;
  let handle: unknown;
  const wait = (ms: number) => void (handle = timers.setTimeout(run, ms));
  const run = async () => {
    // The next unit that is due; none due: look again at the next poll.
    let unit: string | undefined;
    for (let i = 0; i < req.units.length && unit === undefined; i += 1) {
      const u = req.units[(at + i) % req.units.length];
      if ((notBefore.get(u) ?? 0) <= now()) {
        unit = u;
        at = (at + i + 1) % req.units.length;
      }
    }
    if (unit !== undefined) {
      asked += 1;
      const r = await fetchOpenWard({ fetch: req.fetch, base: req.base, ward: unit, timers, signal: ctl.signal });
      if (off) return;
      if (r.ok) req.onUnit(unit, r.body);
      else if (r.kind === "gone") {
        notBefore.set(unit, now() + OPEN_RETRY_MS);
        req.onUnit(unit, null);
      }
    }
    wait(asked < req.units.length ? OPEN_FIRST_MS : OPEN_POLL_MS);
  };
  if (req.units.length > 0) wait(0);
  return () => {
    off = true;
    ctl.abort();
    timers.clearTimeout(handle);
  };
}

/**
 * Asks for the run's units now and then every OPEN_RETRY_MS, so the page follows a server that starts or stops running a whole
 * hospital. `onUnits(null)`: the server has no list (404: the route is off, or the page is older than the server's run). A server
 * that is down says nothing: the last list stays. Returns stop.
 */
export function startUnitsList(req: Omit<OpenRequest, "ward" | "signal"> & { onUnits: (units: RunUnit[] | null) => void }): () => void {
  const timers: Timers = req.timers ?? { setTimeout: (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: (h) => globalThis.clearTimeout(h as never) };
  const ctl = new AbortController();
  let off = false;
  let handle: unknown;
  const run = async () => {
    const r = await fetchOpenUnits({ fetch: req.fetch, base: req.base, timers, signal: ctl.signal });
    if (off) return;
    if (r.ok) req.onUnits(drawnUnits(r.body));
    else if (r.kind === "gone") req.onUnits(null);
    handle = timers.setTimeout(run, OPEN_RETRY_MS);
  };
  handle = timers.setTimeout(run, 0);
  return () => {
    off = true;
    ctl.abort();
    timers.clearTimeout(handle);
  };
}
