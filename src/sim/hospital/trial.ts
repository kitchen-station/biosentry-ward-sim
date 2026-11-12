// A headless hospital trial: (seed, scenario, days) in, the text of three result files out. Pure: no clock, no I/O.
// It steps the world as the page does (speed 60, one step a sim second) and drains takeRows every sim hour.
import { minuteOf, setSpeed, step } from "../sim";
import { createSyntheticSource, FIXTURE_SEED } from "../source";
import { createHospitalSim } from "./attach";
import { PARAMS } from "./params";
import type { Scenario } from "./scenario";
import { takeRows } from "./step";
import type { EventKind, EventRow, HourRow } from "./types";

export type TrialEvent = Omit<EventRow, "kind"> & { kind: EventKind | "w4_higher_care" };

export const WARM_UP_DAYS = 3;
export const SPEED = 60;
export const LIMITS =
  "synthetic, not validated: staffing outside W4 is shown, not modelled; deaths are pre-drawn fates, so crowding does not change who dies";
const STEPS_PER_HOUR = 3600; // speed 60: one step is one sim second

export const HOURLY_COLUMNS = [
  "hour", "unit", "census", "beds", "stretchers_used", "occupancy_pct", "arrivals", "admitted_in", "discharged", "transferred_in",
  "transferred_out", "died", "nurses", "patients_per_nurse", "er_waiting", "er_consult", "er_workup", "er_boarding", "er_boarding_hours",
  "er_lwbs", "door_to_doctor_median_min", "icu_indicated_not_in_icu", "morgue",
] as const satisfies readonly (keyof HourRow)[];
export const EVENT_COLUMNS = ["minute", "person", "w4_id", "unit", "kind", "detail", "news2_independent"] as const;

// The design's `w4_higher_care` is the step that moves a W4 patient out for higher care (the sim writes it as a transfer or a board).
export const isHigherCare = (e: EventRow) => e.detail === "W4 to ICU" || e.detail === "W4 higher care, no ICU bed";

/** A CSV field: String(n), blank for null. A comma in the sim's fixed wording becomes ";". Nothing else can break a row: asserted. */
function field(v: string | number | boolean | null): string {
  const t = v === null ? "" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v).replaceAll(",", ";");
  if (!/^[\x20-\x7e]*$/.test(t)) throw new Error(`trial: a field holds a character outside printable ASCII: ${JSON.stringify(t.slice(0, 20))}`);
  return t;
}
const line = (values: (string | number | boolean | null)[]) => values.map(field).join(",") + "\n";

const personNumber = (id: string) => {
  if (!/^h-\d{6,}$/.test(id)) throw new Error(`trial: unexpected person id ${JSON.stringify(id.slice(0, 20))}`);
  return Number(id.slice(2));
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s[Math.ceil(q * s.length) - 1]; // nearest rank
};
const r = (x: number | null, places = 2) => (x === null ? null : Math.round(x * 10 ** places) / 10 ** places);
const share = (n: number, d: number) => (d === 0 ? null : r(n / d, 4));

/** Figures over minutes [fromMin, endMin). Counts use the event's minute; stay figures use the stay's first event (arrival, decision, board). */
export function figures(events: TrialEvent[], hourly: HourRow[], units: string[], fromMin: number, endMin: number) {
  const all = events.filter((e) => e.minute < endMin);
  const ev = all.filter((e) => e.minute >= fromMin);
  const hr = hourly.filter((h) => h.hour * 60 >= fromMin && h.hour * 60 < endMin);
  const count = (kind: string, unit?: string) => ev.filter((e) => e.kind === kind && (unit === undefined || e.unit === unit)).length;

  const per_unit: Record<string, unknown> = {};
  for (const id of units) {
    const rows = hr.filter((h) => h.unit === id);
    const occ = rows.map((h) => h.occupancy_pct);
    per_unit[id] = {
      occupancy_mean_pct: occ.length ? r(occ.reduce((a, b) => a + b, 0) / occ.length) : null,
      occupancy_max_pct: occ.length ? Math.max(...occ) : null,
      admissions: rows.reduce((a, h) => a + h.admitted_in, 0),
      deaths: rows.reduce((a, h) => a + h.died, 0),
    };
  }

  // People who arrived during the run (minute-0 residents have no arrive event) and arrived in the window.
  const arrivedAt = new Map<string, number>();
  const triage = new Map<string, string>();
  for (const e of all) {
    if (e.kind === "arrive") arrivedAt.set(e.person, e.minute);
    else if (e.kind === "triage") triage.set(e.person, e.detail);
  }
  const arrivers = new Set([...arrivedAt].filter(([, m]) => m >= fromMin).map(([p]) => p));

  const d2d: number[] = [], d2dBy: Record<string, number[]> = { emergent: [], urgent: [], non_urgent: [] }, lwbsWait: number[] = [];
  const boardedAt = new Map<string, number>(), boardH: number[] = [];
  for (const e of all) {
    if (e.kind === "consult" && arrivers.has(e.person)) {
      const w = e.minute - arrivedAt.get(e.person)!;
      d2d.push(w);
      d2dBy[triage.get(e.person) ?? ""]?.push(w);
    } else if (e.kind === "lwbs" && arrivers.has(e.person)) lwbsWait.push(e.minute - arrivedAt.get(e.person)!);
    else if (e.kind === "board" && !boardedAt.has(e.person)) boardedAt.set(e.person, e.minute);
    else if ((e.kind === "place" || e.kind === "transfer_out" || e.kind === "died") && boardedAt.has(e.person)) {
      const start = boardedAt.get(e.person)!;
      boardedAt.delete(e.person);
      if (start >= fromMin) boardH.push((e.minute - start) / 60);
    }
  }
  const stillBoarding = [...boardedAt.values()].filter((m) => m >= fromMin).map((m) => (endMin - m) / 60);

  const admit = ev.filter((e) => e.kind === "decide_admit" && arrivers.has(e.person)).length;
  const home = ev.filter((e) => e.kind === "decide_home" && arrivers.has(e.person)).length;
  const erDeaths = ev.filter((e) => e.kind === "died" && e.unit === "ER" && arrivers.has(e.person)).length;
  const indicated = new Set(ev.filter((e) => e.kind === "decide_admit" && e.detail.endsWith("ICU-indicated")).map((e) => e.person));
  const reached = new Set(all.filter((e) => e.kind === "place" && e.unit === "ICU" && indicated.has(e.person)).map((e) => e.person));
  const ended = new Set(all.filter((e) => (e.kind === "died" || e.kind === "transfer_out" || e.kind === "discharge") && indicated.has(e.person)).map((e) => e.person));
  const pending = [...indicated].filter((p) => !reached.has(p) && !ended.has(p)).length;

  return {
    per_unit,
    admissions: hr.reduce((a, h) => a + h.admitted_in, 0), // people the ER placed in any unit; moves between units are transfers
    deaths: count("died"),
    er_boarding_hours_median: r(median(boardH)), // completed boardings only: biased down when many are still boarding at the end
    er_boarding_hours_p90: r(pct(boardH, 0.9)),
    er_boarders_ended: boardH.length,
    er_still_boarding_at_end: { count: stillBoarding.length, median_hours_so_far: r(median(stillBoarding)) },
    left_without_being_seen: count("lwbs"),
    lwbs_wait_median_min: r(median(lwbsWait)),
    transfers_out: count("transfer_out"),
    // People who left unseen are not in these.
    door_to_doctor_median_min: r(median(d2d)),
    door_to_doctor_p90_min: r(pct(d2d, 0.9)),
    share_seen_within_30_min: share(d2d.filter((w) => w <= 30).length, d2d.length),
    share_seen_in_arrival_minute: share(d2d.filter((w) => w === 0).length, d2d.length),
    door_to_doctor_median_min_by_triage: { emergent: r(median(d2dBy.emergent)), urgent: r(median(d2dBy.urgent)), non_urgent: r(median(d2dBy.non_urgent)) },
    er_arrivals: arrivers.size,
    er_admission_share: share(admit, admit + home),
    er_death_share: share(erDeaths, arrivers.size),
    icu_access: {
      icu_indicated_admitted_from_er: indicated.size, reached_icu: reached.size, share: share(reached.size, indicated.size),
      icu_indicated_pending_at_end: pending,
    },
    w4_admissions: count("place", "W4"),
    w4_higher_care_transfers: count("w4_higher_care"),
  };
}

/** The design's `w4_higher_care` kind for a W4 move out for higher care; a row that is not news2_independent: no is a fault. */
export function labelEvents(rows: EventRow[]): TrialEvent[] {
  return rows.map((e) => {
    if (!isHigherCare(e)) return e;
    if (e.news2_independent) throw new Error("trial: w4_higher_care must be news2_independent: no");
    return { ...e, kind: "w4_higher_care" };
  });
}

/** Both blocks of summary.json's figures. */
export function summarize(events: TrialEvent[], hourly: HourRow[], units: string[], days: number) {
  const end = days * 1440;
  return { all_days: figures(events, hourly, units, 0, end), after_warm_up: figures(events, hourly, units, WARM_UP_DAYS * 1440, end) };
}

export interface TrialResult {
  hourlyCsv: string; eventsCsv: string; summaryJson: string; hourlyRows: number; eventRows: number;
}

/** Runs the world for `days` sim days. Throws if a buffer was ever full when drained: the files would be incomplete. */
export function runHospitalTrial(seed: number, scenario: Scenario, days: number, caps = { events: PARAMS.bufferCap.events.value, hourly: PARAMS.bufferCap.hourly.value }): TrialResult {
  const src = createSyntheticSource(FIXTURE_SEED, true);
  const s = createHospitalSim(src, scenario, seed);
  setSpeed(s, SPEED);
  const h = s.hospital!;
  const events: TrialEvent[] = [], hourly: HourRow[] = [];
  const drain = () => {
    if (h.events.length >= caps.events || h.hourly.length >= caps.hourly) throw new Error("trial: a row buffer was full, rows may have been dropped; no files written");
    const rows = takeRows(h);
    events.push(...labelEvents(rows.events));
    hourly.push(...rows.hourly);
    s.moves.length = 0; // as skipDay: trolleys are only for drawing
  };
  const total = days * 24 * STEPS_PER_HOUR;
  for (let i = 1; i <= total; i += 1) {
    step(s, src);
    if (i % STEPS_PER_HOUR === 0) drain();
  }
  if (minuteOf(s) !== days * 1440) throw new Error("trial: the clock is not where the trial should end");
  drain();
  events.splice(0, events.length, ...events.filter((e) => e.minute < days * 1440)); // the last minute is stepped but has no hourly row: files cover [0, days x 1440)
  const units = h.units.map((u) => u.id);
  let hourlyCsv = line([...HOURLY_COLUMNS]);
  for (const row of hourly) hourlyCsv += line(HOURLY_COLUMNS.map((c) => row[c]));
  let eventsCsv = line([...EVENT_COLUMNS]);
  for (const e of events) eventsCsv += line([e.minute, personNumber(e.person), e.w4_id, e.unit, e.kind, e.detail, e.news2_independent]);

  const summary = {
    format_version: 1, synthetic: true, seed, days, warm_up_days: WARM_UP_DAYS, scenario,
    ...summarize(events, hourly, units, days),
    limits: LIMITS,
  };
  return { hourlyCsv, eventsCsv, summaryJson: JSON.stringify(summary, null, 2) + "\n", hourlyRows: hourly.length, eventRows: events.length };
}
