// The hospital admin's view: what the signed-in routes return for a reader with the admin role, in the shape the admin
// panel shows. Pure: no DOM, no storage. fetch comes in as a parameter. The token is sent only to these four routes.
//
// Read-only: there is no write here. Only what a route returned is kept, field by field; nothing is filled in. A value
// the server did not send is null and the panel says so.
import { readCapped } from "./open-view";

export const ADMIN_CAP_BYTES = 2_000_000; // a unit's rows carry each patient's vitals and their sources
export const ADMIN_TIMEOUT_MS = 10_000;
export const ADMIN_REFRESH_MS = 10_000; // an open level is asked again this often: never faster than 2 s

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 200): v is string => typeof v === "string" && v.length <= max;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const int = (v: unknown, min: number, max: number): v is number => num(v) && Number.isInteger(v) && v >= min && v <= max;
const KINDS = ["ranked", "shown", "unranked"] as const;
const RISKS = ["low", "low_medium", "medium", "high"] as const;
const TRENDS = ["rising", "falling", "stable", "insufficient"] as const;
const OUTCOMES = ["discharged", "higher_care", "transferred", "died"] as const;
const oneOf = <T,>(v: unknown, list: readonly T[]): v is T => list.includes(v as T);
const timeMs = (v: unknown): number | null => (typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
const json = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export interface AdminUnit { id: string; name: string; floor: number | null; kind: (typeof KINDS)[number]; patients: number }
/** One stored value as served: null value = the server says it is absent. */
export interface AdminValue { value: number | null; atMs: number | null; source: string | null }
export interface AdminVitals {
  heart_rate: AdminValue; respiratory_rate: AdminValue; spo2: AdminValue; temperature: AdminValue;
  blood_pressure: { systolic: number | null; diastolic: number | null; atMs: number | null; source: string | null };
}
export const ADMIN_VITALS = ["heart_rate", "respiratory_rate", "spo2", "temperature"] as const;
export interface AdminRow {
  id: string; name: string; age: number | null; sex: string | null; bed: string; context: string;
  /** A ranked patient: rank and NEWS2 score in this unit, and the trend. */
  ranked: { rank: number; score: number; trend: (typeof TRENDS)[number] } | null;
  /** A patient who is not ranked: why, and the NEWS2 band where the unit shows one. */
  reason: string | null; risk: (typeof RISKS)[number] | null;
  /** null: the route served no vitals for this row. "unreadable": it served something there that is out of shape, so none of it is shown. */
  vitals: AdminVitals | null | "unreadable";
}
export interface AdminRows { unit: string; nowMs: number; rows: AdminRow[] }
export interface AdminStay { id: string; name: string; bed: string; inMs: number | null; outMs: number | null; outcome: (typeof OUTCOMES)[number] | null; toUnit: string | null }
export interface AdminPatient { row: AdminRow; nowMs: number; unit: string | null }

function value(v: unknown): AdminValue | null {
  if (!isObj(v) || !isObj(v.data) || !isObj(v.provenance)) return null;
  const present = v.data.present === true && num(v.data.value);
  return { value: present ? (v.data.value as number) : null, atMs: timeMs(v.provenance.observed_at), source: str(v.provenance.source, 20) ? v.provenance.source : null };
}

/** The five vitals of a row. null: the row holds none (the field is missing or null). "unreadable": it holds something out of shape. */
function vitals(v: unknown): AdminVitals | null | "unreadable" {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) return "unreadable";
  const out = {} as Record<(typeof ADMIN_VITALS)[number], AdminValue>;
  for (const code of ADMIN_VITALS) {
    const one = value(v[code]);
    if (!one) return "unreadable";
    out[code] = one;
  }
  const bp = v.blood_pressure;
  if (!isObj(bp) || !isObj(bp.data) || !isObj(bp.provenance)) return "unreadable";
  const pair = bp.data.present === true && isObj(bp.data.value) && int(bp.data.value.systolic, 1, 400) && int(bp.data.value.diastolic, 1, 400) ? (bp.data.value as { systolic: number; diastolic: number }) : null;
  return { ...out, blood_pressure: { systolic: pair?.systolic ?? null, diastolic: pair?.diastolic ?? null, atMs: timeMs(bp.provenance.observed_at), source: str(bp.provenance.source, 20) ? bp.provenance.source : null } };
}

function person(v: Obj): Pick<AdminRow, "id" | "name" | "age" | "sex" | "bed" | "context"> | null {
  if (!str(v.id, 80) || v.id.length < 1 || !str(v.name) || !str(v.bed, 40) || !str(v.admitting_context, 500)) return null;
  const age = v.age ?? null;
  const sex = v.sex ?? null;
  if ((age !== null && !int(age, 0, 130)) || (sex !== null && !str(sex, 20))) return null;
  return { id: v.id, name: v.name, age, sex, bed: v.bed, context: v.admitting_context };
}

function rankedRow(v: unknown): AdminRow | null {
  if (!isObj(v)) return null;
  const who = person(v);
  if (!who || !int(v.rank, 1, 1000) || !int(v.score, 0, 20) || !oneOf(v.trend, TRENDS)) return null;
  return { ...who, ranked: { rank: v.rank, score: v.score, trend: v.trend }, reason: null, risk: null, vitals: vitals(v.vitals) };
}

function abstainedRow(v: unknown): AdminRow | null {
  if (!isObj(v)) return null;
  const who = person(v);
  if (!who || !str(v.reason, 500)) return null;
  const risk = v.news2_risk ?? null;
  if (risk !== null && !oneOf(risk, RISKS)) return null;
  return { ...who, ranked: null, reason: v.reason, risk, vitals: vitals(v.last_seen) };
}

export function parseAdminUnits(text: string): AdminUnit[] | null {
  const v = json(text);
  if (!Array.isArray(v) || v.length > 12) return null;
  const out: AdminUnit[] = [];
  for (const u of v) {
    if (!isObj(u) || !str(u.id, 20) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(u.id) || !str(u.name, 60) || !oneOf(u.kind, KINDS) || !int(u.patients, 0, 10_000)) return null;
    const floor = u.floor ?? null;
    if (floor !== null && !int(floor, -5, 200)) return null;
    out.push({ id: u.id, name: u.name, floor, kind: u.kind, patients: u.patients });
  }
  return out;
}

/** A unit's rows: the ranked in rank order, then those not ranked. One row out of shape refuses the answer: a list with a hole would look complete. */
export function parseAdminRows(text: string, unit: string): AdminRows | null {
  const v = json(text);
  if (!isObj(v) || v.ward !== unit || !Array.isArray(v.ranked) || !Array.isArray(v.abstained) || v.ranked.length + v.abstained.length > 400) return null;
  const nowMs = timeMs(v.now);
  if (nowMs === null) return null;
  const rows: AdminRow[] = [];
  for (const r of v.ranked) {
    const row = rankedRow(r);
    if (!row) return null;
    rows.push(row);
  }
  rows.sort((a, b) => a.ranked!.rank - b.ranked!.rank);
  for (const r of v.abstained) {
    const row = abstainedRow(r);
    if (!row) return null;
    rows.push(row);
  }
  return { unit, nowMs, rows };
}

export function parseAdminStays(text: string): AdminStay[] | null {
  const v = json(text);
  if (!Array.isArray(v) || v.length > 5000) return null;
  const out: AdminStay[] = [];
  for (const s of v) {
    if (!isObj(s) || !str(s.id, 80) || !str(s.name) || !str(s.bed, 40)) return null;
    const outcome = s.outcome ?? null;
    const toUnit = s.to_unit ?? null;
    if ((outcome !== null && !oneOf(outcome, OUTCOMES)) || (toUnit !== null && !str(toUnit, 20))) return null;
    out.push({ id: s.id, name: s.name, bed: s.bed, inMs: timeMs(s.admitted_at), outMs: timeMs(s.left_at), outcome, toUnit });
  }
  return out;
}

/** GET /patients/{id}: a ranked patient's page or a not-ranked one's, told apart by the rank. */
export function parseAdminPatient(text: string, id: string): AdminPatient | null {
  const v = json(text);
  if (!isObj(v) || v.id !== id) return null;
  const nowMs = timeMs(v.now);
  const row = "rank" in v ? rankedRow(v) : abstainedRow(v);
  if (nowMs === null || !row) return null;
  return { row, nowMs, unit: str(v.unit, 20) ? v.unit : null };
}

export type AdminAnswer<T> = { ok: true; body: T } | { ok: false; kind: "signed_out" | "denied" | "gone" | "down" };
export interface AdminRequest { fetch: typeof fetch; base: string; token: string; signal?: AbortSignal }

/** One signed-in GET. signed_out: 401. denied: 403. gone: 404, another status or a body out of shape. down: 5xx, network, timeout. */
async function adminGet<T>({ fetch: f, base, token, signal }: AdminRequest, path: string, parse: (text: string) => T | null): Promise<AdminAnswer<T>> {
  try {
    const res = await f(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(ADMIN_TIMEOUT_MS)]) : AbortSignal.timeout(ADMIN_TIMEOUT_MS) });
    if (res.status === 401) return { ok: false, kind: "signed_out" };
    if (res.status === 403) return { ok: false, kind: "denied" };
    if (res.status >= 500) return { ok: false, kind: "down" };
    if (res.status !== 200) return { ok: false, kind: "gone" };
    const text = await readCapped(res, ADMIN_CAP_BYTES);
    const body = text === null ? null : parse(text);
    return body ? { ok: true, body } : { ok: false, kind: "gone" };
  } catch {
    return { ok: false, kind: "down" };
  }
}

const seg = encodeURIComponent;
export const fetchAdminUnits = (req: AdminRequest) => adminGet(req, "/wards", parseAdminUnits);
export const fetchAdminRows = (req: AdminRequest, unit: string) => adminGet(req, `/wards/${seg(unit)}/rows`, (t) => parseAdminRows(t, unit));
export const fetchAdminStays = (req: AdminRequest, unit: string) => adminGet(req, `/wards/${seg(unit)}/stays`, parseAdminStays);
export const fetchAdminPatient = (req: AdminRequest, id: string) => adminGet(req, `/patients/${seg(id)}`, (t) => parseAdminPatient(t, id));
