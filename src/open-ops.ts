// The Hospital operations panel while the page watches the server: what can be counted from the open views, and nothing
// else. The open views name each bed in use and its NEWS2 band; they hold no nurse, no waiting time, no transfer and no bed
// count. Bed counts are this page's own copy of the simulator's unit table (the drawing uses the same copy), and the panel
// says so. Every line a unit is read against carries what kind of source it is: a study and an unconfirmed figure are never
// called a rule. Sources: the orchestrator's operations references, 16 Nov 2026.
import type { OpenViews } from "./open-hospital";
import { UNITS } from "./sim/hospital/params";
import type { RunUnit } from "./sim/hospital/units";

/** Bed occupancy of an acute hospital. Bagust, Place and Posnett, BMJ 1999;319:155: a simulation study, not a standard. */
export const OCCUPANCY = { amberAbove: 85, redFrom: 90, tag: "Bagust 1999 (BMJ), a simulation study, not a rule" } as const;
/** Intensive care use. The DOH's 2021 COVID-19 tiers, seen in news reports only: the issuing order was not confirmed. */
export const ICU_USE = { moderateFrom: 60, highFrom: 70, criticalFrom: 85, tag: "DOH 2021 COVID-19 tiers, source not confirmed" } as const;
/** An emergency room has no agreed crowding number: the panel only counts patients against the bays it was built with. */
export const ER_TAG = "no agreed standard: patients against built bays";
/** NEWS2 total 7 or more is the RCP's emergency trigger (its clinical response table). */
export const HIGH_TAG = "RCP NEWS2 clinical response: a total of 7 or more is the emergency trigger";

export interface OpsUnit {
  id: string; name: string; floor: number; kind: RunUnit["kind"];
  /** Beds in use as the server's open view lists them; null when that unit has not answered. */
  inUse: number | null;
  /** This page's copy of the unit's bed count. */
  beds: number;
  /** In use, as a whole percent of the beds. */
  pct: number | null;
  /** What the percent is read against, in words; null when nothing is passed or nothing is known. */
  flag: string | null;
  /** Beds at NEWS2 high risk (7 or more) and medium risk. Null where the unit is not scored or has not answered. */
  high: number | null; medium: number | null;
}
export interface Ops { units: OpsUnit[]; inUse: number; beds: number; pct: number | null; flag: string | null; issues: string[]; tags: { occupancy: string; icu: string; er: string; high: string } }

const wardFlag = (pct: number) => (pct >= OCCUPANCY.redFrom ? `${OCCUPANCY.redFrom}% or more` : pct > OCCUPANCY.amberAbove ? `above ${OCCUPANCY.amberAbove}%` : null);
const icuFlag = (pct: number) => (pct >= ICU_USE.criticalFrom ? "critical tier" : pct >= ICU_USE.highFrom ? "high tier" : pct >= ICU_USE.moderateFrom ? "moderate tier" : null);

/** Counts for the units the server's list names, top floor first. A unit this page has no bed count for is left out. */
export function openOps(units: RunUnit[], views: OpenViews): Ops {
  const rows: OpsUnit[] = [];
  for (const u of [...units].sort((a, b) => b.floor - a.floor)) {
    const beds = UNITS.find((x) => x.id === u.id)?.beds.value;
    if (!beds) continue;
    const view = views[u.id];
    const inUse = view ? view.beds.length : null;
    const pct = inUse === null ? null : Math.round((100 * inUse) / beds);
    const flag = pct === null ? null : u.id === "ER" ? (inUse! > beds ? "over its bays" : null) : u.kind === "unranked" ? icuFlag(pct) : wardFlag(pct);
    const scored = view && u.kind === "ranked";
    rows.push({ id: u.id, name: u.name, floor: u.floor, kind: u.kind, inUse, beds, pct, flag, high: scored ? view.beds.filter((b) => b.risk === "high").length : null, medium: scored ? view.beds.filter((b) => b.risk === "medium").length : null });
  }
  // The whole house: inpatient units that answered. The emergency room is counted against bays, not beds, so it is left out.
  const wards = rows.filter((r) => r.id !== "ER" && r.inUse !== null);
  const inUse = wards.reduce((n, r) => n + r.inUse!, 0);
  const beds = wards.reduce((n, r) => n + r.beds, 0);
  const pct = beds ? Math.round((100 * inUse) / beds) : null;
  const issues: string[] = [];
  for (const r of rows) {
    if (!r.flag) continue;
    if (r.id === "ER") issues.push(`${r.name}: ${r.inUse} patients for ${r.beds} bays (${ER_TAG})`);
    else if (r.kind === "unranked") issues.push(`${r.name}: ${r.pct}% of beds in use, ${r.flag} (${ICU_USE.tag})`);
    else issues.push(`${r.name}: ${r.pct}% of beds in use, ${r.flag} (${OCCUPANCY.tag})`);
  }
  const high = rows.filter((r) => r.high);
  if (high.length) issues.push(`NEWS2 7 or more outside intensive care: ${high.map((r) => `${r.name} ${r.high}`).join(", ")} (${HIGH_TAG})`);
  return { units: rows, inUse, beds, pct, flag: pct === null ? null : wardFlag(pct), issues, tags: { occupancy: OCCUPANCY.tag, icu: ICU_USE.tag, er: ER_TAG, high: HIGH_TAG } };
}
