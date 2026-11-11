// Hospital mode: ward W4 inside the hospital. The page and the runner stay ward-only; this is switched on only by calling
// createHospitalSim. Hospital mode and API sync never run together in v1 (sim.ts w4Port throws when an outbox exists).
//
// Decisions made in H3 (the design is silent on them):
//  - A W4 patient waiting for the ICU leaves W4 in movePatients and is placed in step 3 of the next stepHospital, but the bed
//    is claimed only when icuFree shows one, which is counted after the ER's placements of the previous minute. So W4's
//    waiters have the lowest ICU priority and can wait a long time when the ICU is busy. A departure the design does not set.
//  - w4Port's outbox refusal fires at the first minute boundary, AFTER sync's register and first flush would already have
//    posted W4's rows. So the page (H5) must never start sync for a hospital world, and the runner refuses a hospital state
//    file before sync starts (refuseHospitalState, used by src/headless.ts).
//  - W4 occupancy in hospital mode is steady-state about 50% under typical and 25-35% under doh-standard (measured by the
//    H3 reviewer over 30 days, seeds 101 and 202), below ward-only's 75%: cardiac arrivals are arrivals x 0.10 x the non-ICU
//    admit share. The ER doctor cap does not bind. No parameter is changed in this slice.
//  - The hospital steps from minute 1, as W4's own flow does.
import { createSim, type Sim } from "../sim";
import type { VitalsSource } from "../source";
import { drawPerson } from "./people";
import type { Scenario } from "./scenario";
import { createHospital } from "./step";
import type { Sex } from "./types";

// W4's patients at minute 0 are numbered apart from arrivals (from 1) and the other residents (from 1,000,001).
const W4_BASE = 2_000_000;

/** A ward with patient flow, inside a new hospital. W4's 12 patients at minute 0 become hospital persons on W4. */
export function createHospitalSim(src: VitalsSource, scenario: Scenario, seed: number): Sim {
  if (!src.admit) throw new Error("Hospital mode needs a ward source with patient flow");
  const s = createSim(src);
  const h = createHospital(seed, scenario);
  let k = 0;
  for (const p of s.patients) {
    let d = drawPerson(seed, W4_BASE + (k += 1));
    while (d.group !== "cardiac") d = drawPerson(seed, W4_BASE + (k += 1)); // their stay draws are a cardiac person's
    h.people.push({
      ...d, name: p.name, age: typeof p.age === "number" ? p.age : d.age, sex: p.sex as Sex, admit: true, icuIndicated: false,
      arrivedMin: 0, unit: "W4", where: "bed", sinceMin: 0, slot: null, wants: null, seenMin: null, decideMin: null,
      dueMin: null, dieMin: null, boardedMin: 0, w4Id: p.id, fromW4: false,
    });
    h.createdCount += 1;
  }
  s.hospital = h;
  return s;
}

/** Why the ward-only runner must not continue a saved state, or null: the runner syncs to the API, hospital mode never does in v1. */
export const refuseHospitalState = (s: Sim): string | null =>
  s.hospital ? "state file holds a hospital; the runner is ward-only in this version" : null;
