import { describe, expect, it } from "vitest";
import { floorName, floorSummary, GROUP_COLOURS } from "./building";
import { cellDot, RISK_LIGHT } from "./render/draw";
import { createHospitalSim } from "./sim/hospital/attach";
import { UNITS } from "./sim/hospital/params";
import { parseScenario } from "./sim/hospital/scenario";
import { saveWard } from "./sim/persist";
import { setSpeed, step } from "./sim/sim";
import { createSyntheticSource } from "./sim/source";
import { createHospital } from "./sim/hospital/step";
import typical from "../scenarios/hospital/typical.json?raw";
import type { Person, Where } from "./sim/hospital/types";
import type { Group, Triage, UnitId } from "./sim/hospital/params";

// A fixed hand-built state: createHospital's own residents are removed, then people are placed by hand.
const base = { arrivedMin: 0, sinceMin: 0, wants: null, seenMin: null, decideMin: null, dueMin: null, dieMin: null, boardedMin: 0, w4Id: null, fromW4: false, obsDueMin: null, obsLastMin: null, course: null, visit: 1, history: [] as never[], look: [0, 0, 0] as [number, number, number] } as const;
let n = 0;
function person(unit: UnitId, where: Where, slot: number | null, o: Partial<Person> = {}): Person {
  n += 1;
  return { ...base, id: `p${n}`, n, name: `Ana Reyes`, age: 50, sex: "F", group: "minor" as Group, complaint: "x", triage: "urgent" as Triage, patienceMin: null,
    admit: true, icuU: 0, icuIndicated: false, decisionMin: 0, stayMin: 0, icuStayMin: 0, dischargeHour: 0, erDeathAfterMin: null, deathU: 1, deathF: 0, unit, where, slot, ...o };
}

function fixed() {
  n = 0;
  const h = createHospital(1, parseScenario(typical));
  h.people = [
    person("ER", "waiting", null, { triage: "non_urgent", arrivedMin: 5 }), person("ER", "waiting", null, { triage: "emergent", arrivedMin: 9 }), person("ER", "waiting", null),
    person("ER", "consult", 0), person("ER", "boarding", 1, { wants: "MED3A", sinceMin: 0 }), person("ER", "boarding", 2, { wants: "ICU", sinceMin: 66 }), person("MED3A", "bed", 5, { icuIndicated: true }), person("ER", "workup", 10), // slot 10: a trolley beyond the 10 bays
    person("MED3A", "bed", 0), person("MED3A", "bed", 1), person("MED3A", "stretcher", 30), // stretchers start at slot 30
    person("W4", "bed", null, { w4Id: "W4-01", group: "cardiac" }), person("W4", "bed", null, { w4Id: "W4-02", group: "cardiac" }),
    person("MORGUE", "morgue", 0, { dieMin: 10 }), person("MORGUE", "morgue", 6), person("MED3B", "awaiting_morgue", 3, { dieMin: 20 }),
  ];
  h.gone = [person("MORGUE", "morgue", null, { dieMin: 1 })]; // died on day 1; "today" below is day 1 too
  h.lastMinute = 125; // 15:00 + 125 min = day 1
  return h;
}

describe("floorSummary", () => {
  const f = floorSummary(fixed(), { "W4-01": "high", "W4-02": null });
  const at = (floor: number) => f.find((x) => x.floor === floor)!;

  it("lists floors from 5F down to GF", () => expect(f.map((x) => x.label)).toEqual(["5F", "4F", "3F", "2F", "1F", "GF"]));

  it("counts the ER queue in seeing order, bays, trolleys and boarders", () => {
    const er = at(0).units.find((u) => u.id === "ER")!;
    expect(er.queue).toEqual(["emergent", "urgent", "non_urgent"]);
    expect([er.consult, er.workup, er.boarders]).toEqual([1, 1, [{ to: "MED3A", hours: 2 }, { to: "ICU", hours: 0 }]]);
    expect(er.beds.filter(Boolean).length).toBe(3);
    expect(er.over.length).toBe(1);
    expect(er.census).toBe(7); // 3 waiting + consult + 2 boarding + workup
    expect(er.ratio).toBe(3.5); // 7 over 2 nurses
    expect(at(0).boarders).toBe(2);
    expect([at(0).baysUsed, at(0).erCount]).toEqual([3, 7]);
    expect(floorName(at(0))).toBe("GF: Emergency Room, 3 waiting, 2 boarding");
  });

  it("counts beds, stretchers, occupancy and the nurse ratio on 3F and 1F", () => {
    const a = at(3).units.find((u) => u.id === "MED3A")!;
    expect([a.beds.filter(Boolean).length, a.stretchers.filter(Boolean).length, a.census]).toEqual([3, 1, 4]); // 3 beds: the ICU-indicated one is a patient too
    const b = at(1).units.find((u) => u.id === "MED3B")!; // Medicine 1A
    expect([b.census, b.bodies, b.beds[3]?.dead]).toEqual([0, 1, true]); // a body holds its bed but is no patient
    expect(at(3).census).toBe(4);
    expect(at(3).occupancyPct).toBe(13); // 4 of 30
    expect(at(3).ratio).toBe(2); // 4 patients over 2 nurses
    expect([at(1).census, at(1).ratio, at(1).awaitingMorgue, at(3).awaitingMorgue]).toEqual([0, 0, 1, 0]); // the body is not a patient
    expect(a.beds[5]?.icu).toBe(true);
    expect(floorName(at(3))).toMatch(/^3F: Medicine 3A, 4 patients/);
    expect(floorName(at(1))).toMatch(/^1F: Medicine 1A, 0 patients/);
  });

  it("counts boarders on the floor they wait for, and a zero-nurse unit has no ratio", () => {
    expect([at(3).boarders, at(2).boarders, at(5).boarders]).toEqual([1, 1, 0]); // MED3A on 3F, ICU on 2F
    expect(at(0).units.find((u) => u.id === "MORGUE")!.ratio).toBeNull();
  });

  it("counts deaths today, bodies awaiting, and the morgue's drawers", () => {
    expect(at(0).deathsToday).toBe(3);
    expect(at(0).awaitingMorgue).toBe(1); // GF shows the house-wide count
    expect(at(3).deathsToday).toBeNull();
    const m = at(0).units.find((u) => u.id === "MORGUE")!;
    expect([m.census, m.beds.filter(Boolean).length, m.over.length]).toEqual([2, 1, 1]); // slot 6 is past the 6 drawers
  });

  it("colours W4 beds by NEWS2 risk, grey when not ranked", () => {
    const w4 = at(4).units[0];
    expect(w4.census).toBe(2);
    expect(w4.beds.slice(0, 3).map((c) => (c ? c.risk : "empty"))).toEqual(["high", null, "empty"]);
    expect(RISK_LIGHT[w4.beds[0]!.risk!]).toBe("#FF6B6B");
  });

  it("outside W4 a cell takes its risk by its click key; intensive care and bodies have none", () => {
    const h = fixed();
    h.people.push(person("ICU", "bed", 0));
    const [med, icu] = [h.people.find((p) => p.unit === "MED3A" && p.slot === 0)!, h.people.find((p) => p.unit === "ICU")!];
    const risk = { "W4-01": "high", "W4-02": null, [`h:${med.n}`]: "medium" };
    const f = floorSummary(h, risk);
    const cells = (id: string) => f.flatMap((x) => x.units).find((u) => u.id === id)!;
    expect(cells("MED3A").beds[0]!.risk).toBe("medium");
    expect(cells("MED3A").beds[1]!.risk).toBeUndefined(); // no key: nothing shown
    expect(cells("ICU").beds[0]!.risk).toBeUndefined(); // riskBySel has no ICU key, and a stray key is the engine's to withhold
    expect(cells("W4").beds.slice(0, 2).map((c) => c!.risk)).toEqual(["high", null]); // W4 as before
    expect(icu.n).toBeGreaterThan(0);
    expect(cellDot(cells("MED3A").beds[0]!)).toBe(RISK_LIGHT.medium);
    expect(cellDot({ ...cells("MED3A").beds[0]!, risk: null })).toBe("#A899B5");
    expect(cellDot(cells("ICU").beds[0]!)).toBe(GROUP_COLOURS.minor);
  });

  it("counts deaths on a later day by the clock's own day, not the minute count", () => {
    const h = fixed();
    h.people = [person("MORGUE", "morgue", 0, { dieMin: 1000 }), person("MORGUE", "morgue", 1, { dieMin: 400 })];
    h.gone = [];
    h.lastMinute = 1500; // 15:00 + 1500 min is day 1; minute 1000 is day 1 too, minute 400 is day 0
    expect(floorSummary(h).find((x) => x.floor === 0)!.deathsToday).toBe(1);
  });
});

describe("Medicine 1A on its own floor", () => {
  it("changes only that unit's floor and name: two days of the hospital are otherwise identical, draw for draw", () => {
    const twoDays = () => {
      const src = createSyntheticSource(101, true);
      const s = createHospitalSim(src, parseScenario(typical), 101);
      setSpeed(s, 60);
      for (let i = 0; i < 2 * 1440 * 60; i += 1) step(s, src);
      return saveWard(s, src, { runId: null, origin: "", cursor: 0, commandCursor: 0 });
    };
    const now = twoDays();
    const row = UNITS.find((u) => u.id === "MED3B")!;
    expect([row.floor, row.name]).toEqual([1, "Medicine 1A"]);
    Object.assign(row, { floor: 3, name: "Medicine 3B" }); // the table as it was, both medicine wards on 3F
    let before: string;
    try { before = twoDays(); } finally { Object.assign(row, { floor: 1, name: "Medicine 1A" }); }
    const was = '"id":"MED3B","name":"Medicine 3B","floor":3,';
    expect(before.split(was).length).toBe(2); // exactly once: the unit table inside the state
    expect(before.replace(was, '"id":"MED3B","name":"Medicine 1A","floor":1,')).toBe(now);
  }, 120_000);
});
