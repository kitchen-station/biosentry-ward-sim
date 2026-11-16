// The units of a hospital run, as POST /sim/runs takes them (hospital-contract v1, section 2). Names and floors come from the
// hospital's own table. W4 is first: it is the run's home unit, so every body that names no unit (W4's patients, its view, its
// commands) means W4, as the ward-only runner always sent. The morgue is not a unit: a death is a stay ending.
import { UNITS } from "./params";

export interface RunUnit { id: string; name: string; floor: number; kind: "ranked" | "shown" | "unranked"; /** How to read this unit's NEWS2: one line the API serves with the unit. */ score_note?: string }

const KIND: Record<string, RunUnit["kind"]> = { ICU: "unranked" };
/**
 * Owner decision orch-h10 (er-aid): the emergency room is ranked, and says how to read its NEWS2. The words are the
 * decision's own, from the NEWS2 use research note (RCP 2017/2020; emergency department studies). Not to be reworded here.
 */
export const ER_SCORE_NOTE = "NEWS2 used as an aid: evidence in the emergency department is mixed (RCP 2017/2020; studies AUROC 0.59-0.88).";
const NOTE: Record<string, string> = { ER: ER_SCORE_NOTE };

export const RUN_UNITS: RunUnit[] = [...UNITS]
  .filter((u) => u.id !== "MORGUE")
  .sort((a, b) => Number(b.id === "W4") - Number(a.id === "W4"))
  .map((u) => ({ id: u.id, name: u.name, floor: u.floor, kind: KIND[u.id] ?? "ranked", ...(NOTE[u.id] && { score_note: NOTE[u.id] }) }));
