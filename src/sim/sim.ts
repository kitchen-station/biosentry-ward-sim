// The ward simulation. Plain data, no React, no canvas: it runs headless in tests.
//
// Demo-only behaviour, not from the product: the quality gate rule, the 30-minute NOT RANKED
// cutoff, and the whole staff response loop. BioSentry itself only ranks and displays.

import { arbitrate, LEVEL, rankWard, type Decision } from "./arbiter";
import { bedByLabel, findPath, HOMES, nurseStand, physicianStand, type Tile } from "./map";
import { scoreNews2, type Acvpu } from "./news2";
import { CLAMPS, VITALS, type Cuff, type Vital, type VitalsSource } from "./source";
import fixture from "./synthetic.json";

export type Speed = 0 | 1 | 10 | 60;
export type Quality = "ok" | "degraded" | "missing";
export type Trend = "rising" | "falling" | "stable" | "insufficient";

const WINDOW_MINUTES = 15;
const MIN_VALID = 8; // BioSentry MIN_VALID_PER_BIN
const DEGRADED_AFTER = 15; // BioSentry STALE_AFTER_S, in minutes
const NOT_RANKED_AFTER = 30; // demo value
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
  age: number;
  sex: string;
  bed: string;
  context: string;
  story: string;
  rn: string;
  md: string;
  offsetS: number;
  nextMinute: number;
  patch: boolean;
  window: Record<Vital, (number | null)[]>;
  signal: number[]; // last 60 minutes, 1 = usable
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

export type PacketOutcome = "ok" | "rejected" | "abstained";

export interface Sim {
  clockS: number;
  speed: Speed;
  patients: Patient[];
  staff: Staff[];
  tasks: Task[];
  mdCalls: MdCall[];
  packets: { patient: string; outcome: PacketOutcome }[]; // drained by the renderer
  log: { minute: number; text: string }[];
  counts: { received: number; rejected: number; abstained: number };
}

interface FixturePatient {
  id: string;
  name: string;
  age: number;
  sex: string;
  bed: string;
  admitting_context: string;
  trend: Trend;
  vitals: Record<string, { data: { present: boolean; value?: unknown } }>;
  vital_trends: Record<Vital, (number | null)[]>;
}

const fx = fixture as unknown as {
  ranked: FixturePatient[];
  unscored: FixturePatient[];
  labels: Record<string, { story: string }>;
  clinicians: Record<string, { role: string; patients: string[] }>;
  seed: number;
};

export const FIXTURE_SEED = fx.seed;

const SIGNAL_LOST_MIN: Record<string, number> = { "p-011": 20 };
const NO_PATCH = new Set(["p-005"]);
// Demo values: the fixture assigns these two patients no physician.
const DEMO_PHYSICIAN: Record<string, string> = { "p-004": "md-santos", "p-005": "md-aquino" };

const STAFF: [string, string, string, Staff["role"]][] = [
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

const present = <T,>(m: { data: { present: boolean; value?: unknown } } | undefined) =>
  m?.data.present ? (m.data.value as T) : null;

const assignee = (id: string, role: string) => {
  const hit = Object.entries(fx.clinicians).find(
    ([, c]) => c.role === role && c.patients.includes(id),
  );
  return hit?.[0];
};

export const minuteOf = (s: Sim) => Math.floor(s.clockS / 60);
export const staffById = (s: Sim, id: string) => s.staff.find((m) => m.id === id)!;
export const patientById = (s: Sim, id: string) => s.patients.find((p) => p.id === id)!;

function say(s: Sim, text: string) {
  s.log.push({ minute: minuteOf(s), text });
  if (s.log.length > 200) s.log.shift();
}

function gate(p: Patient, reading: Record<Vital, number | null> | null, minute: number) {
  let usable = reading !== null;
  for (const v of VITALS) {
    const value = reading?.[v] ?? null;
    const inRange = value !== null && value >= CLAMPS[v][0] && value <= CLAMPS[v][1];
    if (reading && !inRange) usable = false;
    const buffer = p.window[v];
    buffer.push(inRange ? value : null);
    if (buffer.length > WINDOW_MINUTES) buffer.shift();
    const got = buffer.filter((x): x is number => x !== null);
    if (inRange && got.length >= MIN_VALID) {
      p.held[v] = median(got);
      p.heldAt[v] = minute;
    }
  }
  p.signal.push(usable ? 1 : 0);
  if (p.signal.length > 60) p.signal.shift();
  return usable;
}

export function vitalQuality(p: Patient, v: Vital, minute: number): Quality {
  const at = p.heldAt[v];
  if (at === null || minute - at > NOT_RANKED_AFTER) return "missing";
  return minute - at > DEGRADED_AFTER ? "degraded" : "ok";
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

function sample(s: Sim, src: VitalsSource, p: Patient, minute: number) {
  const reading = src.read(p.id, minute); // the body continues whether or not the patch does
  const delivered = p.patch ? reading : null;
  const usable = gate(p, delivered, minute);
  const before = p.decision;
  decide(p, minute);
  rerank(s);
  logDecisionChange(s, p, before);
  maybeQueueAssessment(s, p, minute);

  if (minute % WINDOW_MINUTES === 0) {
    for (const v of VITALS) {
      p.history[v].push(vitalQuality(p, v, minute) === "ok" ? p.held[v] : null);
      p.history[v].shift();
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
  }

  if (!p.patch) return;
  s.counts.received += 1;
  let outcome: PacketOutcome = "ok";
  if (!usable) {
    s.counts.rejected += 1;
    outcome = "rejected";
  } else if (p.decision.kind === "not_ranked") {
    s.counts.abstained += 1;
    outcome = "abstained";
  }
  s.packets.push({ patient: p.id, outcome });
  if (s.packets.length > 120) s.packets.shift();
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
  rerank(s);
  logDecisionChange(s, p, before);
  p.lastAssessed = minute;
  p.ackLevel = levelOf(p);
  say(s, `${m.name} assessed ${p.name}, BP ${cuff?.systolic}/${cuff?.diastolic}`);
  if (levelOf(p) === LEVEL.high && task.kind === "assess") {
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

export function step(s: Sim, src: VitalsSource) {
  if (s.speed === 0) return;
  s.clockS += s.speed / 60;
  for (const p of s.patients) {
    while (p.nextMinute * 60 + p.offsetS <= s.clockS) {
      sample(s, src, p, p.nextMinute);
      p.nextMinute += 1;
    }
  }
  const dt = Math.min(s.speed, ACTOR_SPEED_CAP) / 60;
  for (const m of s.staff) {
    if (m.role === "rn") stepNurse(s, src, m, dt);
    else if (m.role === "md") stepPhysician(s, m, dt);
  }
}

// --- Commands: called from the UI between ticks ---------------------------------------------

export function injectDeterioration(s: Sim, src: VitalsSource, id: string) {
  const p = patientById(s, id);
  if (!src.inject || p.injected) return;
  src.inject(id, minuteOf(s));
  p.injected = true;
  say(s, `Deterioration started for ${p.name}`);
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

export function createSim(src: VitalsSource): Sim {
  const rows = [...fx.ranked, ...fx.unscored];
  const patients: Patient[] = rows.map((row, i) => {
    const nurseId = assignee(row.id, "rn");
    const p: Patient = {
      id: row.id,
      name: row.name,
      age: row.age,
      sex: row.sex,
      bed: row.bed,
      context: row.admitting_context,
      story: fx.labels[row.id].story,
      rn: nurseId ?? "rn-delacruz",
      md: assignee(row.id, "md") ?? DEMO_PHYSICIAN[row.id],
      offsetS: i * 5,
      nextMinute: 1,
      patch: !NO_PATCH.has(row.id),
      window: blank(() => []),
      signal: [],
      held: blank(() => null),
      heldAt: blank(() => null),
      history: { ...row.vital_trends },
      bp: present<Cuff>(row.vitals.blood_pressure),
      bpAt: present<Cuff>(row.vitals.blood_pressure) ? -20 : null,
      bpHistory: Array(12).fill(present<Cuff>(row.vitals.blood_pressure)?.systolic ?? null),
      nurseAt: -20,
      consciousness: present<Acvpu>(row.vitals.consciousness) ?? "A",
      onOxygen: present<boolean>(row.vitals.supplemental_o2) ?? false,
      spo2Scale: present<1 | 2>(row.vitals.spo2_scale) ?? 1,
      decision: { kind: "not_ranked", patientId: row.id, reason: "", instruction: "" },
      rank: null,
      trend: row.trend,
      totals: Array(13).fill(null),
      ackLevel: 0,
      lastAssessed: -999,
      injected: false,
    };
    // Warm-up: the hour before as_of, so the gate starts full. p-011's patch stops 20 minutes in.
    const lost = SIGNAL_LOST_MIN[row.id] ?? 0;
    for (let minute = -59; minute <= 0; minute += 1) {
      const reading = src.read(row.id, minute);
      gate(p, p.patch && minute <= -lost ? reading : null, minute);
    }
    if (lost > 0) p.patch = false;
    decide(p, 0);
    p.totals[12] = p.decision.kind === "ranked" ? p.decision.news2.total : null;
    return p;
  });

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
    packets: [],
    log: [],
    counts: { received: 0, rejected: 0, abstained: 0 },
  };
  rerank(s);
  for (const p of patients) maybeQueueAssessment(s, p, 0);
  return s;
}
