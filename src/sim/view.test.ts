// The ward as viewers get it: what the runner publishes, and the Sim the page rebuilds from it.
import { describe, expect, it } from "vitest";
import { explain } from "../explain";
import { createSim, flowStats, minuteOf, recordBp, skipDay, staffStatus, step, vitalQuality, type Sim } from "./sim";
import { createSyntheticSource, FIXTURE_SEED, VITALS } from "./source";
import { createSync } from "./sync";
import { createPublisher, createReader, type LiveView, type ViewBody } from "./view";

const LIMIT = 65_536;

const start = () => {
  const src = createSyntheticSource(FIXTURE_SEED, true);
  return { src, s: createSim(src) };
};

/** As the API hands it on: through JSON, and only the patients that clinician may see. */
const answer = (body: ViewBody, sees: (id: string) => boolean = () => true): LiveView => {
  const live = JSON.parse(JSON.stringify(body)) as LiveView;
  return { ...live, patients: live.patients.filter((p) => sees(p.id)) };
};

function drawable(sim: Sim) {
  const minute = minuteOf(sim);
  for (const m of sim.staff) staffStatus(sim, m);
  for (const p of sim.patients) {
    explain(p);
    for (const v of VITALS) vitalQuality(p, v, minute);
  }
  flowStats(sim);
}

describe("the published view", () => {
  it("round-trips through JSON into a Sim the panels can read", () => {
    const { s, src } = start();
    const publish = createPublisher();
    const read = createReader();
    for (let round = 0; round < 5; round += 1) {
      for (let tick = 0; tick < 1000; tick += 1) step(s, src);
      const sim = read(answer(publish(s)));
      expect(() => drawable(sim)).not.toThrow();
      expect(sim.patients.map((p) => [p.id, p.rank, p.decision, p.held, p.stay])).toEqual(
        s.patients.map((p) => [p.id, p.rank, p.decision, p.held, p.stay]),
      );
      expect(sim.staff).toEqual(s.staff);
      expect(sim.stays).toHaveLength(sim.patients.length);
      expect(sim.log).toEqual([]);
    }
  });

  it("keeps patient names and readings out of what every clinician gets", () => {
    const { s, src } = start();
    recordBp(s, s.patients[0].id, { systolic: 123, diastolic: 77 });
    const publish = createPublisher();
    for (let day = 0; day < 2; day += 1) {
      const shared = JSON.stringify(publish(s).shared);
      expect(shared).not.toContain("systolic");
      for (const stay of s.stays) {
        expect(shared).not.toContain(stay.name);
        expect(shared).not.toContain(stay.context);
      }
      for (const p of s.patients) expect(shared).not.toContain(p.story);
      skipDay(s, src);
    }
  });

  it("stays under the API's size limits after a day, and a long stay's scores are capped", () => {
    const { s, src } = start();
    skipDay(s, src);
    s.patients[0].stay.scores = Array(30 * 24).fill(20);
    const body = createPublisher()(s);
    expect(JSON.stringify(body.shared).length).toBeLessThan(LIMIT);
    for (const p of body.patients) expect(JSON.stringify(p.view).length).toBeLessThan(LIMIT);
    expect(body.patients[0].view.stay.scores).toHaveLength(200);
    expect(s.patients[0].stay.scores).toHaveLength(30 * 24); // the sim's own stay is untouched
    expect(body.patients.length).toBeLessThanOrEqual(200);
    expect(new Set(body.patients.map((p) => p.id)).size).toBe(body.patients.length);
  });

  it("delivers a move to the reader once, and none from before it began", () => {
    const { s } = start();
    const publish = createPublisher();
    const read = createReader();
    s.moves.push({ bed: "W4-01", kind: "in" });
    expect(read(answer(publish(s))).moves).toEqual([]); // already old at sign-in
    expect(s.moves).toEqual([]); // drained: the runner has no renderer to do it
    s.moves.push({ bed: "W4-02", kind: "discharged" });
    expect(read(answer(publish(s))).moves).toEqual([{ bed: "W4-02", kind: "discharged", seq: 2 }]);
    expect(read(answer(publish(s))).moves).toEqual([]);
    for (let i = 0; i < 30; i += 1) s.moves.push({ bed: "W4-03", kind: "in" });
    expect(publish(s).shared.moves.map((m) => m.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 13));
  });

  it("delivers the moves of a restarted runner", () => {
    const { s } = start();
    const read = createReader();
    const old = createPublisher();
    s.clockS = 600;
    for (let i = 0; i < 5; i += 1) s.moves.push({ bed: "W4-01", kind: "in" });
    read(answer(old(s)));
    const fresh = createPublisher();
    s.clockS = 60;
    s.moves.push({ bed: "W4-02", kind: "in" });
    expect(read(answer(fresh(s))).moves).toHaveLength(1);
  });

  it("draws an empty ward when nothing is published", () => {
    const sim = createReader()({ shared: null, patients: [] });
    expect(sim.patients).toEqual([]);
    expect(() => drawable(sim)).not.toThrow();
  });

  it("does not crash a staff card when the clinician is not sent that patient", () => {
    const { s, src } = start();
    const hidden = (body: ViewBody) =>
      body.shared.staff.some((m) => m.task && s.patients.find((p) => p.id === m.task!.patient)!.rn !== "rn-delacruz") &&
      body.shared.tasks.some((t) => t.rn !== "rn-delacruz");
    const publish = createPublisher();
    let body = publish(s);
    for (let tick = 0; tick < 200_000 && !hidden(body); tick += 1) {
      step(s, src);
      body = publish(s);
    }
    expect(hidden(body)).toBe(true);
    const mine = new Set(s.patients.filter((p) => p.rn === "rn-delacruz").map((p) => p.id));
    const sim = createReader()(answer(body, (id) => mine.has(id)));
    expect(sim.patients.length).toBe(mine.size);
    expect(() => drawable(sim)).not.toThrow();
    for (const task of [...sim.tasks, ...sim.staff.flatMap((m) => m.task ?? [])]) expect(mine.has(task.patient)).toBe(true);
  });
});

describe("sync.publish, with a fake fetch", () => {
  function fake() {
    const calls: { path: string; key: string | null; body: unknown }[] = [];
    const net = { offline: false, view: 204 };
    const f = (async (url: string, init: RequestInit) => {
      if (net.offline) throw new Error("offline");
      const path = url.replace("http://api", "");
      calls.push({ path, key: (init.headers as Record<string, string>)["X-Ingest-Key"] ?? null, body: JSON.parse(init.body as string) });
      if (path === "/sim/runs") return new Response('{"run_id":7}', { status: 201 });
      return new Response(null, { status: path.endsWith("/view") ? net.view : 204 });
    }) as unknown as typeof fetch;
    return { calls, net, sync: createSync({ apiUrl: "http://api", key: "k", clientId: "page-1", fetch: f }) };
  }

  it("posts the view to its run with the ingest key, and only once a run is registered", async () => {
    const { s, src } = start();
    const { calls, sync } = fake();
    const body = createPublisher()(s);
    await sync.publish(body);
    expect(calls).toEqual([]);
    await sync.start(s, src);
    await sync.publish(body);
    expect(calls.at(-1)).toEqual({ path: "/sim/runs/7/view", key: "k", body: JSON.parse(JSON.stringify(body)) });
  });

  it("never throws or queues when the API is away, and stops on 409", async () => {
    const { s, src } = start();
    const { calls, net, sync } = fake();
    await sync.start(s, src);
    const body = createPublisher()(s);
    net.offline = true;
    await expect(sync.publish(body)).resolves.toBeUndefined();
    net.offline = false;
    net.view = 500;
    await expect(sync.publish(body)).resolves.toBeUndefined();
    expect(sync.stopped).toBeNull();
    net.view = 409;
    await sync.publish(body);
    expect(sync.stopped).toBe("superseded");
    const sent = calls.length;
    await sync.publish(body);
    expect(calls.length).toBe(sent);
  });
});
