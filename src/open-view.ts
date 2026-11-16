// The ward without a token: parse the open answer, draw it with the existing reader, poll it.
// Pure: no DOM, no storage, no logging. fetch and timers come in as parameters.
// Rules: docs/open-view.md and the wire contract, section 9.1.
import { BEDS } from "./sim/map";
import type { Staff } from "./sim/sim";
import type { LiveView, PatientView } from "./sim/view";

export const OPEN_WARD = "W4";
export const OPEN_POLL_MS = 2000;
export const OPEN_TIMEOUT_MS = 5000;
export const OPEN_CAP_BYTES = 65_536;
const MAX_STAFF = 20;
const MAX_MOVES = 20;
const MAX_BEDS = 100;

type Role = "rn" | "charge_rn" | "md";
type Stage = Staff["stage"];
type Risk = "low" | "low_medium" | "medium" | "high";
export interface OpenStaff { key: number; role: Role; x: number; y: number; facing: "front" | "back"; walking: boolean; moved: number; stage: Stage; timer: number }
export interface OpenMove { seq: number; bed: string; kind: "in" | "out" }
export interface OpenBed { bed: string; state: "ranked" | "not_ranked"; rank: number | null; risk: Risk | null }
export interface OpenSim { clockS: number; speed: 0 | 1 | 10 | 60; ended: boolean; staff: OpenStaff[]; moves: OpenMove[] }
export interface OpenWard { ward: string; synthetic: true; can_control: false; sim: OpenSim | null; beds: OpenBed[] }

const ROLES: Role[] = ["rn", "charge_rn", "md"];
const STAGES: Stage[] = ["home", "message", "walk", "work", "wait_md", "done", "walk_home"];
const RISKS: Risk[] = ["low", "low_medium", "medium", "high"];
const SPEEDS = [0, 1, 10, 60];
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,19}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const int = (v: unknown, min: number, max: number): v is number => num(v, min, max) && Number.isInteger(v);
const oneOf = <T,>(v: unknown, list: readonly T[]): v is T => list.includes(v as T);
const label = (v: unknown): v is string => typeof v === "string" && LABEL.test(v);

function parseStaff(v: unknown, seen: Set<number>): OpenStaff | null {
  if (!isObj(v)) return null;
  const { key, role, x, y, facing, walking, moved, stage, timer } = v;
  if (!int(key, 0, 19) || seen.has(key) || !oneOf(role, ROLES) || !num(x, 0, 100) || !num(y, 0, 100)) return null;
  if (!oneOf(facing, ["front", "back"] as const) || typeof walking !== "boolean" || !num(moved, 0, 1e9)) return null;
  if (!oneOf(stage, STAGES) || !num(timer, -1e6, 1e6)) return null;
  seen.add(key);
  return { key, role, x, y, facing, walking, moved, stage, timer };
}

function parseSim(v: unknown): OpenSim | null {
  if (!isObj(v)) return null;
  const { clockS, speed, ended, staff, moves } = v;
  if (!num(clockS, 0, 1e9) || !oneOf(speed, SPEEDS) || typeof ended !== "boolean") return null;
  if (!Array.isArray(staff) || staff.length > MAX_STAFF || !Array.isArray(moves) || moves.length > MAX_MOVES) return null;
  const seen = new Set<number>();
  const outStaff: OpenStaff[] = [];
  for (const m of staff) {
    const one = parseStaff(m, seen);
    if (!one) return null;
    outStaff.push(one);
  }
  const outMoves: OpenMove[] = [];
  for (const m of moves) {
    if (!isObj(m) || !int(m.seq, 1, Number.MAX_SAFE_INTEGER) || !label(m.bed) || !oneOf(m.kind, ["in", "out"] as const)) return null;
    outMoves.push({ seq: m.seq, bed: m.bed, kind: m.kind });
  }
  return { clockS, speed: speed as OpenSim["speed"], ended, staff: outStaff, moves: outMoves };
}

/** Strict: any field out of shape refuses the whole body. Built field by field, so extra keys are never read or kept. */
export function parseOpenWard(text: string, ward = OPEN_WARD): OpenWard | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(v) || v.ward !== ward || v.synthetic !== true || v.can_control !== false || !Array.isArray(v.beds) || v.beds.length > MAX_BEDS) return null;
  const sim = v.sim === null ? null : parseSim(v.sim);
  if (v.sim !== null && !sim) return null;
  const seen = new Set<string>();
  const beds: OpenBed[] = [];
  for (const b of v.beds) {
    if (!isObj(b) || !label(b.bed) || seen.has(b.bed) || !oneOf(b.state, ["ranked", "not_ranked"] as const)) return null;
    const rank = b.rank ?? null; // a missing rank or risk reads as null
    const risk = b.risk ?? null;
    if (rank !== null && !int(rank, 1, v.beds.length)) return null;
    if (risk !== null && !oneOf(risk, RISKS)) return null;
    if (b.state === "not_ranked" && (rank !== null || risk !== null)) return null;
    seen.add(b.bed);
    beds.push({ bed: b.bed, state: b.state, rank, risk });
  }
  return { ward, synthetic: true, can_control: false, sim, beds };
}

/** Reads at most `cap` bytes. A longer body, by header or by count, gives null. */
export async function readCapped(res: Response, cap = OPEN_CAP_BYTES): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    return new TextEncoder().encode(text).length > cap ? null : text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export interface Timers { setTimeout: (f: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void }
const BROWSER_TIMERS: Timers = { setTimeout: (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: (h) => globalThis.clearTimeout(h as never) };

export type OpenAnswer<T> = { ok: true; body: T } | { ok: false; kind: "down" | "gone" };
export type OpenResult = OpenAnswer<OpenWard>;
export interface OpenRequest { fetch: typeof fetch; base: string; ward?: string; timers?: Timers; signal?: AbortSignal }

/** One request to an open route. down: 5xx, network error, timeout. gone: any other status or a bad body. */
async function openGet<T>({ fetch: f, base, timers = BROWSER_TIMERS, signal }: OpenRequest, path: string, parse: (text: string) => T | null): Promise<OpenAnswer<T>> {
  const ctl = new AbortController();
  const join = () => ctl.abort(); // the caller's signal and the 5 s timeout both end this request
  if (signal?.aborted) join();
  signal?.addEventListener("abort", join, { once: true });
  let timer: unknown;
  const timeout = new Promise<never>((_, reject) => {
    timer = timers.setTimeout(() => {
      ctl.abort();
      reject(new Error("timeout"));
    }, OPEN_TIMEOUT_MS);
  });
  const work = (async (): Promise<OpenAnswer<T>> => {
    // A simple GET: no headers key, so no Authorization and no custom header, and no cookie.
    const res = await f(`${base}${path}`, { credentials: "omit", cache: "no-store", redirect: "error", signal: ctl.signal });
    if (res.status >= 500) return { ok: false, kind: "down" };
    if (res.status !== 200) return { ok: false, kind: "gone" };
    const text = await readCapped(res);
    const body = text === null ? null : parse(text);
    return body ? { ok: true, body } : { ok: false, kind: "gone" };
  })();
  work.catch(() => {}); // a late failure after the timeout is not reported
  try {
    return await Promise.race([work, timeout]);
  } catch {
    return { ok: false, kind: "down" };
  } finally {
    timers.clearTimeout(timer);
    signal?.removeEventListener("abort", join);
  }
}

/** One unit's beds. */
export const fetchOpenWard = (req: OpenRequest): Promise<OpenResult> =>
  openGet(req, `/wards/${encodeURIComponent(req.ward ?? OPEN_WARD)}/open-view`, (text) => parseOpenWard(text, req.ward ?? OPEN_WARD));

// ---- The run's units (GET /open-view) ----
const UNIT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/;
const KINDS = ["ranked", "shown", "unranked"] as const;
export interface OpenUnit { id: string; name: string; floor: number | null; kind: (typeof KINDS)[number] }

/** Strict, as parseOpenWard: 1 to 12 units, each id once. */
export function parseOpenUnits(text: string): OpenUnit[] | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(v) || v.synthetic !== true || !Array.isArray(v.units) || v.units.length < 1 || v.units.length > 12) return null;
  const seen = new Set<string>();
  const units: OpenUnit[] = [];
  for (const u of v.units) {
    if (!isObj(u) || typeof u.id !== "string" || !UNIT_ID.test(u.id) || seen.has(u.id)) return null;
    if (typeof u.name !== "string" || u.name.length < 1 || u.name.length > 60 || !oneOf(u.kind, KINDS)) return null;
    const floor = u.floor ?? null;
    if (floor !== null && !int(floor, -5, 200)) return null;
    seen.add(u.id);
    units.push({ id: u.id, name: u.name, floor, kind: u.kind });
  }
  return units;
}

export const fetchOpenUnits = (req: Omit<OpenRequest, "ward">): Promise<OpenAnswer<OpenUnit[]>> => openGet(req, "/open-view", parseOpenUnits);

// ---- One bed's card (GET /wards/{unit}/open-view/beds/{bed}) ----
const SOURCES = ["device", "nurse", "lab", "derived", "model", "reference"] as const;
const TRENDS = ["rising", "falling", "stable", "insufficient"] as const;
export const CARD_VITALS = ["heart_rate", "respiratory_rate", "spo2", "temperature"] as const;
type Source = (typeof SOURCES)[number];
export interface OpenVital { value: number; atMs: number; source: Source }
export interface OpenPressure { systolic: number; diastolic: number; atMs: number; source: Source }
export type OpenCard = { unit: string; bed: string; floor: number | null; kind: (typeof KINDS)[number] } & (
  | { state: "ranked"; score: number; risk: Risk; trend: (typeof TRENDS)[number]; vitals: Record<(typeof CARD_VITALS)[number], OpenVital> & { blood_pressure: OpenPressure } }
  | { state: "not_ranked"; reason: string | null }
);

/** A time the API wrote: an ISO string with a zone. Anything else is refused. */
const timeMs = (v: unknown): number | null => {
  if (typeof v !== "string" || v.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};

/** Strict: the card must be for the unit and bed asked for, and a ranked card must hold all of its parts. Extra keys are never read. */
export function parseOpenCard(text: string, unit: string, bed: string): OpenCard | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(v) || v.unit !== unit || v.bed !== bed || v.synthetic !== true || !oneOf(v.kind, KINDS)) return null;
  const floor = v.floor ?? null;
  if (floor !== null && !int(floor, -5, 200)) return null;
  const place = { unit, bed, floor, kind: v.kind };
  if (v.state === "not_ranked") {
    const reason = v.reason ?? null;
    if (reason !== null && (typeof reason !== "string" || reason.length < 1 || reason.length > 300)) return null;
    if ((v.score ?? null) !== null || (v.risk ?? null) !== null || (v.vitals ?? null) !== null || (v.trend ?? null) !== null) return null;
    return { ...place, state: "not_ranked", reason };
  }
  if (v.state !== "ranked" || !int(v.score, 0, 20) || !oneOf(v.risk, RISKS) || !oneOf(v.trend, TRENDS) || !isObj(v.vitals)) return null;
  const vitals = {} as Record<(typeof CARD_VITALS)[number], OpenVital>;
  for (const code of CARD_VITALS) {
    const m = v.vitals[code];
    if (!isObj(m) || !num(m.value, 0, 1000) || !oneOf(m.source, SOURCES)) return null;
    const atMs = timeMs(m.observed_at);
    if (atMs === null) return null;
    vitals[code] = { value: m.value, atMs, source: m.source };
  }
  const bp = v.vitals.blood_pressure;
  if (!isObj(bp) || !int(bp.systolic, 1, 400) || !int(bp.diastolic, 1, 400) || !oneOf(bp.source, SOURCES)) return null;
  const bpAt = timeMs(bp.observed_at);
  if (bpAt === null) return null;
  return { ...place, state: "ranked", score: v.score, risk: v.risk, trend: v.trend, vitals: { ...vitals, blood_pressure: { systolic: bp.systolic, diastolic: bp.diastolic, atMs: bpAt, source: bp.source } } };
}

/** One request, made when a bed is picked. The caller never repeats it by itself. */
export const fetchOpenCard = (req: Omit<OpenRequest, "ward"> & { unit: string; bed: string }): Promise<OpenAnswer<OpenCard>> =>
  openGet(req, `/wards/${encodeURIComponent(req.unit)}/open-view/beds/${encodeURIComponent(req.bed)}`, (text) => parseOpenCard(text, req.unit, req.bed));

/** Polls: the next request starts OPEN_POLL_MS after the last one ended, one at a time. Returns stop. A "gone" answer stops it. */
export function startOpenPoll(req: OpenRequest & { onBody: (b: OpenWard) => void; onDown: () => void; onGone: () => void }): () => void {
  const timers = req.timers ?? BROWSER_TIMERS;
  let off = false;
  let handle: unknown;
  const ctl = new AbortController();
  const wait = () => void (handle = timers.setTimeout(run, OPEN_POLL_MS));
  const run = async () => {
    const r = await fetchOpenWard({ ...req, signal: ctl.signal });
    if (off) return;
    if (r.ok) req.onBody(r.body);
    else if (r.kind === "down") req.onDown();
    else {
      off = true;
      return req.onGone();
    }
    wait();
  };
  wait();
  return () => {
    off = true;
    ctl.abort(); // a request in flight is cancelled, so a remount never leaves two open
    timers.clearTimeout(handle);
  };
}

const ROLE_WORD: Record<Role, string> = { rn: "Nurse", charge_rn: "Charge nurse", md: "Physician" };
const known = new Set(BEDS.map((b) => b.label));
const OPEN_BED = "open-bed:";
/** A bed stub made here from the open answer. The drawing shows no tag for one without a rank. */
export const isOpenBed = (p: { id: string }) => p.id.startsWith(OPEN_BED);

/** The open answer in the shape the viewer already reads. Staff carry a role word and nothing else about who they are. */
export function toLive(w: OpenWard): LiveView {
  const s = w.sim;
  const patients = w.beds
    .filter((b) => known.has(b.bed))
    .map((b) => {
      const tagged = b.rank !== null && b.risk !== null;
      // shortcut: a stub with only the fields the drawing reads (id, bed, rank, decision, stay); revisit if the drawing reads more.
      const view = {
        id: OPEN_BED + b.bed,
        name: "",
        bed: b.bed,
        rank: tagged ? b.rank : null,
        decision: b.risk !== null ? { kind: "ranked", patientId: OPEN_BED + b.bed, news2: { risk: b.risk }, escalated: false, reasons: [] } : { kind: "not_ranked", patientId: OPEN_BED + b.bed },
        stay: { id: OPEN_BED + b.bed, name: "", bed: b.bed, context: "", rn: "", md: null, inMin: 0, outMin: null, outcome: null, peak: null, peakRisk: null, scores: [], events: [] },
      } as unknown as PatientView;
      return { id: OPEN_BED + b.bed, view };
    });
  return {
    shared: s && {
      clockS: s.clockS,
      speed: s.speed,
      ended: s.ended,
      counts: { received: 0, rejected: 0, abstained: 0 },
      staff: s.staff.map((m) => ({ id: `open-${m.key}`, name: ROLE_WORD[m.role], title: "", role: m.role, x: m.x, y: m.y, path: m.walking ? [[m.x, m.y]] : [], facing: m.facing, moved: m.moved, stage: m.stage, timer: m.timer, task: null })),
      tasks: [],
      moves: s.moves.filter((m) => known.has(m.bed)).map((m) => ({ seq: m.seq, bed: m.bed, kind: m.kind === "out" ? ("discharged" as const) : ("in" as const) })),
      beds: [],
    },
    patients,
    can_control: false,
  };
}

export type Gate = "trying" | "watch" | "signin";
export type GateEvent = "probe_ok" | "probe_fail" | "poll_gone" | "leave" | "signed_out";
/** The page's open-view state. Sign-in, once shown, stays until a reload; a sign-out or a 401 tries once more. */
export function nextGate(g: Gate, e: GateEvent): Gate {
  if (e === "signed_out") return "trying";
  if (g === "trying") return e === "probe_ok" ? "watch" : e === "probe_fail" ? "signin" : g;
  if (g === "watch" && (e === "poll_gone" || e === "leave")) return "signin";
  return g;
}

/**
 * What to say on the stage when a signed-in admin has no drawing: the open view did not answer, so nothing is drawn (the page
 * never draws its own engine's patients beside the server's data). down: the server could not be reached. gone: its public
 * drawing is off. null: there is a drawing, or the reader is not an admin.
 */
export const noDrawing = (admin: boolean, watching: boolean, probe: "down" | "gone" | null): string | null =>
  !admin || watching ? null : probe === "gone" ? "No drawing: the server's public view is off. The lists still come from the server." : "Server not reachable. No drawing is shown.";

/** Which page to show. With a token, or in a build with no view API, the open route plays no part. */
export function screen(viewApi: string | undefined, token: string | null, gate: Gate, first: OpenWard | null): "ward" | "loading" | "watch" | "signin" {
  if (!viewApi || token !== null) return "ward";
  if (gate === "watch" && !first) return "signin"; // never a ward with no token and nothing to watch
  return gate === "trying" ? "loading" : gate;
}
