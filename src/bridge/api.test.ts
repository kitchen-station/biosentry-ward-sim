import { describe, expect, it } from "vitest";
import { createSim, step } from "../sim/sim";
import { createSyntheticSource, FIXTURE_SEED } from "../sim/source";
import { createApiState, handle, type ApiState } from "./api";
import { wardSnapshot } from "./snapshot";

const NOW = Date.parse("2026-11-08T07:00:00Z");

type Row = {
  vitals: Record<string, { data: { value?: number } }>;
  vital_trends: Record<string, (number | null)[]>;
  vital_history: Record<string, { value: number | null }[] | undefined>;
};

function running(): ApiState {
  const state = createApiState(() => {});
  const s = createSim(createSyntheticSource(FIXTURE_SEED));
  const body = JSON.stringify(wardSnapshot(s, true, NOW));
  expect(handle(state, { method: "POST", path: "/snapshot", authorization: null, body }).status).toBe(204);
  return state;
}

function signIn(state: ApiState, id: string) {
  const res = handle(state, { method: "POST", path: "/session", authorization: null, body: JSON.stringify({ clinician_id: id }) });
  expect(res.status).toBe(200);
  return `Bearer ${(res.body as { token: string }).token}`;
}

const get = (state: ApiState, path: string, authorization: string | null) =>
  handle(state, { method: "GET", path, authorization, body: null });

describe("dashboard API bridge", () => {
  it("fails closed without a token, and refuses staff the sim does not have", () => {
    const state = running();
    expect(get(state, "/wards/W4/rows", null).status).toBe(401);
    expect(get(state, "/wards/W4/rows", "Bearer md-santos").status).toBe(401); // an id is not a token
    const res = handle(state, { method: "POST", path: "/session", authorization: null, body: '{"clinician_id":"rn-nobody"}' });
    expect(res.status).toBe(403);
  });

  it("sends vitals at the precision NEWS2 scores them", () => {
    const src = createSyntheticSource(FIXTURE_SEED);
    const sim = createSim(src);
    for (let i = 0; i < 600; i += 1) step(sim, src); // live samples, not just the fixture's round history
    const ranked = wardSnapshot(sim, true, NOW).patients.flatMap((p) => (p.ranked ? [p.ranked as Row] : []));
    expect(ranked.length).toBeGreaterThan(0);
    const check = (vital: string, x: number | null | undefined) => {
      if (x == null) return;
      const scaled = x * (vital === "temperature" ? 10 : 1);
      expect(Math.abs(scaled - Math.round(scaled))).toBeLessThan(1e-9);
    };
    for (const row of ranked) {
      for (const vital of ["heart_rate", "respiratory_rate", "spo2", "temperature"]) {
        check(vital, row.vitals[vital].data.value);
        row.vital_trends[vital].forEach((x) => check(vital, x));
        row.vital_history[vital]?.forEach((point) => check(vital, point.value));
      }
    }
  });

  it("splits the ward evenly between the two staff nurses", () => {
    const state = running();
    const ids = (nurse: string) => (get(state, "/patients", signIn(state, nurse)).body as { id: string }[]).map((p) => p.id);
    const delacruz = ids("rn-delacruz");
    const reyes = ids("rn-reyes");
    expect(delacruz).toHaveLength(6);
    expect(reyes).toHaveLength(6);
    expect(delacruz.filter((id) => reyes.includes(id))).toEqual([]);
    expect(reyes).toContain("p-003"); // the fixture's own assignment
  });

  it("answers 503 before the sim page has published", () => {
    const res = handle(createApiState(() => {}), { method: "POST", path: "/session", authorization: null, body: '{"clinician_id":"md-santos"}' });
    expect(res.status).toBe(503);
  });

  it("serves the ward in the dashboard's shape, scoped to the clinician, ranked contiguously", () => {
    const state = running();
    const all = get(state, "/wards/W4/rows", signIn(state, "rn-manalo")).body as {
      ranked: { id: string; rank: number; vitals: object; vital_history?: unknown }[];
      abstained: { id: string; reason: string }[];
    };
    expect(all.ranked.length + all.abstained.length).toBe(12); // the charge nurse sees the ward
    expect(all.ranked.map((r) => r.rank)).toEqual(all.ranked.map((_, i) => i + 1));
    expect(all.ranked[0]).not.toHaveProperty("vital_history"); // ward rows are ScoreRows

    const md = get(state, "/wards/W4/rows", signIn(state, "md-santos")).body as typeof all;
    const mine = [...md.ranked, ...md.abstained].map((p) => p.id);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.length).toBeLessThan(12);
    expect(md.ranked.map((r) => r.rank)).toEqual(md.ranked.map((_, i) => i + 1));
  });

  it("scopes each clinician to the dashboard fixture's list", () => {
    const state = running();
    const ids = (who: string) =>
      (get(state, "/patients", signIn(state, who)).body as { id: string }[]).map((p) => p.id).sort();
    expect(ids("md-santos")).toEqual(["p-001", "p-002", "p-006", "p-008", "p-011"]);
    expect(ids("md-aquino")).toEqual(["p-003", "p-007", "p-009", "p-010", "p-012"]);
    expect(ids("rn-delacruz")).toHaveLength(6);
    expect(ids("rn-reyes")).toHaveLength(6);
    expect(ids("rn-manalo")).toHaveLength(12);
  });

  it("hides another clinician's patient exactly like a missing one", () => {
    const state = running();
    const santos = signIn(state, "md-santos");
    const theirs = (get(state, "/patients", signIn(state, "md-aquino")).body as { id: string }[])[0].id;
    expect(get(state, `/patients/${theirs}`, santos)).toEqual(get(state, "/patients/p-999", santos));
  });

  it("returns a PatientDetail with history for a ranked patient, and audits the view", () => {
    const lines: string[] = [];
    const state = running();
    state.audit = (line) => lines.push(line);
    const auth = signIn(state, "rn-manalo");
    const first = (get(state, "/wards/W4/rows", auth).body as { ranked: { id: string }[] }).ranked[0].id;
    const detail = get(state, `/patients/${first}`, auth);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: first, rank: 1, sort_tier: "A", tier_breakdown: { tier_a: { label: "NEWS2" } } });
    expect(lines).toContain(`[audit] rn-manalo viewed ${first}`);
  });

  it("is read-only", () => {
    const state = running();
    const res = handle(state, { method: "POST", path: "/patients/p-001/notes", authorization: signIn(state, "rn-manalo"), body: "{}" });
    expect(res.status).toBe(501);
  });
});
