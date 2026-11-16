// The units of a hospital run, as POST /sim/runs takes them (hospital-contract v1, section 2). Names and floors come from the
// hospital's own table. W4 is first: it is the run's home unit, so every body that names no unit (W4's patients, its view, its
// commands) means W4, as the ward-only runner always sent. The morgue is not a unit: a death is a stay ending.
import { UNITS } from "./params";

export interface RunUnit { id: string; name: string; floor: number; kind: "ranked" | "shown" | "unranked" }

const KIND: Record<string, RunUnit["kind"]> = { ER: "shown", ICU: "unranked" };

export const RUN_UNITS: RunUnit[] = [...UNITS]
  .filter((u) => u.id !== "MORGUE")
  .sort((a, b) => Number(b.id === "W4") - Number(a.id === "W4"))
  .map((u) => ({ id: u.id, name: u.name, floor: u.floor, kind: KIND[u.id] ?? "ranked" }));
