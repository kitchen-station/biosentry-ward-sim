// The ward simulation. Plain data, no React, no canvas: it runs headless in tests.
//
// Demo-only behaviour, not from the product: the quality gate rule, the 30-minute NOT RANKED
// cutoff, and the whole staff response loop. BioSentry itself only ranks and displays.

import { arbitrate, LEVEL, rankWard, type Decision } from "./arbiter";
import { BEDS, bedByLabel, findPath, HOMES, nurseStand, physicianStand, type Tile } from "./map";
import { roundHalfUp, scoreNews2, type Acvpu } from "./news2";
import type { Risk } from "./news2";
import {
  CLAMPS,
  VITALS,
  type Cuff,
  type GateRules,
  type PatientSeed,
  type Vital,
  type VitalsSource,
} from "./source";

export type Speed = 0 | 1 | 10 | 60;
export type Quality = "ok" | "degraded" | "missing";
export type Trend = "rising" | "falling" | "stable" | "insufficient";

const WINDOW_MINUTES = 15;
const REASSESS_AFTER = 60; // demo value
const ACTOR_SPEED_CAP = 6; // staff would cross the ward in a quarter second at 60x
const WALK_TILES_PER_S = 1;
const MESSAGE_S = 2;
const ASSESS_S = 12;
const REVIEW_S = 10;
const DONE_S = 2;

export interface Patient {
  id: string;
  name: string;
  age: number | string;
  sex: string;
  bed: string;
  context: string;
  story: string;
  rn: string;
  md: string; // who is called to the bedside
  listMd: string | null; // whose list the patient is on: null only for the fixture's two with no physician
  rules: GateRules;
  offsetS: number;
  nextMinute: number;
  patch: boolean;
  window: Record<Vital, (number | null)[]>;
  signal: number[]; // last 60 minutes of samples, 1 = usable
  held: Record<Vital, number | null>;
  heldAt: Record<Vital, number | null>;
  history: Record<Vital, (number | null)[]>; // 15-minute medians, oldest first
  bp: Cuff | null;
  bpAt: number | null;
  bpHistory: (number | null)[];
  nurseAt: number;
  consciousness: Acvpu;
  onOxygen: boolean;
  spo2Scale: 1 | 2;
  decision: Decision;
  rank: number | null;
  trend: Trend;
  totals: (number | null)[]; // NEWS2 per 15 minutes
  ackLevel: number;
  lastAssessed: number;
  injected: boolean;
  irregular: boolean;
  ectopyPerHour: number;
  dueMin: number | null; // patient flow: leaves once this minute passes
  oxygenUntilMin: number | null;
  stay: Stay;
}

export type StayOutcome = "discharged" | "higher_care";

/** One patient's time on the ward. Kept after they leave. */
export interface Stay {
  id: string; // the patient's id: each admission is a new patient
  name: string;
  bed: string;
  context: string;
  rn: string;
  md: string | null;
  inMin: number; // 0: already on the ward when the sim began, so the true arrival is unknown
  outMin: number | null;
  outcome: StayOutcome | null;
  peak: number | null; // highest NEWS2, checked every 15 minutes
  peakRisk: Risk | null;
  scores: (number | null)[]; // NEWS2 each hour
  events: { minute: number; text: string }[];
}

export type TaskKind = "assess" | "apply_patch" | "record_bp";

export interface Task {
  kind: TaskKind;
  patient: string;
  rn: string;
  bp?: Cuff;
}

export type Stage = "home" | "message" | "walk" | "work" | "wait_md" | "done" | "walk_home";
export type Chip = "idle" | "thinking" | "working" | "waiting" | "success";

export interface Staff {
  id: string;
  name: string;
  title: string;
  role: "rn" | "charge_rn" | "md";
  x: number;
  y: number;
  path: Tile[];
  facing: "front" | "back";
  moved: number;
  stage: Stage;
  timer: number;
  task: Task | null;
}

export interface MdCall {
  patient: string;
  md: string;
  nurse: string;
}


/** What the database API is sent, queued by the sim as it runs. Set only by src/sim/sync.ts. */
export interface Obs {
  patient_id: string;
  code: string;
  minute: number;
  num?: number;
  num2?: number;
  txt?: string;
  absent_reason?: string;
  source: "device" | "nurse";
  quality: Quality;
}
export interface Bin {
  patient_id: string;
  vital: Vital;
  minute: number;
  value: number | null;
}
export interface LogEvent {
  minute: number;
  kind: "log";
  patient_id: null;
  staff_id: null;
  text: string;
}
export interface PatientRow {
  id: string;
  name: string;
  age: number | null;
  sex: string;
  bed: string;
  context: string;
  story: string;
  rn: string;
  md: string | null;
  trend: Trend;
  signal_quality: number | null;
  observations: Obs[];
  bins: Bin[];
}
export interface Outbox {
  observations: Obs[];
  bins: Bin[];
  events: LogEvent[];
  admissions: (PatientRow & { minute: number })[];
  departures: { patient_id: string; minute: number; outcome: StayOutcome }[];
  sent: Map<string, string>; // patient/code to the value and quality last queued
}

export interface Sim {
  clockS: number;
  speed: Speed;
  patients: Patient[];
  staff: Staff[];
  tasks: Task[];
  mdCalls: MdCall[];
  log: { minute: number; text: string }[];
  counts: { received: number; rejected: number; abstained: number };
  stays: Stay[];
  moves: { bed: string; kind: "in" | StayOutcome }[]; // drained by the renderer
  flow: { lastMinute: number; admitted: number; everOnOxygen: number; discharged: number; transferred: number; turnedAway: number };
  ended: boolean;
  outbox?: Outbox;
  occupied?: string[]; // viewer only: beds someone else's patient is in, labels and nothing more
}

export const STAFF: [string, string, string, Staff["role"]][] = [
  ["rn-delacruz", "Dela Cruz", "Staff nurse", "rn"],
  ["rn-reyes", "Reyes", "Staff nurse", "rn"],
  ["rn-manalo", "Manalo", "Charge nurse", "charge_rn"],
  ["md-santos", "Dr. Santos", "Attending", "md"],
  ["md-aquino", "Dr. Aquino", "Attending", "md"],
];

const blank = <T,>(value: () => T) =>
  Object.fromEntries(VITALS.map((v) => [v, value()])) as Record<Vital, T>;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const MAX_STAY_EVENTS = 30;
const MAX_STAYS = 500; // finished stays past this are forgotten, oldest first
const MINUTES_PER_DAY = 1440;

export const minuteOf = (s: Sim) => Math.floor(s.clockS / 60);
export const staffById = (s: Sim, id: string) => s.staff.find((m) => m.id === id)!;
export const patientById = (s: Sim, id: string) => s.patients.find((p) => p.id === id)!;

export function say(s: Sim, text: string) {
  s.log.push({ minute: minuteOf(s), text });
  for (const p of s.patients) {
    if (!text.includes(p.name)) continue;
    p.stay.events.push({ minute: minuteOf(s), text });
    if (p.stay.events.length > MAX_STAY_EVENTS) p.stay.events.shift();
  }
  if (s.log.length > 200) s.log.shift();
  s.outbox?.events.push({ minute: minuteOf(s), kind: "log", patient_id: null, staff_id: null, text: text.slice(0, 500) });
}

/** Queues every input decide() used that changed since it was last queued, so the server scores the same. */
export const signalQuality = (p: Patient) =>
  p.signal.length ? Math.round((100 * p.signal.reduce((a, b) => a + b, 0)) / p.signal.length) : null;

/** A patient as the database API registers one. `minute` is when their 15-minute bins end. */
export function patientRow(p: Patient, observations: Obs[], minute: number): PatientRow {
  return {
    id: p.id,
    name: p.name,
    age: typeof p.age === "number" ? p.age : null,
    sex: p.sex,
    bed: p.bed,
    context: p.context,
    story: p.story,
    rn: p.rn,
    md: p.listMd,
    trend: p.trend,
    signal_quality: signalQuality(p),
    observations,
    bins: VITALS.flatMap((vital) =>
      p.history[vital].map((value, i, all) => ({
        patient_id: p.id,
        vital,
        minute: minute - (all.length - 1 - i) * 15,
        value,
      })),
    ),
  };
}

export function record(s: Sim, p: Patient, minute: number) {
  const out = s.outbox;
  if (!out) return;
  const put = (code: string, source: Obs["source"], quality: Quality, signature: unknown, value: Partial<Obs>) => {
    const key = `${p.id}/${code}`;
    const sig = JSON.stringify(signature);
    if (out.sent.get(key) === sig) return;
    out.sent.set(key, sig);
    const rows = out.observations;
    const row: Obs = { patient_id: p.id, code, minute, source, quality, ...value };
    const same = (o: Obs) => o.patient_id === p.id && o.code === code && o.minute === minute;
    let at = rows.length - 1;
    while (at >= 0 && rows[at].minute >= minute && !same(rows[at])) at--;
    if (at >= 0 && same(rows[at])) rows[at] = row; // the server keeps one row per minute
    else rows.push(row);
  };
  for (const v of VITALS) {
    const quality = vitalQuality(p, v, minute);
    const heldAt = p.heldAt[v];
    // Sent at the precision NEWS2 scores at (as src/bridge/snapshot.ts), so a shown value agrees with its points.
    const held = quality === "missing" || p.held[v] === null ? null : roundHalfUp(p.held[v]!, v === "temperature" ? 1 : 0);
    // Wording as in src/bridge/snapshot.ts.
    const reason = heldAt === null ? "No usable reading yet" : `No usable reading for ${minute - heldAt} min`;
    if (held === null) put(v, "device", "missing", null, { absent_reason: reason });
    else put(v, "device", quality, [held, quality], { num: held });
  }
  if (p.bp) put("blood_pressure", "nurse", "ok", p.bp, { num: p.bp.systolic, num2: p.bp.diastolic });
  else put("blood_pressure", "nurse", "missing", null, { absent_reason: "No blood pressure recorded" });
  put("consciousness", "nurse", "ok", p.consciousness, { txt: p.consciousness });
  put("supplemental_o2", "nurse", "ok", p.onOxygen, { num: p.onOxygen ? 1 : 0 });
  put("spo2_scale", "nurse", "ok", p.spo2Scale, { num: p.spo2Scale });
}

function gate(p: Patient, reading: Record<Vital, number | null> | null, minute: number) {
  const { sampleEveryMin, minValid, charted } = p.rules;
  let usable = reading !== null;
  for (const v of VITALS) {
    const value = reading?.[v] ?? null;
    const inRange = value !== null && value >= CLAMPS[v][0] && value <= CLAMPS[v][1];
    if (reading && !inRange && !(value === null && charted.includes(v))) usable = false;
    const buffer = p.window[v];
    buffer.push(inRange ? value : null);
    if (buffer.length > WINDOW_MINUTES / sampleEveryMin) buffer.shift();
    const got = buffer.filter((x): x is number => x !== null);
    if (inRange && got.length >= minValid[v]) {
      p.held[v] = median(got);
      p.heldAt[v] = minute;
    }
  }
  p.signal.push(usable ? 1 : 0);
  if (p.signal.length > 60 / sampleEveryMin) p.signal.shift();
  return usable;
}

export function vitalQuality(p: Patient, v: Vital, minute: number): Quality {
  const at = p.heldAt[v];
  if (at === null || minute - at > p.rules.notRankedAfter[v]) return "missing";
  return minute - at > p.rules.degradedAfter[v] ? "degraded" : "ok";
}

function applyCharted(src: VitalsSource, p: Patient, minute: number) {
  const chart = src.charted?.(p.id, minute);
  if (chart) Object.assign(p, chart);
}

function decide(p: Patient, minute: number) {
  const device = (v: Vital) => (vitalQuality(p, v, minute) === "missing" ? null : p.held[v]);
  p.decision = arbitrate(
    p.id,
    scoreNews2({
      respiratory_rate: device("respiratory_rate"),
      spo2: device("spo2"),
      spo2_scale: p.spo2Scale,
      supplemental_o2: p.onOxygen,
      systolic_bp: p.bp?.systolic ?? null,
      heart_rate: device("heart_rate"),
      consciousness: p.consciousness,
      temperature: device("temperature"),
    }),
  );
}

function rerank(s: Sim) {
  const { ranked } = rankWard(s.patients.map((p) => p.decision));
  for (const p of s.patients) p.rank = null;
  ranked.forEach((d, i) => {
    patientById(s, d.patientId).rank = i + 1;
  });
}

const levelOf = (p: Patient) => (p.decision.kind === "ranked" ? LEVEL[p.decision.news2.risk] : 0);

function maybeQueueAssessment(s: Sim, p: Patient, minute: number) {
  const level = levelOf(p);
  p.ackLevel = Math.min(p.ackLevel, level);
  const pending =
    s.tasks.some((t) => t.patient === p.id) ||
    s.staff.some((m) => m.task?.patient === p.id);
  const due =
    level >= 1 &&
    minute - p.lastAssessed >= REASSESS_AFTER &&
    (level > p.ackLevel || level >= 2); // demo rule: medium and high are seen at least hourly
  if (due && !pending) {
    s.tasks.push({ kind: "assess", patient: p.id, rn: p.rn });
  }
}

function logDecisionChange(s: Sim, p: Patient, before: Decision) {
  const after = p.decision;
  if (before.kind === "ranked" && after.kind === "not_ranked") {
    say(s, `${p.name} is NOT RANKED: ${after.reason}`);
  } else if (before.kind === "not_ranked" && after.kind === "ranked") {
    say(s, `${p.name} is ranked again, NEWS2 ${after.news2.total}`);
  } else if (before.kind === "ranked" && after.kind === "ranked") {
    if (before.news2.risk !== after.news2.risk) {
      say(s, `${p.name}: ${after.news2.totalReason}`);
    }
  }
}

function scoreStay(p: Patient, minute: number) {
  const stay = p.stay;
  const news2 = p.decision.kind === "ranked" ? p.decision.news2 : null;
  if (news2) {
    stay.peak = Math.max(stay.peak ?? 0, news2.total);
    if (stay.peakRisk === null || LEVEL[news2.risk] > LEVEL[stay.peakRisk]) stay.peakRisk = news2.risk;
  }
  if (minute % 60 === 0) stay.scores.push(news2 ? news2.total : null);
}

function sample(s: Sim, src: VitalsSource, p: Patient, minute: number) {
  const reading = src.read(p.id, minute); // the body continues whether or not the patch does
  p.irregular = src.irregularAt?.(p.id, minute) ?? p.irregular;
  if (p.oxygenUntilMin !== null && minute >= p.oxygenUntilMin) {
    p.onOxygen = false;
    p.oxygenUntilMin = null;
  }
  const delivered = p.patch ? reading : null;
  const usable = gate(p, delivered, minute);
  applyCharted(src, p, minute);
  const before = p.decision;
  decide(p, minute);
  rerank(s);
  logDecisionChange(s, p, before);
  maybeQueueAssessment(s, p, minute);
  record(s, p, minute);

  if (minute % WINDOW_MINUTES === 0) {
    for (const v of VITALS) {
      const value = vitalQuality(p, v, minute) === "ok" ? p.held[v] : null;
      p.history[v].push(value);
      p.history[v].shift();
      s.outbox?.bins.push({ patient_id: p.id, vital: v, minute, value });
    }
    p.bpHistory.push(p.bp?.systolic ?? null);
    p.bpHistory.shift();
    p.totals.push(p.decision.kind === "ranked" ? p.decision.news2.total : null);
    p.totals.shift();
    const now = p.totals.at(-1) ?? null;
    const then = p.totals[0];
    if (now !== null && then !== null) {
      const delta = now - then;
      p.trend = delta >= 1 ? "rising" : delta <= -1 ? "falling" : "stable";
    }
    scoreStay(p, minute);
  }

  if (!p.patch) return;
  s.counts.received += 1;
  if (!usable) s.counts.rejected += 1;
  else if (p.decision.kind === "not_ranked") s.counts.abstained += 1;
}

function goTo(m: Staff, target: Tile) {
  m.path = findPath([Math.round(m.x), Math.round(m.y)], target);
}

/** Moves along the path; true when there is nowhere left to go. */
function walk(m: Staff, dt: number) {
  let budget = dt * WALK_TILES_PER_S;
  while (budget > 0 && m.path.length > 0) {
    const [tx, ty] = m.path[0];
    const dx = tx - m.x;
    const dy = ty - m.y;
    const distance = Math.abs(dx) + Math.abs(dy);
    m.facing = dx < 0 || dy < 0 ? "back" : dx > 0 || dy > 0 ? "front" : m.facing;
    const step = Math.min(budget, distance);
    if (distance > 0) {
      m.x += (dx / distance) * step;
      m.y += (dy / distance) * step;
      m.moved += step;
    }
    budget -= step;
    if (step === distance) {
      m.x = tx;
      m.y = ty;
      m.path.shift();
    }
  }
  return m.path.length === 0;
}

const taskRank = (s: Sim, t: Task) =>
  t.kind === "assess" ? (patientById(s, t.patient).rank ?? 99) : 0; // a direct request goes first

function nextTask(s: Sim, rn: string) {
  const mine = s.tasks.filter((t) => t.rn === rn);
  if (mine.length === 0) return null;
  const pick = mine.reduce((best, t) => (taskRank(s, t) < taskRank(s, best) ? t : best));
  s.tasks.splice(s.tasks.indexOf(pick), 1);
  return pick;
}

function finishTask(s: Sim, src: VitalsSource, m: Staff) {
  const task = m.task!;
  const p = patientById(s, task.patient);
  const minute = minuteOf(s);
  if (task.kind === "apply_patch") {
    p.patch = true;
    say(s, `${m.name} applied the patch for ${p.name}`);
    m.stage = "done";
    m.timer = DONE_S;
    return;
  }
  const cuff = task.bp ?? src.cuff(p.id, minute);
  if (cuff) {
    p.bp = cuff;
    p.bpAt = minute;
  }
  p.nurseAt = minute;
  const before = p.decision;
  decide(p, minute);
  record(s, p, minute);
  rerank(s);
  logDecisionChange(s, p, before);
  p.lastAssessed = minute;
  p.ackLevel = levelOf(p);
  say(s, `${m.name} assessed ${p.name}, BP ${cuff?.systolic}/${cuff?.diastolic}`);
  // NEWS2 5+: the nurse must immediately inform the medical team (RCP 2017, and Kitchen).
  if (levelOf(p) >= LEVEL.medium && task.kind === "assess") {
    s.mdCalls.push({ patient: p.id, md: p.md, nurse: m.id });
    say(s, `${m.name} called ${staffById(s, p.md).name} to ${p.bed}`);
    m.stage = "wait_md";
  } else {
    m.stage = "done";
    m.timer = DONE_S;
  }
}

function stepNurse(s: Sim, src: VitalsSource, m: Staff, dt: number) {
  if (m.stage === "home" || m.stage === "walk_home") {
    const task = nextTask(s, m.id);
    if (task) {
      m.task = task;
      m.stage = "message";
      m.timer = MESSAGE_S;
      return;
    }
    if (m.stage === "walk_home" && walk(m, dt)) m.stage = "home";
    return;
  }
  if (m.stage === "message" || m.stage === "work" || m.stage === "done") m.timer -= dt;
  if (m.stage === "message" && m.timer <= 0) {
    goTo(m, nurseStand(bedByLabel(patientById(s, m.task!.patient).bed)));
    m.stage = "walk";
  } else if (m.stage === "walk" && walk(m, dt)) {
    m.stage = "work";
    m.timer = ASSESS_S;
  } else if (m.stage === "work" && m.timer <= 0) {
    finishTask(s, src, m);
  } else if (m.stage === "done" && m.timer <= 0) {
    m.task = null;
    goTo(m, HOMES[m.id]);
    m.stage = "walk_home";
  }
}

function stepPhysician(s: Sim, m: Staff, dt: number) {
  if (m.stage === "home" || m.stage === "walk_home") {
    const index = s.mdCalls.findIndex((c) => c.md === m.id);
    if (index >= 0) {
      const [call] = s.mdCalls.splice(index, 1);
      m.task = { kind: "assess", patient: call.patient, rn: call.nurse };
      m.stage = "message";
      m.timer = MESSAGE_S;
      return;
    }
    if (m.stage === "walk_home" && walk(m, dt)) m.stage = "home";
    return;
  }
  if (m.stage === "message" || m.stage === "work") m.timer -= dt;
  if (m.stage === "message" && m.timer <= 0) {
    goTo(m, physicianStand(bedByLabel(patientById(s, m.task!.patient).bed)));
    m.stage = "walk";
  } else if (m.stage === "walk" && walk(m, dt)) {
    const nurse = staffById(s, m.task!.rn);
    if (nurse.stage === "wait_md") {
      nurse.stage = "done";
      nurse.timer = DONE_S;
    }
    m.stage = "work";
    m.timer = REVIEW_S;
  } else if (m.stage === "work" && m.timer <= 0) {
    const p = patientById(s, m.task!.patient);
    say(s, `${m.name} reviewed ${p.name}`);
    p.lastAssessed = minuteOf(s);
    m.task = null;
    goTo(m, HOMES[m.id]);
    m.stage = "walk_home";
  }
}

const HOLD_IF_UNWELL_MIN = 48 * 60; // demo rule: not sent home at NEWS2 5+; moved to higher care after this

function leave(s: Sim, p: Patient, minute: number, outcome: StayOutcome, text: string) {
  s.patients.splice(s.patients.indexOf(p), 1);
  p.stay.outMin = minute;
  p.stay.outcome = outcome;
  s.outbox?.departures.push({ patient_id: p.id, minute, outcome });
  s.moves.push({ bed: p.bed, kind: outcome });
  if (s.moves.length > 20) s.moves.shift();
  if (s.stays.length > MAX_STAYS) s.stays.splice(s.stays.findIndex((x) => x.outMin !== null), 1);
  say(s, text);
}

function movePatients(s: Sim, src: VitalsSource, minute: number) {
  for (const p of [...s.patients]) {
    if (p.dueMin === null || minute < p.dueMin) continue;
    // A staff member at the bedside finishes first; the patient leaves a minute later.
    const busy =
      s.tasks.some((t) => t.patient === p.id) ||
      s.mdCalls.some((c) => c.patient === p.id) ||
      s.staff.some((m) => m.task?.patient === p.id);
    if (busy) continue;
    const unwell = p.decision.kind === "ranked" && p.decision.news2.total >= 5;
    if (unwell && minute < p.dueMin + HOLD_IF_UNWELL_MIN) continue;
    if (unwell) s.flow.transferred += 1;
    else s.flow.discharged += 1;
    leave(s, p, minute, unwell ? "higher_care" : "discharged", unwell ? `${p.name} moved to higher care from ${p.bed}` : `${p.name} discharged from ${p.bed}`);
  }
  if (src.admit && src.flowRandom!() < src.admissionChance!) {
    const seed = src.admit(minute, s.patients);
    if (!seed) {
      s.flow.turnedAway += 1;
      return;
    }
    place(s, src, seed, minute);
  }
}

/** Puts a new patient in their bed. `known`: the API already has this patient, so it is not sent the admission. */
export function place(s: Sim, src: VitalsSource, seed: PatientSeed, minute: number, known = false) {
  const admitted = seat(src, seed, s.patients.length, minute);
  s.patients.push(admitted);
  s.stays.push(admitted.stay);
  if (!known) s.outbox?.admissions.push({ ...patientRow(admitted, [], minute - (minute % 15)), minute });
  record(s, admitted, minute);
  s.moves.push({ bed: admitted.bed, kind: "in" });
  if (s.moves.length > 20) s.moves.shift();
  s.flow.admitted += 1;
  if (seed.onOxygen) s.flow.everOnOxygen += 1;
  say(s, `${seed.name} admitted to ${seed.bed}: ${seed.context}`);
}

export function step(s: Sim, src: VitalsSource) {
  if (s.speed === 0 || s.ended) return;
  s.clockS += s.speed / 60;
  if (src.durationMin !== undefined && minuteOf(s) >= src.durationMin) {
    s.ended = true;
    say(s, "Run ended");
    return;
  }
  if (src.admit) {
    while (s.flow.lastMinute < minuteOf(s)) {
      s.flow.lastMinute += 1;
      movePatients(s, src, s.flow.lastMinute);
    }
    rerank(s);
  }
  for (const p of s.patients) {
    while (p.nextMinute * 60 + p.offsetS <= s.clockS) {
      sample(s, src, p, p.nextMinute);
      p.nextMinute += p.rules.sampleEveryMin;
    }
  }
  const dt = Math.min(s.speed, ACTOR_SPEED_CAP) / 60;
  for (const m of s.staff) {
    if (m.role === "rn") stepNurse(s, src, m, dt);
    else if (m.role === "md") stepPhysician(s, m, dt);
  }
}

// --- Commands: called from the UI or the runner between ticks ---------------------------------------------

export function injectDeterioration(s: Sim, src: VitalsSource, id: string) {
  const p = patientById(s, id);
  if (!src.inject || p.injected) return;
  src.inject(id, minuteOf(s));
  p.injected = true;
  say(s, `Deterioration started for ${p.name}`);
}

export function startArrhythmia(s: Sim, src: VitalsSource, id: string) {
  const p = patientById(s, id);
  if (!src.startAf || p.irregular) return;
  const minute = minuteOf(s);
  const length = src.startAf(id, minute);
  p.irregular = true;
  say(s, `Atrial fibrillation for ${p.name}, about ${Math.max(1, Math.round(length))} min`);
}

export function detachPatch(s: Sim, id: string) {
  const p = patientById(s, id);
  if (!p.patch) return;
  p.patch = false;
  say(s, `Patch detached for ${p.name}`);
}

export function applyPatch(s: Sim, id: string) {
  const p = patientById(s, id);
  const pending = s.tasks.some((t) => t.patient === id && t.kind === "apply_patch");
  if (p.patch || pending) return;
  s.tasks.push({ kind: "apply_patch", patient: id, rn: p.rn });
  say(s, `Patch requested for ${p.name}`);
}

export function recordBp(s: Sim, id: string, bp: Cuff) {
  const p = patientById(s, id);
  if (s.tasks.some((t) => t.patient === id && t.kind === "record_bp")) return;
  s.tasks.push({ kind: "record_bp", patient: id, rn: p.rn, bp });
  say(s, `BP entry requested for ${p.name}`);
}

/** Values charted away from the bedside: they count at once, with no walk to the bed. */
export function chart(s: Sim, id: string, values: Partial<Pick<Patient, "consciousness" | "onOxygen" | "spo2Scale">>) {
  const p = patientById(s, id);
  const minute = minuteOf(s);
  Object.assign(p, values);
  const before = p.decision;
  decide(p, minute);
  record(s, p, minute);
  rerank(s);
  logDecisionChange(s, p, before);
}

/** Runs a whole sim day now, at 60x fidelity. Only a ward with patient flow has anything to skip to. */
export function skipDay(s: Sim, src: VitalsSource) {
  if (!src.admit || s.ended) return;
  const speed = s.speed;
  s.speed = 60;
  for (let tick = 0; tick < MINUTES_PER_DAY * 60; tick += 1) step(s, src);
  s.speed = speed;
  s.moves.length = 0; // a day of trolleys at once would only be noise
}

/** The entrance's numbers. Stays with an unknown arrival are left out of the average. */
export function flowStats(s: Sim) {
  const minute = minuteOf(s);
  const since = minute - MINUTES_PER_DAY;
  const full = s.stays.filter((x) => x.outMin !== null && x.inMin > 0);
  return {
    in24h: s.stays.filter((x) => x.inMin > 0 && x.inMin > since).length,
    out24h: s.stays.filter((x) => x.outMin !== null && x.outMin > since).length,
    occupied: s.patients.length + (s.occupied?.length ?? 0),
    beds: BEDS.length,
    averageStayMin: full.length
      ? Math.round(full.reduce((sum, x) => sum + x.outMin! - x.inMin, 0) / full.length)
      : null,
  };
}

export function setSpeed(s: Sim, speed: Speed) {
  s.speed = speed;
}

/** What a staff card shows: the status chip and one line of current work. */
export function staffStatus(s: Sim, m: Staff): { chip: Chip; text: string } {
  if (m.role === "charge_rn") return { chip: "thinking", text: "Watching the ward list" };
  const task = m.task;
  const p = task ? patientById(s, task.patient) : null;
  const who = p ? `${p.name} (${p.bed})` : "";
  const verb = !task
    ? ""
    : task.kind === "apply_patch"
      ? "Apply patch"
      : task.kind === "record_bp"
        ? "Record BP"
        : m.role === "md"
          ? "Review"
          : "Assess";
  switch (m.stage) {
    case "home":
      return { chip: "idle", text: "At station" };
    case "walk_home":
      return { chip: "idle", text: "Heading back" };
    case "message":
      return { chip: "thinking", text: `Message: ${who}` };
    case "walk":
      return { chip: "working", text: `To bed: ${who}` };
    case "work":
      return { chip: "working", text: `${verb}: ${who}` };
    case "wait_md":
      return { chip: "waiting", text: `Waiting for physician: ${who}` };
    case "done":
      return { chip: "success", text: `Done: ${who}` };
  }
}

function seat(src: VitalsSource, seed: PatientSeed, i: number, startMinute = 0): Patient {
  const { rules } = src;
  const p: Patient = {
    id: seed.id,
    name: seed.name,
    age: seed.age,
    sex: seed.sex,
    bed: seed.bed,
    context: seed.context,
    story: seed.story,
    rn: seed.rn,
    md: seed.md,
    listMd: seed.listMd,
    rules,
    offsetS: i * 5,
    nextMinute: startMinute + rules.sampleEveryMin,
    patch: seed.patch,
    window: blank(() => []),
    signal: [],
    held: blank(() => null),
    heldAt: blank(() => null),
    history: seed.history,
    bp: seed.bp,
    bpAt: seed.bp ? startMinute - 20 : null,
    bpHistory: Array(12).fill(seed.bp?.systolic ?? null),
    nurseAt: startMinute - 20,
    consciousness: seed.consciousness,
    onOxygen: seed.onOxygen,
    spo2Scale: seed.spo2Scale,
    decision: { kind: "not_ranked", patientId: seed.id, reason: "", instruction: "" },
    rank: null,
    trend: seed.trend,
    totals: Array(13).fill(null),
    ackLevel: 0,
    lastAssessed: -999,
    injected: false,
    irregular: seed.irregular,
    ectopyPerHour: seed.ectopyPerHour,
    dueMin: seed.dueMin ?? src.dueForInitialPatient?.() ?? null,
    oxygenUntilMin: seed.oxygenUntilMin ?? null,
    stay: {
      id: seed.id,
      name: seed.name,
      bed: seed.bed,
      context: seed.context,
      rn: seed.rn,
      md: seed.listMd,
      inMin: startMinute,
      outMin: null,
      outcome: null,
      peak: null,
      peakRisk: null,
      scores: [],
      events: [],
    },
  };
  // Warm-up, so the gate starts full. p-011's patch stops before the start.
  for (let minute = startMinute + 1 - rules.warmupMin; minute <= startMinute; minute += 1) {
    if (minute % rules.sampleEveryMin !== 0) continue;
    const reading = src.read(seed.id, minute);
    gate(p, p.patch && minute <= startMinute - seed.signalLostMin ? reading : null, minute);
  }
  if (seed.signalLostMin > 0) p.patch = false;
  applyCharted(src, p, startMinute);
  decide(p, startMinute);
  p.totals[12] = p.decision.kind === "ranked" ? p.decision.news2.total : null;
  scoreStay(p, 0);
  return p;
}

export function createSim(src: VitalsSource): Sim {
  const patients = src.seeds().map((seed, i) => seat(src, seed, i));

  const staff: Staff[] = STAFF.map(([id, name, title, role]) => ({
    id,
    name,
    title,
    role,
    x: HOMES[id][0],
    y: HOMES[id][1],
    path: [],
    facing: "front",
    moved: 0,
    stage: "home",
    timer: 0,
    task: null,
  }));

  const s: Sim = {
    clockS: 0,
    speed: 60,
    patients,
    staff,
    tasks: [],
    mdCalls: [],
    log: [],
    stays: patients.map((p) => p.stay),
    moves: [],
    counts: { received: 0, rejected: 0, abstained: 0 },
    flow: { lastMinute: 0, admitted: 0, everOnOxygen: 0, discharged: 0, transferred: 0, turnedAway: 0 },
    ended: false,
  };
  rerank(s);
  for (const p of patients) maybeQueueAssessment(s, p, 0);
  return s;
}
