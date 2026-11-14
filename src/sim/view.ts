// The ward as viewers get it. The headless runner publishes it; the page in viewer mode draws it
// and never makes a ward of its own. Pure: no browser or Node APIs.
// `shared` goes to every signed-in clinician, so it holds ids and bed labels only: no names, context,
// story or log text. A patient's `view` goes only to the clinicians the server assigns them to.

import { BEDS } from "./map";
import { minuteOf, type Patient, type Sim, type Staff, type Stay, type StayOutcome, type Task } from "./sim";
import { VITALS, type Vital } from "./source";

const MAX_MOVES = 20; // as the sim keeps
const MAX_SCORES = 200;
const MAX_LOG = 200;
const PLACE_TILES = 3; // a staff member further than this from where they were drawn is placed, not eased

type Move = Sim["moves"][number] & { seq: number };
// Nothing the page draws reads these.
type Dropped =
  | "window" | "nextMinute" | "offsetS" | "nurseAt" | "totals" | "ackLevel"
  | "lastAssessed" | "dueMin" | "oxygenUntilMin" | "md" | "listMd";
export type PatientView = Omit<Patient, Dropped>;

export interface Shared {
  clockS: number;
  speed: Sim["speed"];
  ended: boolean;
  counts: Sim["counts"];
  staff: Staff[];
  tasks: Task[];
  moves: Move[];
  beds?: string[]; // labels of every occupied bed, nothing else. Absent from an older runner: none.
}
interface PatientEntry {
  id: string;
  view: PatientView;
}
/** The body of POST /sim/runs/{run_id}/view. */
export interface ViewBody {
  shared: Shared;
  patients: PatientEntry[];
}
/** What GET /wards/W4/live answers. `shared` is null while no ward is being published. `can_control` is absent from an older API: false. */
export interface LiveView {
  shared: Shared | null;
  patients: PatientEntry[];
  can_control?: boolean;
  /** The API's time base for this answer (ISO, ward time): every served time is compared with it. Absent from an older API. */
  now?: string;
}

/** The served `now` in epoch ms, or `fallbackMs` (the real clock) when the answer has none or it does not parse. */
export function servedNowMs(live: { now?: unknown }, fallbackMs: number): number {
  const ms = typeof live.now === "string" ? Date.parse(live.now) : NaN;
  return Number.isFinite(ms) ? ms : fallbackMs;
}

// A requested BP is a patient's reading: it stays out of `shared`.
const bare = ({ kind, patient, rn }: Task): Task => ({ kind, patient, rn });

/** Turns the live sim into what is published. Drains `s.moves`, as the renderer does in the page. */
export function createPublisher() {
  let seq = 0;
  let moves: Move[] = [];
  return (s: Sim): ViewBody => {
    // Numbered once here, so a viewer that polls the same move twice launches one trolley.
    for (const move of s.moves.splice(0)) moves.push({ ...move, seq: (seq += 1) });
    moves = moves.slice(-MAX_MOVES);
    return {
      shared: {
        clockS: s.clockS,
        speed: s.speed,
        ended: s.ended,
        counts: s.counts,
        staff: s.staff.map((m) => ({ ...m, task: m.task && bare(m.task) })),
        tasks: s.tasks.map(bare),
        moves,
        beds: s.patients.map((p) => p.bed),
      },
      patients: s.patients.map((p) => {
        const { window, nextMinute, offsetS, nurseAt, totals, ackLevel, lastAssessed, dueMin, oxygenUntilMin, md, listMd, ...view } = p;
        // shortcut: the stay's chart shows its last 200 hours so a view stays under the API's 65,536 characters, send hourly scores another way if a longer chart is wanted
        return { id: p.id, view: { ...view, stay: { ...p.stay, scores: p.stay.scores.slice(-MAX_SCORES) } } };
      }),
    };
  };
}

const NONE: Shared = {
  clockS: 0,
  speed: 0,
  ended: false,
  counts: { received: 0, rejected: 0, abstained: 0 },
  staff: [],
  tasks: [],
  moves: [],
};

/** Turns each answer into a Sim the renderer and panels can draw. An empty ward when nothing is published. */
export function createReader() {
  let last: number | null = null; // null until the first ward: moves from before sign-in are old news
  let clock = 0;
  return (live: LiveView): Sim => {
    const shared = live.shared ?? NONE;
    if (shared.clockS < clock) last = 0; // the runner restarted, and its numbering with it
    clock = shared.clockS;
    const moves = shared.moves.filter((move) => move.seq > (last ?? Infinity));
    if (live.shared) last = Math.max(last ?? 0, ...shared.moves.map((move) => move.seq));
    const patients: Patient[] = live.patients.map(({ view }) => ({
      window: Object.fromEntries(VITALS.map((v) => [v, []])) as unknown as Record<Vital, (number | null)[]>,
      nextMinute: 0,
      offsetS: 0,
      nurseAt: 0,
      totals: [],
      ackLevel: 0,
      lastAssessed: 0,
      dueMin: null,
      oxygenUntilMin: null,
      md: "",
      listMd: null,
      ...view,
    }));
    // A clinician is sent only their own patients: work on anyone else's loses its patient rather than crash a panel.
    const mine = (task: Task | null) => (task && patients.some((p) => p.id === task.patient) ? task : null);
    // Built here from the stays the viewer was sent: no ward-wide log text is published.
    const seen = new Set<string>();
    const log = patients
      .flatMap((p) => p.stay.events)
      .filter((line) => {
        const key = `${line.minute} ${line.text}`; // one line can name two patients
        return !seen.has(key) && seen.add(key);
      })
      .sort((a, b) => a.minute - b.minute)
      .slice(-MAX_LOG);
    return {
      clockS: shared.clockS,
      speed: shared.speed,
      ended: shared.ended,
      counts: shared.counts,
      patients,
      staff: shared.staff.map((m) => ({ ...m, task: mine(m.task) })),
      tasks: shared.tasks.filter(mine),
      mdCalls: [],
      log,
      stays: patients.map((p) => p.stay),
      moves,
      flow: { lastMinute: 0, admitted: 0, everOnOxygen: 0, discharged: 0, transferred: 0, turnedAway: 0 },
      occupied: (shared.beds ?? []).filter((bed) => !patients.some((p) => p.bed === bed)),
    };
  };
}

/** A row of GET /wards/W4/stays. Times are ISO strings in served ward time. */
export interface StayRow {
  id: string;
  name: string;
  bed: string;
  admitted_at: string | null;
  left_at: string | null;
  outcome: StayOutcome | null;
}

/**
 * The finished stays among `rows`, oldest departure first, as the sim keeps them. What the API does not
 * give (context, nurse, physician, peak, scores, events) stays empty: nothing is made up.
 */
export function finishedStays(rows: StayRow[], s: Sim, nowMs: number): Stay[] {
  // "That long before now" is counted back from the sim's minute. `nowMs` is the API's own `now` from the same poll round when it
  // serves one (ward time), else the real clock, which is right only while the API shifts served times onto it.
  const at = (iso: string) => Math.max(0, Math.round(minuteOf(s) - (nowMs - Date.parse(iso)) / 60000));
  return rows
    .filter((row) => row.left_at !== null && BEDS.some((bed) => bed.label === row.bed)) // the ward draws only its own beds
    .map((row) => {
      const inMin = row.admitted_at === null ? 0 : at(row.admitted_at); // 0: arrival unknown, as for patients present at the start
      return {
        id: row.id,
        name: row.name,
        bed: row.bed,
        context: "",
        rn: "",
        md: null,
        inMin,
        outMin: Math.max(inMin, at(row.left_at!)),
        outcome: row.outcome,
        peak: null,
        peakRisk: null,
        scores: [],
        events: [],
      };
    })
    .sort((a, b) => a.outMin - b.outMin);
}

type Point = { x: number; y: number };

/** Where a staff member is drawn `t` (0 to 1) of the way from `previous` to `next`. Placed at `next` when new or far (a restart). */
export function ease(previous: Point | undefined, next: Point, t: number): Point {
  if (!previous || Math.hypot(next.x - previous.x, next.y - previous.y) > PLACE_TILES) return { x: next.x, y: next.y };
  const k = Math.max(0, Math.min(1, t));
  return { x: previous.x + (next.x - previous.x) * k, y: previous.y + (next.y - previous.y) * k };
}
