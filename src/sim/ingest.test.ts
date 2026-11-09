/// <reference types="node" />
// The sim's writes to the database API. The fake-fetch tests always run; the parity tests need a
// real API: BIOSENTRY_API=http://127.0.0.1:8000 BIOSENTRY_INGEST_KEY=dev-local npx vitest run src/sim/ingest.test.ts
import { describe, expect, it } from "vitest";
import { createReplaySource, type ReplayFile } from "./replay";
import { createSim, detachPatch, injectDeterioration, minuteOf, recordBp, step, type Obs, type Sim } from "./sim";
import { createSyntheticSource, FIXTURE_SEED, type VitalsSource } from "./source";
import { createSync } from "./sync";
import fixture from "./synthetic.json";

const API = process.env.BIOSENTRY_API;
const KEY = process.env.BIOSENTRY_INGEST_KEY ?? "dev-local";
const PASSPHRASE = process.env.BIOSENTRY_PASSPHRASE ?? "dev-passphrase-local"; // the seeded local one
const real = import.meta.glob<ReplayFile>("/public/replay/eicu-12.json", { eager: true, import: "default" });
const realReplay = Object.values(real)[0];

const start = () => {
  const src = createSyntheticSource(FIXTURE_SEED);
  return { src, s: createSim(src) };
};

function run(s: Sim, src: VitalsSource, minutes: number) {
  const until = s.clockS + minutes * 60;
  while (s.clockS < until) step(s, src);
}

/** A fetch that records the requests and can be switched offline. */
function fake() {
  const calls: { path: string; key: string | null; body: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const net = { offline: false };
  const f = (async (url: string, init: RequestInit) => {
    if (net.offline) throw new Error("offline");
    const path = url.replace("http://api", "");
    calls.push({ path, key: (init.headers as Record<string, string>)["X-Ingest-Key"] ?? null, body: JSON.parse(init.body as string) });
    return path === "/sim/runs" ? new Response('{"run_id":7}', { status: 201 }) : new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return { calls, net, sync: createSync({ apiUrl: "http://api", key: "k", fetch: f }) };
}

const stay = (id: string) => ({
  id, dx: "CHF", age: "> 89", sex: "F", unit: "MICU", to: "Floor", durationMin: 120,
  hr: [[-30, 80], [0, 80], [60, 80]], rr: [[-30, 16], [0, 16], [60, 16]], spo2: [[-30, 97], [0, 97], [60, 97]],
  temp: [[-200, 36.8]], bp: [[-10, 120, 70]], o2: [[-10, 0]], gcs: [[-10, 15]],
}) as unknown as ReplayFile["stays"][number];
const fakeReplay: ReplayFile = { dataset: "test", licence: "test", stays: Array.from({ length: 12 }, (_, i) => stay(String(1000 + i))) };

describe("the outbox", () => {
  it("is off by default, and filling it changes nothing the sim does", () => {
    const a = start();
    const b = start();
    expect(a.s.outbox).toBeUndefined();
    b.s.outbox = { observations: [], bins: [], events: [], admissions: [], departures: [], sent: new Map() };
    run(a.s, a.src, 180);
    run(b.s, b.src, 180);
    const view = (s: Sim) => s.patients.map((p) => [p.id, p.decision, p.rank, p.trend, p.held, p.bp]);
    expect(view(b.s)).toEqual(view(a.s));
    expect(b.s.log).toEqual(a.s.log);
    expect(b.s.outbox!.observations.length).toBeGreaterThan(0);
  });
});

describe("sync, with a fake fetch", () => {
  it("registers the run with the minute-0 state and 12 patients", async () => {
    const { s, src } = start();
    const { calls, sync } = fake();
    await sync.start(s, src);
    expect(calls).toHaveLength(1);
    const { path, key, body } = calls[0];
    expect([path, key]).toEqual(["/sim/runs", "k"]);
    expect(Object.keys(body).sort()).toEqual(["client_id", "origin", "patients", "seed", "source"]);
    expect([body.source, body.seed]).toEqual(["synthetic", FIXTURE_SEED]);
    expect(Date.parse(body.origin)).not.toBeNaN();
    expect(body.origin).toMatch(/Z$/);
    expect(body.patients).toHaveLength(12);
    for (const p of body.patients) {
      expect(Object.keys(p).sort()).toEqual(
        ["age", "bed", "bins", "context", "id", "md", "name", "observations", "rn", "sex", "signal_quality", "story", "trend"].sort(),
      );
      expect(p.observations.map((o: Obs) => o.code).sort()).toEqual(
        ["blood_pressure", "consciousness", "heart_rate", "respiratory_rate", "spo2", "spo2_scale", "supplemental_o2", "temperature"],
      );
      expect(p.bins).toHaveLength(48);
      expect(Math.min(...p.bins.map((b: { minute: number }) => b.minute))).toBe(-165);
      expect(Math.max(...p.bins.map((b: { minute: number }) => b.minute))).toBe(0);
    }
    const byId = Object.fromEntries(body.patients.map((p: { id: string }) => [p.id, p]));
    expect([byId["p-004"].md, byId["p-005"].md, byId["p-001"].md]).toEqual([null, null, "md-santos"]);
    for (const o of body.patients.flatMap((p: { observations: Obs[] }) => p.observations) as Obs[]) {
      expect(o.absent_reason === undefined, `${o.patient_id} ${o.code}`).toBe(o.num !== undefined || o.txt !== undefined);
      expect(o.source).toBe(["blood_pressure", "consciousness", "supplemental_o2", "spo2_scale"].includes(o.code) ? "nurse" : "device");
    }
  });

  it("sends a batch of changes only, including the absent rows", async () => {
    const { s, src } = start();
    const { calls, sync } = fake();
    await sync.start(s, src);
    detachPatch(s, "p-001");
    run(s, src, 40);
    await sync.flush();
    const { path, body } = calls[1];
    expect(path).toBe("/sim/runs/7/batch");
    expect(Object.keys(body).sort()).toEqual(["admissions", "bins", "counts", "departures", "ended", "events", "minute", "observations", "patients"]);
    expect([body.minute, body.ended]).toEqual([40, false]);
    expect(body.patients).toHaveLength(12);
    expect(Object.keys(body.patients[0]).sort()).toEqual(["id", "last_sample_minute", "signal_quality", "trend"]);
    expect(body.bins).toHaveLength(2 * 12 * 4); // minutes 15 and 30
    expect(body.events.some((e: { text: string }) => e.text.startsWith("Patch detached"))).toBe(true);
    expect(body.events[0]).toEqual({ minute: expect.any(Number), kind: "log", patient_id: null, staff_id: null, text: expect.any(String) });

    const hr = (body.observations as Obs[]).filter((o) => o.patient_id === "p-001" && o.code === "heart_rate");
    expect(hr.some((o) => o.quality === "degraded" && o.num !== undefined)).toBe(true);
    const gone = hr.at(-1)!;
    expect(gone).toMatchObject({ quality: "missing", source: "device" });
    expect(gone.absent_reason).toMatch(/^No usable reading for \d+ min$/);
    expect(gone.num).toBeUndefined();

    // Nothing the chart holds changed, so only device rows repeat; and no row repeats its last value.
    expect((body.observations as Obs[]).filter((o) => ["consciousness", "spo2_scale", "supplemental_o2"].includes(o.code))).toEqual([]);
    const last = new Map<string, string>();
    for (const { minute: _m, absent_reason, ...o } of body.observations as Obs[]) {
      const key = `${o.patient_id}/${o.code}`;
      const value = JSON.stringify({ ...o, absent: absent_reason !== undefined });
      expect(last.get(key), key).not.toBe(value);
      last.set(key, value);
    }

    await sync.flush();
    expect(calls).toHaveLength(2); // nothing new, nothing sent
  });

  it("keeps rows through a failed flush and sends them next time", async () => {
    const { s, src } = start();
    const { calls, net, sync } = fake();
    await sync.start(s, src);
    run(s, src, 10);
    net.offline = true;
    await sync.flush();
    run(s, src, 5);
    expect(calls).toHaveLength(1);
    net.offline = false;
    await sync.flush();
    const rows = calls[1].body.observations as Obs[];
    expect(rows.some((o) => o.minute <= 10)).toBe(true);
    expect(rows.some((o) => o.minute > 10)).toBe(true);
    expect(s.outbox!.observations).toHaveLength(0);
  });

  it("retries registering on a later flush", async () => {
    const { s, src } = start();
    const { calls, net, sync } = fake();
    net.offline = true;
    await sync.start(s, src);
    run(s, src, 5);
    net.offline = false;
    await sync.flush();
    expect(calls.map((c) => c.path)).toEqual(["/sim/runs", "/sim/runs/7/batch"]);
    expect(calls[0].body.patients).toHaveLength(12);
  });

  it("bounds the buffer while the API is away, and splits a backlog at the API's limits", async () => {
    const { s, src } = start();
    const { calls, net, sync } = fake();
    await sync.start(s, src);
    const bin = { patient_id: "p-001", vital: "spo2" as const, minute: 1, value: 97 };
    net.offline = true;
    s.outbox!.bins.push(...Array.from({ length: 60_000 }, () => bin));
    await sync.flush();
    expect(s.outbox!.bins).toHaveLength(50_000);
    expect(sync.dropped).toBe(10_000);

    net.offline = false;
    await sync.flush();
    const sizes = calls.slice(1).map((c) => c.body.bins.length);
    expect(sizes).toEqual([20_000, 20_000, 10_000]);
    expect(calls.slice(1).map((c) => c.body.ended)).toEqual([false, false, false]);
  });

  it("registers the source: synthetic or eicu_demo, with no age for a replay stay over 89", async () => {
    const replay = fake();
    const src = createReplaySource(fakeReplay);
    await replay.sync.start(createSim(src), src);
    const { body } = replay.calls[0];
    expect([body.source, body.seed]).toEqual(["eicu_demo", null]);
    expect(body.patients.every((p: { age: null }) => p.age === null)).toBe(true);
    expect(body.patients.filter((p: { md: string | null }) => p.md === null)).toHaveLength(2); // the p-004 and p-005 seats

    const synthetic = fake();
    const { s, src: syntheticSrc } = start();
    await synthetic.sync.start(s, syntheticSrc);
    expect(synthetic.calls[0].body.source).toBe("synthetic");
  });

  it("sends the final ended state", async () => {
    const src = createReplaySource(fakeReplay);
    const s = createSim(src);
    const { calls, sync } = fake();
    await sync.start(s, src);
    while (!s.ended) step(s, src);
    await sync.flush();
    expect(calls.at(-1)!.body).toMatchObject({ ended: true, minute: 120 });
  });
});

// --- Against the real API ----------------------------------------------------------------------

const fx = fixture as unknown as { clinicians: Record<string, { patients: string[] }> };

async function rows(who: string) {
  const login = await fetch(`${API}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clinician_id: who, passphrase: PASSPHRASE }),
  });
  const { token } = (await login.json()) as { token: string };
  const res = await fetch(`${API}/wards/W4/rows`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    ranked: { id: string; score: number; synthetic: boolean }[];
    abstained: { id: string; reason: string }[];
  };
}

/** The ward as the sim ranks it, in the API's terms. */
const mirror = (s: Sim) => ({
  ranked: s.patients
    .filter((p) => p.rank !== null && p.decision.kind === "ranked")
    .sort((a, b) => a.rank! - b.rank!)
    .map((p) => [p.id, p.decision.kind === "ranked" ? p.decision.news2.total : -1]),
  abstained: s.patients
    .flatMap((p) => (p.decision.kind === "not_ranked" ? [[p.id, p.decision.reason]] : []))
    .sort((a, b) => a[0].localeCompare(b[0])),
});

/** Runs the sim through a real sync, flushing every 15 sim minutes and comparing the API's ranks. */
async function parity(s: Sim, src: VitalsSource, minutes: number, commands: Record<number, () => void> = {}) {
  const sync = createSync({ apiUrl: API!, key: KEY, fetch: globalThis.fetch.bind(globalThis) });
  await sync.start(s, src);
  let compared = 0;
  const compare = async () => {
    await sync.flush();
    const server = await rows("rn-manalo");
    const label = `minute ${minuteOf(s)}`;
    expect(
      { ranked: server.ranked.map((r) => [r.id, r.score]), abstained: server.abstained.map((a) => [a.id, a.reason]).sort((a, b) => a[0].localeCompare(b[0])) },
      label,
    ).toEqual(mirror(s));
    compared += 1;
    return server;
  };
  let next = 15;
  while (minuteOf(s) < minutes && !s.ended) {
    step(s, src);
    const minute = minuteOf(s);
    for (const at of Object.keys(commands).map(Number)) {
      if (minute >= at) {
        commands[at]();
        delete commands[at];
      }
    }
    if (minute >= next) {
      next = minute + 15;
      await compare();
    }
  }
  const last = await compare();
  return { last, compared };
}

describe.runIf(API)("rank parity with the real API", () => {
  it("matches the synthetic ward over 8 sim-hours, with a deterioration, a detached patch and a recorded BP", async () => {
    const { s, src } = start();
    const { last, compared } = await parity(s, src, 8 * 60, {
      30: () => injectDeterioration(s, src, "p-007"),
      60: () => detachPatch(s, "p-010"),
      120: () => recordBp(s, "p-008", { systolic: 85, diastolic: 50 }),
    });
    expect(compared).toBeGreaterThanOrEqual(32);
    expect(mirror(s).abstained.length).toBeGreaterThan(0);

    // Each clinician sees exactly the fixture's patients.
    for (const [who, { patients }] of Object.entries(fx.clinicians)) {
      const seen = await rows(who);
      expect([...seen.ranked.map((r) => r.id), ...seen.abstained.map((a) => a.id)].sort(), who).toEqual([...patients].sort());
    }
    expect(last.ranked.length + last.abstained.length).toBe(12);
  }, 120_000);

  it.runIf(realReplay)("matches the eICU replay, stored as eicu_demo", async () => {
    const src = createReplaySource(realReplay);
    const s = createSim(src);
    const { last } = await parity(s, src, 24 * 60);
    expect(s.ended).toBe(true);
    expect(last.ranked.length).toBeGreaterThan(0);
    expect(last.ranked.every((r) => r.synthetic === false)).toBe(true);
  }, 120_000);
});
