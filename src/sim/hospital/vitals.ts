// One vital-sign stream per hospital person, kept beside the hospital.
//
// Read-only: it reads `h.seed`, `h.lastMinute` and `h.people`, and writes only its own objects. It draws from no existing
// random stream: each person gets a new source of their own, seeded by `vitals:${id}:v${visit}`.
// Display only: a score here never changes care, a move, a staff task or any hospital number.
//
// Stated defaults (inputs the generator or the hospital does not give; none is a new clinical number):
//  - Consciousness (ACVPU) is "A" for everyone, as the generator's admit sets it. It is not modelled.
//  - Oxygen is the generator's own draw and off-time (the rates W4 uses). It is not the hospital's.
//  - Blood pressure is the arrival cuff, then a new cuff each time the hospital records an observation round. No rounds in ICU.
//  - SpO2 scale is 1 for everyone, as the generator's admit sets it.
//
// A deterioration starts when the hospital records `course.onsetMin` for the person, through the generator's own `inject`.
// A person with no recorded onset has no episode: an episode the generator drew at admission is cleared at open.
// The generator has no recovery. At an ICU to ward step-down the episode is cleared the same way, and the span is marked
// `recovery: "not_modelled"`. One switch, CLEAR_EPISODE_AT_ICU_STEP_DOWN, turns this off.
//
// Notes: the first sync happens at hospital minute -1, so a few people get their minute-0 reading one second late (harmless:
// a read at minute 0 or before returns the anchor). Create the engine anew for every new world: an old engine fed a new world
// would silently reuse streams with a matching id and visit.
// Ward W4 is untouched: while a person is on W4 the engine reads nothing and keeps a span with their W4 patient id.
import { rankWard } from "../arbiter";
import { BEDS } from "../map";
import { roundHalfUp, type Risk } from "../news2";
import { decide, gate, seat, vitalQuality, type Patient } from "../sim";
import { createSyntheticSource, VITALS, type SavedSource, type VitalsSource } from "../source";
import type { UnitId } from "./params";
import { fnv1a, streamSeed } from "./rng";
import type { Hospital, Person, Where } from "./types";

/** The owner's pending decision: clear the generator's episode when a person steps down from intensive care. */
export const CLEAR_EPISODE_AT_ICU_STEP_DOWN = true;

export const CAPS = { bins: 800, scores: 200, finished: 100, catchUpMin: 60 } as const;
export const RANKED_UNITS: UnitId[] = ["ER", "MED3A", "MED3B", "SURG5A"];

const BIN_MIN = 15;
const HOUR_MIN = 60;

export interface Span { unit: UnitId; where: Where; fromMin: number; w4Id: string | null; gap?: "not_read"; recovery?: "not_modelled" }
export interface VitalBin { m: number; unit: UnitId; hr: number | null; rr: number | null; spo2: number | null; temp: number | null; sbp: number | null; news2: number | null }

export interface PersonVitals {
  id: string; visit: number; n: number;
  unit: UnitId; where: Where;
  src: VitalsSource | null; // null once the stream is finished
  p: Patient;
  next: number; offsetS: number; reads: number;
  bins: VitalBin[]; scores: (number | null)[];
  spans: Span[];
  episode: { startMin: number } | null;
  cleared: boolean; // the episode was ended at an ICU step-down
  lastObs: number | null;
}

export interface HospitalVitals {
  live: Map<string, PersonVitals>;
  finished: PersonVitals[];
  at: number | null; // the hospital minute last synced
  clearAtStepDown: boolean;
  created: number; reads: number; episodes: number; generatorEpisodesCleared: number; stepDownsCleared: number; gaps: number;
}

export interface VitalsSummary {
  live: number; finished: number; created: number; reads: number; episodes: number;
  generatorEpisodesCleared: number; stepDownsCleared: number; gaps: number;
  bins: number; maxBins: number; maxScores: number;
  byUnit: Record<string, { people: number; ranked: number; notRanked: number }>;
  digest: string;
}

export function createVitals(opts: { clearEpisodeAtIcuStepDown?: boolean } = {}): HospitalVitals {
  return {
    live: new Map(), finished: [], at: null, clearAtStepDown: opts.clearEpisodeAtIcuStepDown ?? CLEAR_EPISODE_AT_ICU_STEP_DOWN,
    created: 0, reads: 0, episodes: 0, generatorEpisodesCleared: 0, stepDownsCleared: 0, gaps: 0,
  };
}

/** The same source with no episode scheduled: rebuilt from its saved state, so every later draw is the same. */
function withoutSchedule(src: VitalsSource, id: string): VitalsSource | null {
  const saved: SavedSource = src.save!([id]);
  const st = saved.streams[id] as { injectAt: number | null };
  if (st.injectAt === null) return null;
  return createSyntheticSource(saved.seed, true, { ...saved, streams: { [id]: { ...st, injectAt: null } } });
}

function open(v: HospitalVitals, h: Hospital, q: Person, minute: number): PersonVitals {
  let src = createSyntheticSource(streamSeed(h.seed, `vitals:${q.id}:v${q.visit}`), true);
  const seed = src.admit!(minute, [], { id: q.id, bed: BEDS[0].label }, { name: q.name, age: q.age, sex: q.sex })!;
  const rebuilt = withoutSchedule(src, q.id);
  if (rebuilt) { src = rebuilt; v.generatorEpisodesCleared += 1; }
  const p = seat(src, seed, 0, minute);
  v.created += 1;
  return {
    id: q.id, visit: q.visit, n: q.n, unit: q.unit, where: q.where, src, p, next: minute + 1, offsetS: q.n % 60, reads: 0,
    bins: [], scores: [], spans: [{ unit: q.unit, where: q.where, fromMin: minute, w4Id: q.w4Id }], episode: null, cleared: false, lastObs: q.obsLastMin,
  };
}

/** Start reading again at minute `next`, with a gate that holds nothing from before the break. */
function restart(pv: PersonVitals, next: number) {
  pv.next = next;
  for (const vt of VITALS) pv.p.window[vt] = [];
  pv.p.signal = [];
}

function finish(v: HospitalVitals, pv: PersonVitals) {
  v.live.delete(pv.id);
  pv.src = null;
  v.finished.push(pv);
  if (v.finished.length > CAPS.finished) v.finished.shift();
}

function sync(v: HospitalVitals, h: Hospital) {
  const minute = h.lastMinute;
  v.at = minute;
  const seen = new Set<string>();
  for (const q of h.people) {
    if (q.where === "awaiting_morgue" || q.where === "morgue") continue;
    let pv = v.live.get(q.id);
    if (pv && pv.visit !== q.visit) { finish(v, pv); pv = undefined; }
    if (!pv) {
      if (q.unit === "W4") continue; // W4's own record holds this person; a stream opens when they leave
      pv = open(v, h, q, minute);
      v.live.set(q.id, pv);
    }
    seen.add(q.id);
    pv.where = q.where;
    if (q.unit !== pv.unit) {
      const was = pv.unit;
      const span: Span = { unit: q.unit, where: q.where, fromMin: minute, w4Id: q.unit === "W4" ? q.w4Id : null };
      if (was === "ICU" && v.clearAtStepDown && pv.episode !== null && !pv.cleared) {
        const rebuilt = pv.src ? withoutSchedule(pv.src, pv.id) : null;
        if (rebuilt) pv.src = rebuilt;
        pv.cleared = true;
        span.recovery = "not_modelled";
        v.stepDownsCleared += 1;
      }
      pv.spans.push(span);
      pv.unit = q.unit;
      if (was === "W4") restart(pv, minute + 1);
    }
    if (q.unit === "W4") continue;
    if (q.obsLastMin !== null && q.obsLastMin !== pv.lastObs) {
      pv.lastObs = q.obsLastMin;
      pv.p.bp = pv.src!.cuff(pv.id, q.obsLastMin);
      pv.p.bpAt = q.obsLastMin;
    }
    const onset = q.course?.onsetMin ?? null;
    if (pv.episode === null && onset !== null) {
      pv.src!.inject!(pv.id, onset);
      pv.episode = { startMin: onset };
      v.episodes += 1;
    }
  }
  for (const pv of [...v.live.values()]) if (!seen.has(pv.id)) finish(v, pv);
}

function sample(v: HospitalVitals, pv: PersonVitals, m: number) {
  const p = pv.p;
  const src = pv.src!;
  const reading = src.read(pv.id, m);
  p.irregular = src.irregularAt?.(pv.id, m) ?? p.irregular;
  if (p.oxygenUntilMin !== null && m >= p.oxygenUntilMin) { p.onOxygen = false; p.oxygenUntilMin = null; }
  gate(p, reading, m);
  decide(p, m);
  pv.reads += 1;
  v.reads += 1;
  const total = p.decision.kind === "ranked" ? p.decision.news2.total : null;
  if (m % BIN_MIN === 0) {
    for (const vt of VITALS) {
      p.history[vt].push(vitalQuality(p, vt, m) === "ok" ? p.held[vt] : null);
      p.history[vt].shift();
    }
    p.bpHistory.push(p.bp?.systolic ?? null);
    p.bpHistory.shift();
    p.totals.push(total);
    p.totals.shift();
    const now = p.totals.at(-1) ?? null, then = p.totals[0];
    if (now !== null && then !== null) p.trend = now - then >= 1 ? "rising" : now - then <= -1 ? "falling" : "stable";
    // As record() sends them: missing is null, otherwise the precision NEWS2 scores at.
    const shown = (vt: (typeof VITALS)[number]) => (vitalQuality(p, vt, m) === "missing" || p.held[vt] === null ? null : roundHalfUp(p.held[vt]!, vt === "temperature" ? 1 : 0));
    pv.bins.push({ m, unit: pv.unit, hr: shown("heart_rate"), rr: shown("respiratory_rate"), spo2: shown("spo2"), temp: shown("temperature"), sbp: p.bp?.systolic ?? null, news2: total });
    if (pv.bins.length > CAPS.bins) pv.bins.shift();
  }
  if (m % HOUR_MIN === 0) {
    pv.scores.push(total);
    if (pv.scores.length > CAPS.scores) pv.scores.shift();
  }
}

/** Call after every `step()`. Reads each person once per simulated minute, on their own second. */
export function feedVitals(v: HospitalVitals, h: Hospital, clockS: number): void {
  if (h.lastMinute !== v.at) sync(v, h);
  for (const pv of v.live.values()) {
    if (pv.unit === "W4") continue;
    const latest = Math.floor((clockS - pv.offsetS) / 60);
    if (latest - pv.next + 1 > CAPS.catchUpMin) { // a jump: no catch-up, and the gap is on the record
      pv.spans.push({ unit: pv.unit, where: pv.where, fromMin: pv.next, w4Id: null, gap: "not_read" });
      pv.spans.push({ unit: pv.unit, where: pv.where, fromMin: latest, w4Id: null });
      restart(pv, latest);
      v.gaps += 1;
    }
    while (pv.next * 60 + pv.offsetS <= clockS) {
      sample(v, pv, pv.next);
      pv.next += 1;
    }
  }
}

/** The live stream for a person, or the latest kept one. `visit` picks one visit. */
export function vitalsOf(v: HospitalVitals, id: string, visit?: number): PersonVitals | null {
  const live = v.live.get(id);
  if (live && (visit === undefined || live.visit === visit)) return live;
  for (let i = v.finished.length - 1; i >= 0; i -= 1) {
    const f = v.finished[i];
    if (f.id === id && (visit === undefined || f.visit === visit)) return f;
  }
  return null;
}

/** NEWS2 risk by click key `h:${n}`, for live people outside W4 and intensive care. null: not ranked. */
export function riskBySel(v: HospitalVitals): Record<string, Risk | null> {
  const out: Record<string, Risk | null> = {};
  for (const pv of v.live.values()) {
    if (pv.unit === "ICU" || pv.unit === "W4" || pv.unit === "MORGUE") continue;
    out[`h:${pv.n}`] = pv.p.decision.kind === "ranked" ? pv.p.decision.news2.risk : null;
  }
  return out;
}

/** One unit in the ward's own order (rankWard). null for intensive care, W4 and the morgue: they are not ranked here. */
export function unitRank(v: HospitalVitals, h: Hospital, unit: UnitId): { ranked: PersonVitals[]; notRanked: PersonVitals[] } | null {
  if (unit === "ICU" || unit === "W4" || unit === "MORGUE") return null;
  const here: PersonVitals[] = [];
  for (const q of h.people) {
    const pv = q.unit === unit ? v.live.get(q.id) : undefined;
    if (pv && pv.visit === q.visit) here.push(pv);
  }
  const byId = new Map(here.map((pv) => [pv.id, pv]));
  const { ranked, notRanked } = rankWard(here.map((pv) => pv.p.decision));
  return { ranked: ranked.map((d) => byId.get(d.patientId)!), notRanked: notRanked.map((d) => byId.get(d.patientId)!) };
}

/** Plain JSON: counts, per unit tallies and a digest of every bin, score and span. Same seed, same summary. */
export function summary(v: HospitalVitals): VitalsSummary {
  const all = [...v.live.values(), ...v.finished];
  const byUnit: VitalsSummary["byUnit"] = {};
  for (const pv of v.live.values()) {
    if (pv.unit === "W4") continue; // paused: its last score is old, and W4's own record holds the person
    const row = (byUnit[pv.unit] ??= { people: 0, ranked: 0, notRanked: 0 });
    row.people += 1;
    if (pv.unit !== "ICU" && pv.p.decision.kind === "ranked") row.ranked += 1; // NEWS2 is a ward score: ICU is never ranked
    else row.notRanked += 1;
  }
  return {
    live: v.live.size, finished: v.finished.length, created: v.created, reads: v.reads, episodes: v.episodes,
    generatorEpisodesCleared: v.generatorEpisodesCleared, stepDownsCleared: v.stepDownsCleared, gaps: v.gaps,
    bins: all.reduce((a, pv) => a + pv.bins.length, 0),
    maxBins: all.reduce((a, pv) => Math.max(a, pv.bins.length), 0),
    maxScores: all.reduce((a, pv) => Math.max(a, pv.scores.length), 0),
    byUnit,
    digest: fnv1a(JSON.stringify(all.map((pv) => [pv.id, pv.visit, pv.bins, pv.scores, pv.spans, pv.episode, pv.reads]))).toString(16).padStart(8, "0"),
  };
}
