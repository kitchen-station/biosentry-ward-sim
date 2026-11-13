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

export type OpenResult = { ok: true; body: OpenWard } | { ok: false; kind: "down" | "gone" };
export interface OpenRequest { fetch: typeof fetch; base: string; ward?: string; timers?: Timers; signal?: AbortSignal }

/** One request. down: 5xx, network error, timeout. gone: any other status or a bad body. */
export async function fetchOpenWard({ fetch: f, base, ward = OPEN_WARD, timers = BROWSER_TIMERS, signal }: OpenRequest): Promise<OpenResult> {
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
  const work = (async (): Promise<OpenResult> => {
    // A simple GET: no headers key, so no Authorization and no custom header, and no cookie.
    const res = await f(`${base}/wards/${encodeURIComponent(ward)}/open-view`, { credentials: "omit", cache: "no-store", redirect: "error", signal: ctl.signal });
    if (res.status >= 500) return { ok: false, kind: "down" };
    if (res.status !== 200) return { ok: false, kind: "gone" };
    const text = await readCapped(res);
    const body = text === null ? null : parseOpenWard(text, ward);
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

/** Which page to show. With a token, or in a build with no view API, the open route plays no part. */
export function screen(viewApi: string | undefined, token: string | null, gate: Gate, first: OpenWard | null): "ward" | "loading" | "watch" | "signin" {
  if (!viewApi || token !== null) return "ward";
  if (gate === "watch" && !first) return "signin"; // never a ward with no token and nothing to watch
  return gate === "trying" ? "loading" : gate;
}
