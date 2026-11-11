import { describe, expect, it } from "vitest";
import typical from "../../../scenarios/hospital/typical.json?raw";
import { wardSnapshot } from "../../bridge/snapshot";
import { bedByLabel } from "../map";
import { loadWard, saveWard } from "../persist";
import { createSim, injectDeterioration, minuteOf, patientRow, setSpeed, step, type Sim } from "../sim";
import { createSyntheticSource, type VitalsSource } from "../source";
import { createPublisher } from "../view";
import { createHospitalSim, refuseHospitalState } from "./attach";
import { parseScenario, type Scenario } from "./scenario";
import { takeRows } from "./step";
import type { EventRow, Person } from "./types";

const TYPICAL = parseScenario(typical);
// Enough arrivals and ER doctors that W4 fills inside two days (under typical it runs at about half).
const BUSY: Scenario = { ...TYPICAL, arrivalsPerDay: 500, er: { ...TYPICAL.er, doctorsDay: 10, doctorsNight: 10 } };
const RUN = { runId: null, origin: "", cursor: 0 };
const DAY = 1440;
const HOLD_MIN = 48 * 60; // sim.ts HOLD_IF_UNWELL_MIN

function world(scenario: Scenario, seed = 101) {
  const src = createSyntheticSource(seed, true);
  const s = createHospitalSim(src, scenario, seed);
  setSpeed(s, 60);
  return { s, src };
}

/** Steps whole sim minutes at 60x (one tick is one sim second), calling `each` after every minute. */
function run(s: Sim, src: VitalsSource, minutes: number, each?: (minute: number) => boolean | void) {
  for (let m = 0; m < minutes; m += 1) {
    for (let t = 0; t < 60; t += 1) step(s, src);
    if (each?.(minuteOf(s)) === true) return;
  }
}

const everyone = (s: Sim): Person[] => [...s.hospital!.people, ...s.hospital!.gone];

/** Every person in one place, no slot held twice, and W4's patients are exactly the hospital's W4 residents. */
function conserved(s: Sim) {
  const h = s.hospital!;
  expect(new Set(h.people.map((p) => p.id)).size).toBe(h.people.length);
  const slots = h.people.filter((p) => p.slot !== null).map((p) => `${p.unit}:${p.slot}`);
  expect(new Set(slots).size).toBe(slots.length);
  const onW4 = h.people.filter((p) => p.w4Id !== null);
  for (const p of onW4) expect([p.unit, p.where, p.slot]).toEqual(["W4", "bed", null]);
  expect(onW4.map((p) => p.w4Id).sort()).toEqual(s.patients.map((p) => p.id).sort());
}

describe("hospital mode: W4 wired to the hospital", () => {
  it("over two days every W4 admission comes through the ER as that person, and everyone is in one place each hour", () => {
    const { s, src } = world(TYPICAL);
    const events: EventRow[] = [];
    const seen = new Map<string, { name: string; age: number | string; sex: string }>();
    // What sync would send (admission rows, log texts) and what the dashboard bridge serves, for the privacy scan below.
    const sent: string[] = [];
    const logs = new Set<object>();
    expect(s.hospital!.people.filter((p) => p.unit === "W4")).toHaveLength(12);
    conserved(s);
    run(s, src, 2 * DAY, (minute) => {
      for (const p of s.patients) {
        if (seen.has(p.id)) continue;
        seen.set(p.id, { name: p.name, age: p.age, sex: p.sex });
        sent.push(JSON.stringify(patientRow(p, [], minute - (minute % 15))));
      }
      for (const e of s.log) logs.add(e);
      if (minute % 60 === 0) {
        conserved(s);
        events.push(...takeRows(s.hospital!).events);
        sent.push(JSON.stringify(wardSnapshot(s, true, 0)));
      }
    });
    const placed = events.filter((e) => e.kind === "place" && e.unit === "W4");
    const admitted = s.stays.filter((x) => x.inMin > 0);
    expect(admitted.length).toBeGreaterThan(0);
    expect(s.flow.admitted).toBe(admitted.length);
    expect(placed.map((e) => e.w4_id).sort()).toEqual(admitted.map((x) => x.id).sort());
    const people = everyone(s);
    for (const e of placed) {
      const person = people.find((p) => p.id === e.person)!;
      const stay = admitted.find((x) => x.id === e.w4_id)!;
      expect(person.group).toBe("cardiac");
      expect(events.some((r) => r.person === person.id && r.kind === "arrive" && r.unit === "ER")).toBe(true);
      expect(stay.inMin).toBe(e.minute);
      expect(seen.get(stay.id)).toEqual({ name: person.name, age: person.age, sex: person.sex });
      expect(bedByLabel(stay.bed).zone).not.toBe(person.sex === "F" ? "B" : "A"); // the person's sex picks the bay
    }
    // Discharges from W4 are reported back: each finished W4 stay is a W4 discharge or a move to the ICU.
    const out = s.stays.filter((x) => x.outMin !== null);
    expect(out.length).toBeGreaterThan(0);
    const reported = events.filter((e) => (e.kind === "discharge" && e.unit === "W4") || (e.kind === "transfer" && e.detail === "W4 to ICU"));
    expect(reported.map((e) => e.w4_id).sort()).toEqual(out.map((x) => x.id).sort());
    expect(events.some((e) => e.detail === "W4 higher care, no ICU bed")).toBe(false);
    // Nothing of a person who was never on W4 reaches an admission row, a log text or the dashboard snapshot.
    const text = [...sent, JSON.stringify([...logs])].join("\n");
    const w4Names = new Set([...seen.values()].map((x) => x.name));
    const others = people.filter((p) => !w4Names.has(p.name));
    expect(others.length).toBeGreaterThan(100);
    for (const p of others) expect(text).not.toContain(p.name);
    for (const c of new Set(people.filter((p) => p.group !== "cardiac").map((p) => p.complaint))) expect(text).not.toContain(c);
    expect(text).toContain([...w4Names].at(-1)!); // the scan does read names
    expect(text).not.toMatch(/"h-\d|hospital/);
  }, 60_000);

  it("a full W4 makes cardiac people board, and refuses them before drawing any random number", () => {
    const { s, src } = world(BUSY);
    let full = false;
    const askers = () => s.hospital!.people.filter((p) => p.group === "cardiac" && p.where === "boarding" && !p.fromW4);
    run(s, src, 2 * DAY, () => (full = s.patients.length === 20 && askers().some((p) => p.wants === "W4")));
    expect(full).toBe(true);
    for (const p of s.patients) p.dueMin = null; // W4 stays full for the window
    const text = saveWard(s, src, RUN);
    const b = loadWard(text);
    const flowBefore = src.save!([]).flowRng;
    run(s, src, 240, () => {
      expect(s.patients).toHaveLength(20);
      expect(askers().length).toBeGreaterThan(0); // they ask every minute
    });
    // The same ward with nobody asking: every cardiac person not on W4 is removed each minute.
    const drop = () => { b.s.hospital!.people = b.s.hospital!.people.filter((p) => p.group !== "cardiac" || p.w4Id !== null); };
    drop();
    run(b.s, b.src, 240, drop);
    expect(src.save!([]).flowRng).toBe(flowBefore);
    expect(b.src.save!([]).flowRng).toBe(flowBefore);
    expect(JSON.stringify(s.patients)).toBe(JSON.stringify(b.s.patients));
    const ids = s.patients.map((p) => p.id);
    expect(src.save!(ids)).toEqual(b.src.save!(ids));
  }, 60_000);

  it("higher care moves the patient to a free ICU bed", () => {
    const { s, src } = world({ ...TYPICAL, startOccupancy: 0.5, units: { ...TYPICAL.units, ICU: { ...TYPICAL.units.ICU, beds: 2 } } });
    expect(s.hospital!.icuFree).toBe(1);
    const sick = s.patients[0]; // NEWS2 9 at the start
    sick.dueMin = -HOLD_MIN;
    run(s, src, 120, () => !s.patients.includes(sick)); // a nurse at the bedside finishes first
    expect(s.patients).not.toContain(sick);
    expect(sick.stay.outcome).toBe("higher_care");
    const person = s.hospital!.people.find((p) => p.name === sick.name && p.fromW4)!;
    expect([person.unit, person.where, person.w4Id]).toEqual(["ICU", "bed", null]);
    conserved(s);
  });

  it("two W4 patients due for higher care in one minute with one free ICU bed: one goes, the other waits on W4", () => {
    const { s, src } = world({ ...TYPICAL, startOccupancy: 0.5, units: { ...TYPICAL.units, ICU: { ...TYPICAL.units.ICU, beds: 2 } } });
    expect(s.hospital!.icuFree).toBe(1);
    const [a, b] = s.patients; // NEWS2 9 and 7 at the start
    for (const p of [a, b]) p.dueMin = -HOLD_MIN;
    s.tasks = []; // nobody at either bedside, so both are due in minute 1
    run(s, src, 1);
    expect([a, b].filter((p) => s.patients.includes(p))).toHaveLength(1);
    const gone = s.patients.includes(a) ? b : a;
    expect(gone.stay.outcome).toBe("higher_care");
    expect(s.hospital!.people.find((p) => p.name === gone.name && p.fromW4)!.unit).toBe("ICU");
    expect(s.hospital!.icuFree).toBe(0);
    expect(takeRows(s.hospital!).events.some((e) => e.detail === "W4 higher care, no ICU bed")).toBe(false);
    conserved(s);
  });

  it("keeps a just-ended W4 stay past the stay limit, so the hospital always hears of the departure", () => {
    const { s, src } = world(TYPICAL);
    const open = Array.from({ length: 500 }, (_, i) => ({ ...s.patients[0].stay, id: `x-${i}` })); // open stays: none may be trimmed
    s.stays.push(...open);
    const p = s.patients.find((x) => x.decision.kind === "ranked" && x.decision.news2.total < 5)!;
    p.dueMin = 0;
    run(s, src, 120, () => !s.patients.includes(p));
    expect(p.stay.outcome).toBe("discharged");
    expect(s.stays).toContain(p.stay);
    expect(s.stays.filter((x) => x.id.startsWith("x-"))).toHaveLength(500);
    expect(everyone(s).some((x) => x.name === p.name && x.w4Id === p.id && !s.hospital!.people.includes(x))).toBe(true);
    conserved(s);
  });

  it("higher care waits on W4 while the ICU is full", () => {
    const { s, src } = world({ ...TYPICAL, units: { ...TYPICAL.units, ICU: { ...TYPICAL.units.ICU, beds: 1 } } });
    expect(s.hospital!.icuFree).toBe(0);
    const sick = s.patients[0];
    sick.dueMin = -HOLD_MIN;
    injectDeterioration(s, src, sick.id); // keeps NEWS2 at 5 or more, so higher care stays due
    let waited = 0;
    run(s, src, 360, () => {
      expect(s.hospital!.icuFree).toBe(0);
      expect(sick.stay.outcome).not.toBe("higher_care");
      if (s.patients.includes(sick) && sick.decision.kind === "ranked" && sick.decision.news2.total >= 5) waited += 1;
      conserved(s);
    });
    expect(waited).toBeGreaterThan(120); // unwell, due and past the hold for hours, yet on W4
    // The same patient in ward-only W4 goes to higher care at once.
    const wsrc = createSyntheticSource(101, true);
    const ward = createSim(wsrc);
    const control = ward.patients[0];
    control.dueMin = -HOLD_MIN;
    injectDeterioration(ward, wsrc, control.id);
    run(ward, wsrc, 120, () => !ward.patients.includes(control));
    expect(control.stay.outcome).toBe("higher_care");
  });

  it("saved at an odd second and loaded, it continues exactly as an uninterrupted run", () => {
    const a = world(TYPICAL);
    const b = world(TYPICAL);
    const split = 757 * 60 + 23; // not on an hour, not on a minute
    for (let i = 0; i < split; i += 1) { step(a.s, a.src); step(b.s, b.src); }
    const loaded = loadWard(saveWard(b.s, b.src, RUN));
    expect(loaded.s.hospital).toEqual(b.s.hospital);
    for (let i = split; i < 1500 * 60; i += 1) { step(a.s, a.src); step(loaded.s, loaded.src); }
    expect(saveWard(loaded.s, loaded.src, RUN)).toBe(saveWard(a.s, a.src, RUN));
    expect(a.s.hospital!.lastMinute).toBe(1500);
  }, 60_000);

  it("is deterministic: the same seed is equal, another seed differs", () => {
    const one = (seed: number) => { const w = world(TYPICAL, seed); run(w.s, w.src, DAY); return saveWard(w.s, w.src, RUN); };
    expect(one(101)).toBe(one(101));
    expect(one(102)).not.toBe(one(101));
  }, 60_000);

  it("never runs with API sync, and needs a ward with patient flow", () => {
    const { s, src } = world(TYPICAL);
    s.outbox = { observations: [], bins: [], events: [], admissions: [], departures: [], sent: new Map() }; // as sync.ts register does
    expect(() => run(s, src, 1)).toThrow(/never run together/);
    expect(() => createHospitalSim(createSyntheticSource(101, false), TYPICAL, 101)).toThrow(/patient flow/);
  });

  it("the ward-only runner refuses a state file that holds a hospital", () => {
    const h = world(TYPICAL);
    expect(refuseHospitalState(loadWard(saveWard(h.s, h.src, RUN)).s)).toBe("state file holds a hospital; the runner is ward-only in this version");
    const src = createSyntheticSource(101, true);
    expect(refuseHospitalState(loadWard(saveWard(createSim(src), src, RUN)).s)).toBeNull();
  });

  it("the viewer's body carries nothing from the hospital", () => {
    const { s, src } = world(TYPICAL);
    run(s, src, 12 * 60);
    const body = createPublisher()(s);
    const text = JSON.stringify(body);
    expect(Object.keys(body).sort()).toEqual(["patients", "shared"]);
    expect(Object.keys(body.shared).sort()).toEqual(["beds", "clockS", "counts", "ended", "moves", "speed", "staff", "tasks"]);
    expect(text).not.toMatch(/hospital|"h-\d/);
    const shared = JSON.stringify(body.shared);
    const w4Names = new Set(s.patients.map((p) => p.name));
    for (const p of everyone(s)) {
      expect(shared).not.toContain(p.name);
      if (!w4Names.has(p.name)) expect(text).not.toContain(p.name);
    }
  });
});
