/// <reference types="node" />
// The sim's writes to the database API. The fake-fetch tests always run; the parity tests need a
// real API: BIOSENTRY_API=http://127.0.0.1:8123 BIOSENTRY_INGEST_KEY=dev-local BIOSENTRY_PASSPHRASE=... npx vitest run src/sim/ingest.test.ts
import { describe, expect, it } from "vitest";
import type { Action } from "./actions";
import { createSim, detachPatch, injectDeterioration, minuteOf, recordBp, setSpeed, step, type Obs, type Sim } from "./sim";
import { createSyntheticSource, FIXTURE_SEED, type VitalsSource } from "./source";
import { createSync } from "./sync";
import fixture from "./synthetic.json";

const API = process.env.BIOSENTRY_API;
const KEY = process.env.BIOSENTRY_INGEST_KEY ?? "dev-local";
const PASSPHRASE = process.env.BIOSENTRY_PASSPHRASE ?? "";
// One id for every test run, so a run replaces its predecessor instead of meeting a 409.
const TEST_CLIENT = "ward-sim-ingest-test";

const start = () => {
  const src = createSyntheticSource(FIXTURE_SEED);
  return { src, s: createSim(src) };
};

function run(s: Sim, src: VitalsSource, minutes: number) {
  const until = s.clockS + minutes * 60;
  while (s.clockS < until) step(s, src);
}

/** A fetch that records the requests, can be switched offline, and answers with a chosen status. `feed` is the actions route's rows. */
function fake(clientId = "page-1") {
  const calls: { path: string; key: string | null; body: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const net = { offline: false, register: 201, batch: 204, actions: 200, feed: [] as Action[] };
  const f = (async (url: string, init: RequestInit) => {
    if (net.offline) throw new Error("offline");
    const path = url.replace("http://api", "");
    calls.push({ path, key: (init.headers as Record<string, string>)["X-Ingest-Key"] ?? null, body: init.body ? JSON.parse(init.body as string) : null });
    if (!init.method) {
      const after = Number(new URL(url).searchParams.get("after"));
      return new Response(JSON.stringify({ actions: net.feed.filter((a) => a.seq > after) }), { status: net.actions });
    }
    return path === "/sim/runs"
      ? new Response(net.register === 201 ? '{"run_id":7}' : "{}", { status: net.register })
      : new Response(null, { status: net.batch });
  }) as unknown as typeof fetch;
  return { calls, net, sync: createSync({ apiUrl: "http://api", key: "k", clientId, fetch: f }) };
}

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
    expect(calls.map((c) => c.path)).toEqual(["/sim/runs", "/sim/runs/7/batch"]);
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
    const { path, body } = calls[2];
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
    expect(calls).toHaveLength(4); // the next flush sends a batch even though only device rows repeat
  });

  it("keeps rows through a failed flush and sends them next time", async () => {
    const { s, src } = start();
    const { calls, net, sync } = fake();
    await sync.start(s, src);
    run(s, src, 10);
    net.offline = true;
    await sync.flush();
    run(s, src, 5);
    expect(calls).toHaveLength(2);
    net.offline = false;
    await sync.flush();
    const rows = calls[2].body.observations as Obs[];
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
    const sizes = calls.slice(2).map((c) => c.body.bins.length);
    expect(sizes).toEqual([20_000, 20_000, 10_000]);
    expect(calls.slice(2).map((c) => c.body.ended)).toEqual([false, false, false]);
  });

  it("sends the same client_id for every sync of one page", async () => {
    const id = crypto.randomUUID();
    const sent = [];
    for (let i = 0; i < 2; i += 1) {
      const { s, src } = start();
      const { calls, sync } = fake(id);
      await sync.start(s, src);
      sent.push(calls[0].body.client_id);
    }
    expect(sent).toEqual([id, id]);
  });

  it("does not register a source that is not synthetic", async () => {
    const src = { ...createSyntheticSource(FIXTURE_SEED), synthetic: false };
    const s = createSim(src);
    const { calls, sync } = fake();
    await sync.start(s, src);
    await sync.flush();
    expect(calls).toHaveLength(0);
    expect(s.outbox).toBeUndefined();
  });

  it("stops on 409 at registration: no more requests, the status is set, the sim runs on", async () => {
    const { s, src } = start();
    const { calls, net, sync } = fake();
    net.register = 409;
    await sync.start(s, src);
    expect(sync.stopped).toBe("other_live");
    run(s, src, 5);
    await sync.flush();
    await sync.flush();
    expect(calls).toHaveLength(1);
    expect(minuteOf(s)).toBe(5);
    expect(s.outbox).toBeUndefined();
  });

  it("stops on 409 for a batch and drops the queue", async () => {
    const { s, src } = start();
    const { calls, net, sync } = fake();
    await sync.start(s, src);
    run(s, src, 10);
    net.batch = 409;
    await sync.flush();
    expect(sync.stopped).toBe("superseded");
    expect(s.outbox).toBeUndefined();
    run(s, src, 5);
    await sync.flush();
    expect(calls).toHaveLength(3); // registration, the first batch, the refused one
  });

  it("continues a saved ward in its run without registering", async () => {
    const { s, src } = start();
    const first = fake();
    await first.sync.start(s, src);
    run(s, src, 10);
    const { calls, sync } = fake();
    await sync.resume(s, src, first.sync.run);
    expect(first.sync.run).toEqual({ runId: 7, origin: first.calls[0].body.origin, cursor: 0 });
    expect(sync.run).toEqual(first.sync.run);
    expect(calls.map((c) => c.path)).toEqual(["/sim/runs/7/batch"]);
    expect(calls[0].body.minute).toBe(10);
    expect(calls[0].body.observations.length).toBeGreaterThan(0); // the queue it was saved with
  });

  it("registers a resumed ward as it is now when the API no longer has its run", async () => {
    const { s, src } = start();
    const first = fake();
    await first.sync.start(s, src);
    run(s, src, 40);
    const { calls, net, sync } = fake();
    net.batch = 404;
    await sync.resume(s, src, first.sync.run);
    expect(sync.stopped).toBeNull();
    net.batch = 204;
    await sync.flush();
    expect(calls.map((c) => c.path)).toEqual(["/sim/runs/7/batch", "/sim/runs", "/sim/runs/7/batch"]);
    const { body } = calls[1];
    expect(body.origin).toBe(first.sync.run.origin); // minute 40 stays the same wall time
    expect(body.patients).toHaveLength(12);
    expect(new Set(body.patients.flatMap((p: { observations: Obs[] }) => p.observations.map((o) => o.minute)))).toEqual(new Set([40]));
    expect(calls[2].body.minute).toBe(40);
  });

  it("registers a ward that was saved before the API ever answered", async () => {
    const { s, src } = start();
    const { calls, sync } = fake();
    await sync.resume(s, src, { runId: null, origin: "2026-11-11T00:00:00.000Z", cursor: 0 });
    expect(calls.map((c) => c.path)).toEqual(["/sim/runs", "/sim/runs/7/batch"]);
    expect(calls[0].body.origin).toBe("2026-11-11T00:00:00.000Z");
  });

  it.each([403, 503])("stops on %i at registration", async (status) => {
    const { s, src } = start();
    const { calls, net, sync } = fake();
    net.register = status;
    await sync.start(s, src);
    await sync.flush();
    expect(sync.stopped).toBe("bad_key");
    expect(calls).toHaveLength(1);
  });

  it("pulls the clinician actions after its cursor, and a resumed ward continues from it", async () => {
    const { s, src } = start();
    const { calls, net, sync } = fake();
    expect(await sync.pull()).toEqual([]); // no run yet: nothing is asked
    expect(calls).toHaveLength(0);
    await sync.start(s, src);
    const note = (seq: number) => ({ seq, kind: "add_note", patient_id: "p-001", clinician_id: "rn-reyes" }) as Action;
    net.feed = [note(1), note(3)];
    expect((await sync.pull()).map((a) => a.seq)).toEqual([1, 3]);
    expect([calls.at(-1)!.path, calls.at(-1)!.key]).toEqual(["/sim/runs/7/actions?after=0", "k"]);
    expect(sync.run.cursor).toBe(3);
    net.feed.push(note(4));
    net.offline = true;
    expect(await sync.pull()).toEqual([]);
    net.offline = false;
    net.actions = 500;
    expect(await sync.pull()).toEqual([]);
    expect(sync.run.cursor).toBe(3);
    net.actions = 200;
    const both = [sync.pull(), sync.pull()]; // the second finds the first under way
    expect((await both[0]).map((a) => a.seq)).toEqual([4]);
    expect(await both[1]).toEqual([]);
    expect(calls.filter((c) => c.path === "/sim/runs/7/actions?after=3")).toHaveLength(2); // the 500 and this one

    const again = fake();
    await again.sync.resume(s, src, sync.run);
    expect(again.sync.run.cursor).toBe(4);
    await again.sync.pull();
    expect(again.calls.at(-1)!.path).toBe("/sim/runs/7/actions?after=4");
  });

  it("stops on 409 for a pull, and leaves a 404 to the next flush", async () => {
    const { s, src } = start();
    const { calls, net, sync } = fake();
    await sync.start(s, src);
    net.feed = [{ seq: 2, kind: "add_note", patient_id: "p-001", clinician_id: "rn-reyes" } as Action];
    await sync.pull();
    net.actions = 404;
    expect(await sync.pull()).toEqual([]);
    expect(sync.run).toMatchObject({ runId: 7, cursor: 2 }); // an API without the route answers 404 too: no new run
    await sync.flush();
    expect(calls.at(-1)!.path).toBe("/sim/runs/7/batch");
    expect(calls.filter((c) => c.path === "/sim/runs")).toHaveLength(1);
    net.actions = 409;
    expect(await sync.pull()).toEqual([]);
    expect(sync.stopped).toBe("superseded");
    const sent = calls.length;
    expect(await sync.pull()).toEqual([]);
    expect(calls).toHaveLength(sent);
  });

  it("still retries on a 500, at registration and for a batch", async () => {
    const { s, src } = start();
    const { calls, net, sync } = fake();
    net.register = 500;
    await sync.start(s, src);
    expect(sync.stopped).toBeNull();
    net.register = 201;
    net.batch = 500;
    run(s, src, 5);
    await sync.flush();
    expect(sync.stopped).toBeNull();
    expect(s.outbox!.observations.length).toBeGreaterThan(0);
    net.batch = 204;
    await sync.flush();
    expect(s.outbox!.observations).toHaveLength(0);
    expect(calls.map((c) => c.path)).toEqual(["/sim/runs", "/sim/runs", "/sim/runs/7/batch", "/sim/runs/7/batch"]);
  });

  it("sends an empty batch while paused, so the run is not stale", async () => {
    const { s, src } = start();
    const { calls, sync } = fake();
    await sync.start(s, src);
    run(s, src, 5);
    await sync.flush();
    setSpeed(s, 0);
    await sync.flush();
    await sync.flush();
    const paused = calls.slice(-2).map((c) => c.body);
    expect(paused.map((b) => [b.observations.length, b.bins.length, b.events.length, b.minute, b.ended])).toEqual([
      [0, 0, 0, 5, false],
      [0, 0, 0, 5, false],
    ]);
  });

  it("sends the final ended state", async () => {
    const src = { ...createSyntheticSource(FIXTURE_SEED), durationMin: 120 };
    const s = createSim(src);
    const { calls, sync } = fake();
    await sync.start(s, src);
    while (!s.ended) step(s, src);
    await sync.flush();
    expect(calls.at(-1)!.body).toMatchObject({ ended: true, minute: 120 });
    const before = calls.length;
    await sync.flush();
    expect(calls).toHaveLength(before); // an ended run is not written to again
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
  expect(login.status, `sign-in as ${who}: is BIOSENTRY_PASSPHRASE set?`).toBe(200);
  const { token } = (await login.json()) as { token: string };
  const res = await fetch(`${API}/wards/W4/rows`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    ranked: { id: string; score: number }[];
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
  const sync = createSync({ apiUrl: API!, key: KEY, clientId: TEST_CLIENT, fetch: globalThis.fetch.bind(globalThis) });
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

  it("gives a second client a 409 while the first is live", async () => {
    const { s, src } = start();
    const first = createSync({ apiUrl: API!, key: KEY, clientId: TEST_CLIENT, fetch: globalThis.fetch.bind(globalThis) });
    await first.start(s, src);
    expect(first.stopped).toBeNull();

    const other = start();
    const second = createSync({ apiUrl: API!, key: KEY, clientId: `${TEST_CLIENT}-other`, fetch: globalThis.fetch.bind(globalThis) });
    await second.start(other.s, other.src);
    expect(second.stopped).toBe("other_live");

    await first.flush(); // the first keeps the ward
    expect(first.stopped).toBeNull();
  });
});
