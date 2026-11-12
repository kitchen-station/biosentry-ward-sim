import { describe, expect, it } from "vitest";
import { cellLabel, floorSummary } from "./building";
import { personStatus, censusSeries, doorToDoctor24h, releasedPartial, complications, doctorsNow, doorToDoctorMedian24h, isHospitalId, personPath, releasedLast24h, seeingOrder, todayCounts } from "./hospital-panels";
import { PARAMS } from "./sim/hospital/params";
import { parseScenario } from "./sim/hospital/scenario";
import { createHospital } from "./sim/hospital/step";
import typical from "../scenarios/hospital/typical.json?raw";
import type { EventKind, EventRow, HourRow, Person, Where } from "./sim/hospital/types";
import type { Group, Triage, UnitId } from "./sim/hospital/params";

const base = { arrivedMin: 100, sinceMin: 100, wants: null, seenMin: null, decideMin: null, dueMin: null, dieMin: null, boardedMin: 0, w4Id: null, fromW4: false, obsDueMin: null, obsLastMin: null, course: null, visit: 1, history: [] as never[], look: [0, 0, 0] as [number, number, number] } as const;
let n = 0;
function person(unit: UnitId, where: Where, slot: number | null, o: Partial<Person> = {}): Person {
  n += 1;
  return { ...base, id: `p${n}`, n, name: `Ana Reyes`, age: 50, sex: "F", group: "minor" as Group, complaint: "x", triage: "urgent" as Triage, patienceMin: null,
    admit: true, icuU: 0, icuIndicated: false, decisionMin: 0, stayMin: 0, icuStayMin: 0, dischargeHour: 0, erDeathAfterMin: null, deathU: 1, deathF: 0, unit, where, slot, ...o };
}
const ev = (person: string, minute: number, kind: EventKind, unit: UnitId = "ER", detail = ""): EventRow => ({ minute, person, visit: 1, w4_id: null, unit, kind, detail, news2_independent: true });
const row = (hour: number, unit: UnitId, census: number, o: Partial<HourRow> = {}): HourRow => ({
  hour, unit, census, beds: 10, stretchers_used: 0, occupancy_pct: 0, arrivals: 0, admitted_in: 0, discharged: 0, transferred_in: 0, transferred_out: 0, died: 0,
  nurses: 2, patients_per_nurse: null, er_waiting: null, er_consult: null, er_workup: null, er_boarding: null, er_boarding_hours: null, er_lwbs: null,
  door_to_doctor_median_min: null, icu_indicated_not_in_icu: null, morgue: null,
  obs_due: null, obs_done: null, obs_late: null, obs_overdue_now: null, obs_longest_overdue_min: null, care_min_demanded: null, care_min_available: null,
  obs_longest_since_round_min: null, obs_rel_late_median: null,
  deteriorated: null, noticed: null, noticed_late: null, unnoticed_now: null, recognition_delay_median_min: null, returns: null, ...o,
});

function fixed() {
  n = 0;
  const h = createHospital(1, parseScenario(typical));
  h.people = [];
  h.gone = [];
  h.events = [];
  h.hourly = [];
  h.lastMinute = 3000; // day 3 (15:00 start): minute 3000 + 900 = 3900 -> day 2 (index), clock 17:00
  return h;
}

describe("personPath", () => {
  it("lists a person's events in time order and says nothing is missing when the arrival is there", () => {
    const h = fixed();
    const p = person("MED3A", "bed", 0, { arrivedMin: 10 });
    h.people = [p, person("ER", "waiting", null)];
    h.events = [ev("p2", 5, "arrive"), ev(p.id, 40, "consult"), ev(p.id, 10, "arrive", "ER", "cardiac: chest pain"), ev(p.id, 10, "triage", "ER", "non_urgent"), ev(p.id, 90, "place", "MED3A", "ICU-indicated, not in ICU corridor stretcher")];
    const path = personPath(h, p);
    expect(path.lines.map((l) => [l.minute, l.kind])).toEqual([[10, "arrive"], [10, "triage"], [40, "consult"], [90, "place"]]);
    expect(path.lines[1].text).toBe("Triage: non-urgent");
    expect(path.lines[3].text).toBe("Placed in Medicine 3A, on a corridor stretcher (ICU-indicated, not in the ICU)");
    expect(path.note).toBeNull();
  });

  it("says earlier events are not kept when the arrival rolled out, and for the run's first residents", () => {
    const h = fixed();
    const late = person("MED3A", "bed", 0, { arrivedMin: 500 });
    const res = person("MED3A", "bed", 1, { arrivedMin: 0 });
    h.events = [ev(late.id, 600, "place", "MED3A", "MED3A")];
    expect(personPath(h, late).note).toMatch(/Earlier events not kept/);
    expect(personPath(h, late).lines).toHaveLength(1);
    expect(personPath(h, res).note).toMatch(/when the run began/);
  });

  it("shows a return and never the sim's foreknowledge of one", () => {
    const h = fixed();
    const p = person("MED3A", "bed", 0, { arrivedMin: 10 });
    h.events = [ev(p.id, 10, "arrive"), ev(p.id, 200, "discharge"), ev(p.id, 200, "return_scheduled", "MED3A", "in 12 d"), ev(p.id, 900, "return", "ER", "visit 2"), ev(p.id, 950, "return_dropped", "MED3A", "visit 3")];
    const path = personPath(h, p);
    expect(path.lines.map((l) => l.kind)).toEqual(["arrive", "discharge", "return"]);
    expect(path.lines[2].text).toBe("Came back to the emergency room (visit 2)");
  });
});

describe("seeingOrder", () => {
  it("sorts by triage, then arrival minute, then number", () => {
    const h = fixed();
    h.people = [
      person("ER", "waiting", null, { triage: "non_urgent", arrivedMin: 1 }), person("ER", "waiting", null, { triage: "urgent", arrivedMin: 60 }),
      person("ER", "waiting", null, { triage: "emergent", arrivedMin: 90 }), person("ER", "waiting", null, { triage: "urgent", arrivedMin: 50 }),
      person("ER", "waiting", null, { triage: "urgent", arrivedMin: 50 }),
      person("ER", "consult", 0, { triage: "emergent", arrivedMin: 0 }),
    ];
    expect(seeingOrder(h).map((p) => p.n)).toEqual([3, 4, 5, 2, 1]);
  });
});

describe("doorToDoctorMedian24h", () => {
  it("takes the median of arrival to doctor for people first seen in the last 24 h, skipping the run's first residents", () => {
    const h = fixed();
    h.people = [
      person("ER", "consult", 0, { arrivedMin: 2900, seenMin: 2910 }),  // 10
      person("ER", "consult", 1, { arrivedMin: 2800, seenMin: 2860 }),  // 60
      person("ER", "workup", 2, { arrivedMin: -30, seenMin: -30 }),     // a first resident: skipped
      person("ER", "waiting", null, { arrivedMin: 2950 }),              // not seen
    ];
    h.gone = [person("ER", "workup", null, { arrivedMin: 2000, seenMin: 2040 }), person("ER", "workup", null, { arrivedMin: 1000, seenMin: 1100 })]; // 40 counts; 1100 is over 24 h ago (3000 - 1440 = 1560)
    expect(doorToDoctorMedian24h(h)).toBe(40);
    h.gone = [];
    expect(doorToDoctorMedian24h(h)).toBe(35);
    h.people = [];
    expect(doorToDoctorMedian24h(h)).toBeNull();
  });
});

describe("censusSeries", () => {
  it("keeps one unit's last 72 rows, oldest first", () => {
    const h = fixed();
    for (let i = 0; i < 80; i += 1) h.hourly.push(row(i, "MED3A", i), row(i, "ICU", 900 + i));
    const s = censusSeries(h, "MED3A");
    expect([s.length, s[0], s.at(-1)]).toEqual([72, 8, 79]);
    expect(censusSeries(h, "ICU", 3)).toEqual([977, 978, 979]);
    expect(censusSeries(h, "W4")).toEqual([]);
  });
});

describe("todayCounts and the ER numbers", () => {
  it("sums today's rows and the hour in progress, and counts doctors and released bodies", () => {
    const h = fixed(); // clock day index: (3000 + 900) / 1440 = 2
    h.hourly = [
      row(10, "ER", 5, { admitted_in: 9, er_lwbs: 4 }),                 // minute 600: day 0, not today
      row(48, "ER", 5, { admitted_in: 2, transferred_in: 1, discharged: 3, transferred_out: 1, died: 1, er_lwbs: 2 }), // minute 2880 + 900 = 3780: day 2
      row(49, "ER", 5, { admitted_in: 1, discharged: 1, er_lwbs: 1 }),
    ];
    h.acc.by.ER.admittedIn = 4; h.acc.by.ER.discharged = 2; h.acc.lwbs = 3;
    expect(todayCounts(h, "ER")).toEqual({ in: 8, out: 7, died: 1, lwbs: 6 });
    // doctors: day shift 07-19 on a 17:00 clock; the first doctor frees after minute 3000, the second is free
    const sc = h.scenario.er;
    h.doctorsFreeAt = Array<number>(Math.max(sc.doctorsDay, sc.doctorsNight)).fill(0);
    h.doctorsFreeAt[0] = 3010;
    expect(doctorsNow(h)).toEqual({ onShift: sc.doctorsDay, busy: 1, free: sc.doctorsDay - 1 });
    h.events = [ev("a", 1000, "released", "MORGUE"), ev("b", 2000, "released", "MORGUE"), ev("c", 2999, "released", "MORGUE")];
    expect(releasedLast24h(h)).toBe(2); // 3000 - 1440 = 1560: minute 1000 is too old
  });
});

describe("complications", () => {
  it("names only what has happened", () => {
    const h = fixed();
    const p = person("MED3A", "stretcher", 30, { icuIndicated: true, boardedMin: 150 });
    expect(complications(h, p)).toEqual(["ICU-indicated, no ICU bed was free", "on a corridor stretcher", "boarded 2.5 h"]);
    const q = person("ER", "boarding", 1, { sinceMin: 2940, boardedMin: 0 });
    expect(complications(h, q)).toEqual(["boarded 1 h"]);
    expect(complications(h, person("MORGUE", "morgue", 0, { icuIndicated: true }))).toEqual([]);
    expect(complications(h, person("MED3A", "bed", 0, { deathU: 0, dieMin: 5000 }))).toEqual([]); // a fated death is not shown
  });
});

describe("isHospitalId", () => {
  it("accepts the new ids and not the ward's", () => {
    for (const ok of ["h:12", "hbed:MED3A:4", "unit:ICU", "queue:ER", "morgue"]) expect(isHospitalId(ok)).toBe(true);
    for (const no of ["bed:A1", "W4-01", "entrance", "h:x", "unit:"]) expect(isHospitalId(no)).toBe(false);
  });
});

describe("round 2 edges", () => {
  it("counts a row in the first hour of the next clock day as that day's, and the hour before as the day before's", () => {
    const h = fixed();
    h.lastMinute = 600; // 15:00 start: day 2 begins at minute 540, hour 9
    h.hourly = [row(8, "ICU", 1, { admitted_in: 5 }), row(9, "ICU", 1, { admitted_in: 2 })];
    expect(todayCounts(h, "ICU").in).toBe(2);
  });

  it("uses a strict 24 h edge for the median and for released bodies", () => {
    const h = fixed(); // now 3000, edge 1560
    h.people = [person("ER", "workup", 0, { arrivedMin: 1500, seenMin: 1560 }), person("ER", "workup", 1, { arrivedMin: 1500, seenMin: 1561 })];
    expect(doorToDoctor24h(h)).toEqual({ median: 61, n: 1, partial: false });
    h.events = [ev("a", 1560, "released", "MORGUE"), ev("b", 1561, "released", "MORGUE")];
    expect(releasedLast24h(h)).toBe(1);
  });

  it("tags the median and the release count partial only when the record cannot cover 24 h", () => {
    const h = fixed();
    h.gone = [person("ER", "workup", null, { arrivedMin: 2000, seenMin: 2040 })];
    h.goneCount = 1;
    expect(doorToDoctor24h(h).partial).toBe(false); // nothing dropped
    h.goneCount = 500;
    expect(doorToDoctor24h(h).partial).toBe(true); // any dropped person
    h.gone[0].arrivedMin = 100;
    expect(doorToDoctor24h(h).partial).toBe(true); // however old the oldest kept one is
    const cap = PARAMS.bufferCap.events.value;
    h.events = Array.from({ length: cap }, (_, i) => ev("x", 2000 + (i % 900), "arrive"));
    expect(releasedPartial(h)).toBe(true);
    h.events[0] = ev("x", 1000, "arrive");
    expect(releasedPartial(h)).toBe(false);
    h.events = h.events.slice(1);
    h.events[0] = ev("x", 2500, "arrive");
    expect(releasedPartial(h)).toBe(false); // not full
  });

  it("switches the ER doctors' shift at 07:00 and 19:00", () => {
    const h = fixed();
    h.scenario = { ...h.scenario, er: { ...h.scenario.er, doctorsDay: 3, doctorsNight: 1 } };
    h.doctorsFreeAt = [0, 0, 0];
    const at = (clockMin: number) => { h.lastMinute = clockMin + 1440 - 900; return doctorsNow(h).onShift; };
    expect([at(6 * 60 + 59), at(7 * 60), at(18 * 60 + 59), at(19 * 60)]).toEqual([1, 3, 3, 1]);
  });

  it("gives each status its pill and line, and a released body still died", () => {
    const h = fixed();
    const bed = person("MED3A", "bed", 0);
    const dying = person("MED3A", "awaiting_morgue", 1, { dieMin: 3000 });
    const morgue = person("MORGUE", "morgue", 0, { dieMin: 2000 });
    const released = person("MORGUE", "morgue", null, { dieMin: 1000 });
    const home = person("MED3A", "bed", 2), out = person("ER", "waiting", null);
    h.people = [bed, dying, morgue];
    h.gone = [released, home, out];
    h.events = [ev(dying.id, 3000, "died", "MED3A"), ev(released.id, 1000, "died", "ICU"), ev(home.id, 50, "discharge", "MED3A"), ev(out.id, 60, "lwbs", "ER", "waited 4 h")];
    expect(personStatus(h, bed)).toEqual({ pill: "In hospital", line: null });
    expect(personStatus(h, dying)).toEqual({ pill: "Died", line: "Died day 3, 17:00 in Medicine 3A." });
    expect(personStatus(h, morgue)).toEqual({ pill: "Died", line: "Died day 3, 00:20 (place not kept)." });
    expect(personStatus(h, released)).toEqual({ pill: "Died", line: "Died day 2, 07:40 in Intensive Care." });
    expect(personStatus(h, home)).toEqual({ pill: "Left", line: "Discharged" });
    expect(personStatus(h, out).line).toMatch(/^Outcome not observed/);
  });

  it("shows the ICU mark only once the person is admitted and boarding or placed", () => {
    const h = fixed();
    h.people = [
      person("ER", "consult", 0, { icuIndicated: true }), person("ER", "boarding", 1, { icuIndicated: true, wants: "ICU" }),
      person("MED3A", "bed", 0, { icuIndicated: true }), person("MED3A", "bed", 1, { icuIndicated: true, admit: false }),
    ];
    const f = floorSummary(h);
    const er = f.flatMap((x) => x.units).find((u) => u.id === "ER")!;
    const med = f.flatMap((x) => x.units).find((u) => u.id === "MED3A")!;
    expect([er.beds[0]?.icu, er.beds[1]?.icu, med.beds[0]?.icu, med.beds[1]?.icu]).toEqual([undefined, true, true, undefined]);
    // the spoken name and the panel's complication line agree with the mark: consult none, boarding present, placed present, not admitted none
    const names = [er.beds[0], er.beds[1], med.beds[0], med.beds[1]].map((c, i) => cellLabel(i < 2 ? er : med, c, c!.slot, false));
    expect(names.map((x) => x.includes("ICU-indicated"))).toEqual([false, true, true, false]);
    expect(h.people.map((p) => complications(h, p).includes("ICU-indicated, no ICU bed was free"))).toEqual([false, true, true, false]);
  });
});
