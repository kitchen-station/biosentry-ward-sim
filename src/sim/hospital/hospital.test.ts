import { beforeAll, describe, expect, it } from "vitest";
import dohStandard from "../../../scenarios/hospital/doh-standard.json?raw";
import surge from "../../../scenarios/hospital/surge.json?raw";
import typical from "../../../scenarios/hospital/typical.json?raw";
import { GIVEN, SURNAMES } from "./names";
import { PARAMS } from "./params";
import { drawPerson, GROUPS, stayDeathP, TRIAGES } from "./people";
import { parseScenario, type Scenario } from "./scenario";
import { createHospital, stepHospital, takeRows } from "./step";
import type { EventKind, EventRow, Hospital, HourRow, Person, Sex, UnitId, W4Port } from "./types";

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
    expect(GIVEN.F).toHaveLength(PARAMS.people.namePool.value.givenPerSex);
    expect(GIVEN.M).toHaveLength(PARAMS.people.namePool.value.givenPerSex);
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

  it("stepping N minutes, a JSON round trip and M more equals stepping N + M straight through", () => {
    const N = 2 * DAY + 137; // not an hour boundary
    const M = 2 * DAY + 411;
    const straight = createHospital(31, SC.surge);
    const p1 = acceptingPort();
    run(straight, p1, 0, N + M, undefined, false);
    const split = createHospital(31, SC.surge);
    const p2 = acceptingPort();
    run(split, p2, 0, N, undefined, false);
    const resumed = JSON.parse(JSON.stringify(split)) as Hospital;
    run(resumed, p2, N, N + M, undefined, false);
    expect(resumed).toEqual(straight);
    expect(straight.events.length).toBeGreaterThan(0);
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
      lwbs: true, transfer_out: true, died: true, to_morgue: true, released: true, turned_away: true,
    };
    const UNIT_IDS: Record<UnitId, true> = { ER: true, MORGUE: true, ICU: true, MED3A: true, MED3B: true, W4: true, SURG5A: true };
    const events: EventRow[] = [];
    const hourly: HourRow[] = [];
    const scan = (h: Hospital, days: number) => { const r = run(h, acceptingPort(), 0, days * DAY); events.push(...r.events); hourly.push(...r.hourly); return h; };
    const typicalHouse = scan(createHospital(51, SC.typical), 4);
    scan(createHospital(52, SC.surge), 4);
    scan(createHospital(53, tight), 6);
    scan(createHospital(54, { ...SC.typical, startOccupancy: 0, er: { ...SC.typical.er, bays: 2 } }, 40), 4); // the people cap
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
      decideMin: 10, dueMin: null, dieMin: null, boardedMin: 0, w4Id: null, fromW4: false, ...o,
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
  interface Measured { occupancy: number; erFull: number; boardHours: number; deaths: number; admitShare: number; erDeathShare: number; lwbs: number; transfersOut: number; icuOcc: number }
  const measure = (sc: Scenario): Measured => {
    let med = 0, medBeds = 0, icu = 0, icuBeds = 0, erHours = 0, erFull = 0, boardMin = 0, deaths = 0, arrived = 0, admitted = 0, erDeaths = 0, lwbs = 0, out = 0;
    for (const seed of SEEDS) {
      const h = createHospital(seed, sc);
      const { events, hourly } = run(h, fullPort(), 0, DAYS * DAY);
      for (const r of hourly.filter((x) => x.hour * 60 >= WARM)) {
        if (r.unit === "MED3A" || r.unit === "MED3B") { med += r.census; medBeds += r.beds; }
        if (r.unit === "ICU") { icu += r.census; icuBeds += r.beds; }
        if (r.unit === "ER") { erHours += 1; erFull += r.census >= 2 * r.beds ? 1 : 0; boardMin += (r.er_boarding_hours ?? 0); }
      }
      // the cohort that arrived after the warm-up and early enough to have been decided
      const cohort = new Set(events.filter((e) => e.kind === "arrive" && e.minute >= WARM && e.minute < (DAYS - 3) * DAY).map((e) => e.person));
      arrived += cohort.size;
      admitted += events.filter((e) => e.kind === "decide_admit" && cohort.has(e.person)).length;
      erDeaths += events.filter((e) => e.kind === "died" && e.unit === "ER" && cohort.has(e.person)).length;
      deaths += events.filter((e) => e.kind === "died").length;
      lwbs += events.filter((e) => e.kind === "lwbs").length;
      out += events.filter((e) => e.kind === "transfer_out").length;
    }
    return { occupancy: med / medBeds, erFull: erFull / erHours, boardHours: boardMin, deaths, admitShare: admitted / arrived, erDeathShare: erDeaths / arrived, lwbs, transfersOut: out, icuOcc: icu / icuBeds };
  };
  const line = (name: string, m: Measured) =>
    console.log(`hospital ${name}: medicine occupancy ${(m.occupancy * 100).toFixed(1)}%, ICU ${(m.icuOcc * 100).toFixed(1)}%, ER census >= 2 x bays ${(m.erFull * 100).toFixed(1)}% of hours, ` +
      `ER boarding ${m.boardHours.toFixed(0)} h, deaths ${m.deaths}, ER admit share ${(m.admitShare * 100).toFixed(1)}%, ER-phase deaths ${(m.erDeathShare * 100).toFixed(2)}%, lwbs ${m.lwbs}, transfers out ${m.transfersOut} (3 seeds x 30 d)`);

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
});
