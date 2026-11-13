// What the Analytics page keeps while a ward runs: W4's NEWS2 levels per 15 minutes, alerts per shift, finished stays, and
// (hospital world) the units' hourly counts. Pure: it only reads the Sim, calls no random stream and writes nothing on the
// Sim or the source. It lives beside the world, not in Sim, so saves and the golden run are unchanged.
// Synthetic data only. An alert here is a demo line, not a clinical claim.
import { BEDS } from "./map";
import { minuteOf, type Sim } from "./sim";
import { START_CLOCK_MIN, type VitalsSource } from "./source";

export const BIN_MIN = 15;
export const ALERT_AT = 5; // the demo line: NEWS2 total 5 or more, as compare's rule news2_total_ge_5
export const REARM_BINS = 16; // quiet bins (4 h) before a patient can alert again; also read by src/compare.ts
export const WINDOW_AFTER_FULL_MIN = 120; // an episode's window ends this long after the offset is fully in; also read by src/compare.ts
export const SHIFT_MIN = 720; // 12 h shifts that start at 07:00 and 19:00
const SHIFT_START_CLOCK_MIN = 7 * 60;
// A patient's sample for a bin minute lands up to 5 s per bed after it (Patient.offsetS). The window is the trial runner's own
// (src/sim/trial.ts): a bin is read in the 60 + 5 x beds seconds after its minute, and closed after.
const WINDOW_S = 60 + 5 * BEDS.length;

export const CAPS = { levels: 672, shifts: 14, stays: 200, hoursPerUnit: 168, episodes: 200 } as const; // 7 days of bins, 7 days of shifts, 7 days of hours

export interface WardSummary {
  version: 1;
  ward: "W4";
  synthetic: true;
  binMin: 15;
  fromMin: number;
  toMin: number; // sim minutes fed
  levels: { m: number; low: number; low_medium: number; medium: number; high: number; not_ranked: number; beds: number }[];
  shifts: { start: number; alerts: number; patientMin: number; partial: boolean }[];
  stays: { inMin: number; outMin: number; outcome: "discharged" | "higher_care" }[];
  // The simulator's own truth (owner decision sim-lab-4). Null with no source that can save. No patient id, no outcome, and no
  // ramp or end of window: nothing here gives a time that is still ahead of the clock.
  episodes:
    | { start: number; kind: string; alertMin: number | null; minutesBetween: number | null; windowOpen: boolean }[]
    | null;
  staff: { hour: number; rn: number; charge_rn: number; md: number }[] | null; // not computed in version 1
  hospital: {
    units: { id: string; name: string; floor: number; beds: number }[];
    hours: { hour: number; unit: string; census: number; arrivals: number; admitted_in: number; discharged: number; transferred_in: number; transferred_out: number }[];
  } | null;
}

/** Opaque. Plain JSON, so a copy is structuredClone. */
export interface WardStats {
  from: number | null;
  to: number;
  at: number; // the bin in `stage`
  next: number; // the next 15-minute bin that may still be read
  stage: [id: string, total: number | null, level: "low" | "low_medium" | "medium" | "high" | "not_ranked"][] | null; // the bin being read, one entry per patient read
  levels: WardSummary["levels"];
  shifts: WardSummary["shifts"];
  stays: WardSummary["stays"];
  lastOut: number; // finished stays are taken once, by the minute they left
  alert: Record<string, [armed: boolean, quiet: number, last: number]>; // per patient in the ward: compare's re-arm rule
  hospital: WardSummary["hospital"];
  ep: { id: string; start: number; rampMin: number; kind: string; alertMin: number | null; done: boolean }[] | null; // null: no truth to read
  epSeen: string[]; // ids of patients in the ward whose episode was recorded, kept when the list is capped, so an evicted one does not come back
}

export function createWardStats(): WardStats {
  return { from: null, to: 0, next: BIN_MIN, at: 0, stage: null, levels: [], shifts: [], stays: [], lastOut: 0, alert: {}, hospital: null, ep: null, epSeen: [] };
}

const shiftStartOf = (m: number) => m - ((START_CLOCK_MIN + m - SHIFT_START_CLOCK_MIN) % SHIFT_MIN);

/**
 * Reads the Sim after a step(). The rule is the trial runner's: each patient is read on the first tick after its own
 * sample for the bin minute (`nextMinute - sampleEveryMin` is that minute), with its total and level at that moment.
 * A patient placed after the minute is never counted. Cheap except in the window after a bin minute, where it is O(patients).
 */
export function feed(st: WardStats, s: Sim, src?: VitalsSource): void {
  const minute = minuteOf(s);
  st.from ??= minute;
  st.to = minute;
  const c = s.clockS;
  const bin = Math.floor(c / (BIN_MIN * 60)) * BIN_MIN;
  const into = c - bin * 60;
  if (st.stage !== null && st.at !== bin) st.stage = null; // a jump: the bin is not made up
  if (st.stage === null) {
    // Begin only in the first minute of the window, so no patient has been passed over. A bin begun late stays a gap.
    if (bin < Math.max(st.next, BIN_MIN) || into >= 60) return;
    st.stage = [];
    st.at = bin;
    st.next = bin + BIN_MIN;
  }
  if (into > WINDOW_S) return close(st, s, bin, src);
  for (const p of s.patients) {
    if (p.nextMinute - p.rules.sampleEveryMin !== bin || st.stage.some((x) => x[0] === p.id)) continue;
    const d = p.decision;
    st.stage.push([p.id, d.kind === "ranked" ? d.news2.total : null, d.kind === "ranked" ? d.news2.risk : "not_ranked"]);
  }
}

function close(st: WardStats, s: Sim, m: number, src?: VitalsSource) {
  const rows = st.stage!;
  st.stage = null;
  const row = { m, low: 0, low_medium: 0, medium: 0, high: 0, not_ranked: 0, beds: rows.length };
  // The truth, read once per bin. A start is recorded only once the bin minute has reached it, never before.
  // An episode that starts inside the stay. Compare leaves out patients on the ward at minute 0; the page lists them too
  // (a chosen group, or a click on "Start deterioration"). The hand-written 12 have none unless clicked.
  if (typeof src?.save === "function") {
    st.ep ??= [];
    const saved = src.save(s.patients.map((p) => p.id));
    for (const p of s.patients) {
      const t = saved.streams[p.id] as { episode: { kind: string } | null; injectAt: number | null; rampMin: number } | undefined;
      if (!t || t.episode === null || t.injectAt === null || t.injectAt > m || t.injectAt < p.stay.inMin || st.epSeen.includes(p.id)) continue;
      st.epSeen.push(p.id);
      st.ep.push({ id: p.id, start: t.injectAt, rampMin: t.rampMin, kind: t.episode.kind, alertMin: null, done: false });
    }
    if (st.ep.length > CAPS.episodes) st.ep.splice(0, st.ep.length - CAPS.episodes);
  }
  const start = shiftStartOf(m);
  if (st.shifts.at(-1)?.start !== start) st.shifts.push({ start, alerts: 0, patientMin: 0, partial: false });
  const shift = st.shifts.at(-1)!;
  for (const [id, total, level] of rows) {
    row[level] += 1;
    shift.patientMin += BIN_MIN;
    // The same rule as compare's w4Arm for news2_total_ge_5: a bin with no alert counts toward re-arming, and so does a missing bin.
    const a = (st.alert[id] ??= [true, 0, -1]);
    const quiet = () => {
      if (!a[0] && ++a[1] >= REARM_BINS) a[0] = true;
    };
    if (a[2] >= 0) for (let g = (m - a[2]) / BIN_MIN - 1; g > 0; g -= 1) quiet();
    a[2] = m;
    if (total !== null && total >= ALERT_AT) {
      if (a[0]) {
        shift.alerts += 1;
        // The first new alert in the window, as compare's w4Arm takes it.
        const e = st.ep?.find((x) => x.id === id && !x.done); // a closed row never changes
        if (e && e.alertMin === null && m >= e.start && m <= e.start + e.rampMin + WINDOW_AFTER_FULL_MIN) e.alertMin = m;
      }
      a[0] = false;
      a[1] = 0;
    } else quiet();
  }
  const here = new Set(s.patients.map((p) => p.id));
  for (const e of st.ep ?? []) if (!e.done && (e.alertMin !== null || m >= e.start + e.rampMin + WINDOW_AFTER_FULL_MIN || !here.has(e.id))) e.done = true;
  st.epSeen = st.epSeen.filter((id) => here.has(id)); // a patient who left cannot come back: ids are per admission
  for (const id of Object.keys(st.alert)) if (!here.has(id)) delete st.alert[id];
  st.levels.push(row);
  if (st.levels.length > CAPS.levels) st.levels.shift();
  if (st.shifts.length > CAPS.shifts) st.shifts.shift();

  const left = s.stays.filter((x) => x.outMin !== null && x.outMin > st.lastOut && x.outMin <= m && x.inMin > 0 && x.outcome !== null);
  left.sort((a, b) => a.outMin! - b.outMin!);
  for (const x of left) st.stays.push({ inMin: x.inMin, outMin: x.outMin!, outcome: x.outcome! });
  st.lastOut = m;
  if (st.stays.length > CAPS.stays) st.stays.splice(0, st.stays.length - CAPS.stays);

  const h = s.hospital;
  if (h && m % 60 === 0) {
    const rows = h.hourly.slice(-CAPS.hoursPerUnit * h.units.length);
    st.hospital = {
      units: h.units.map((u) => ({ id: u.id, name: u.name, floor: u.floor, beds: u.beds })),
      hours: rows.map((r) => ({ hour: r.hour, unit: r.unit, census: r.census, arrivals: r.arrivals, admitted_in: r.admitted_in, discharged: r.discharged, transferred_in: r.transferred_in, transferred_out: r.transferred_out })),
    };
  }
}

/** A copy. The caps already hold. */
export function summary(st: WardStats): WardSummary {
  const copy = structuredClone({ levels: st.levels, shifts: st.shifts, stays: st.stays, hospital: st.hospital });
  // minutesBetween is whole minutes; compare keeps the fraction. A new alert is never before the start, so it is never negative.
  const episodes = st.ep && st.ep.map((e) => ({ start: e.start, kind: e.kind, alertMin: e.alertMin, minutesBetween: e.alertMin === null ? null : Math.round(e.alertMin - e.start), windowOpen: !e.done }));
  const from = st.from ?? 0;
  return {
    version: 1,
    ward: "W4",
    synthetic: true,
    binMin: 15,
    fromMin: from,
    toMin: st.to,
    levels: copy.levels,
    shifts: copy.shifts.map((x) => ({ ...x, partial: x.start < from || x.start + SHIFT_MIN > st.to })),
    stays: copy.stays,
    episodes,
    staff: null,
    hospital: copy.hospital,
  };
}
