import { describe, expect, it } from "vitest";
import { floorName, floorSummary } from "./building";
import { RISK_LIGHT } from "./render/draw";
import { parseScenario } from "./sim/hospital/scenario";
import { createHospital } from "./sim/hospital/step";
import typical from "../scenarios/hospital/typical.json?raw";
import type { Person, Where } from "./sim/hospital/types";
import type { Group, Triage, UnitId } from "./sim/hospital/params";

// A fixed hand-built state: createHospital's own residents are removed, then people are placed by hand.
const base = { arrivedMin: 0, sinceMin: 0, wants: null, seenMin: null, decideMin: null, dueMin: null, dieMin: null, boardedMin: 0, w4Id: null, fromW4: false } as const;
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

  it("lists floors from 5F down to GF", () => expect(f.map((x) => x.label)).toEqual(["5F", "4F", "3F", "2F", "GF"]));

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

  it("counts beds, stretchers, occupancy and the nurse ratio on 3F", () => {
    const a = at(3).units.find((u) => u.id === "MED3A")!;
    expect([a.beds.filter(Boolean).length, a.stretchers.filter(Boolean).length, a.census]).toEqual([3, 1, 4]); // 3 beds: the ICU-indicated one is a patient too
    const b = at(3).units.find((u) => u.id === "MED3B")!;
    expect([b.census, b.bodies, b.beds[3]?.dead]).toEqual([0, 1, true]); // a body holds its bed but is no patient
    expect(at(3).census).toBe(4);
    expect(at(3).occupancyPct).toBe(7);
    expect(at(3).ratio).toBe(1); // 4 patients over 4 nurses: the body is not in it
    expect(at(3).awaitingMorgue).toBe(1);
    expect(a.beds[5]?.icu).toBe(true);
    expect(floorName(at(3))).toMatch(/^3F: Medicine 3A and Medicine 3B, 4 patients/);
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

  it("counts deaths on a later day by the clock's own day, not the minute count", () => {
    const h = fixed();
    h.people = [person("MORGUE", "morgue", 0, { dieMin: 1000 }), person("MORGUE", "morgue", 1, { dieMin: 400 })];
    h.gone = [];
    h.lastMinute = 1500; // 15:00 + 1500 min is day 1; minute 1000 is day 1 too, minute 400 is day 0
    expect(floorSummary(h).find((x) => x.floor === 0)!.deathsToday).toBe(1);
  });
});
