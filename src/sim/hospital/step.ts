// The hospital core: an emergency room with triage and a doctor queue, work-up, the admit-or-home decision, boarding,
// medicine and surgery wards with corridor stretchers, an ICU, deaths and a morgue. Ward W4 is only the W4Port.
//
// Decisions made in H2 (the design left them open or the code departs from it):
//  - DEPARTURE from design row 9: freed beds go first to ICU step-down, then to stretcher-to-bed promotion, then to ER
//    boarders (row 9 says boarders; row 13 gives no order). The ICU is the bottleneck, so its step-downs go first.
//  - A new event kind, `turned_away`: an arrival the house cannot hold (people cap) is counted and recorded, never dropped.
//    The same holds at the start: residents beyond the cap are turned away at minute 0 and recorded.
//  - W4 to ER boarding (higher care, no ICU bed) counts both sides: transferred_out on W4 and transferred_in on the ER.
//  - Fates are pre-drawn. An ER-phase death is fixed per person; a stay death is timed from placement, so boarding delays it;
//    a person transferred out or who left without being seen leaves our record before any stay fate (outcome not observed,
//    not prevented). Fated ER deaths never reach a decision. Stay fates are skipped for W4 patients (W4 deaths are H8).
//  - Residents of minute 0 are numbered from 1,000,001 so arrival k is the same person in every scenario.
//  - A person who left W4 for the ICU (`fromW4`) is never sent back to W4. An ICU-indicated person from the ER with the ICU
//    full still goes to its ward or W4 flagged, as row 10 says.
// Note for H3: each cardiac boarder calls `port.admit` every minute (at most one refusal is remembered per minute), so the real
// W4 must refuse before it draws any random number, or boarding would change W4's own draws.
// Pure and seeded: one call per sim minute, no clock, no I/O. Everything that can differ between runs is in `Hospital`.
import { drawPerson, DAY_MIN, stayDeathP } from "./people";
import { PARAMS, UNITS, type Group, type UnitId } from "./params";
import { poisson, rngFrom, stream, streamSeed } from "./rng";
import type { Scenario } from "./scenario";
import type { Acc, Counters, EventKind, EventRow, Hospital, HourRow, Person, Unit, W4Port, Where } from "./types";

const START = PARAMS.clock.startMinuteOfDay.value;
const RANK = { emergent: 0, urgent: 1, non_urgent: 2 };
const WARDS: UnitId[] = ["MED3A", "MED3B", "SURG5A"];
// Arrivals are numbered from 1 in every scenario, so arrival k is the same person everywhere (common random numbers).
// Residents of the first minute are numbered apart, as their count depends on beds and start occupancy.
const INITIAL_BASE = 1_000_000;

const unitOf = (h: Hospital, id: UnitId) => h.units.find((u) => u.id === id)!;
const blank = (): Counters => ({ admittedIn: 0, discharged: 0, transferredIn: 0, transferredOut: 0, died: 0 });
const emptyAcc = (): Acc => ({
  by: { ER: blank(), MORGUE: blank(), ICU: blank(), MED3A: blank(), MED3B: blank(), W4: blank(), SURG5A: blank() },
  arrivals: 0, lwbs: 0, boardMin: 0, d2d: [],
});

/** Units as the scenario sets them; W4 and the morgue are fixed. */
function buildUnits(s: Scenario): Unit[] {
  return UNITS.map((r) => {
    const base = { id: r.id, name: r.name, floor: r.floor, beds: r.beds.value, stretchers: r.stretchers.value, nurses: r.nurses.typical.value, residents: r.residents.value };
    if (r.id === "ER") return { ...base, beds: s.er.bays, nurses: s.er.nurses };
    if (r.id === "ICU" || r.id === "MED3A" || r.id === "MED3B" || r.id === "SURG5A") return { ...base, ...s.units[r.id] };
    return base;
  });
}

/** The hospital at minute 0: the ER full, the wards at the scenario's start occupancy part-way through their stays. */
export function createHospital(seed: number, scenario: Scenario, peopleCap: number = PARAMS.peopleCap.value): Hospital {
  const units = buildUnits(scenario);
  const h: Hospital = {
    seed, scenario, units, arrivalRng: streamSeed(seed, "arrivals"), nextN: 1, lastMinute: -1,
    people: [], gone: [], goneCount: 0, createdCount: 0, turnedAway: 0, peopleCap,
    doctorsFreeAt: Array<number>(Math.max(scenario.er.doctorsDay, scenario.er.doctorsNight)).fill(0),
    icuFree: 0, events: [], hourly: [], acc: emptyAcc(),
  };
  seedResidents(h);
  h.icuFree = unitOf(h, "ICU").beds - h.people.filter((p) => p.unit === "ICU" && p.slot !== null).length;
  return h;
}

// `used` and `out` are rebuilt each minute and never saved: the people hold the truth.
interface Ctx { h: Hospital; port: W4Port; minute: number; used: Record<string, Set<number>>; out: Set<Person>; w4Full: boolean }

const slotIn = (used: Set<number>, lo: number, hi: number): number | null => {
  for (let i = lo; i < hi; i += 1) if (!used.has(i)) return i;
  return null;
};
const freeBed = (c: Ctx, id: UnitId) => slotIn(c.used[id], 0, unitOf(c.h, id).beds);
const freeStretcher = (c: Ctx, id: UnitId) => { const u = unitOf(c.h, id); return slotIn(c.used[id], u.beds, u.beds + u.stretchers); };
const anySlot = (c: Ctx, id: UnitId) => slotIn(c.used[id], 0, Infinity)!; // ER trolleys and morgue overflow have no cap
const release = (c: Ctx, p: Person) => { if (p.slot !== null) c.used[p.unit].delete(p.slot); p.slot = null; };
const take = (c: Ctx, p: Person, id: UnitId, slot: number | null) => { p.unit = id; p.slot = slot; if (slot !== null) c.used[id].add(slot); };

function push(h: Hospital, row: EventRow) {
  h.events.push(row);
  const cap = PARAMS.bufferCap.events.value;
  if (h.events.length > cap) h.events.splice(0, h.events.length - cap);
}
const log = (c: Ctx, p: Person, unit: UnitId, kind: EventKind, detail: string, news2Independent = true) =>
  push(c.h, { minute: c.minute, person: p.id, w4_id: p.w4Id, unit, kind, detail, news2_independent: news2Independent });

/** A discharge hour on the clock, as W4's dueAt does: nearest day, then the drawn hour. */
function dueAt(minute: number, stayMin: number, hour: number) {
  const due = Math.round(Math.round((minute + stayMin) / DAY_MIN) * DAY_MIN + hour * 60 - START); // whole minutes: the drawn hour is fractional
  return due > minute ? due : due + DAY_MIN;
}

const wardsOf = (g: Group): UnitId[] => PARAMS.placement.value[g === "trauma" ? "trauma" : "others"] as UnitId[];
const wantsIcu = (p: Person) => p.icuIndicated || p.wants === "ICU";
const endBoarding = (p: Person, minute: number) => { if (p.where === "boarding") p.boardedMin += minute - p.sinceMin; };

function finish(c: Ctx, p: Person) {
  release(c, p);
  c.out.add(p);
}

/** Puts a person in a slot (or on W4), sets the stay clock and the in-stay fate. `fromEr` counts as an admission, else a transfer. */
function put(c: Ctx, p: Person, id: UnitId, where: Where, slot: number | null, kind: EventKind, detail: string, fromEr: boolean, news2Independent = true) {
  const from = p.unit;
  endBoarding(p, c.minute);
  release(c, p);
  take(c, p, id, slot);
  p.where = where; p.sinceMin = c.minute; p.wants = null;
  p.dueMin = id === "ICU" ? c.minute + p.icuStayMin : id === "W4" ? null : dueAt(c.minute, p.stayMin, p.dischargeHour);
  // W4 patients carry no hospital fate in this slice: W4 deaths are slice H8's.
  if (id !== "W4" && p.dieMin === null && p.deathU < stayDeathP(p.group, p.icuIndicated)) {
    // The stay is what is left until the discharge clock, plus the ward stay still to come after an ICU stay.
    const left = id === "ICU" ? p.icuStayMin + p.stayMin : p.dueMin! - c.minute;
    p.dieMin = c.minute + 1 + Math.floor(p.deathF * left);
  }
  const by = c.h.acc.by;
  if (fromEr) by[id].admittedIn += 1;
  else { by[id].transferredIn += 1; by[from].transferredOut += 1; }
  log(c, p, id, kind, detail, news2Independent);
}

/** Row 9 and 10: ICU if indicated and free; cardiac through W4's port; else the group's bed, then its stretcher. */
function tryPlace(c: Ctx, p: Person): boolean {
  const flag = p.icuIndicated ? "ICU-indicated, not in ICU" : "";
  if (wantsIcu(p)) {
    const s = freeBed(c, "ICU");
    if (s !== null) { put(c, p, "ICU", "bed", s, "place", "ICU", true); return true; }
  }
  if (p.fromW4) return false; // left W4 for the ICU: only the ICU will do, never back to W4, whatever the draws say
  if (p.group === "cardiac") {
    if (c.w4Full) return false;
    const w4Id = c.port.admit({ name: p.name, age: p.age, sex: p.sex }, c.minute);
    if (w4Id === null) { c.w4Full = true; return false; }
    p.w4Id = w4Id;
    put(c, p, "W4", "bed", null, "place", flag || "W4", true);
    return true;
  }
  for (const id of wardsOf(p.group)) {
    const s = freeBed(c, id);
    if (s !== null) { put(c, p, id, "bed", s, "place", flag || id, true); return true; }
  }
  for (const id of wardsOf(p.group)) {
    const s = freeStretcher(c, id);
    if (s !== null) { put(c, p, id, "stretcher", s, "place", `${flag || id} corridor stretcher`, true); return true; }
  }
  return false;
}

function newPerson(h: Hospital, n: number, arrivedMin: number): Person {
  const d = drawPerson(h.seed, n);
  return {
    ...d, arrivedMin, unit: "ER", where: "waiting", sinceMin: arrivedMin, slot: null, wants: null, seenMin: null, decideMin: null, dueMin: null,
    dieMin: d.erDeathAfterMin === null ? null : arrivedMin + d.erDeathAfterMin, boardedMin: 0, w4Id: null, fromW4: false,
  };
}

/** The first minute's residents. Candidates are drawn by number and kept only if their unit still needs one. */
function seedResidents(h: Hospital) {
  const rng = stream(h.seed, "init");
  const c = { h, used: Object.fromEntries(h.units.map((u) => [u.id, new Set<number>()])) } as Ctx; // only `used` is read here
  let k = 0;
  const candidate = () => { k += 1; return newPerson(h, INITIAL_BASE + k, 0); };
  // The start never exceeds the people cap: a resident who does not fit is turned away at minute 0 and recorded, like an arrival.
  const room = (p: Person) => {
    if (h.people.length < h.peopleCap) return true;
    h.turnedAway += 1;
    push(h, { minute: 0, person: p.id, w4_id: null, unit: "ER", kind: "turned_away", detail: "people cap reached at start", news2_independent: true });
    return false;
  };
  const add = (p: Person) => { h.people.push(p); h.createdCount += 1; };

  const consult = PARAMS.consultMin.value;
  for (let i = 0; i < unitOf(h, "ER").beds; i += 1) {
    const p = candidate();
    if (!room(p)) continue;
    const total = consult + p.decisionMin;
    const elapsed = Math.floor(rng() * total);
    p.arrivedMin = 0 - elapsed; p.seenMin = p.arrivedMin; p.decideMin = p.arrivedMin + total;
    p.where = elapsed < consult ? "consult" : "workup"; p.sinceMin = p.arrivedMin;
    if (p.erDeathAfterMin !== null) p.dieMin = Math.max(1, p.arrivedMin + p.erDeathAfterMin);
    take(c, p, "ER", anySlot(c, "ER"));
    add(p);
  }

  const need: Partial<Record<UnitId, number>> = {};
  for (const id of ["ICU", ...WARDS] as UnitId[]) need[id] = Math.round(unitOf(h, id).beds * h.scenario.startOccupancy);
  while (Object.values(need).some((n) => n! > 0)) {
    if (k > 200_000) throw new RangeError("could not fill the start occupancy");
    const p = candidate();
    p.icuIndicated = p.icuU < PARAMS.icuIndicated[p.group].value; // a resident is admitted by construction
    const home: UnitId | null = p.icuIndicated ? "ICU" : p.group === "cardiac" ? null /* W4's 12 patients are linked in H3 */
      : p.group === "trauma" ? "SURG5A" : need.MED3A! >= need.MED3B! ? "MED3A" : "MED3B";
    if (home === null || need[home]! <= 0) continue;
    need[home]! -= 1;
    if (!room(p)) continue;
    const bed = freeBed(c, home);
    const slot = bed ?? freeStretcher(c, home);
    if (slot === null) { // beyond beds and stretchers: boards in the ER for its unit
      p.where = "boarding"; p.wants = home; p.decideMin = 0; p.arrivedMin = 0;
      take(c, p, "ER", anySlot(c, "ER"));
    } else {
      p.where = bed !== null ? "bed" : "stretcher"; p.arrivedMin = 0;
      take(c, p, home, slot);
      const left = home === "ICU" ? Math.floor(p.icuStayMin * rng()) + 1 : dueAt(0, Math.floor(p.stayMin * rng()), p.dischargeHour); // W4's dueForInitialPatient
      p.dueMin = left;
      if (p.deathU < stayDeathP(p.group, p.icuIndicated)) p.dieMin = 1 + Math.floor(p.deathF * p.dueMin);
    }
    add(p);
  }
}

function die(c: Ctx, p: Person) {
  endBoarding(p, c.minute);
  c.h.acc.by[p.unit].died += 1;
  log(c, p, p.unit, "died", p.where);
  p.where = "awaiting_morgue"; p.sinceMin = c.minute; p.wants = null; // the bed or bay stays blocked until the body leaves
}

function leaveEr(c: Ctx, p: Person, kind: EventKind, detail: string) {
  endBoarding(p, c.minute);
  log(c, p, "ER", kind, detail);
  finish(c, p);
}

const round = (x: number, places: number) => Math.round(x * 10 ** places) / 10 ** places;
const inEr = (p: Person) => p.unit === "ER" && (p.where === "waiting" || p.where === "consult" || p.where === "workup" || p.where === "boarding");
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export function stepHospital(h: Hospital, port: W4Port, minute: number) {
  h.lastMinute = minute;
  const used = Object.fromEntries(h.units.map((u) => [u.id, new Set<number>()]));
  for (const p of h.people) if (p.slot !== null) used[p.unit].add(p.slot);
  const c: Ctx = { h, port, minute, used, out: new Set(), w4Full: false };
  const sc = h.scenario;
  const live = () => h.people.filter((p) => !c.out.has(p));

  // 1. Arrivals: Poisson per minute, the rate set by the 8-hour block of the clock (flat inside it).
  const clockHour = Math.floor(((minute + START) % DAY_MIN) / 60);
  const shares = PARAMS.arrivals.blockShares.value;
  const share = clockHour >= 6 && clockHour < 14 ? shares[0] : clockHour >= 14 && clockHour < 22 ? shares[1] : shares[2];
  const arng = rngFrom(h.arrivalRng);
  const arrivals = poisson(arng, sc.arrivalsPerDay * share / 8 / 60);
  h.arrivalRng = arng.state();
  for (let i = 0; i < arrivals; i += 1) {
    const n = h.nextN;
    h.nextN += 1;
    if (h.people.length >= h.peopleCap) { // never dropped silently
      h.turnedAway += 1;
      push(h, { minute, person: `h-${String(n).padStart(6, "0")}`, w4_id: null, unit: "ER", kind: "turned_away", detail: "people cap reached", news2_independent: true });
      continue;
    }
    const p = newPerson(h, n, minute);
    h.people.push(p);
    h.createdCount += 1;
    h.acc.arrivals += 1;
    log(c, p, "ER", "arrive", `${p.group}: ${p.complaint}`);
    log(c, p, "ER", "triage", p.triage);
  }

  // 2. Deaths and the morgue. A death is a pre-drawn time, whatever the person is doing.
  const toMorgue = PARAMS.morgue.toMorgueH.value * 60;
  const released = PARAMS.morgue.releasedAfterH.value * 60;
  for (const p of h.people) {
    if (p.where === "awaiting_morgue") {
      if (minute - p.sinceMin < toMorgue) continue;
      release(c, p);
      take(c, p, "MORGUE", anySlot(c, "MORGUE"));
      p.where = "morgue"; p.sinceMin = minute;
      log(c, p, "MORGUE", "to_morgue", "");
    } else if (p.where === "morgue") {
      if (minute - p.sinceMin >= released) { log(c, p, "MORGUE", "released", ""); finish(c, p); }
    } else if (p.dieMin !== null && p.dieMin <= minute) die(c, p);
  }

  // 3. Beds free up. W4 patients leave first, then ward discharges, then ICU step-downs (an ICU patient who needs a ward bed
  // goes before a boarder: the ICU is the bottleneck, and design row 13 gives no priority).
  for (const p of live()) {
    if (p.w4Id === null) continue;
    const left = port.left(p.w4Id);
    if (left === null) continue;
    if (left.outcome === "discharged") {
      h.acc.by.W4.discharged += 1;
      log(c, p, "W4", "discharge", "", false); // W4's discharge time is NEWS2-decided
      finish(c, p);
      continue;
    }
    const s = freeBed(c, "ICU");
    p.fromW4 = true;
    if (s !== null) put(c, p, "ICU", "bed", s, "transfer", "W4 to ICU", false, false);
    else { // the real W4 (sim.ts w4Port) keeps the patient until an ICU bed is free, so only a test double reaches this
      h.acc.by.W4.transferredOut += 1;
      h.acc.by.ER.transferredIn += 1;
      release(c, p); take(c, p, "ER", anySlot(c, "ER"));
      p.where = "boarding"; p.wants = "ICU"; p.sinceMin = minute; p.dueMin = null;
      log(c, p, "ER", "board", "W4 higher care, no ICU bed", false);
    }
    p.w4Id = null;
  }
  const settled = (p: Person) => (p.where === "bed" || p.where === "stretcher") && p.dueMin !== null && p.dueMin <= minute;
  for (const p of live()) {
    if (!settled(p) || p.unit === "ICU") continue;
    h.acc.by[p.unit].discharged += 1;
    log(c, p, p.unit, "discharge", "");
    finish(c, p);
  }
  for (const p of live()) {
    if (!settled(p) || p.unit !== "ICU") continue;
    for (const id of wardsOf(p.group)) { // no free ward bed: stays in the ICU and tries again next minute
      const s = freeBed(c, id);
      if (s !== null) { put(c, p, id, "bed", s, "transfer", `ICU to ${id}`, false); break; }
    }
  }
  for (const id of WARDS) { // a freed bed goes to the person who has waited longest on a stretcher of that unit
    const queue = live().filter((p) => p.unit === id && p.where === "stretcher").sort((a, b) => a.sinceMin - b.sinceMin || a.n - b.n);
    for (const p of queue) {
      const s = freeBed(c, id);
      if (s === null) break;
      release(c, p); take(c, p, id, s);
      p.where = "bed";
      log(c, p, id, "transfer", "stretcher to bed");
    }
  }

  // 4. The ER. Consults end, boarders are placed or transferred out, decisions fall due, doctors take the queue.
  const consultMin = PARAMS.consultMin.value;
  for (const p of live()) if (p.where === "consult" && minute >= p.seenMin! + consultMin) { p.where = "workup"; p.sinceMin = p.seenMin! + consultMin; }

  const byTriage = (a: Person, b: Person) => RANK[a.triage] - RANK[b.triage] || (a.decideMin ?? a.arrivedMin) - (b.decideMin ?? b.arrivedMin) || a.n - b.n;
  for (const p of live().filter((q) => q.where === "boarding").sort(byTriage)) {
    if (tryPlace(c, p)) continue;
    if (minute - p.sinceMin >= sc.transferOutAfterH * 60) {
      h.acc.by.ER.transferredOut += 1;
      leaveEr(c, p, "transfer_out", `boarded ${Math.round((minute - p.sinceMin) / 60)} h`);
    }
  }
  const deciding = live().filter((p) => p.where === "workup" && p.erDeathAfterMin === null && minute >= p.decideMin!).sort(byTriage);
  for (const p of deciding) {
    if (!p.admit) {
      h.acc.by.ER.discharged += 1;
      leaveEr(c, p, "decide_home", "");
      continue;
    }
    p.wants = wantsIcu(p) ? "ICU" : p.group === "cardiac" ? "W4" : wardsOf(p.group)[0];
    log(c, p, "ER", "decide_admit", p.icuIndicated ? `${p.group}, ICU-indicated` : p.group);
    if (!tryPlace(c, p)) {
      p.where = "boarding"; p.sinceMin = minute;
      log(c, p, "ER", "board", p.wants);
    }
  }

  const onShift = clockHour >= 7 && clockHour < 19 ? sc.er.doctorsDay : sc.er.doctorsNight;
  const free: number[] = [];
  for (let k = 0; k < onShift; k += 1) if (h.doctorsFreeAt[k] <= minute) free.push(k);
  if (free.length > 0) {
    const queue = live().filter((p) => p.where === "waiting").sort((a, b) => RANK[a.triage] - RANK[b.triage] || a.arrivedMin - b.arrivedMin || a.n - b.n);
    for (let i = 0; i < Math.min(free.length, queue.length); i += 1) {
      const p = queue[i];
      h.doctorsFreeAt[free[i]] = minute + consultMin;
      take(c, p, "ER", anySlot(c, "ER"));
      p.where = "consult"; p.sinceMin = minute; p.seenMin = minute; p.decideMin = minute + consultMin + p.decisionMin;
      h.acc.d2d.push(minute - p.arrivedMin);
      log(c, p, "ER", "consult", "");
    }
  }
  for (const p of live()) { // left without being seen: urgent and non-urgent only, once their own patience is spent
    if (p.where === "waiting" && p.patienceMin !== null && minute - p.arrivedMin >= p.patienceMin) {
      h.acc.lwbs += 1;
      leaveEr(c, p, "lwbs", `waited ${Math.round((minute - p.arrivedMin) / 60)} h`);
    }
  }

  h.acc.boardMin += h.people.filter((p) => p.where === "boarding" && !c.out.has(p)).length;
  if (c.out.size > 0) {
    h.people = h.people.filter((p) => !c.out.has(p));
    h.gone.push(...c.out);
    h.goneCount += c.out.size;
    if (h.gone.length > 300) h.gone.splice(0, h.gone.length - 300);
  }
  h.icuFree = unitOf(h, "ICU").beds - used.ICU.size;
  if ((minute + 1) % 60 === 0) hourRows(h, Math.floor(minute / 60));
}

/** One row per unit: the state now and what happened since the last row. */
function hourRows(h: Hospital, hour: number) {
  const a = h.acc;
  for (const u of h.units) {
    const here = h.people.filter((p) => p.unit === u.id);
    const stay = u.id === "ER" ? here.filter(inEr) : u.id === "MORGUE" ? here.filter((p) => p.where === "morgue") : here.filter((p) => p.slot !== null || p.w4Id !== null);
    const census = stay.length;
    const er = u.id === "ER";
    const count = (where: Where) => stay.filter((p) => p.where === where).length;
    const row: HourRow = {
      hour, unit: u.id, census, beds: u.beds, stretchers_used: stay.filter((p) => p.slot !== null && p.slot >= u.beds).length,
      occupancy_pct: u.beds > 0 ? round((census / u.beds) * 100, 1) : 0, // a raw scenario with no beds must not give NaN
      arrivals: er ? a.arrivals : 0,
      admitted_in: a.by[u.id].admittedIn, discharged: a.by[u.id].discharged, transferred_in: a.by[u.id].transferredIn,
      transferred_out: a.by[u.id].transferredOut, died: a.by[u.id].died,
      nurses: u.nurses, patients_per_nurse: u.nurses > 0 ? round(census / u.nurses, 1) : null,
      er_waiting: er ? count("waiting") : null, er_consult: er ? count("consult") : null, er_workup: er ? count("workup") : null,
      er_boarding: er ? count("boarding") : null, er_boarding_hours: er ? round(a.boardMin / 60, 2) : null, er_lwbs: er ? a.lwbs : null,
      door_to_doctor_median_min: er ? median(a.d2d) : null,
      icu_indicated_not_in_icu: u.id === "MORGUE" ? null : here.filter((p) => p.icuIndicated && p.unit !== "ICU" && (p.where === "boarding" || p.where === "bed" || p.where === "stretcher" || p.w4Id !== null)).length,
      morgue: u.id === "MORGUE" ? here.length + h.people.filter((p) => p.unit !== "MORGUE" && p.where === "awaiting_morgue").length : null,
    };
    h.hourly.push(row);
  }
  const cap = PARAMS.bufferCap.hourly.value;
  if (h.hourly.length > cap) h.hourly.splice(0, h.hourly.length - cap);
  h.acc = emptyAcc();
}

/** Hands over the event and hourly rows and clears them; a caller does this each hour. */
export function takeRows(h: Hospital): { events: EventRow[]; hourly: HourRow[] } {
  const rows = { events: h.events, hourly: h.hourly };
  h.events = [];
  h.hourly = [];
  return rows;
}
