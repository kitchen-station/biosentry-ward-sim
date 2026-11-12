// The hospital's state is plain JSON: numbers, strings, booleans, null, arrays and plain objects. No Map, Set, class
// instance, function or undefined-valued key, so JSON.parse(JSON.stringify(h)) continues identically.
import type { Group, Triage, UnitId } from "./params";
import type { Scenario } from "./scenario";

export type { Group, Triage, UnitId };
export type Sex = "F" | "M";
export type Where = "waiting" | "consult" | "workup" | "boarding" | "bed" | "stretcher" | "awaiting_morgue" | "morgue";

// Floor is a plain number: do not export a type named Floor (map.ts has one for room colours).
// obsCredit: nurse-minutes saved for observation rounds, capped at nurses x obs.roundMin; always 0 outside the workload units.
export interface Unit { id: UnitId; name: string; floor: number; beds: number; stretchers: number; nurses: number; residents: number; obsCredit: number }

/** Everything person n will ever need, drawn at arrival from the stream `person:${n}` in a fixed order. */
export interface PersonDraw {
  id: string; n: number; name: string; age: number; sex: Sex; group: Group; complaint: string; triage: Triage;
  look: [number, number, number]; // A3: skin 0-3, hair 0-4, shirt 0-5; same on every visit
  patienceMin: number | null;      // null for emergent: they never leave unseen
  admit: boolean; icuU: number; icuIndicated: boolean; // icuIndicated is only meaningful when admit
  decisionMin: number;             // consult end to decision, minutes
  stayMin: number; icuStayMin: number; dischargeHour: number; // ward stay, ICU stay, clock hour of a ward discharge
  erDeathAfterMin: number | null;  // pre-drawn ER-phase fate, minutes after arrival
  deathU: number; deathF: number;  // pre-drawn in-stay fate: dies when deathU < P(group), at fraction deathF of the stay
}

/** Section 7's record plus the few drawn numbers a stay needs. No vitals, no per-minute series. */
export interface Person extends PersonDraw {
  arrivedMin: number; unit: UnitId; where: Where; sinceMin: number;
  slot: number | null;             // ER: bay (>= bays is a trolley or chair); wards: bed, then stretcher; morgue: drawer; null in a queue or on W4
  wants: UnitId | null; seenMin: number | null; decideMin: number | null; dueMin: number | null; dieMin: number | null;
  boardedMin: number;              // total minutes spent boarding so far
  w4Id: string | null;             // set while the person is a W4 patient; W4 holds the clinical record
  fromW4: boolean;                 // left W4 needing higher care: only the ICU will do, never back to W4
  obsDueMin: number | null;        // next observation round falls due; null where rounds are not modelled (ICU, W4, morgue)
  obsLastMin: number | null;       // minute of the last observation round done, null before the first
  course: Course | null;           // slice A2: set at the admit decision, null for everyone never admitted during the run
  visit: number;                   // A3: 1 for a new person, 2 and on for a return (same id, name, age, sex, look)
  history: Visit[];                // A3: the earlier visits, last 5 only
}

/** Slice A3: one finished visit. Only a person discharged alive can return, so the outcome is always "discharged". */
export interface Visit { visit: number; arrivedMin: number; leftMin: number; lastUnit: UnitId; outcome: "discharged" }
/** Slice A3: a return waiting for an arrival slot (it takes the place of a new arrival, so arrivalsPerDay holds). */
export interface ReturnDue { n: number; visit: number; atMin: number; history: Visit[]; same: { name: string; sex: Sex; age: number; group: Group; look: [number, number, number] } }

/** Slice A2: one admission's deterioration course (people.ts drawCourse). atMin null: no deterioration in this stay. */
export interface Course {
  atMin: number | null;            // drawn onset minute; set to null when the person is not where a course is followed (W4, gone, dead)
  excessU: number;                 // the draw for a death caused by late recognition
  onsetMin: number | null;         // onset recorded on a ward, in ER boarding or in the ICU
  noticedMin: number | null;       // the round (or ICU arrival) that noticed it
  unnoticedMin: number | null;     // left (discharge, transfer out, death, W4) before anyone noticed
  escalated: boolean;              // reached an ICU bed after the notice
  excess: boolean;                 // the notice came late enough to cause a death (dieMin set by it)
}

export type EventKind =
  | "arrive" | "triage" | "consult" | "decide_home" | "decide_admit" | "board" | "place" | "transfer" | "discharge"
  | "lwbs" | "transfer_out" | "died" | "to_morgue" | "released"
  | "turned_away" // not in the design's list: an arrival the house could not hold (people cap)
  | "deteriorate" | "noticed" | "unnoticed" // slice A2
  | "return_scheduled" | "return" | "return_dropped"; // slice A3

export interface EventRow { minute: number; person: string; visit: number; w4_id: string | null; unit: UnitId; kind: EventKind; detail: string; news2_independent: boolean }

// transferred_in/out count moves between units (ICU step-down, W4 to ICU) and, for the ER, transfers out to another hospital.
// er_boarding_hours is boarding person-hours accrued during the hour. morgue is every body in the house (drawers and awaiting), on the MORGUE row.
export interface HourRow {
  hour: number; unit: UnitId; census: number; beds: number; stretchers_used: number; occupancy_pct: number;
  arrivals: number; admitted_in: number; discharged: number; transferred_in: number; transferred_out: number; died: number;
  nurses: number; patients_per_nurse: number | null;
  er_waiting: number | null; er_consult: number | null; er_workup: number | null; er_boarding: number | null;
  er_boarding_hours: number | null; er_lwbs: number | null; door_to_doctor_median_min: number | null;
  icu_indicated_not_in_icu: number | null; morgue: number | null;
  // Observation rounds (slice A1), appended; null on ICU, W4 and MORGUE, which are not in the workload model.
  obs_due: number | null; obs_done: number | null; obs_late: number | null; obs_overdue_now: number | null;
  obs_longest_overdue_min: number | null; care_min_demanded: number | null; care_min_available: number | null;
  obs_longest_since_round_min: number | null; obs_rel_late_median: number | null; // round 2: late but not abandoned
  // Late recognition (slice A2), appended; null where rounds are not modelled.
  deteriorated: number | null; noticed: number | null; noticed_late: number | null; unnoticed_now: number | null;
  recognition_delay_median_min: number | null;
  returns: number | null; // slice A3: ER only, returning people who arrived this hour
}

export interface Counters {
  admittedIn: number; discharged: number; transferredIn: number; transferredOut: number; died: number;
  obsDue: number; obsDone: number; obsLate: number; // rounds that fell due, done, done late this hour
  obsRel: number[]; // relative lateness of each round done this hour: (done - due) / interval; at most the hour's rounds
  deteriorated: number; noticed: number; noticedLate: number; delays: number[]; // A2: onsets, notices, late notices, their delays
}
export interface Acc { by: Record<UnitId, Counters>; arrivals: number; returns: number; lwbs: number; boardMin: number; d2d: number[] }

export interface Hospital {
  seed: number; scenario: Scenario; units: Unit[]; arrivalRng: number; nextN: number; lastMinute: number;
  people: Person[]; gone: Person[]; // gone: the last 300
  returning: ReturnDue[]; // A3: sorted by atMin, at most PARAMS.returns.cap
  goneCount: number; createdCount: number; turnedAway: number; peopleCap: number;
  doctorsFreeAt: number[]; icuFree: number;
  events: EventRow[]; hourly: HourRow[]; // a caller drains them each hour with takeRows
  acc: Acc;
}

// Same two words as the ward's own StayOutcome; H8 adds "died" there. Not imported: this code never reads sim.ts.
export type StayOutcome = "discharged" | "higher_care";
export interface W4Port {
  admit(person: { name: string; age: number; sex: Sex }, minute: number): string | null; // W4 id, or null when full
  left(w4Id: string): { outcome: StayOutcome; minute: number } | null;
}
