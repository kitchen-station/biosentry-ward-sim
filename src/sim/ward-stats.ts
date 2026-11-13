// What the Analytics page keeps while a ward runs: W4's NEWS2 levels per 15 minutes, alerts per shift, finished stays, and
// (hospital world) the units' hourly counts. Pure: it only reads the Sim, calls no random stream and writes nothing on the
// Sim or the source. It lives beside the world, not in Sim, so saves and the golden run are unchanged.
// Synthetic data only. An alert here is a demo line, not a clinical claim.
import { minuteOf, type Sim } from "./sim";
import { START_CLOCK_MIN, type VitalsSource } from "./source";

export const BIN_MIN = 15;
export const ALERT_AT = 5; // the demo line: NEWS2 total 5 or more, as compare's rule news2_total_ge_5
export const REARM_BINS = 16; // quiet bins (4 h) before a patient can alert again; also read by src/compare.ts
export const SHIFT_MIN = 720; // 12 h shifts that start at 07:00 and 19:00
const SHIFT_START_CLOCK_MIN = 7 * 60;
// Patient i is sampled i x 5 s after the minute (Patient.offsetS). The ward has 20 beds, so the last offset is 95 s: that
// is past the next minute, when a patient may already have left. A bin is read in two parts for that reason.
const FIRST_PART_S = 59; // every patient with an offset under 60 has been sampled
const LAST_OFFSET_S = 95;

export const CAPS = { levels: 672, shifts: 14, stays: 200, hoursPerUnit: 168 } as const; // 7 days of bins, 7 days of shifts, 7 days of hours

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
  episodes: { start: number; rampMin: number; alertMin: number | null }[] | null; // not computed in version 1
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
  stage: [id: string, total: number | null, level: "low" | "low_medium" | "medium" | "high" | "not_ranked"][] | null; // the bin being read: first part done
  levels: WardSummary["levels"];
  shifts: WardSummary["shifts"];
  stays: WardSummary["stays"];
  lastOut: number; // finished stays are taken once, by the minute they left
  alert: Record<string, [armed: boolean, quiet: number, last: number]>; // per patient in the ward: compare's re-arm rule
  hospital: WardSummary["hospital"];
}

export function createWardStats(): WardStats {
  return { from: null, to: 0, next: BIN_MIN, at: 0, stage: null, levels: [], shifts: [], stays: [], lastOut: 0, alert: {}, hospital: null };
}

const shiftStartOf = (m: number) => m - ((START_CLOCK_MIN + m - SHIFT_START_CLOCK_MIN) % SHIFT_MIN);

/** Reads the Sim after a step(). Cheap unless a 15-minute bin is being read: then O(patients), and O(finished stays + hospital hours) once it closes. */
export function feed(st: WardStats, s: Sim, _src?: VitalsSource): void {
  const minute = minuteOf(s);
  st.from ??= minute;
  st.to = minute;
  const c = s.clockS;
  if (st.stage === null) {
    // The latest bin whose first part is due. If a jump went past its minute, it stays a gap.
    const m = Math.floor((c - FIRST_PART_S) / (BIN_MIN * 60)) * BIN_MIN;
    if (m < st.next) return;
    st.next = m + BIN_MIN;
    if (c >= (m + 1) * 60) return;
    st.stage = [];
    // Placed this minute: its row is the placing decision, as the trial reads it. Offset 60 or more: sampled later, in the second part.
    for (const p of s.patients) if (p.offsetS < 60 || p.stay.inMin === m) stage(st, p);
    st.at = m;
  }
  const m = st.at;
  if (c < m * 60 + LAST_OFFSET_S) return;
  if (c >= (m + 2) * 60) {
    st.stage = null; // a jump: the bin is not made up
    return;
  }
  const have = new Set(st.stage.map((x) => x[0]));
  for (const p of s.patients) if (!have.has(p.id)) stage(st, p);
  close(st, s, m);
}

function stage(st: WardStats, p: Sim["patients"][number]) {
  const level = p.decision.kind === "ranked" ? p.decision.news2.risk : "not_ranked";
  st.stage!.push([p.id, p.totals.at(-1) ?? null, level]);
}

function close(st: WardStats, s: Sim, m: number) {
  const rows = st.stage!;
  st.stage = null;
  const row = { m, low: 0, low_medium: 0, medium: 0, high: 0, not_ranked: 0, beds: rows.length };
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
      if (a[0]) shift.alerts += 1;
      a[0] = false;
      a[1] = 0;
    } else quiet();
  }
  const here = new Set(s.patients.map((p) => p.id));
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
    episodes: null,
    staff: null,
    hospital: copy.hospital,
  };
}
