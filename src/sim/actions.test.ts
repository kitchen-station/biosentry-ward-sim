import { describe, expect, it } from "vitest";
import { applyAction, type Action } from "./actions";
import { loadWard, saveWard } from "./persist";
import { createSim, patientById, step, type Sim } from "./sim";
import { createSyntheticSource, FIXTURE_SEED, type VitalsSource } from "./source";

function ward() {
  const src = createSyntheticSource(FIXTURE_SEED, true);
  const s = createSim(src);
  s.outbox = { observations: [], bins: [], events: [], admissions: [], departures: [], sent: new Map() };
  return { s, src };
}

let seq = 0;
const action = (kind: Action["kind"], patient_id: string, rest: Partial<Action> = {}): Action => ({
  seq: (seq += 1),
  kind,
  patient_id,
  clinician_id: "rn-reyes",
  score: null,
  systolic: null,
  diastolic: null,
  acvpu: null,
  on_oxygen: null,
  spo2_scale: null,
  name: null,
  age: null,
  sex: null,
  bed: null,
  context: null,
  ...rest,
});
const newPatient = (bed: string, rest: Partial<Action> = {}) =>
  action("admit_patient", "p-900", { name: "Navarro, Pilar", age: 61, sex: "F", bed, context: "Chest pain, for observation", ...rest });

/** Steps until `done`, for at most three sim hours. */
function runUntil(s: Sim, src: VitalsSource, done: () => boolean) {
  for (let tick = 0; tick < 180 * 60 && !done(); tick += 1) step(s, src);
  expect(done()).toBe(true);
}
const lastLog = (s: Sim) => s.log.at(-1)!.text;
const total = (s: Sim, id: string) => {
  const d = patientById(s, id).decision;
  return d.kind === "ranked" ? d.news2.total : null;
};

describe("a clinician action from the dashboard", () => {
  it("acknowledge: sends the patient's nurse to assess them, once", () => {
    const { s, src } = ward();
    const p = s.patients.find((x) => !s.tasks.some((t) => t.patient === x.id))!;
    const mine = () => s.tasks.filter((t) => t.patient === p.id);
    applyAction(s, src, action("acknowledge", p.id, { score: 7, clinician_id: "md-santos" }));
    expect(mine()).toEqual([{ kind: "assess", patient: p.id, rn: p.rn }]);
    expect(lastLog(s)).toBe(`Dr. Santos acknowledged ${p.name}, NEWS2 7`);
    applyAction(s, src, action("acknowledge", p.id, { score: 7, clinician_id: "someone-else" }));
    expect(mine()).toHaveLength(1);
    expect(lastLog(s)).toBe(`someone-else acknowledged ${p.name}, NEWS2 7`);
  });

  it("record_vitals: charted values count at once, and the nurse enters the blood pressure at the bed", () => {
    const { s, src } = ward();
    const p = s.patients.find((x) => x.decision.kind === "ranked" && x.consciousness === "A" && !x.onOxygen)!;
    const before = total(s, p.id)!;
    applyAction(s, src, action("record_vitals", p.id, { acvpu: "V", systolic: 118, diastolic: 71 }));
    expect(p.consciousness).toBe("V");
    expect(total(s, p.id)).toBe(before + 3);
    expect(lastLog(s)).toBe(`Reyes recorded vitals for ${p.name}`);
    expect(s.outbox!.observations).toContainEqual(expect.objectContaining({ patient_id: p.id, code: "consciousness", txt: "V" }));
    expect(p.bp).not.toEqual({ systolic: 118, diastolic: 71 });
    runUntil(s, src, () => p.bp?.systolic === 118 && p.bp.diastolic === 71);

    applyAction(s, src, action("record_vitals", p.id, { on_oxygen: true, spo2_scale: 2 }));
    expect([p.onOxygen, p.spo2Scale, p.consciousness]).toEqual([true, 2, "V"]);
    expect(s.tasks.some((t) => t.patient === p.id && t.kind === "record_bp")).toBe(false);
  });

  it("add_note: says who added a note for whom, in the log and the patient's stay", () => {
    const { s, src } = ward();
    const p = s.patients[0];
    applyAction(s, src, action("add_note", p.id));
    expect(lastLog(s)).toBe(`Reyes added a note for ${p.name}`);
    expect(p.stay.events.at(-1)!.text).toBe(lastLog(s));
  });

  it("admit_patient: seats the patient in the named bed, NOT RANKED until a nurse fits the patch", () => {
    const { s, src } = ward();
    const admitted = s.flow.admitted;
    applyAction(s, src, newPatient(" a4 ", { systolic: 132, diastolic: 80, acvpu: "C" }));
    const p = patientById(s, "p-900");
    expect([p.name, p.age, p.sex, p.bed, p.context]).toEqual(["Navarro, Pilar", 61, "F", "A4", "Chest pain, for observation"]);
    expect([p.rn, p.bp, p.consciousness]).toEqual(["rn-reyes", { systolic: 132, diastolic: 80 }, "C"]);
    expect(["md-santos", "md-aquino"]).toContain(p.md);
    expect([p.patch, p.decision.kind, p.rank]).toEqual([false, "not_ranked", null]);
    expect(s.stays).toContain(p.stay);
    expect(s.flow.admitted).toBe(admitted + 1);
    expect(s.tasks).toContainEqual({ kind: "apply_patch", patient: "p-900", rn: "rn-reyes" });
    expect(s.log.map((l) => l.text)).toContain("Navarro, Pilar admitted to A4: Chest pain, for observation");
    expect(s.outbox!.admissions).toEqual([]); // the API already has this patient
    expect(s.outbox!.observations.some((o) => o.patient_id === "p-900")).toBe(true);

    runUntil(s, src, () => p.patch);
    runUntil(s, src, () => p.decision.kind === "ranked");
    expect(s.outbox!.admissions.some((a) => a.id === "p-900")).toBe(false);

    const count = s.patients.length;
    applyAction(s, src, newPatient("A5")); // the same id again
    expect(s.patients).toHaveLength(count);
  });

  it("admit_patient: a physician who admits takes the patient, and no blood pressure stays missing", () => {
    const { s, src } = ward();
    applyAction(s, src, newPatient("S4", { clinician_id: "md-aquino" }));
    const p = patientById(s, "p-900");
    expect([p.md, p.listMd, p.bp, p.consciousness]).toEqual(["md-aquino", "md-aquino", null, "A"]);
    expect(["rn-delacruz", "rn-reyes"]).toContain(p.rn);
  });

  it("admit_patient: an occupied or unknown bed places nobody", () => {
    const { s, src } = ward();
    for (const bed of [s.patients[0].bed, "Z9"]) {
      const before = JSON.stringify({ ...s, log: [], outbox: { ...s.outbox, events: [] } });
      applyAction(s, src, newPatient(bed));
      expect(lastLog(s)).toBe(`No free bed ${bed} for Navarro, Pilar: not placed on the ward`);
      expect(JSON.stringify({ ...s, log: [], outbox: { ...s.outbox, events: [] } })).toBe(before);
    }
  });

  it("ignores a patient who is not in the ward", () => {
    const { s, src } = ward();
    const before = JSON.stringify(s);
    for (const kind of ["acknowledge", "record_vitals", "add_note"] as const) {
      applyAction(s, src, action(kind, "p-999", { score: 5, acvpu: "U", systolic: 90, diastolic: 50 }));
    }
    expect(JSON.stringify(s)).toBe(before);
  });

  it("a ward with an admitted patient is saved, loaded and runs on the same", () => {
    const a = ward();
    applyAction(a.s, a.src, newPatient("B5", { systolic: 125, diastolic: 78 }));
    runUntil(a.s, a.src, () => patientById(a.s, "p-900").patch);
    const b = loadWard(saveWard(a.s, a.src, { runId: 7, origin: "2026-11-11T00:00:00.000Z", cursor: 1 }));
    expect(b.run.cursor).toBe(1);
    for (const w of [a, b]) for (let tick = 0; tick < 240 * 60; tick += 1) step(w.s, w.src);
    const plain = (s: Sim) => JSON.parse(JSON.stringify({ ...s, outbox: { ...s.outbox, sent: [...s.outbox!.sent].sort() } }));
    expect(plain(b.s)).toEqual(plain(a.s));
    expect(b.s.stays.some((x) => x.id === "p-900")).toBe(true);
  });
});
