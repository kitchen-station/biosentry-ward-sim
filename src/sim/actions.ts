// What clinicians did on the BioSentry dashboard, applied to the running ward. Pure: the runner
// reads the feed (src/sim/sync.ts) and calls applyAction between ticks.

import { BEDS } from "./map";
import type { Acvpu } from "./news2";
import { applyPatch, chart, minuteOf, place, recordBp, say, STAFF, type Sim } from "./sim";
import type { VitalsSource } from "./source";

/** One row of GET /sim/runs/{run_id}/actions. A field that does not apply to the kind is null. */
export interface Action {
  seq: number;
  kind: "acknowledge" | "record_vitals" | "add_note" | "admit_patient";
  patient_id: string;
  clinician_id: string;
  score: number | null;
  systolic: number | null;
  diastolic: number | null;
  acvpu: Acvpu | null;
  on_oxygen: boolean | null;
  spo2_scale: 1 | 2 | null;
  name: string | null;
  age: number | string | null;
  sex: string | null;
  bed: string | null;
  context: string | null;
}

const bpOf = (a: Action) => (a.systolic !== null && a.diastolic !== null ? { systolic: a.systolic, diastolic: a.diastolic } : null);

function admit(s: Sim, src: VitalsSource, a: Action, who: (typeof STAFF)[number] | undefined) {
  if (!src.admit || s.patients.some((p) => p.id === a.patient_id)) return;
  const name = a.name ?? a.patient_id;
  const label = (a.bed ?? "").trim().toLowerCase();
  const bed = BEDS.find((b) => b.label.toLowerCase() === label);
  const seed =
    bed &&
    src.admit(minuteOf(s), s.patients, {
      id: a.patient_id,
      name,
      age: a.age ?? "",
      sex: a.sex ?? "",
      bed: bed.label,
      context: a.context ?? "",
      story: "New admission, entered on the dashboard",
      bp: bpOf(a),
      patch: false, // NOT RANKED until a nurse has fitted one
      ...(a.acvpu && { consciousness: a.acvpu }),
      ...(who?.[3] === "rn" && { rn: a.clinician_id }),
      ...(who?.[3] === "md" && { md: a.clinician_id, listMd: a.clinician_id }),
    });
  if (!seed) return say(s, `No free bed ${a.bed} for ${name}: not placed on the ward`);
  place(s, src, seed, minuteOf(s), true);
  applyPatch(s, seed.id);
}

export function applyAction(s: Sim, src: VitalsSource, a: Action) {
  const who = STAFF.find(([id]) => id === a.clinician_id);
  const clinician = who?.[1] ?? a.clinician_id;
  if (a.kind === "admit_patient") return admit(s, src, a, who);
  const p = s.patients.find((x) => x.id === a.patient_id);
  if (!p) return; // already left, or never here
  if (a.kind === "acknowledge") {
    // The same test as maybeQueueAssessment: one visit at a time.
    const pending = s.tasks.some((t) => t.patient === p.id) || s.staff.some((m) => m.task?.patient === p.id);
    if (!pending) s.tasks.push({ kind: "assess", patient: p.id, rn: p.rn });
    say(s, `${clinician} acknowledged ${p.name}${a.score === null ? "" : `, NEWS2 ${a.score}`}`);
  } else if (a.kind === "record_vitals") {
    chart(s, p.id, {
      ...(a.acvpu && { consciousness: a.acvpu }),
      ...(a.on_oxygen !== null && { onOxygen: a.on_oxygen }),
      ...(a.spo2_scale && { spo2Scale: a.spo2_scale }),
    });
    const bp = bpOf(a);
    if (bp) recordBp(s, p.id, bp);
    say(s, `${clinician} recorded vitals for ${p.name}`);
  } else if (a.kind === "add_note") {
    say(s, `${clinician} added a note for ${p.name}`);
  }
}
