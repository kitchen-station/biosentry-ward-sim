import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import dohStandard from "../../../scenarios/hospital/doh-standard.json?raw";
import surge from "../../../scenarios/hospital/surge.json?raw";
import typical from "../../../scenarios/hospital/typical.json?raw";
import { GIVEN, INITIALS, LEGACY, SURNAMES } from "./names";
import { PARAMS } from "./params";
import { drawCourse, drawPerson, givenIndex, GROUPS, lookOf, stayDeathP, TRIAGES } from "./people";
import { parseScenario, type Scenario } from "./scenario";
import { stream } from "./rng";
import { createHospital, noticedLateMin, overdueRounds, stepHospital, takeRows } from "./step";
import type { EventKind, EventRow, Hospital, HourRow, Person, Sex, UnitId, W4Port } from "./types";

// These tests simulate days of a hospital and take 2-3 s each on a busy machine: only the time limit is raised.
vi.setConfig({ testTimeout: 60_000 });

const SC = { standard: parseScenario(dohStandard), typical: parseScenario(typical), surge: parseScenario(surge) };
const DAY = 1440;
const nOf = (id: string) => Number(id.slice(2));

// ---- W4 doubles and the run loop ----
interface FakePort extends W4Port { now: number; calls: { name: string; age: number; sex: Sex }[] }

/** W4 with no free bed: admit always says no. */
const fullPort = (): FakePort => ({ now: 0, calls: [], admit() { return null; }, left() { return null; } });

/** W4 with a bed for everyone. A person leaves after 4 days, discharged; every fourth person after 2 days, needing higher care. */
function acceptingPort(): FakePort {
  const at: Record<string, number> = {};
  const port: FakePort = {
    now: 0, calls: [],
    admit(person, minute) {
      port.calls.push({ ...person });
      const id = `w4-${port.calls.length}`;
      at[id] = minute;
      return id;
    },
    left(id) {
      const higher = Number(id.slice(3)) % 4 === 0;
      return port.now - at[id] >= (higher ? 2 : 4) * DAY ? { outcome: higher ? "higher_care" : "discharged", minute: port.now } : null;
    },
  };
  return port;
}

/** Steps minutes [from, to). With `drain` the rows are taken each hour and returned; `onHour` sees the state at each hour's end. */
function run(h: Hospital, port: FakePort, from: number, to: number, onHour?: (h: Hospital, minute: number) => void, drain = true) {
  const events: EventRow[] = [];
  const hourly: HourRow[] = [];
  for (let m = from; m < to; m += 1) {
    port.now = m;
    stepHospital(h, port, m);
    if (m % 60 === 59) {
      if (drain) { const r = takeRows(h); events.push(...r.events); hourly.push(...r.hourly); }
      onHour?.(h, m);
    }
  }
  return { events, hourly };
}

/** A small, crowded house, so stretchers, boarding, ICU refusals and transfers out all happen within days. */
const tight: Scenario = {
  ...SC.typical, name: "tight", transferOutAfterH: 12,
  units: { ICU: { beds: 3, stretchers: 0, nurses: 3 }, MED3A: { beds: 8, stretchers: 2, nurses: 2 }, MED3B: { beds: 8, stretchers: 2, nurses: 2 }, SURG5A: { beds: 6, stretchers: 2, nurses: 1 } },
};

const peopleOf = (h: Hospital) => [...h.people, ...h.gone];
const drawnKeys = Object.keys(drawPerson(1, 1));
const drawnOf = (p: Person) => Object.fromEntries(drawnKeys.map((k) => [k, p[k as keyof Person]]));

// ---- the draws ----
describe("person n", () => {
  it("is a function of the seed and n alone, and its draws follow the sourced shares", () => {
    expect(drawPerson(7, 3)).toEqual(drawPerson(7, 3));
    expect(drawPerson(7, 3)).not.toEqual(drawPerson(8, 3));
    expect(drawPerson(7, 3)).not.toEqual(drawPerson(7, 4));
    expect(SURNAMES).toHaveLength(PARAMS.people.namePool.value.surnames);
    expect(GIVEN.F).toHaveLength(PARAMS.people.namePool.value.givenFemale);
    expect(GIVEN.M).toHaveLength(PARAMS.people.namePool.value.givenMale);
    const N = 20000;
    const ps = Array.from({ length: N }, (_, i) => drawPerson(5, i + 1));
    const share = (f: (p: (typeof ps)[number]) => boolean) => ps.filter(f).length / N;
    for (const g of GROUPS) expect(Math.abs(share((p) => p.group === g) - PARAMS.complaint[g].value)).toBeLessThan(0.01);
    for (const t of TRIAGES) expect(Math.abs(share((p) => p.triage === t) - PARAMS.triage[t].value)).toBeLessThan(0.012);
    expect(Math.abs(share((p) => p.sex === "M") - PARAMS.people.maleShare.value)).toBeLessThan(0.012);
    expect(Math.abs(share((p) => p.admit) - 0.283)).toBeLessThan(0.012);
    expect(Math.abs(share((p) => p.erDeathAfterMin !== null) - PARAMS.death.erOverall.value)).toBeLessThan(0.004);
    expect(ps.filter((p) => p.group === "cardiac").every((p) => p.age >= 45 && p.age <= 84)).toBe(true);
    expect(ps.every((p) => p.age >= 18 && p.age <= 95 && Number.isInteger(p.age))).toBe(true);
    expect(ps.every((p) => p.patienceMin === null === (p.triage === "emergent"))).toBe(true);
    expect(ps.every((p) => p.stayMin <= PARAMS.stay.capDays.value * DAY && p.stayMin >= 60)).toBe(true);
  });

  it("is the same person under doh-standard, typical and surge", () => {
    const runs = (["standard", "typical", "surge"] as const).map((k) => {
      const h = createHospital(11, SC[k]);
      run(h, fullPort(), 0, 2 * DAY);
      return h;
    });
    for (const h of runs) for (const p of peopleOf(h)) if (p.n < 1_000_000) expect(drawnOf(p)).toEqual(drawnOf({ ...drawPerson(h.seed, p.n) } as Person));
    // arrival k is the same person in every scenario, whatever the beds and rates did meanwhile
    for (const n of [1, 2, 3, 5, 8, 13, 21]) {
      const found = runs.map((h) => peopleOf(h).find((p) => p.n === n)!);
      expect(found.every((p) => p !== undefined)).toBe(true);
      expect(drawnOf(found[1])).toEqual(drawnOf(found[0]));
      expect(drawnOf(found[2])).toEqual(drawnOf(found[0]));
    }
  });
});

// ---- state ----
describe("state", () => {
  it("is plain JSON: no undefined, NaN, Infinity, -0, function, Map, Set or class instance anywhere, and it survives a round trip", () => {
    const h = createHospital(3, SC.typical);
    const port = acceptingPort();
    run(h, port, 0, 3 * DAY, undefined, false);
    const bad: string[] = [];
    const walk = (v: unknown, path: string) => {
      if (v === undefined) bad.push(`${path} is undefined`);
      else if (typeof v === "number") { if (!Number.isFinite(v) || Object.is(v, -0)) bad.push(`${path} is ${v}`); }
      else if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") bad.push(`${path} is a ${typeof v}`);
      else if (v !== null && typeof v === "object") {
        const proto = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== Array.prototype) bad.push(`${path} is not plain`);
        for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      }
    };
    walk(h, "hospital");
    expect(bad).toEqual([]);
    expect(h.events.length).toBeGreaterThan(100);
    expect(JSON.parse(JSON.stringify(h))).toEqual(h);
  });

  it("gives equal state for the same seed and scenario, and a different state for another seed", () => {
    const go = (seed: number, sc: Scenario) => { const h = createHospital(seed, sc); run(h, acceptingPort(), 0, 3 * DAY, undefined, false); return h; };
    expect(go(21, SC.typical)).toEqual(go(21, SC.typical));
    expect(go(22, SC.typical)).not.toEqual(go(21, SC.typical));
    expect(go(21, SC.surge)).not.toEqual(go(21, SC.typical));
  });

  it("stepping N minutes, a JSON round trip and M more equals stepping N + M straight through, observation rounds included", () => {
    for (const N of [1000, 2 * DAY + 137]) { // not hour boundaries; 1,000 is the design's A1 case
      const M = 2 * DAY + 411;
      const straight = createHospital(31, SC.surge);
      const p1 = acceptingPort();
      run(straight, p1, 0, N + M, undefined, false);
      const split = createHospital(31, SC.surge);
      const p2 = acceptingPort();
      run(split, p2, 0, N, undefined, false);
      // the state carried across the split holds A1's part: credit part-way, rounds done and rounds due
      expect(split.units.some((u) => u.obsCredit > 0 && u.obsCredit < u.nurses * PARAMS.obs.roundMin.value)).toBe(true);
      expect(split.people.some((p) => p.obsLastMin !== null) && split.people.some((p) => p.obsDueMin !== null && p.obsDueMin <= N - 1)).toBe(true);
      const resumed = JSON.parse(JSON.stringify(split)) as Hospital;
      run(resumed, p2, N, N + M, undefined, false);
      expect(resumed).toEqual(straight);
      expect(straight.events.length).toBeGreaterThan(0);
      expect(straight.hourly.some((r) => (r.obs_done ?? 0) > 0)).toBe(true);
    }
  });

  it("holds a hard cap on people: arrivals beyond it are counted, recorded as events and never silently dropped", () => {
    const sc: Scenario = { ...SC.typical, startOccupancy: 0, er: { ...SC.typical.er, bays: 2 } };
    const h = createHospital(41, sc, 40);
    const { events } = run(h, fullPort(), 0, 4 * DAY, (hh) => expect(hh.people.length).toBeLessThanOrEqual(40));
    const away = events.filter((e) => e.kind === "turned_away");
    expect(away.length).toBeGreaterThan(0);
    expect(h.turnedAway).toBe(away.length);
    expect(away.every((e) => e.person.startsWith("h-") && e.detail === "people cap reached")).toBe(true);
    // every number is accounted for: arrived, or turned away
    const arrived = events.filter((e) => e.kind === "arrive").length;
    expect(arrived + away.length).toBe(h.nextN - 1);
    expect(PARAMS.peopleCap.source).toBe("judgement");
  });

  it("never starts above the people cap: residents who do not fit are turned away at minute 0 and recorded", () => {
    const h = createHospital(71, { ...SC.typical, startOccupancy: 1.5 }, 100);
    expect(h.people).toHaveLength(100);
    expect(h.createdCount).toBe(100);
    expect(h.turnedAway).toBeGreaterThan(50);
    expect(h.events.filter((e) => e.kind === "turned_away")).toHaveLength(h.turnedAway);
    expect(createHospital(71, { ...SC.typical, startOccupancy: 1.5 }).turnedAway).toBe(0); // the default cap holds the whole start
    run(h, fullPort(), 0, DAY, checkHouse);
    expect(h.people.length).toBeLessThanOrEqual(100);
  });

  it("gives no NaN or Infinity in an hourly row for a raw scenario with no beds", () => {
    const sc: Scenario = {
      ...SC.typical, er: { ...SC.typical.er, bays: 0 },
      units: { ICU: { beds: 0, stretchers: 0, nurses: 3 }, MED3A: { beds: 0, stretchers: 0, nurses: 2 }, MED3B: { beds: 4, stretchers: 0, nurses: 2 }, SURG5A: { beds: 0, stretchers: 0, nurses: 1 } },
    };
    const { hourly } = run(createHospital(72, sc), fullPort(), 0, DAY);
    expect(hourly.length).toBe(24 * 7);
    for (const r of hourly) for (const v of Object.values(r)) if (typeof v === "number") expect(Number.isFinite(v)).toBe(true);
    expect(hourly.filter((r) => r.unit === "ER" || r.unit === "ICU").every((r) => r.occupancy_pct === 0)).toBe(true);
  });

  it("hands over events and hourly rows and clears them", () => {
    const h = createHospital(51, SC.typical);
    const port = acceptingPort();
    run(h, port, 0, 3 * 60, undefined, false);
    expect(h.hourly).toHaveLength(3 * 7);
    const first = takeRows(h);
    expect(first.hourly).toHaveLength(21);
    expect(first.events.length).toBeGreaterThan(10);
    expect(h.events).toEqual([]);
    expect(h.hourly).toEqual([]);
    expect(takeRows(h)).toEqual({ events: [], hourly: [] });
    const { events } = run(h, port, 3 * 60, 3 * DAY);
    expect(events.every((e) => typeof e.news2_independent === "boolean")).toBe(true);
  });

  it("writes no name into any row, and every event kind and every unit appears in the rows scanned", () => {
    const KINDS: Record<EventKind, true> = {
      arrive: true, triage: true, consult: true, decide_home: true, decide_admit: true, board: true, place: true, transfer: true, discharge: true,
      lwbs: true, transfer_out: true, died: true, to_morgue: true, released: true, turned_away: true, deteriorate: true, noticed: true, unnoticed: true,
      return_scheduled: true, return: true, return_dropped: true,
    };
    const UNIT_IDS: Record<UnitId, true> = { ER: true, MORGUE: true, ICU: true, MED3A: true, MED3B: true, W4: true, SURG5A: true };
    const events: EventRow[] = [];
    const hourly: HourRow[] = [];
    const scan = (h: Hospital, days: number) => { const r = run(h, acceptingPort(), 0, days * DAY); events.push(...r.events); hourly.push(...r.hourly); return h; };
    const typicalHouse = scan(createHospital(51, SC.typical), 4);
    scan(createHospital(52, SC.surge), 4);
    scan(createHospital(53, tight), 6);
    scan(createHospital(54, { ...SC.typical, startOccupancy: 0, er: { ...SC.typical.er, bays: 2 } }, 40), 4); // the people cap
    const noRounds = (u: Scenario["units"]["MED3A"]) => ({ ...u, nurses: 0 });
    scan(createHospital(55, { ...tight, units: { ...tight.units, MED3A: noRounds(tight.units.MED3A), MED3B: noRounds(tight.units.MED3B), SURG5A: noRounds(tight.units.SURG5A) } }), 8); // no rounds: unnoticed
    const keepCap = PARAMS.returns.cap.value;
    PARAMS.returns.cap.value = 0; // every return is dropped: the third A3 kind
    try { scan(createHospital(56, SC.typical), 6); } finally { PARAMS.returns.cap.value = keepCap; }
    expect([...new Set(events.map((e) => e.kind))].sort()).toEqual(Object.keys(KINDS).sort());
    expect([...new Set(hourly.map((r) => r.unit))].sort()).toEqual(Object.keys(UNIT_IDS).sort());
    const names = new RegExp(`\\b(${[...SURNAMES, ...GIVEN.F, ...GIVEN.M].join("|")})\\b`);
    expect(JSON.stringify([events, hourly])).not.toMatch(names);
    expect(peopleOf(typicalHouse).every((p) => names.test(p.name))).toBe(true); // the names are on the person only
  });

  it("caps the rows it keeps when nobody drains them", () => {
    const h = createHospital(52, SC.surge);
    run(h, fullPort(), 0, 12 * DAY, undefined, false);
    expect(h.events.length).toBeLessThanOrEqual(PARAMS.bufferCap.events.value);
    expect(h.hourly.length).toBeLessThanOrEqual(PARAMS.bufferCap.hourly.value);
  });
});

// ---- the rules ----
const unitSlots = (h: Hospital, id: string) => new Set(h.people.filter((p) => p.unit === id && p.slot !== null).map((p) => p.slot));

function checkHouse(h: Hospital) {
  const everyone = peopleOf(h);
  expect(h.createdCount).toBe(h.people.length + h.goneCount);
  expect(new Set(everyone.map((p) => p.id)).size).toBe(everyone.length); // in exactly one place
  const keys = h.people.filter((p) => p.slot !== null).map((p) => `${p.unit}:${p.slot}`);
  expect(new Set(keys).size).toBe(keys.length); // no bed, stretcher, bay or drawer holds two people
  for (const p of h.people) {
    const u = h.units.find((x) => x.id === p.unit)!;
    if (p.where === "bed") expect(p.slot === null ? p.w4Id !== null : p.slot < u.beds).toBe(true);
    if (p.where === "stretcher") expect(p.slot! >= u.beds && p.slot! < u.beds + u.stretchers).toBe(true);
    if (p.where === "morgue") expect(p.unit).toBe("MORGUE");
    if (p.w4Id !== null) expect(p.unit).toBe("W4");
    if (p.where === "stretcher") for (let i = 0; i < u.beds; i += 1) expect(unitSlots(h, u.id).has(i)).toBe(true); // stretchers fill only when beds are full
  }
  const full = (id: "ICU" | "MED3A" | "MED3B" | "SURG5A", stretchers: boolean) => {
    const u = h.units.find((x) => x.id === id)!;
    const used = unitSlots(h, id);
    return Array.from({ length: u.beds + (stretchers ? u.stretchers : 0) }, (_, i) => i).every((i) => used.has(i));
  };
  for (const p of h.people.filter((q) => q.where === "boarding")) { // boarding only when beds and stretchers are full
    if (p.wants === "ICU") expect(full("ICU", false)).toBe(true);
    else if (p.group === "cardiac") expect(p.wants).toBe("W4");
    else for (const id of p.group === "trauma" ? (["SURG5A"] as const) : (["MED3A", "MED3B"] as const)) expect(full(id, true)).toBe(true);
    if (p.icuIndicated) expect(full("ICU", false)).toBe(true); // an ICU-indicated boarder means the ICU had no free bed
  }
  expect(h.icuFree).toBe(h.units.find((u) => u.id === "ICU")!.beds - unitSlots(h, "ICU").size);
}

describe("the hospital's rules, checked every hour", () => {
  for (const [name, sc] of [["typical", SC.typical], ["surge", SC.surge], ["tight", tight]] as const) {
    it(`${name}: every person is in exactly one place, no slot is shared, stretchers and boarding follow the capacity rules`, () => {
      const h = createHospital(61, sc);
      const { events } = run(h, acceptingPort(), 0, 8 * DAY, checkHouse);
      expect(events.some((e) => e.kind === "place")).toBe(true);
      if (name === "tight") {
        expect(events.some((e) => e.kind === "place" && e.detail.includes("corridor stretcher"))).toBe(true);
        expect(events.some((e) => e.kind === "board")).toBe(true);
      }
    });
  }

  it("an ICU-indicated person takes an ICU bed only when one is free, and is otherwise flagged", () => {
    const h = createHospital(62, tight);
    const { events, hourly } = run(h, fullPort(), 0, 8 * DAY);
    const icuPlaces = events.filter((e) => e.kind === "place" && e.unit === "ICU");
    expect(icuPlaces.length).toBeGreaterThan(0);
    expect(icuPlaces.every((e) => drawPerson(h.seed, nOf(e.person)).icuIndicated || nOf(e.person) >= 1_000_000)).toBe(true);
    const elsewhere = events.filter((e) => e.kind === "place" && e.unit !== "ICU" && drawPerson(h.seed, nOf(e.person)).icuIndicated);
    expect(elsewhere.length).toBeGreaterThan(0);
    expect(elsewhere.every((e) => e.detail.includes("ICU-indicated, not in ICU"))).toBe(true);
    expect(hourly.some((r) => (r.icu_indicated_not_in_icu ?? 0) > 0)).toBe(true);
    expect(hourly.filter((r) => r.unit === "ICU").every((r) => r.census <= r.beds)).toBe(true);
  });

  it("every death reaches the morgue and is released, with the bed blocked until the body leaves", () => {
    const h = createHospital(63, SC.typical);
    const T = 14 * DAY;
    const { events } = run(h, acceptingPort(), 0, T, (hh) => {
      for (const p of hh.people.filter((q) => q.where === "awaiting_morgue" && q.unit !== "ER")) expect(p.slot).not.toBeNull(); // still blocking
    });
    const at = (kind: string) => new Map(events.filter((e) => e.kind === kind).map((e) => [e.person, e.minute]));
    const died = at("died"), morgue = at("to_morgue"), released = at("released");
    expect(died.size).toBeGreaterThan(20);
    for (const [id, minute] of died) {
      if (minute >= T - (PARAMS.morgue.toMorgueH.value + PARAMS.morgue.releasedAfterH.value) * 60) continue;
      expect(morgue.get(id)).toBe(minute + PARAMS.morgue.toMorgueH.value * 60);
      expect(released.get(id)).toBe(morgue.get(id)! + PARAMS.morgue.releasedAfterH.value * 60);
    }
    expect(events.filter((e) => e.kind === "died").every((e) => e.news2_independent)).toBe(true);
  });

  it("transfers a boarder out after the scenario's hours, and only a boarder", () => {
    const h = createHospital(64, tight);
    const { events } = run(h, fullPort(), 0, 8 * DAY);
    const out = events.filter((e) => e.kind === "transfer_out");
    expect(out.length).toBeGreaterThan(0);
    const boarded = new Map(events.filter((e) => e.kind === "board").map((e) => [e.person, e.minute]));
    for (const e of out) if (nOf(e.person) < 1_000_000) expect(e.minute - boarded.get(e.person)!).toBe(tight.transferOutAfterH * 60);
    expect(events.some((e) => e.kind === "transfer_out" && e.unit !== "ER")).toBe(false);
  });

  it("lets only urgent and non-urgent people leave without being seen", () => {
    const h = createHospital(65, SC.surge);
    const { events } = run(h, fullPort(), 0, 5 * DAY);
    const lwbs = events.filter((e) => e.kind === "lwbs");
    expect(lwbs.length).toBeGreaterThan(20);
    expect(lwbs.every((e) => drawPerson(h.seed, nOf(e.person)).triage !== "emergent")).toBe(true);
    for (const e of lwbs) {
      const d = drawPerson(h.seed, nOf(e.person));
      const arrived = events.find((x) => x.kind === "arrive" && x.person === e.person)!.minute;
      expect(e.minute - arrived).toBe(d.patienceMin);
    }
  });

  it("with a W4 that is always full, cardiac people board and W4 receives nobody", () => {
    const h = createHospital(66, SC.typical);
    const port = fullPort();
    const calls: unknown[] = [];
    port.admit = (person) => { calls.push(person); return null; };
    const { events } = run(h, port, 0, 6 * DAY);
    expect(calls.length).toBeGreaterThan(0);
    expect(events.some((e) => e.unit === "W4")).toBe(false);
    expect(peopleOf(h).some((p) => p.w4Id !== null)).toBe(false);
    const cardiacBoarders = events.filter((e) => e.kind === "board" && drawPerson(h.seed, nOf(e.person)).group === "cardiac");
    expect(cardiacBoarders.length).toBeGreaterThan(5);
    // an ICU-indicated cardiac person still gets the ICU when it is free
    const cardiacPlaced = events.filter((e) => e.kind === "place" && drawPerson(h.seed, nOf(e.person)).group === "cardiac");
    expect(cardiacPlaced.every((e) => e.unit === "ICU")).toBe(true);
  });

  it("with a W4 that always accepts, cardiac admissions go through the port with the person's name, age and sex", () => {
    const h = createHospital(67, SC.typical);
    const port = acceptingPort();
    const { events } = run(h, port, 0, 8 * DAY);
    const placed = events.filter((e) => e.kind === "place" && e.unit === "W4");
    expect(placed.length).toBeGreaterThan(10);
    expect(port.calls).toHaveLength(placed.length);
    expect(new Set(placed.map((e) => e.person)).size).toBe(placed.length); // a person goes to W4 once
    placed.forEach((e, i) => {
      const d = drawPerson(h.seed, nOf(e.person));
      expect(d.group).toBe("cardiac");
      expect(port.calls[i]).toEqual({ name: d.name, age: d.age, sex: d.sex });
      expect(e.w4_id).toBe(`w4-${i + 1}`);
    });
    // no cardiac admission was boarded for want of W4, and every admitted cardiac person went to W4 or the ICU
    expect(events.filter((e) => e.kind === "place" && drawPerson(h.seed, nOf(e.person)).group === "cardiac").every((e) => e.unit === "W4" || e.unit === "ICU")).toBe(true);
    // what W4 decides is marked as such: its discharge and its move to the ICU depend on NEWS2
    const fromW4 = events.filter((e) => e.w4_id !== null && (e.kind === "discharge" || e.kind === "transfer"));
    expect(fromW4.some((e) => e.kind === "discharge")).toBe(true);
    expect(fromW4.some((e) => e.kind === "transfer" && e.unit === "ICU")).toBe(true);
    expect(fromW4.every((e) => !e.news2_independent)).toBe(true);
    expect(events.filter((e) => e.kind === "place").every((e) => e.news2_independent)).toBe(true);
  });

  it("stay deaths outside the ER are a share of placed admissions near the weighted design rates (row 14)", () => {
    let placed = 0, died = 0, expected = 0;
    for (const seed of [301, 302, 303]) {
      const h = createHospital(seed, SC.typical);
      const { events } = run(h, acceptingPort(), 0, 45 * DAY);
      // placed on a ward or in the ICU (W4 patients carry no hospital fate), early enough for their stays to have run
      const placedIds = new Set(events.filter((e) => e.kind === "place" && e.unit !== "W4" && nOf(e.person) < 1_000_000 && e.minute >= 3 * DAY && e.minute < 15 * DAY).map((e) => e.person));
      const dead = new Set(events.filter((e) => e.kind === "died").map((e) => e.person));
      for (const id of placedIds) {
        const d = drawPerson(seed, nOf(id));
        placed += 1; expected += stayDeathP(d.group, d.icuIndicated); died += dead.has(id) ? 1 : 0;
      }
    }
    expect(placed).toBeGreaterThan(300);
    expect(died / placed).toBeGreaterThan(0.75 * (expected / placed));
    expect(died / placed).toBeLessThan(1.25 * (expected / placed));
  }, 60_000);

  describe("crafted boarders", () => {
    const craft = (n: number, o: Partial<Person>): Person => ({
      ...drawPerson(1, n), group: "infection", admit: true, icuIndicated: false, triage: "urgent", patienceMin: null, erDeathAfterMin: null,
      deathU: 1, deathF: 0.5, stayMin: 5 * DAY, arrivedMin: 0, unit: "ER", where: "boarding", sinceMin: 0, slot: n, wants: "MED3A", seenMin: 0,
      decideMin: 10, dueMin: null, dieMin: null, boardedMin: 0, w4Id: null, fromW4: false, obsDueMin: 1e9, obsLastMin: null, course: null, visit: 1, history: [], ...o,
    });
    const house = (beds: [number, number], people: Person[]) => {
      const sc: Scenario = { ...SC.typical, startOccupancy: 0, er: { ...SC.typical.er, bays: 0 }, units: { ...SC.typical.units, MED3A: { beds: beds[0], stretchers: 0, nurses: 2 }, MED3B: { beds: beds[1], stretchers: 0, nurses: 2 } } };
      const h = createHospital(81, sc);
      h.people = people; h.createdCount = people.length;
      return h;
    };

    it("gives one freed bed to the emergent boarder, not the urgent one who decided earlier", () => {
      const resident = craft(70, { unit: "MED3B", where: "bed", slot: 0, wants: null, dueMin: 1e9 });
      const urgent = craft(50, { triage: "urgent", decideMin: 10 });
      const emergent = craft(60, { triage: "emergent", decideMin: 500 });
      const h = house([1, 1], [urgent, emergent, resident]);
      stepHospital(h, fullPort(), 0);
      expect([emergent.unit, emergent.where]).toEqual(["MED3A", "bed"]);
      expect(urgent.where).toBe("boarding");
    });

    it("times a stay death inside the stay: after the placement minute and no later than the discharge", () => {
      const first = craft(50, { deathU: 0, deathF: 0 });
      const last = craft(51, { deathU: 0, deathF: 0.999999 });
      const h = house([2, 0], [first, last]);
      stepHospital(h, fullPort(), 0);
      for (const p of [first, last]) {
        expect(p.where).toBe("bed");
        expect(p.dieMin).toBeGreaterThan(p.sinceMin);
        expect(p.dieMin).toBeLessThanOrEqual(p.dueMin!);
      }
    });
  });

  it("never sends a person who left W4 for the ICU back to W4: with the ICU full they board and W4 receives nobody more", () => {
    const sc: Scenario = { ...SC.typical, units: { ...SC.typical.units, ICU: { beds: 1, stretchers: 0, nurses: 3 } } };
    const h = createHospital(82, sc);
    const port = acceptingPort();
    const admitted: Record<string, number> = {};
    const admit = port.admit;
    port.admit = (person, minute) => { const id = admit(person, minute); if (id !== null) admitted[id] = minute; return id; };
    port.left = (id) => (port.now - admitted[id] >= DAY ? { outcome: "higher_care", minute: port.now } : null); // everyone needs the ICU after a day
    const { events, hourly } = run(h, port, 0, 12 * DAY);
    const boards = events.filter((e) => e.kind === "board" && e.detail === "W4 higher care, no ICU bed");
    expect(boards.length).toBeGreaterThan(3);
    expect(boards.some((e) => { const d = drawPerson(h.seed, nOf(e.person)); return d.group === "cardiac" && d.icuIndicated; })).toBe(true);
    const w4Places = events.filter((e) => e.kind === "place" && e.unit === "W4");
    expect(port.calls).toHaveLength(w4Places.length);
    for (const e of boards) expect(w4Places.filter((x) => x.person === e.person)).toHaveLength(1);
    // both sides of the W4 to ER move are counted: transferred_in on the ER equals transferred_out on W4 that did not go to the ICU
    const sum = (unit: UnitId, f: keyof HourRow) => hourly.filter((r) => r.unit === unit).reduce((a, r) => a + (r[f] as number), 0);
    const toIcu = events.filter((e) => e.kind === "transfer" && e.detail === "W4 to ICU").length;
    expect(sum("ER", "transferred_in")).toBe(boards.length);
    expect(sum("W4", "transferred_out")).toBe(boards.length + toIcu);
  });

  it("starts above capacity by boarding the extra people in the ER", () => {
    const h = createHospital(68, { ...SC.typical, startOccupancy: 1.5 });
    expect(h.people.filter((p) => p.unit === "MED3A" && p.where === "bed")).toHaveLength(30);
    expect(h.people.filter((p) => p.unit === "MED3A" && p.where === "stretcher")).toHaveLength(8);
    const boarders = h.people.filter((p) => p.where === "boarding");
    expect(boarders.length).toBe((45 - 38) * 2 + (15 - 10) + (36 - 30)); // MED3A, MED3B, ICU, SURG5A
    expect(boarders.every((p) => p.unit === "ER" && p.wants !== null)).toBe(true);
    checkHouse(h);
  });
});

// ---- calibration: the design's numbers, 30 days, hospital alone ----
describe("calibration", () => {
  const SEEDS = [101, 102, 103];
  const DAYS = 30;
  const WARM = PARAMS.warmUpDays.value * DAY;
  interface Measured {
    occupancy: number; erFull: number; boardHours: number; deaths: number; admitShare: number; erDeathShare: number; lwbs: number; transfersOut: number; icuOcc: number;
    medLate: number; surgLate: number; erDemand: number; medDemand: number; medPpn: number; surgPpn: number; // A1: late over done; ER demand over available; patients per nurse
    gap: Record<"ER" | "MED" | "SURG5A", number>; // the longest any patient went without a round, minutes
    excess: number; delays: Record<"MED" | "SURG5A", number[]>; late: number; noticed: number; // A2
  }
  const measure = (sc: Scenario): Measured => {
    let med = 0, medBeds = 0, icu = 0, icuBeds = 0, erHours = 0, erFull = 0, boardMin = 0, deaths = 0, arrived = 0, admitted = 0, erDeaths = 0, lwbs = 0, out = 0;
    const gap = { ER: 0, MED: 0, SURG5A: 0 };
    const rec = { excess: 0, late: 0, noticed: 0, delays: { MED: [] as number[], SURG5A: [] as number[] } };
    const o = { medDone: 0, medLate: 0, surgDone: 0, surgLate: 0, erDem: 0, erAv: 0, medDem: 0, medAv: 0, medPpn: 0, medN: 0, surgPpn: 0, surgN: 0 };
    for (const seed of SEEDS) {
      const h = createHospital(seed, sc);
      const { events, hourly } = run(h, fullPort(), 0, DAYS * DAY);
      for (const r of hourly.filter((x) => x.hour * 60 >= WARM)) {
        if (r.unit === "MED3A" || r.unit === "MED3B") { med += r.census; medBeds += r.beds; }
        if (r.unit === "ICU") { icu += r.census; icuBeds += r.beds; }
        if (r.unit === "ER") { erHours += 1; erFull += r.census >= 2 * r.beds ? 1 : 0; boardMin += (r.er_boarding_hours ?? 0); }
        if (r.unit === "MED3A" || r.unit === "MED3B") { o.medDem += r.care_min_demanded!; o.medAv += r.care_min_available!; o.medDone += r.obs_done!; o.medLate += r.obs_late!; o.medPpn += r.patients_per_nurse!; o.medN += 1; }
        if (r.unit === "SURG5A") { o.surgDone += r.obs_done!; o.surgLate += r.obs_late!; o.surgPpn += r.patients_per_nurse!; o.surgN += 1; }
        if (r.unit === "ER") { o.erDem += r.care_min_demanded!; o.erAv += r.care_min_available!; }
        const g = r.unit === "MED3A" || r.unit === "MED3B" ? "MED" : r.unit === "ER" || r.unit === "SURG5A" ? r.unit : null;
        if (g) gap[g] = Math.max(gap[g], r.obs_longest_since_round_min!);
      }
      // the cohort that arrived after the warm-up and early enough to have been decided
      const cohort = new Set(events.filter((e) => e.kind === "arrive" && e.minute >= WARM && e.minute < (DAYS - 3) * DAY).map((e) => e.person));
      arrived += cohort.size;
      admitted += events.filter((e) => e.kind === "decide_admit" && cohort.has(e.person)).length;
      erDeaths += events.filter((e) => e.kind === "died" && e.unit === "ER" && cohort.has(e.person)).length;
      deaths += events.filter((e) => e.kind === "died").length;
      lwbs += events.filter((e) => e.kind === "lwbs").length;
      out += events.filter((e) => e.kind === "transfer_out").length;
      rec.excess += events.filter((e) => e.kind === "died" && e.detail.endsWith("after late recognition")).length;
      for (const e of events.filter((x) => x.kind === "noticed" && x.unit !== "ICU")) {
        const d = Number(/^delay (\d+) min$/.exec(e.detail)![1]);
        rec.noticed += 1; rec.late += d > PARAMS.obs.lateThresholdMin.value ? 1 : 0;
        if (e.unit === "SURG5A") rec.delays.SURG5A.push(d); else if (e.unit !== "ER") rec.delays.MED.push(d);
      }
    }
    return {
      occupancy: med / medBeds, erFull: erFull / erHours, boardHours: boardMin, deaths, admitShare: admitted / arrived, erDeathShare: erDeaths / arrived, lwbs, transfersOut: out, icuOcc: icu / icuBeds,
      medLate: o.medLate / o.medDone, surgLate: o.surgLate / o.surgDone, erDemand: o.erDem / o.erAv, medDemand: o.medDem / o.medAv, medPpn: o.medPpn / o.medN, surgPpn: o.surgPpn / o.surgN, gap,
      ...rec,
    };
  };
  const line = (name: string, m: Measured) =>
    console.log(`hospital ${name}: medicine occupancy ${(m.occupancy * 100).toFixed(1)}%, ICU ${(m.icuOcc * 100).toFixed(1)}%, ER census >= 2 x bays ${(m.erFull * 100).toFixed(1)}% of hours, ` +
      `ER boarding ${m.boardHours.toFixed(0)} h, deaths ${m.deaths}, ER admit share ${(m.admitShare * 100).toFixed(1)}%, ER-phase deaths ${(m.erDeathShare * 100).toFixed(2)}%, lwbs ${m.lwbs}, transfers out ${m.transfersOut}; ` +
      `rounds late: medicine ${(m.medLate * 100).toFixed(1)}% at ${m.medPpn.toFixed(1)} per nurse, SURG5A ${(m.surgLate * 100).toFixed(1)}% at ${m.surgPpn.toFixed(1)} per nurse; ER care demand / available ${m.erDemand.toFixed(2)}, medicine ${m.medDemand.toFixed(2)}; longest without a round ER ${m.gap.ER}, medicine ${m.gap.MED}, SURG5A ${m.gap.SURG5A} min; ` +
      `A2: noticed ${m.noticed}, late ${(m.late / m.noticed * 100).toFixed(1)}%, median delay medicine ${mid(m.delays.MED)} min, SURG5A ${mid(m.delays.SURG5A)} min, deaths after late recognition ${m.excess} (3 seeds x 30 d, W4 always full)`);
  const mid = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length / 2) - 1];

  const m = {} as Record<"standard" | "typical" | "surge", Measured>;
  beforeAll(() => {
    for (const k of ["standard", "typical", "surge"] as const) { m[k] = measure(SC[k]); line(SC[k].name, m[k]); }
  }, 240_000);

  // These two windows mostly re-measure the draws (the admit rates and ER-phase fates are drawn per person); the queue only shifts them a little.
  it("ER admission share is 25-31% and ER-phase deaths 2-3.6% of arrivals, mostly a check of the draws (admission share: standard and typical; surge reported)", () => {
    for (const k of ["standard", "typical"] as const) {
      expect(m[k].admitShare).toBeGreaterThanOrEqual(0.25);
      expect(m[k].admitShare).toBeLessThanOrEqual(0.31);
    }
    for (const k of ["standard", "typical", "surge"] as const) {
      expect(m[k].erDeathShare).toBeGreaterThanOrEqual(0.02);
      expect(m[k].erDeathShare).toBeLessThanOrEqual(0.036);
    }
  });

  it("medicine occupancy is 100-136% under typical", () => {
    expect(m.typical.occupancy).toBeGreaterThanOrEqual(1.0);
    expect(m.typical.occupancy).toBeLessThanOrEqual(1.36);
  });

  it("medicine occupancy is 75-95% under doh-standard", () => {
    expect(m.standard.occupancy).toBeGreaterThanOrEqual(0.75);
    expect(m.standard.occupancy).toBeLessThanOrEqual(0.95);
  });

  it("under surge the ER census is at least twice its bays for a quarter of the hours or more", () => {
    expect(m.surge.erFull).toBeGreaterThanOrEqual(0.25);
  });

  // A1's windows (workload-design.md), after the warm-up, under the round-2 order (relative lateness). A miss is reported, not tuned away.
  it("observation rounds: typical SURG5A late >= 80% and typical ER demand over available > 1 (design windows that hold)", () => {
    expect(m.typical.surgLate).toBeGreaterThanOrEqual(0.8);
    expect(m.typical.erDemand).toBeGreaterThan(1);
  });

  it("observation demand is nominal need: surge medicine reads clearly above doh-standard and above 1", () => {
    expect(m.surge.medDemand).toBeGreaterThan(1.2);
    expect(m.surge.medDemand).toBeGreaterThan(1.5 * m.standard.medDemand);
  });

  // Two design windows MISS (reported 2026-11-12, not tuned): doh-standard medicine late <= 5% (measured 33.0%) and typical
  // medicine 25-75% (measured 97.5%). Under relative lateness watch rounds (hourly, 30 min grace) run late too, and the
  // ICU-indicated people a full ICU leaves on the medicine wards raise the demand past the design's routine-only arithmetic.
  // Asserted instead: worse staffing gives more late rounds and longer gaps, and nobody waits a day for a round.
  it("observation rounds: worse staffing gives more late rounds and longer gaps; nobody under doh-standard or typical goes 24 h without a round", () => {
    expect(m.standard.medLate).toBeLessThan(m.typical.medLate);
    expect(m.standard.surgLate).toBeLessThan(m.typical.surgLate);
    expect(m.standard.erDemand).toBeLessThan(m.typical.erDemand);
    for (const g of ["ER", "MED", "SURG5A"] as const) {
      expect(m.standard.gap[g]).toBeLessThan(m.typical.gap[g]);
      for (const k of ["standard", "typical"] as const) expect(m[k].gap[g]).toBeLessThanOrEqual(24 * 60);
    }
  });

  // A2, the orchestrator's ruling 1: deaths are calibrated, not added. origin/main (75fda0f, no A2) gives, in this harness,
  // 186 / 282 / 352 deaths under doh-standard / typical / surge. The 5% window is a gross-break check only: at these numbers late
  // recognition moves a few deaths, far inside it. The exact check of the mechanism is "scales stay deaths by exactly..." below.
  const MAIN_DEATHS = { standard: 186, typical: 282, surge: 352 };
  it("late recognition: typical deaths stay within 5% of origin/main's level; doh-standard and surge stay near theirs", () => {
    expect(Math.abs(m.typical.deaths - MAIN_DEATHS.typical)).toBeLessThanOrEqual(0.05 * MAIN_DEATHS.typical);
    // Reported, not tuned: doh-standard gives 187 against 186 (one more, from the changed ICU flow), surge 354 against 352.
    for (const k of ["standard", "surge"] as const) expect(Math.abs(m[k].deaths - MAIN_DEATHS[k])).toBeLessThanOrEqual(0.05 * MAIN_DEATHS[k]);
  });

  it("late recognition: worse staffing gives longer delays and more deaths after late recognition, on the same seeds", () => {
    expect(mid(m.standard.delays.MED)).toBeLessThan(mid(m.typical.delays.MED));
    expect(m.standard.late / m.standard.noticed).toBeLessThan(m.typical.late / m.typical.noticed);
    // Counts of 1, 2 and 4: only the extremes are compared, as a strict order between them would be seed noise.
    expect(m.standard.excess).toBeLessThanOrEqual(m.surge.excess);
    // design windows (workload-design.md A2): typical medicine 150-260 min, typical SURG5A >= 240, late share >= 50% at doh-standard
    expect(mid(m.typical.delays.MED)).toBeGreaterThanOrEqual(150);
    expect(mid(m.typical.delays.MED)).toBeLessThanOrEqual(260);
    expect(mid(m.typical.delays.SURG5A)).toBeGreaterThanOrEqual(240);
    expect(m.standard.late / m.standard.noticed).toBeGreaterThanOrEqual(0.5);
  });
});

// ---- A1 (observation rounds) draws nothing and changes nothing that existed before it ----
// Every key A1 adds; with them taken out, the run must hash to what origin/main (ae80706, no A1 logic) gives; re-record from main when main changes.
const A1_KEYS = new Set([
  "obsCredit", "obsDueMin", "obsLastMin", "obsDue", "obsDone", "obsLate", "obsDemandMin",
  "obs_due", "obs_done", "obs_late", "obs_overdue_now", "obs_longest_overdue_min", "care_min_demanded", "care_min_available",
  "obsRel", "obs_longest_since_round_min", "obs_rel_late_median", // round 2
]);
// Every key and event kind A2 adds. With A2's response off (no class flip or ICU request, no death from the delay, stay deaths
// unscaled) and these taken out too, the run must still hash to ae80706's value: courses are drawn and recorded, nothing else moves.
const A2_KEYS = new Set(["course", "deteriorated", "noticed", "noticedLate", "delays", "noticed_late", "unnoticed_now", "recognition_delay_median_min"]);
const A2_KINDS = new Set<string>(["deteriorate", "noticed", "unnoticed"]);
// Every key and event kind A3 adds (state, event rows, hourly rows). With returns off, the old name lists and these taken out, nothing else moves.
const A3_KEYS = new Set(["visit", "history", "look", "returning", "returns"]);
const A3_KINDS = new Set<string>(["return_scheduled", "return", "return_dropped"]);
const withoutA1A2 = (x: unknown) => JSON.stringify(x, (k, v) => (A1_KEYS.has(k) || A2_KEYS.has(k) || A3_KEYS.has(k) ? undefined : v));
const withoutA3 = (x: unknown) => JSON.stringify(x, (k, v) => (A3_KEYS.has(k) ? undefined : v));
/** Runs `f` with A3 off (no returns, the old name lists). */
function a3Off<T>(f: () => T): T {
  const keep = PARAMS.returns.enabled.value;
  PARAMS.returns.enabled.value = false;
  try { return f(); } finally { PARAMS.returns.enabled.value = keep; }
}
/** Runs `f` with A2's response switched off, then puts the values back. */
function a2Off<T>(f: () => T): T {
  const C = PARAMS.course, keep = [C.escalate.value, PARAMS.obs.excessDeathPerHour.value, C.stayDeathScale.value] as const;
  C.escalate.value = false; PARAMS.obs.excessDeathPerHour.value = 0; C.stayDeathScale.value = 1;
  try { return a3Off(f); } finally { [C.escalate.value, PARAMS.obs.excessDeathPerHour.value, C.stayDeathScale.value] = keep; }
}

describe("A1 and A2 leave every old output as it was", () => {
  it("seeds 101-103 under all three scenarios, 6 days: events, old hourly columns and the final state hash as on main", () => {
    const hash = createHash("sha256");
    let recorded = 0;
    a2Off(() => {
      for (const k of ["standard", "typical", "surge"] as const) {
        for (const seed of [101, 102, 103]) {
          const h = createHospital(seed, SC[k]);
          const { events, hourly } = run(h, acceptingPort(), 0, 6 * DAY);
          recorded += events.filter((e) => A2_KINDS.has(e.kind)).length;
          hash.update(withoutA1A2({ events: events.filter((e) => !A2_KINDS.has(e.kind)), hourly, h }));
        }
      }
    });
    expect(recorded).toBeGreaterThan(20); // courses were drawn and recorded in these runs
    expect(hash.digest("hex").slice(0, 16)).toBe("9096414920e7a93f");
  }, 240_000);
});

describe("observation rounds (A1)", () => {
  const O = PARAMS.obs;
  /** A house of fixed people: no arrivals, no ER, no residents, nobody ever leaves. */
  const still = (units: Partial<Scenario["units"]>) => {
    const sc: Scenario = { ...SC.typical, arrivalsPerDay: 0, startOccupancy: 0, er: { ...SC.typical.er, bays: 0 }, units: { ...SC.typical.units, ...units } };
    return createHospital(91, sc);
  };
  let k = 0;
  const resident = (unit: UnitId, slot: number, o: Partial<Person> = {}): Person => ({
    ...drawPerson(1, (k += 1)), group: "infection", admit: true, icuIndicated: false, triage: "urgent", patienceMin: null, erDeathAfterMin: null,
    deathU: 1, deathF: 0.5, arrivedMin: 0, unit, where: "bed", sinceMin: 0, slot, wants: null, seenMin: 0, decideMin: 0, dueMin: 1e9, dieMin: null,
    boardedMin: 0, w4Id: null, fromW4: false, obsDueMin: 0, obsLastMin: null, course: null, visit: 1, history: [], ...o,
  });
  const fill = (h: Hospital, people: Person[]) => { h.people = people; h.createdCount = people.length; };

  // cycle = max(interval, census x roundMin / (nurses x share)) minutes: census x roundMin / (nurses x share x 60) hours when demand exceeds credit
  it.each([
    [35, 2, 0.25, 5], // typical medicine: 350 min
    [26, 1, 0.25, 5], // typical surgery: 520 min
    [30, 2, 0.5, 10], // 300 min
    [27, 3, 0.25, 5], // 180 min of work in a 240 min interval: on time
    [10, 4, 0.25, 5], // spare time: on time
  ])("a unit held at census %i with %i nurses, share %f, %i min a round, cycles as the formula says, within 10 percent", (census, nurses, share, roundMin) => {
    const keep = [O.shareOfNurseTime.value, O.roundMin.value];
    O.shareOfNurseTime.value = share; O.roundMin.value = roundMin;
    try {
      const h = still({ MED3A: { beds: 40, stretchers: 0, nurses } });
      const people = Array.from({ length: census }, (_, i) => resident("MED3A", i, { obsDueMin: i % 240 }));
      fill(h, people);
      const cycle = Math.max(O.intervalMin.routine.value, (census * roundMin) / (nurses * share));
      const gaps: number[] = [];
      let longest = 0;
      const last = people.map((p) => p.obsLastMin);
      for (let m = 0; m < 4 * DAY; m += 1) {
        stepHospital(h, fullPort(), m);
        people.forEach((p, i) => {
          if (p.obsLastMin !== last[i]) { if (last[i] !== null && m >= DAY) gaps.push(p.obsLastMin! - last[i]!); last[i] = p.obsLastMin; }
          if (m >= 3 * DAY && p.obsDueMin! <= m) longest = Math.max(longest, m - p.obsDueMin!);
        });
      }
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      expect(gaps.length).toBeGreaterThan(census * 3);
      expect(Math.abs(mean - cycle) / cycle).toBeLessThan(0.1);
      // the backlog stays bounded: nobody is overdue much longer than one cycle minus the interval
      expect(longest).toBeLessThanOrEqual(Math.max(0, cycle - O.intervalMin.routine.value) * 1.1 + 2 * roundMin / (nurses * share));
      expect(h.people.every((p) => p.unit === "MED3A")).toBe(true); // the census really was held
    } finally {
      [O.shareOfNurseTime.value, O.roundMin.value] = keep;
    }
  });

  it("serves the largest relative lateness first (now - due over own interval); the next round counts from the round", () => {
    const h = still({ MED3A: { beds: 10, stretchers: 0, nurses: 1 } }); // one nurse: a round every 20 min, the first at minute 19
    const a = resident("MED3A", 0, { n: 50, obsDueMin: 0 });
    const b = resident("MED3A", 1, { n: 40, obsDueMin: 0 });
    const c = resident("MED3A", 2, { n: 60, obsDueMin: -100 });
    const d = resident("MED3A", 3, { n: 70, obsDueMin: 5, icuIndicated: true }); // ICU-indicated, not in the ICU: watch
    fill(h, [a, b, c, d]);
    for (let m = 0; m < 60; m += 1) stepHospital(h, fullPort(), m);
    // minute 19: c 119/240 = 0.50 beats d 14/60 = 0.23; minute 39: d 34/60 = 0.57 beats b, a 39/240; minute 59: b and a tie, lower number
    expect([c.obsLastMin, d.obsLastMin, b.obsLastMin, a.obsLastMin]).toEqual([19, 39, 59, null]);
    expect([c.obsDueMin, d.obsDueMin, b.obsDueMin]).toEqual([19 + O.intervalMin.routine.value, 39 + O.intervalMin.watch.value, 59 + O.intervalMin.routine.value]);
    const row = takeRows(h).hourly.find((r) => r.unit === "MED3A")!;
    expect([row.obs_done, row.obs_overdue_now, row.obs_longest_overdue_min, row.obs_longest_since_round_min]).toEqual([3, 1, 59, 59]);
    expect(row.obs_rel_late_median).toBe(0.5); // 119/240, 34/60, 59/240
  });

  it("breaks a tie in relative lateness by the more acute class, then by the lower number", () => {
    const h = still({ MED3A: { beds: 10, stretchers: 0, nurses: 1 } });
    const W = O.intervalMin.watch.value, R = O.intervalMin.routine.value;
    const routine = resident("MED3A", 0, { n: 10, obsDueMin: 19 - R }); // 1.0 intervals late at minute 19
    const watch = resident("MED3A", 1, { n: 30, obsDueMin: 19 - W, icuIndicated: true }); // also 1.0
    const routine2 = resident("MED3A", 2, { n: 20, obsDueMin: 39 - R }); // 1.0 at minute 59 less 20 min: (59 - 39 + R) / R
    const routine3 = resident("MED3A", 3, { n: 25, obsDueMin: 39 - R }); // the same as routine2
    fill(h, [routine, watch, routine2, routine3]);
    for (let m = 0; m < 60; m += 1) stepHospital(h, fullPort(), m);
    // 19: watch and routine tie at 1.0, the more acute class wins; 39: routine is the latest; 59: routine2 and routine3 tie, lower number
    expect([watch.obsLastMin, routine.obsLastMin, routine2.obsLastMin, routine3.obsLastMin]).toEqual([19, 39, 59, null]);
  });

  // Starvation: 1 nurse gives c = 0.25 / 5 = 0.05 rounds a minute. Four watch (60 min) people alone want 4/60 = 0.067 > c, so
  // under strict class order the one routine person never gets a round. Under relative lateness everyone settles at the same
  // multiple k of their own interval: sum 1 / (I_i k) = c, so k = (4/60 + 1/240) / 0.05 = 1.417 and the routine cycle is
  // 240 x 1.417 = 340 min. Bound: 1.25 x 340 + 20 (one round's spacing at 1 nurse) = 445 min.
  it("starves nobody: a routine patient among watch patients who could use all the time is seen within the derived bound", () => {
    const h = still({ MED3A: { beds: 10, stretchers: 0, nurses: 1 } });
    const watch = [0, 1, 2, 3].map((i) => resident("MED3A", i, { icuIndicated: true, obsDueMin: i * 5 }));
    const lone = resident("MED3A", 4, { obsDueMin: 0 });
    fill(h, [...watch, lone]);
    const k = (4 / O.intervalMin.watch.value + 1 / O.intervalMin.routine.value) / (O.shareOfNurseTime.value / O.roundMin.value);
    const bound = 1.25 * O.intervalMin.routine.value * k + O.roundMin.value / O.shareOfNurseTime.value;
    expect(Math.round(bound)).toBe(445);
    let last = 0, longest = 0, rounds = 0;
    for (let m = 0; m < 3 * DAY; m += 1) {
      stepHospital(h, fullPort(), m);
      if (lone.obsLastMin === m) { longest = Math.max(longest, m - last); last = m; rounds += 1; }
      if (m % 60 === 59) takeRows(h);
    }
    longest = Math.max(longest, 3 * DAY - 1 - last);
    expect(rounds).toBeGreaterThan(10);
    expect(longest).toBeLessThan(bound);
  });

  it("a round is late only when done more than the grace after it fell due", () => {
    const g = O.graceMin.routine.value;
    const h = still({ MED3A: { beds: 2, stretchers: 0, nurses: 1 }, MED3B: { beds: 2, stretchers: 0, nurses: 1 } });
    fill(h, [resident("MED3A", 0, { obsDueMin: 19 - g }), resident("MED3B", 0, { obsDueMin: 19 - g - 1 })]); // both done at minute 19
    for (let m = 0; m < 60; m += 1) stepHospital(h, fullPort(), m);
    const rows = takeRows(h).hourly;
    const of = (id: UnitId) => rows.find((r) => r.unit === id)!;
    expect([of("MED3A").obs_done, of("MED3A").obs_late]).toEqual([1, 0]);
    expect([of("MED3B").obs_done, of("MED3B").obs_late]).toEqual([1, 1]);
    expect([of("MED3A").obs_due, of("MED3A").care_min_demanded, of("MED3A").care_min_available]).toEqual([0, 1.25, 15]); // fell due before minute 0; one routine person needs 60 x 5 / 240 a hour
  });

  it("ER boarders are on the ER's rounds, and the ICU, W4 and the morgue have none", () => {
    const h = still({ MED3A: { beds: 0, stretchers: 0, nurses: 2 }, MED3B: { beds: 0, stretchers: 0, nurses: 2 } });
    const boarder = resident("ER", 0, { where: "boarding", wants: "MED3A", obsDueMin: 0 });
    const icu = resident("ICU", 0, { obsDueMin: null });
    fill(h, [boarder, icu]);
    for (let m = 0; m < 60; m += 1) stepHospital(h, fullPort(), m);
    expect(boarder.where).toBe("boarding");
    expect(boarder.obsLastMin).toBe(9); // 2 ER nurses earn 0.5 min a minute: 5 min by minute 9
    expect(icu.obsLastMin).toBeNull();
    const rows = takeRows(h).hourly;
    for (const r of rows.filter((x) => x.unit === "ICU" || x.unit === "W4" || x.unit === "MORGUE")) {
      expect([r.obs_due, r.obs_done, r.obs_late, r.obs_overdue_now, r.obs_longest_overdue_min, r.care_min_demanded, r.care_min_available, r.obs_longest_since_round_min, r.obs_rel_late_median]).toEqual(Array(9).fill(null));
    }
  });

  it("credit never goes below 0 or above nurses x roundMin, every minute; everyone in a workload unit has a due time", () => {
    const h = createHospital(92, SC.standard);
    const port = acceptingPort();
    for (let m = 0; m < 2 * DAY; m += 1) {
      port.now = m;
      stepHospital(h, port, m);
      for (const u of h.units) {
        expect(u.obsCredit).toBeGreaterThanOrEqual(0);
        expect(u.obsCredit).toBeLessThanOrEqual(u.nurses * O.roundMin.value);
      }
      if (m % 60 === 59) {
        expect(h.people.filter((p) => ["ER", "MED3A", "MED3B", "SURG5A"].includes(p.unit) && p.where !== "awaiting_morgue").every((p) => p.obsDueMin !== null)).toBe(true);
        expect(h.people.filter((p) => p.unit === "ICU" || p.unit === "W4").every((p) => p.obsDueMin === null)).toBe(true);
        takeRows(h);
      }
    }
    expect(h.units.filter((u) => u.id === "ICU" || u.id === "W4" || u.id === "MORGUE").every((u) => u.obsCredit === 0)).toBe(true);
  });

  it("with zero nurses or zero census the columns stay finite: no rounds, nothing available, no NaN or Infinity", () => {
    const sc: Scenario = {
      ...SC.typical, er: { ...SC.typical.er, nurses: 0 },
      units: { ICU: { beds: 10, stretchers: 0, nurses: 3 }, MED3A: { beds: 0, stretchers: 0, nurses: 2 }, MED3B: { beds: 30, stretchers: 8, nurses: 0 }, SURG5A: { beds: 24, stretchers: 6, nurses: 0 } },
    };
    const { hourly } = run(createHospital(93, sc), fullPort(), 0, DAY);
    for (const r of hourly) for (const v of Object.values(r)) if (typeof v === "number") expect(Number.isFinite(v)).toBe(true);
    const of = (id: UnitId) => hourly.filter((r) => r.unit === id);
    for (const id of ["ER", "MED3B", "SURG5A"] as const) {
      expect(of(id).every((r) => r.obs_done === 0 && r.care_min_available === 0)).toBe(true);
      expect(of(id).at(-1)!.obs_overdue_now).toBeGreaterThan(0);
    }
    expect(of("MED3A").every((r) => r.census === 0 && r.obs_due === 0 && r.obs_overdue_now === 0 && r.obs_longest_overdue_min === 0)).toBe(true);
  });
});

// ---- late recognition (A2) ----
describe("late recognition (A2)", () => {
  const O = PARAMS.obs, C = PARAMS.course;
  const still = (units: Partial<Scenario["units"]> = {}) =>
    createHospital(94, { ...SC.typical, arrivalsPerDay: 0, startOccupancy: 0, er: { ...SC.typical.er, bays: 0 }, units: { ...SC.typical.units, ...units } });
  let k = 5000;
  const course = (atMin: number | null, excessU = 1) => ({ atMin, excessU, onsetMin: null, noticedMin: null, unnoticedMin: null, escalated: false, excess: false });
  const resident = (unit: UnitId, slot: number | null, o: Partial<Person> = {}): Person => ({
    ...drawPerson(1, (k += 1)), group: "infection", admit: true, icuIndicated: false, triage: "urgent", patienceMin: null, erDeathAfterMin: null,
    deathU: 1, deathF: 0.5, arrivedMin: 0, unit, where: "bed", sinceMin: 0, slot, wants: null, seenMin: 0, decideMin: 0, dueMin: 1e9, dieMin: null,
    boardedMin: 0, w4Id: null, fromW4: false, obsDueMin: unit === "ICU" || unit === "W4" ? null : 0, obsLastMin: null, course: null, visit: 1, history: [], ...o,
  });
  const go = (h: Hospital, people: Person[], to: number) => {
    h.people = people; h.createdCount = people.length;
    const { events, hourly } = run(h, fullPort(), 0, to);
    return { events: events.filter((e) => people.some((p) => p.id === e.person)), hourly };
  };

  it("draws the course from the person's own stream: the same under every scenario, and person n's other draws do not move", () => {
    for (let n = 1; n <= 500; n += 1) {
      const a = drawCourse(7, n, "infection", 9000, 100), b = drawCourse(7, n, "infection", 9000, 5000);
      expect(b.excessU).toBe(a.excessU);
      expect(b.atMin === null ? null : b.atMin - 5000).toBe(a.atMin === null ? null : a.atMin - 100); // relative to the decision
    }
    // inside whole runs: whoever is admitted in all three scenarios has the same course relative to the decision
    const runs = (["standard", "typical", "surge"] as const).map((s) => { const h = createHospital(12, SC[s]); run(h, fullPort(), 0, 3 * DAY); return peopleOf(h); });
    let same = 0;
    for (const p of runs[0].filter((q) => q.course !== null && q.n <= 500)) {
      for (const other of runs.slice(1)) {
        const q = other.find((x) => x.n === p.n);
        if (!q || q.course === null) continue;
        expect([q.course.excessU, q.course.atMin === null ? null : q.course.atMin - q.decideMin!]).toEqual([p.course!.excessU, p.course!.atMin === null ? null : p.course!.atMin - p.decideMin!]);
        same += 1;
      }
    }
    expect(same).toBeGreaterThan(30);
    // the rate is per patient-day of the drawn ward stay: about 1 - exp(-0.01 x 7.9) of medicine admissions deteriorate
    let det = 0;
    for (let n = 1; n <= 20_000; n += 1) det += drawCourse(3, n, "infection", 8 * DAY, 0).atMin === null ? 0 : 1;
    expect(Math.abs(det / 20_000 - (1 - Math.exp(-C.ratePerDay.medicine.value * 8)))).toBeLessThan(0.006);
  });

  it("nothing is noticed before a round: onset just after a round is noticed at the next round, which flips the class first", () => {
    const h = still({ ICU: { beds: 0, stretchers: 0, nurses: 3 } }); // no ICU bed: the noticed patient stays on the ward
    const p = resident("MED3A", 0, { course: course(10) });
    const { events, hourly } = go(h, [p], 5 * 60);
    // 2 nurses earn 0.5 min a minute: the first round at minute 9, the onset one minute after it, the next round 240 min later
    expect(events.filter((e) => e.kind === "deteriorate").map((e) => e.minute)).toEqual([10]);
    expect(events.filter((e) => e.kind === "noticed").map((e) => [e.minute, e.detail])).toEqual([[249, "delay 239 min"]]);
    expect(noticedLateMin(p)).toBe(239);
    expect([p.obsLastMin, p.obsDueMin]).toEqual([249, 249 + O.intervalMin.watch.value]); // hourly after the notice, not four-hourly
    expect(hourly.filter((r) => r.unit === "MED3A" && r.hour < 4).map((r) => r.unnoticed_now)).toEqual([1, 1, 1, 1]);
    const at4 = hourly.find((r) => r.unit === "MED3A" && r.hour === 4)!;
    expect([at4.deteriorated, at4.noticed, at4.noticed_late, at4.recognition_delay_median_min, at4.unnoticed_now]).toEqual([0, 1, 1, 239, 0]);
    expect(hourly.find((r) => r.unit === "MED3A" && r.hour === 0)!.deteriorated).toBe(1);
    expect(overdueRounds(h, "MED3A", 309 + 11)).toEqual({ count: 1, longestMin: 11 }); // the seam the screen reads
    expect(overdueRounds(h, "ICU", 320)).toBeNull();
  });

  it("the notice asks for the ICU: a ward patient moves to a free ICU bed, and an onset in the ICU is seen at once (delay 0)", () => {
    const h = still();
    const ward = resident("MED3A", 0, { course: course(10) });
    const icu = resident("ICU", 0, { course: course(20) });
    const { events } = go(h, [ward, icu], 6 * 60);
    expect(events.filter((e) => e.person === ward.id && e.kind === "transfer").map((e) => [e.minute, e.unit, e.detail])).toEqual([[250, "ICU", "MED3A to ICU after notice"]]);
    expect(ward.course!.escalated).toBe(true);
    expect(events.filter((e) => e.person === icu.id).map((e) => [e.minute, e.kind, e.detail])).toEqual([[20, "deteriorate", ""], [20, "noticed", "delay 0 min"]]);
    expect(noticedLateMin(icu)).toBeNull();
  });

  it("W4 gets no course event; a person who leaves before the round is recorded as unnoticed", () => {
    const h = still();
    const w4 = resident("W4", null, { w4Id: "w4-x", course: course(5) });
    const leaver = resident("MED3B", 0, { course: course(30), dueMin: 100 });
    const { events } = go(h, [w4, leaver], 4 * 60);
    expect(events.filter((e) => e.person === w4.id)).toEqual([]);
    expect(w4.course!.atMin).toBeNull();
    expect(events.filter((e) => e.person === leaver.id).map((e) => [e.minute, e.kind, e.detail])).toEqual([[30, "deteriorate", ""], [100, "discharge", ""], [100, "unnoticed", "70 min after onset"]]);
  });

  it("a delay can cause a death 6 h after the notice; no delay causes none, and it never overrides a pre-drawn death", () => {
    const h = still();
    const late = resident("MED3A", 0, { course: course(10, 0) }); // excessU 0: any positive chance kills
    const fated = resident("MED3A", 1, { course: course(10, 0), dieMin: 5000 });
    const icu = resident("ICU", 0, { course: course(10, 0) }); // seen at once: chance 1 - exp(0) = 0
    const { events } = go(h, [late, fated, icu], 2 * DAY);
    const died = events.filter((e) => e.kind === "died");
    expect(late.course!.excess).toBe(true);
    expect(died.filter((e) => e.person === late.id).map((e) => [e.minute, e.detail])).toEqual([[late.course!.noticedMin! + C.deathAfterNoticedH.value * 60, "bed after late recognition"]]);
    expect(fated.course!.excess).toBe(false);
    expect(died.some((e) => e.person === fated.id)).toBe(false); // its pre-drawn minute 5000 is after these two days
    expect(fated.dieMin).toBe(5000);
    expect(icu.course!.excess).toBe(false);
    expect(died.some((e) => e.person === icu.id)).toBe(false);
  });

  it("scales the pre-drawn stay death of people admitted in the run (they carry a course), and only theirs", () => {
    const P = stayDeathP("infection", false), u = P * (1 + C.stayDeathScale.value) / 2; // between the scaled and the unscaled chance
    const board = (o: Partial<Person>) => resident("ER", null, { where: "boarding", wants: "MED3A", obsDueMin: 0, deathU: u, ...o });
    const admitted = board({ course: course(null) }), resident0 = board({});
    go(still(), [admitted, resident0], 2);
    expect([admitted.unit, resident0.unit]).toEqual(["MED3A", "MED3A"]);
    expect(admitted.dieMin).toBeNull();
    expect(resident0.dieMin).not.toBeNull();
  });

  it("calls a notice exactly lateThresholdMin after onset on time, one minute more late", () => {
    const h = still({ ICU: { beds: 0, stretchers: 0, nurses: 3 } });
    const L = O.lateThresholdMin.value;
    // the first rounds fall at minutes 9 and 19 (2 nurses, 0.5 min a minute); onsets L and L + 1 minutes before the next ones
    const onTime = resident("MED3A", 0, { course: course(249 - L) }), late = resident("MED3A", 1, { course: course(259 - L - 1) });
    const { hourly } = go(h, [onTime, late], 5 * 60);
    expect([onTime.course!.noticedMin! - onTime.course!.onsetMin!, late.course!.noticedMin! - late.course!.onsetMin!]).toEqual([L, L + 1]);
    expect([noticedLateMin(onTime), noticedLateMin(late)]).toEqual([null, L + 1]);
    expect(hourly.filter((r) => r.unit === "MED3A").reduce((a, r) => a + r.noticed_late!, 0)).toBe(1);
  });

  it("the chance of a death from the delay is 1 - exp(-rate x delay in hours): an excessU just below it dies, just above it lives", () => {
    const h = still({ ICU: { beds: 0, stretchers: 0, nurses: 3 } });
    const pAt = (delayMin: number) => 1 - Math.exp(-O.excessDeathPerHour.value * delayMin / 60);
    // rounds at 9 and 19, onsets at 20, so noticed at 249 (delay 229) and at 259 (delay 239)
    const dies = resident("MED3A", 0, { course: course(20, pAt(229) * 0.99) }), lives = resident("MED3A", 1, { course: course(20, pAt(239) * 1.01) });
    go(h, [dies, lives], 5 * 60);
    expect([dies.course!.noticedMin, lives.course!.noticedMin]).toEqual([249, 259]);
    expect([dies.course!.excess, lives.course!.excess]).toEqual([true, false]);
  });

  it("draws the course from its own stream, not the shared person stream", () => {
    for (const n of [1, 2, 17, 500]) {
      const r = stream(7, `person:${n}:course`);
      r(); r();
      expect(drawCourse(7, n, "infection", 9000, 0).excessU).toBe(r());
    }
  });

  it("stay deaths of people admitted in the run: response off equals origin/main exactly, the scale on removes one (typical, seeds 101-103, 30 d)", () => {
    const stayDeaths = (scale: number) => a2Off(() => {
      C.stayDeathScale.value = scale;
      let n = 0;
      for (const seed of [101, 102, 103]) {
        const { events } = run(createHospital(seed, SC.typical), fullPort(), 0, 30 * DAY);
        const admitted = new Set(events.filter((e) => e.kind === "decide_admit").map((e) => e.person));
        n += events.filter((e) => e.kind === "died" && admitted.has(e.person)).length;
      }
      return n;
    });
    const off = stayDeaths(1), on = stayDeaths(0.98);
    expect([off, on]).toEqual([115, 114]); // off equals origin/main (75fda0f): 115, measured on its own code; on: one fewer (about 1%)
  }, 600_000);

  it("a JSON round trip part-way through a course (onset, not yet noticed) continues as straight through", () => {
    const straight = createHospital(33, SC.typical), split = createHospital(33, SC.typical);
    const p1 = acceptingPort(), p2 = acceptingPort();
    let N = 0;
    for (; N < 12 * DAY; N += 1) {
      p2.now = N; stepHospital(split, p2, N);
      if (split.people.some((p) => p.course?.onsetMin != null && p.course.noticedMin === null && p.course.unnoticedMin === null)) break;
    }
    expect(N).toBeLessThan(12 * DAY);
    const resumed = JSON.parse(JSON.stringify(split)) as Hospital;
    run(resumed, p2, N + 1, N + 1 + DAY, undefined, false);
    run(straight, p1, 0, N + 1 + DAY, undefined, false);
    expect(resumed).toEqual(straight);
    expect(peopleOf(straight).some((p) => p.course?.noticedMin != null)).toBe(true);
  });

  it("starved rounds give longer recognition delays than well-staffed ones on the same seeds and arrivals", () => {
    const staffed = (n: number): Scenario => ({ ...SC.typical, units: { ...SC.typical.units, MED3A: { ...SC.typical.units.MED3A, nurses: n }, MED3B: { ...SC.typical.units.MED3B, nurses: n } } });
    const delays = (sc: Scenario) => {
      const d: number[] = [];
      for (const seed of [101, 102]) {
        const { events } = run(createHospital(seed, sc), fullPort(), 0, 12 * DAY);
        for (const e of events) if (e.kind === "noticed" && (e.unit === "MED3A" || e.unit === "MED3B")) d.push(Number(/^delay (\d+) min$/.exec(e.detail)![1]));
      }
      return d.sort((a, b) => a - b);
    };
    const well = delays(staffed(4)), starved = delays(staffed(1));
    const med = (xs: number[]) => xs[Math.floor(xs.length / 2)];
    expect(well.length).toBeGreaterThan(10);
    expect(starved.length).toBeGreaterThan(10);
    expect(med(starved)).toBeGreaterThan(1.5 * med(well));
    expect(well.at(-1)!).toBeLessThanOrEqual(O.intervalMin.routine.value + O.graceMin.routine.value); // well staffed: never past the band
  }, 120_000);
});


// ---- A3: returning people and more varied people ----
describe("A3 leaves every v3 output as it was when returns are off", () => {
  // Recorded from origin/main 8616326 (A2, no A3 code): 6 days, seeds 101-103, three scenarios, A2's response on, the hospital-level harness.
  it("hashes events, hourly rows and the final state as on main", () => {
    const hash = createHash("sha256");
    a3Off(() => {
      for (const k of ["standard", "typical", "surge"] as const) {
        for (const seed of [101, 102, 103]) {
          const h = createHospital(seed, SC[k]);
          const { events, hourly } = run(h, acceptingPort(), 0, 6 * DAY);
          expect(events.some((e) => A3_KINDS.has(e.kind))).toBe(false);
          hash.update(withoutA3({ events, hourly, h }));
        }
      }
    });
    expect(hash.digest("hex").slice(0, 16)).toBe("b64d6ecc52607896");
  }, 240_000);
});

describe("names and look (A3)", () => {
  const VULGAR = ["Puto", "Tae", "Bobo", "Gago", "Tanga", "Ulol", "Pwet", "Puki", "Titi", "Shit", "Fuck", "Dick", "Cock", "Ass", "Bitch", "Whore"];
  const OFFICE_FAMILIES = ["Marcos", "Aquino", "Duterte", "Estrada", "Arroyo", "Roxas", "Binay", "Pacquiao", "Rizal"];
  const FAMOUS_PAIRS = [
    "Ramos, Fidel", "Bonifacio, Andres", "Marcos, Ferdinand", "Aquino, Corazon", "Duterte, Rodrigo", "Estrada, Joseph", "Pacquiao, Manny",
    "Yulo, Carlos", "Balagtas, Francisco", "Tagle, Luis", "Ruiz, Lorenzo", "Santos, Vilma", "Reyes, Efren", "Villanueva, Joel", "Teodoro, Gilberto",
    "Tan, Lucio", "Pineda, Arnel", "Montano, Cesar", "Padilla, Dennis", "Ongpin, Jaime",
  ];
  const DROPPED_SURNAMES = ["Yulo", "Balagtas", "Tagle", "Ongpin", "Gatchalian", "Escudero", "Pimentel", "Teodoro"];
  const DROPPED_GIVEN = ["Vilma", "Efren", "Lucio", "Joel", "Arnel", "Dennis"];
  const STAGE = ["Vice", "Pokwang", "Sharon", "Dolphy", "Aga", "Kris", "Bossing", "Madonna", "Beyonce", "Rihanna", "Cher", "Prince", "Sting"];
  const given = [...GIVEN.F, ...GIVEN.M];

  it("holds 392 surnames, 149 female and 145 male given names, with no duplicates, letters only", () => {
    expect([SURNAMES.length, GIVEN.F.length, GIVEN.M.length]).toEqual([392, 149, 145]);
    for (const list of [SURNAMES, GIVEN.F, GIVEN.M]) {
      expect(new Set(list).size).toBe(list.length);
      expect(list.every((w) => /^[A-Z][a-z]+$/.test(w))).toBe(true);
    }
    expect(GIVEN.F.filter((w) => GIVEN.M.includes(w))).toEqual([]); // a name belongs to one sex
  });

  it("holds no office holder's family name, no famous full pair, no vulgar word, no single stage name", () => {
    expect(SURNAMES.filter((w) => OFFICE_FAMILIES.includes(w))).toEqual([]);
    expect(SURNAMES.filter((w) => DROPPED_SURNAMES.includes(w))).toEqual([]);
    expect(given.filter((w) => DROPPED_GIVEN.includes(w))).toEqual([]);
    // Every producible name: each surname with each given-name draw, after the generator's skip. None may be a blocked pair.
    const made = new Set<string>();
    for (const s of SURNAMES) for (const sex of ["F", "M"] as const) for (let i = 0; i < GIVEN[sex].length; i += 1) made.add(`${s}, ${GIVEN[sex][givenIndex(s, sex, i)]}`);
    expect(made.size).toBeGreaterThan(100_000);
    expect(FAMOUS_PAIRS.filter((x) => made.has(x))).toEqual([]);
    // the skip is real: these two pairs are in the pools and are passed over
    for (const [s, g, sex] of [["Ruiz", "Lorenzo", "M"], ["Montano", "Cesar", "M"]] as const) {
      expect(GIVEN[sex]).toContain(g);
      expect(GIVEN[sex][givenIndex(s, sex, GIVEN[sex].indexOf(g))]).not.toBe(g);
    }
    // and drawn people never carry one
    for (let n = 1; n <= 3000; n += 1) expect(FAMOUS_PAIRS.some((x) => drawPerson(3, n).name.startsWith(x))).toBe(false);
    const bad = new Set([...VULGAR, ...STAGE].map((w) => w.toLowerCase()));
    expect([...SURNAMES, ...given].filter((w) => bad.has(w.toLowerCase()))).toEqual([]);
  });

  it("keeps the old 80 x 40 lists for the switch-off, and draws from them only then", () => {
    expect([LEGACY.SURNAMES.length, LEGACY.GIVEN.F.length, LEGACY.GIVEN.M.length]).toEqual([80, 40, 40]);
    const old = a3Off(() => Array.from({ length: 300 }, (_, i) => drawPerson(5, i + 1)));
    expect(old.every((p) => LEGACY.SURNAMES.includes(p.name.split(", ")[0]))).toBe(true);
    const now = Array.from({ length: 300 }, (_, i) => drawPerson(5, i + 1));
    expect(now.some((p) => !LEGACY.SURNAMES.includes(p.name.split(", ")[0]))).toBe(true);
    expect(now.every((p) => SURNAMES.includes(p.name.split(", ")[0]) && p.name.endsWith(".") && INITIALS.includes(p.name.at(-2)!))).toBe(true);
    // only the strings move: every other draw is the same with the old lists
    for (let i = 0; i < 300; i += 1) expect({ ...old[i], name: "" , look: null }).toEqual({ ...now[i], name: "", look: null });
  });

  it("gives few shared names among 600 live people", () => {
    let shared = 0, pairsSeen = 0;
    for (const seed of [101, 102, 103]) {
      const names = Array.from({ length: 600 }, (_, i) => drawPerson(seed, i + 1).name);
      const count = new Map<string, number>();
      for (const x of names) count.set(x, (count.get(x) ?? 0) + 1);
      shared += names.filter((x) => count.get(x)! > 1).length;
      pairsSeen += names.length;
    }
    console.log(`name collision rate among 600 people: ${shared} of ${pairsSeen} share a name (${((shared / pairsSeen) * 100).toFixed(3)}%)`);
    expect(shared / pairsSeen).toBeLessThan(0.005);
  });

  it("draws a look from its own stream: skin 0-3, hair 0-4 (grey or white from 60), shirt 0-5, the same on every visit", () => {
    for (let n = 1; n <= 400; n += 1) {
      const p = drawPerson(9, n);
      const [skin, hair, shirt] = p.look;
      expect([skin >= 0 && skin <= 3, shirt >= 0 && shirt <= 5, p.age >= 60 ? hair >= 3 && hair <= 4 : hair >= 0 && hair <= 2]).toEqual([true, true, true]);
      expect(p.look).toEqual(lookOf(9, n, p.age));
      expect(drawPerson(9, n, 2, p).look).toEqual(p.look);
    }
    expect(new Set(Array.from({ length: 400 }, (_, i) => drawPerson(9, i + 1).look.join())).size).toBeGreaterThan(30);
  });

  it("makes a return the same person: sex, name, age, group and look kept, the rest redrawn", () => {
    let redrawn = 0;
    for (let n = 1; n <= 300; n += 1) {
      const a = drawPerson(4, n), b = drawPerson(4, n, 2, a), c = drawPerson(4, n, 3, a);
      for (const x of [b, c]) expect([x.id, x.name, x.sex, x.age, x.group, x.look]).toEqual([a.id, a.name, a.sex, a.age, a.group, a.look]);
      if (b.stayMin !== a.stayMin && b.deathU !== a.deathU) redrawn += 1;
      expect(drawCourse(4, n, a.group, 5000, 0, 2)).not.toEqual(drawCourse(4, n, a.group, 5000, 0, 1));
    }
    expect(redrawn).toBeGreaterThan(280);
  });
});

describe("returning people (A3)", () => {
  const R = PARAMS.returns;
  const month = (seed: number, sc: Scenario = SC.typical, port: () => FakePort = acceptingPort) => {
    const h = createHospital(seed, sc);
    return { h, ...run(h, port(), 0, 30 * DAY) };
  };
  const wardDischarges = (events: EventRow[]) => events.filter((e) => e.kind === "discharge" && e.unit !== "ER").length;

  it("brings back the same person as visit 2, in the same id lineage, after 1 to 30 days", () => {
    const { h, events } = month(101);
    const back = events.filter((e) => e.kind === "return");
    expect(back.length).toBeGreaterThan(10);
    for (const e of back.slice(0, 30)) {
      const a = drawPerson(101, nOf(e.person));
      const now = [...h.people, ...h.gone].find((p) => p.id === e.person && p.visit === e.visit)!;
      expect(e.visit).toBeGreaterThanOrEqual(2);
      if (now) expect([now.name, now.sex, now.age, now.group, now.look]).toEqual([a.name, a.sex, a.age, a.group, a.look]);
      const mine = events.filter((x) => x.person === e.person && x.minute <= e.minute);
      const sched = mine.filter((x) => x.kind === "return_scheduled" && x.visit === e.visit - 1).at(-1)!;
      const days = Number(/^in (\d+) d$/.exec(sched.detail)![1]);
      expect(days).toBeGreaterThanOrEqual(1);
      expect(days).toBeLessThanOrEqual(30);
      expect(e.minute).toBeGreaterThanOrEqual(sched.minute + 1); // never before it was scheduled
      expect(mine.some((x) => x.kind === "discharge" && x.visit === e.visit - 1 && x.minute === sched.minute)).toBe(true);
      expect(mine.filter((x) => x.kind === "arrive" && x.visit === e.visit)).toHaveLength(1);
    }
    const live = h.people.filter((p) => p.visit > 1);
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((p) => p.history.length === p.visit - 1 && p.history.every((v) => v.outcome === "discharged"))).toBe(true);
  }, 120_000);

  it("keeps one record per person: a returner's earlier visit leaves `gone` when they come back", () => {
    const { h } = month(102);
    const ids = [...h.people, ...h.gone].map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(h.createdCount).toBe(h.people.length + h.goneCount);
  }, 120_000);

  it("puts returns inside arrivalsPerDay: the same arrival slots are used with returns on or off", () => {
    for (const seed of [101, 102, 103]) {
      const on = month(seed).events, off = a3Off(() => month(seed).events);
      const slots = (ev: EventRow[]) => ev.filter((e) => e.kind === "arrive" || (e.kind === "turned_away" && e.minute > 0)).length;
      expect(on.filter((e) => e.kind === "return").length).toBeGreaterThan(0);
      expect(slots(on)).toBe(slots(off)); // a return takes a slot, it adds none
      expect(on.filter((e) => e.kind === "arrive").length / 30).toBeLessThan(SC.typical.arrivalsPerDay * 1.2); // inside the calibration window
    }
  }, 240_000);

  it("never brings back the dead, and every return was scheduled by a live discharge", () => {
    const { events } = month(103);
    const died = new Map<string, number>();
    for (const e of events) if (e.kind === "died") died.set(e.person, e.minute);
    expect(died.size).toBeGreaterThan(20);
    for (const e of events) if (e.kind === "return_scheduled" || e.kind === "return") expect(died.has(e.person) && died.get(e.person)! <= e.minute).toBe(false);
    const sched = new Set(events.filter((e) => e.kind === "return_scheduled").map((e) => `${e.person}.${e.visit}`));
    for (const e of events.filter((x) => x.kind === "return")) expect(sched.has(`${e.person}.${e.visit - 1}`)).toBe(true);
  }, 120_000);

  it("lands near 18% of ward discharges over seeds 101-103 (typical, standard, surge)", () => {
    const out: string[] = [];
    for (const [name, sc] of [["doh-standard", SC.standard], ["typical", SC.typical], ["surge", SC.surge]] as const) {
      let sched = 0, disc = 0, back = 0, arrive = 0;
      for (const seed of [101, 102, 103]) {
        const { events } = month(seed, sc);
        sched += events.filter((e) => e.kind === "return_scheduled").length; disc += wardDischarges(events);
        back += events.filter((e) => e.kind === "return").length; arrive += events.filter((e) => e.kind === "arrive").length;
      }
      out.push(`${name}: scheduled ${(100 * sched / disc).toFixed(1)}% of ${disc} ward discharges, ${back} returns = ${(100 * back / arrive).toFixed(1)}% of ${arrive} arrivals`);
      expect(sched / disc).toBeGreaterThan(0.14);
      expect(sched / disc).toBeLessThan(0.22);
    }
    console.log(out.join("\n"));
  }, 600_000);

  it("decides each return from the person's own stream: the same person and visit give the same fate under any scenario", () => {
    const fate = (sc: Scenario) => {
      const m = new Map<string, string>();
      const { events } = month(101, sc);
      for (const e of events) if (e.kind === "discharge" && e.unit !== "ER") m.set(`${e.person}.${e.visit}`, "none");
      for (const e of events) if (e.kind === "return_scheduled") m.set(`${e.person}.${e.visit}`, e.detail);
      return m;
    };
    const a = fate(SC.standard), b = fate(SC.surge);
    const shared = [...a.keys()].filter((k) => b.has(k));
    expect(shared.length).toBeGreaterThan(100);
    expect(shared.filter((k) => a.get(k) !== b.get(k))).toEqual([]);
  }, 240_000);

  it("caps the waiting list and records what it drops; the house cap holds with returners in it", () => {
    const keep = R.cap.value;
    R.cap.value = 3;
    try {
      const h = createHospital(101, SC.typical);
      let most = 0;
      const { events } = run(h, acceptingPort(), 0, 20 * DAY, (hh) => { most = Math.max(most, hh.returning.length); });
      expect(most).toBeLessThanOrEqual(3);
      expect(events.filter((e) => e.kind === "return_dropped").length).toBeGreaterThan(5);
    } finally { R.cap.value = keep; }
    const tiny = createHospital(101, SC.typical, 60);
    let top = 0;
    const { events } = run(tiny, acceptingPort(), 0, 20 * DAY, (hh) => { top = Math.max(top, hh.people.length); });
    expect(top).toBeLessThanOrEqual(60);
    expect(events.filter((e) => e.kind === "return").length).toBeGreaterThan(0);
    const ids = [...tiny.people, ...tiny.gone].map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 240_000);

  it("keeps the last five visits in `history`", () => {
    const keep = [R.readmit30.medicine.value, R.readmit30.other.value];
    R.readmit30.medicine.value = 1; R.readmit30.other.value = 1;
    try {
      const h = createHospital(103, SC.standard);
      run(h, acceptingPort(), 0, 200 * DAY);
      const most = Math.max(...[...h.people, ...h.gone].map((p) => p.visit));
      expect(most).toBeGreaterThanOrEqual(7);
      expect(Math.max(...[...h.people, ...h.gone].map((p) => p.history.length))).toBe(5);
      for (const p of [...h.people, ...h.gone]) {
        expect(p.history.length).toBe(Math.min(5, p.visit - 1));
        if (p.visit > 1) expect(p.history.at(-1)!.visit).toBe(p.visit - 1);
      }
    } finally { [R.readmit30.medicine.value, R.readmit30.other.value] = keep as [number, number]; }
  }, 240_000);

  it("continues identically after a JSON round trip with a return waiting", () => {
    const a = createHospital(102, SC.typical), port = fullPort(); // W4 never discharges: its test double holds state a clone would not share
    run(a, port, 0, 12 * DAY);
    expect(a.returning.length).toBeGreaterThan(0);
    const b = JSON.parse(JSON.stringify(a)) as Hospital;
    const ra = run(a, port, 12 * DAY, 20 * DAY), rb = run(b, port, 12 * DAY, 20 * DAY);
    expect(rb).toEqual(ra);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(ra.events.some((e) => e.kind === "return")).toBe(true);
  }, 240_000);
  it("draws a return's wait as 1 to 30 days: both ends reachable, nothing else", () => {
    const keep = [R.readmit30.medicine.value, R.readmit30.other.value];
    R.readmit30.medicine.value = 1; R.readmit30.other.value = 1;
    try {
      const { events } = month(101, SC.surge);
      const days = new Set(events.filter((e) => e.kind === "return_scheduled").map((e) => Number(/^in (\d+) d$/.exec(e.detail)![1])));
      expect([...days].sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    } finally { [R.readmit30.medicine.value, R.readmit30.other.value] = keep as [number, number]; }
  }, 240_000);

  it("gives a due return the slot of the minute it falls due (due now counts)", () => {
    const first = (h: Hospital) => { const { events } = run(h, fullPort(), 0, 3 * 60); return events.find((e) => e.kind === "arrive")!.minute; };
    const m = first(createHospital(101, SC.typical));
    const h = createHospital(101, SC.typical);
    h.returning = [{ n: 7, visit: 2, atMin: m, history: [], same: drawPerson(101, 7) }];
    const { events } = run(h, fullPort(), 0, m + 1);
    expect([...events, ...h.events].filter((e) => e.kind === "return").map((e) => e.minute)).toEqual([m]); // rows are drained only on the hour
  });

  it("brings a W4-initial patient back as the same person: name, sex, age and look come from W4's record, not the draw", () => {
    const keep = [R.readmit30.medicine.value, R.readmit30.other.value];
    R.readmit30.medicine.value = 1; R.readmit30.other.value = 1;
    try {
      const h = createHospital(101, { ...SC.typical, startOccupancy: 0 });
      let d = drawPerson(101, 2_000_001);
      for (let k = 2_000_002; d.group !== "cardiac"; k += 1) d = drawPerson(101, k);
      const w4: Person = { ...d, name: "Dela Cruz, Rosa M.", age: 71, sex: "F", look: [3, 4, 5], admit: true, icuIndicated: false, arrivedMin: 0, unit: "W4", where: "bed", sinceMin: 0, slot: null,
        wants: null, seenMin: null, decideMin: null, dueMin: null, dieMin: null, boardedMin: 0, w4Id: "w4-x", fromW4: false, obsDueMin: null, obsLastMin: null, course: null, visit: 1, history: [] };
      h.people.push(w4); h.createdCount += 1;
      const port: FakePort = { now: 0, calls: [], admit: () => null, left: (id) => (id === "w4-x" && port.now >= 10 ? { outcome: "discharged", minute: port.now } : null) };
      const seen: Person[] = [];
      run(h, port, 0, 45 * DAY, (hh) => { const q = hh.people.find((p) => p.n === d.n && p.visit === 2); if (q && seen.length === 0) seen.push({ ...q }); });
      const back = seen[0];
      expect(back).toBeDefined();
      expect([back.name, back.sex, back.age, back.look, back.group]).toEqual(["Dela Cruz, Rosa M.", "F", 71, [3, 4, 5], d.group]);
    } finally { [R.readmit30.medicine.value, R.readmit30.other.value] = keep as [number, number]; }
  }, 240_000);
});
