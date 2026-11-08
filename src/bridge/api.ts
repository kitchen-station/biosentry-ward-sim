// The dashboard's API, served from the sim's latest snapshot. Read-only: the sim owns the ward.
// Scoping is server-side (I7): a token names one clinician, who sees only their patients, and
// every view is audited. Identity is a stub (any listed staff id gets a token), so the dev
// server must stay on loopback, which is Vite's default.

import type { PatientEntry, WardSnapshot } from "./snapshot.ts";

export interface ApiRequest {
  method: string;
  path: string; // after the /api prefix, without the query string
  authorization: string | null;
  body: string | null;
}

export interface ApiResponse {
  status: number;
  body?: unknown;
}

type Role = WardSnapshot["staff"][number]["role"];

export interface ApiState {
  snapshot: WardSnapshot | null;
  sessions: Map<string, { id: string; role: Role }>;
  audit: (line: string) => void;
}

export function createApiState(audit: (line: string) => void = console.log): ApiState {
  return { snapshot: null, sessions: new Map(), audit };
}

const json = (status: number, body?: unknown): ApiResponse => ({ status, body });
const detail = (status: number, text: string) => json(status, { detail: text });

function parse(body: string | null): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body ?? "");
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function visible(entry: PatientEntry, who: { id: string; role: Role }) {
  if (who.role === "charge_rn") return true;
  return who.role === "md" ? entry.md === who.id : entry.rn === who.id;
}

function withoutDetail(row: Record<string, unknown>) {
  const { vital_history: _h, tier_breakdown: _b, ...scoreRow } = row;
  return scoreRow;
}

export function handle(state: ApiState, req: ApiRequest): ApiResponse {
  const { method, path } = req;

  // The sim page publishes its ward here. Same origin only: the plugin refuses cross-origin posts.
  if (method === "POST" && path === "/snapshot") {
    const snapshot = parse(req.body) as WardSnapshot | null;
    if (!snapshot || !Array.isArray(snapshot.patients) || !Array.isArray(snapshot.staff)) {
      return detail(422, "Not a ward snapshot");
    }
    state.snapshot = snapshot;
    return json(204);
  }

  if (method === "POST" && path === "/session") {
    const id = parse(req.body)?.clinician_id;
    const member = state.snapshot?.staff.find((m) => m.id === id);
    if (!state.snapshot) return detail(503, "The ward simulation is not running");
    if (!member) return detail(403, "Not on this ward's staff in the simulation");
    const token = crypto.randomUUID();
    state.sessions.set(token, { id: member.id, role: member.role });
    state.audit(`[audit] session opened for ${member.id}`);
    return json(200, { token });
  }

  const [scheme, token] = (req.authorization ?? "").split(" ");
  const who = scheme?.toLowerCase() === "bearer" && token ? state.sessions.get(token) : undefined;
  if (!who) return detail(401, "Sign in first");
  if (method !== "GET") return detail(501, "Read-only: the ward simulation owns this data");

  const snap = state.snapshot;
  if (!snap) return detail(503, "The ward simulation is not running");
  const mine = snap.patients.filter((p) => visible(p, who));
  const view = (what: string) => state.audit(`[audit] ${who.id} viewed ${what}`);

  if (path === `/wards/${snap.ward}/rows`) {
    view(`ward ${snap.ward}`);
    const ranked = mine
      .flatMap((p) => (p.ranked ? [p.ranked] : []))
      .sort((a, b) => (a.rank as number) - (b.rank as number))
      .map((row, i) => ({ ...withoutDetail(row), rank: i + 1 })); // contiguous within the scope
    return json(200, {
      ward: snap.ward,
      clinician: who.id,
      shift: "07:00",
      receiving_data: snap.receiving_data,
      sort_tier: "A",
      tier_status: [{ tier: "A", label: "NEWS2", live: true }],
      ranked,
      abstained: mine.flatMap((p) => (p.abstained ? [p.abstained] : [])),
    });
  }

  if (path === "/patients") {
    view("patient list");
    return json(
      200,
      mine.map((p) => {
        const row = (p.ranked ?? p.abstained)!;
        return { id: p.id, name: row.name, bed: row.bed, ranked: p.ranked !== null };
      }),
    );
  }

  const match = /^\/patients\/([^/]+)(\/notes)?$/.exec(path);
  if (match) {
    // Not found and not yours answer the same, so the scope does not leak.
    const entry = mine.find((p) => p.id === decodeURIComponent(match[1]));
    if (!entry) return detail(404, "Patient not found");
    view(`${match[2] ? "notes of " : ""}${entry.id}`);
    if (match[2]) return json(200, []); // the sim keeps no notes
    // A NOT RANKED patient has no score, so there is no PatientDetail for them (I4).
    if (!entry.ranked) return detail(404, "Patient not found");
    const rank = mine
      .flatMap((p) => (p.ranked ? [p.ranked.rank as number] : []))
      .filter((r) => r < (entry.ranked!.rank as number)).length + 1;
    return json(200, { ...entry.ranked, rank });
  }

  return detail(404, "Not found");
}
