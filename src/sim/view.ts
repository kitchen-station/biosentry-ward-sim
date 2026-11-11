// The ward as viewers get it. The headless runner publishes it; the page in viewer mode draws it
// and never makes a ward of its own. Pure: no browser or Node APIs.
// `shared` goes to every signed-in clinician, so it holds ids and beds only: no names, context,
// story or log text. A patient's `view` goes only to the clinicians the server assigns them to.

import type { Patient, Sim, Staff, Task } from "./sim";
import { VITALS, type Vital } from "./source";

const MAX_MOVES = 20; // as the sim keeps
const MAX_SCORES = 200;

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
/** What GET /wards/W4/live answers. `shared` is null while no ward is being published. */
export interface LiveView {
  shared: Shared | null;
  patients: PatientEntry[];
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
    return {
      clockS: shared.clockS,
      speed: shared.speed,
      ended: shared.ended,
      counts: shared.counts,
      patients,
      staff: shared.staff.map((m) => ({ ...m, task: mine(m.task) })),
      tasks: shared.tasks.filter(mine),
      mdCalls: [],
      log: [],
      stays: patients.map((p) => p.stay),
      moves,
      flow: { lastMinute: 0, admitted: 0, everOnOxygen: 0, discharged: 0, transferred: 0, turnedAway: 0 },
    };
  };
}
