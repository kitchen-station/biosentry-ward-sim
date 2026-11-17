// Publishes the hospital vitals engine's people outside W4 as the API's patients: one stay per unit, each with the hospital
// person's id (hospital-contract v1, sections 2 and 3). Read-only: it reads the engine and the hospital, writes only the
// outbox, and draws no random number. W4's own people are sent by the ward and are not touched here.
//
//  - A person seen outside W4 gets a stay (an admission row with the unit, the person, one of that unit's two staff nurses
//    and its physician: src/sim/hospital/staff.ts). The API adds the unit's charge nurse by itself.
//  - A move is the old stay ending `transferred` with `to_unit`, then a new stay with a new id. The new row carries the
//    person's recent 15-minute values (the engine's own history), so the chart goes on. Moves into W4 end the old stay;
//    the W4 half is the ward's own admission.
//  - A person who leaves is `discharged`; a person who dies is `died`.
//  - The engine is display only: nothing sent here changes care, and a dashboard action on one of these stays changes nothing.
import { patientRow, record, type Outbox, type PublishedStay, type Sim } from "../sim";
import { VITALS } from "../source";
import { assigned } from "./staff";
import type { HospitalVitals } from "./vitals";

const STORY = "Synthetic hospital person from the vitals engine; display only.";
const CODES = [...VITALS, "blood_pressure", "consciousness", "supplemental_o2", "spo2_scale"];

function close(out: Outbox, rec: PublishedStay, minute: number, how: { outcome: "discharged" | "died" } | { outcome: "transferred"; to_unit: string }) {
  if (!rec.id) return;
  out.departures.push({ patient_id: rec.id, minute, ...how });
  for (const code of CODES) out.sent.delete(`${rec.id}/${code}`); // the stay is over: its last values are not needed
}

/** Call after feedVitals, with the world's engine. Does nothing without an outbox (no sync) or before the engine's first sync. */
export function publishHospital(s: Sim, v: HospitalVitals): void {
  const out = s.outbox;
  const h = s.hospital;
  if (!out || !h || v.at === null) return;
  const stays = (out.stays ??= {});
  const minute = v.at;
  for (const pv of v.live.values()) {
    let rec: PublishedStay | undefined = stays[pv.id];
    let k = 0;
    if (rec && (rec.visit !== pv.visit || rec.unit !== pv.unit)) {
      k = rec.k + 1;
      close(out, rec, minute, rec.visit !== pv.visit ? { outcome: "discharged" } : { outcome: "transferred", to_unit: pv.unit });
      rec = undefined;
    }
    if (!rec) {
      if (pv.unit === "W4") { stays[pv.id] = { id: null, unit: "W4", visit: pv.visit, reads: pv.reads, k }; continue; }
      const q = h.people.find((x) => x.id === pv.id);
      const id = `${pv.id}.${pv.visit}.${k}`;
      // The bed label is the person's own number: a slot changes while a stay is open and is reused by others, so it is not a safe label.
      const who = assigned(pv.unit, pv.n); // one of the unit's two staff nurses, and its physician
      const copy = { ...pv.p, id, bed: `${pv.unit}-${pv.n}`, rn: who.rn, listMd: who.md, context: q?.complaint ?? "", story: STORY };
      out.admissions.push({ ...patientRow(copy, [], minute - (minute % 15)), person: pv.id, unit: pv.unit, minute });
      record(s, copy, pv.next - 1);
      stays[pv.id] = { id, unit: pv.unit, visit: pv.visit, reads: pv.reads, k };
    } else if (rec.id && pv.reads !== rec.reads) {
      const m = pv.next - 1; // the minute of the latest read: a jump of reads sends the latest only
      record(s, { ...pv.p, id: rec.id }, m);
      if (m % 15 === 0) for (const vital of VITALS) out.bins.push({ patient_id: rec.id, vital, minute: m, value: pv.p.history[vital].at(-1) ?? null });
      rec.reads = pv.reads;
    }
  }
  for (const [person, rec] of Object.entries(stays)) {
    if (v.live.has(person)) continue;
    const q = h.people.find((x) => x.id === person) ?? h.gone.find((x) => x.id === person);
    if (q?.unit === "W4" && q.where !== "awaiting_morgue" && q.where !== "morgue") {
      // On W4, whose rows the ward sends. A new engine (after a restart) opens no stream for them, so there is no stream to match:
      // keep the record, and its counter, so their next stay gets a new id. Any stay still open ends here as a move into W4.
      if (rec.id) { close(out, rec, minute, { outcome: "transferred", to_unit: "W4" }); stays[person] = { id: null, unit: "W4", visit: rec.visit, reads: 0, k: rec.k + 1 }; }
      continue;
    }
    close(out, rec, minute, { outcome: q?.where === "awaiting_morgue" || q?.where === "morgue" ? "died" : "discharged" });
    delete stays[person];
  }
}
