/// <reference types="node" />
// The month loop: at ward day 30 a hospital run closes and the next seed starts. No server: a fake API that counts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadWard, saveWard } from "../persist";
import { createSim, minuteOf, step, type Sim } from "../sim";
import { createSyntheticSource, type VitalsSource } from "../source";
import { createSync, withTimeout } from "../sync";
import { freshHospital } from "./fresh";
import { createMonthLoop, MONTH_DAYS, MONTH_GRACE_MIN, MONTH_MIN, type World } from "./month";

type Body = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The API as the runner meets it: each new run gets the next id. `down`: it cannot be reached (a network error) until switched back. */
function fake() {
  const posts: { path: string; body: Body }[] = [];
  const accepted: number[] = []; // each run id, at the moment the sync learned of it
  const net = { down: false, nextRun: 7, superseded: new Set<number>() }; // superseded: the API answers 409 to these runs' batches
  const f = (async (url: string, init: RequestInit) => {
    const path = url.replace("http://api", "");
    if (init.method !== "POST") return new Response("{}", { status: 200 });
    if (net.down) throw new Error("offline"); // not a 503: the sync reads that as "the API refused the key" and stops for good
    const old = /^\/sim\/runs\/(\d+)\/batch$/.exec(path);
    if (old && net.superseded.has(Number(old[1]))) return new Response(null, { status: 409 });
    posts.push({ path, body: JSON.parse(init.body as string) });
    return path === "/sim/runs" ? new Response(`{"run_id":${net.nextRun++}}`, { status: 201 }) : new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const sync = createSync({ apiUrl: "http://api", key: "k", clientId: "ward-runner", fetch: f, onRun: (id) => { accepted.push(id); posts.push({ path: "accepted", body: id }); } });
  const runs = () => posts.filter((p) => p.path === "/sim/runs").map((p) => p.body);
  return { posts, net, sync, runs, accepted };
}

/** One turn of the month loop, as the runner takes it: the world it goes on with. */
async function turn(month: ReturnType<typeof createMonthLoop>, w: World): Promise<World> {
  let next = w;
  await month.turn(w, (x) => (next = x));
  return next;
}

/** The runner's loop at 60x: one sim minute of steps, then the month's turn and a flush, as each second of the runner does. */
async function minutes(w: World, n: number, month: ReturnType<typeof createMonthLoop>, sync: ReturnType<typeof createSync>, each?: (w: World) => void): Promise<World> {
  for (let m = 0; m < n; m += 1) {
    for (let t = 0; t < 60 && !month.due(w.s); t += 1) step(w.s, w.src);
    w = await turn(month, w);
    await sync.flush();
    each?.(w);
  }
  return w;
}

const loop = (api: ReturnType<typeof fake>, monthMin?: number) => {
  const log: string[] = [];
  return { log, month: createMonthLoop({ sync: api.sync, fresh: (speed, seed) => freshHospital(speed, "typical", seed), log: (l) => log.push(l), monthMin }) };
};
const RUN = { runId: null, origin: "", cursor: 0, commandCursor: 0 };

describe("the month loop", () => {
  it("a month is 30 ward days", () => {
    expect([MONTH_DAYS, MONTH_MIN]).toEqual([30, 43_200]);
  });

  it("at ward day 30 the run closes and the next seed starts in a new run, with nothing between them", async () => {
    const api = fake();
    const { month, log } = loop(api); // the real 30 days, at 60x
    let w: World = freshHospital(60);
    w.s.rounds = true;
    await api.sync.start(w.s, w.src);
    const first = w.s;
    // To the last minute of day 30: still the first month.
    for (let h = 0; h < MONTH_DAYS * 24; h += 1) {
      for (let i = 0; i < 3600 && !month.due(w.s); i += 1) step(w.s, w.src);
      if (h < MONTH_DAYS * 24 - 1) {
        expect(month.due(w.s)).toBe(false);
        if (h % 24 === 23) await api.sync.flush(); // once a day keeps the queue small
      }
    }
    expect(minuteOf(w.s)).toBe(MONTH_MIN);
    expect(month.due(w.s)).toBe(true);
    expect(api.runs()).toHaveLength(1);
    w = await turn(month, w);
    // A new world at minute 0, seed 102, same scenario, in a new run the API accepted.
    expect(w.s).not.toBe(first);
    expect([minuteOf(w.s), w.s.hospital!.seed, w.s.speed, w.s.rounds]).toEqual([0, 102, 60, true]);
    expect(w.s.hospital!.scenario).toEqual(first.hospital!.scenario);
    expect(api.runs().map((r) => r.seed)).toEqual([101, 102]);
    expect(api.runs()[1].units.map((u: Body) => u.name)).toContain("Medicine 3B"); // a new run takes the unit names from the code
    expect(api.sync.run.runId).toBe(8);
    expect(month.maySave()).toBe(true);
    // The old run was told it ended, before the new run was asked for.
    const order = api.posts.map((p) => (p.path === "/sim/runs" ? "new" : p.path === "/sim/runs/7/batch" && p.body.ended ? "ended" : "."));
    expect(order.indexOf("ended")).toBeGreaterThan(-1);
    expect(order.indexOf("ended")).toBeLessThan(order.lastIndexOf("new"));
    expect(first.ended).toBe(true);
    expect(log).toEqual([`Month ended at minute ${MONTH_MIN}: seed 101 closes, seed 102 starts`, "New month accepted by the API: run 8"]);
    expect(w.s.log.some((l) => l.text === "New month: hospital seed 102")).toBe(true);
    // The new month runs on, in its own run.
    const before = api.posts.length;
    w = await minutes(w, 30, month, api.sync);
    expect(minuteOf(w.s)).toBe(30);
    expect(api.posts.slice(before).every((p) => p.path === "/sim/runs/8/batch")).toBe(true);
    expect(api.accepted).toEqual([7, 8]);
  }, 900_000);

  it("month after month the seeds go up by one, so the sequence can be repeated", async () => {
    const api = fake();
    const { month, log } = loop(api, 120);
    let w: World = freshHospital(60);
    await api.sync.start(w.s, w.src);
    const seeds: number[] = [];
    w = await minutes(w, 3 * 120 + 30, month, api.sync, (x) => { if (seeds.at(-1) !== x.s.hospital!.seed) seeds.push(x.s.hospital!.seed); });
    expect(seeds).toEqual([101, 102, 103, 104]);
    expect(api.runs().map((r) => r.seed)).toEqual([101, 102, 103, 104]);
    expect(log.filter((l) => l.startsWith("Month ended"))).toEqual([
      "Month ended at minute 120: seed 101 closes, seed 102 starts",
      "Month ended at minute 120: seed 102 closes, seed 103 starts",
      "Month ended at minute 120: seed 103 closes, seed 104 starts",
    ]);
    // The same seed gives the same month: the second month here equals a hospital started at seed 102.
    const again = freshHospital(60, "typical", 102);
    const b = freshHospital(60, "typical", 102);
    for (let i = 0; i < 60 * 60; i += 1) { step(again.s, again.src); step(b.s, b.src); }
    expect(saveWard(again.s, again.src, RUN)).toBe(saveWard(b.s, b.src, RUN));
  }, 300_000);

  it("the state file may be written again only once the API has accepted the new run", async () => {
    const api = fake();
    const { month, log } = loop(api, 60);
    let w: World = freshHospital(60);
    await api.sync.start(w.s, w.src);
    w = await minutes(w, 59, month, api.sync);
    expect(month.maySave()).toBe(true);
    api.net.down = true; // the API is down when the month ends
    w = await minutes(w, 1, month, api.sync);
    expect(w.s.hospital!.seed).toBe(102); // the new month runs
    expect(api.sync.run.runId).toBeNull();
    expect(month.maySave()).toBe(false); // but the file on disk must stay the old month's
    w = await minutes(w, 5, month, api.sync);
    expect(month.maySave()).toBe(false);
    api.net.down = false;
    w = await minutes(w, 1, month, api.sync);
    expect(api.sync.run.runId).toBe(8);
    expect(month.maySave()).toBe(true);
    expect(log.at(-1)).toBe("New month accepted by the API: run 8");
    expect(api.runs().map((r) => r.seed)).toEqual([101, 102]);
  }, 300_000);

  it("a restart at the boundary starts the next month and never continues the old run", async () => {
    const api = fake();
    const one = loop(api, 60);
    let w: World = freshHospital(60);
    await api.sync.start(w.s, w.src);
    for (let i = 0; i < 60 * 60; i += 1) step(w.s, w.src); // to the boundary; the runner is stopped before the switch
    await api.sync.flush();
    const file = saveWard(w.s, w.src, api.sync.run);
    expect(JSON.parse(file).run.runId).toBe(7);
    // The runner starts again on that file.
    const saved = loadWard(file);
    const api2 = fake();
    api2.net.nextRun = 8;
    const two = loop(api2, 60);
    expect(two.month.due(saved.s)).toBe(true);
    const next = await turn(two.month, { s: saved.s, src: saved.src });
    expect([next.s.hospital!.seed, minuteOf(next.s)]).toEqual([102, 0]);
    expect(api2.runs().map((r) => r.seed)).toEqual([102]);
    expect(api2.posts.some((p) => p.path.includes("/sim/runs/7/"))).toBe(false); // nothing more is sent to the old run
    expect(two.month.maySave()).toBe(true);
    expect(one.log).toEqual([]);
  }, 300_000);

  it("a crash after the API took the new run but before the file was replaced starts the same seed again, in a newer run", async () => {
    const api = fake();
    const { month } = loop(api, 60);
    let w: World = freshHospital(60);
    await api.sync.start(w.s, w.src);
    for (let i = 0; i < 60 * 60; i += 1) step(w.s, w.src);
    const file = saveWard(w.s, w.src, api.sync.run); // the last file written: the old month, at its end
    w = await turn(month, w); // run 8, seed 102, accepted; the process dies before it saves
    expect([api.sync.run.runId, w.s.hospital!.seed]).toEqual([8, 102]);
    const saved = loadWard(file);
    const api2 = fake();
    api2.net.nextRun = 9;
    const again = loop(api2, 60);
    const next = await turn(again.month, { s: saved.s, src: saved.src });
    expect([api2.sync.run.runId, next.s.hospital!.seed]).toEqual([9, 102]); // the same seed: the month is the same month
    expect(api2.runs()[0].client_id).toBe("ward-runner"); // the same client: the API keeps one live run, the newest
    expect(api2.posts.some((p) => /\/sim\/runs\/[78]\//.test(p.path))).toBe(false);
  }, 300_000);

  it("switches once when asked twice at the same time, and never for a ward alone", async () => {
    const api = fake();
    const { month } = loop(api, 60);
    const w: World = freshHospital(60);
    await api.sync.start(w.s, w.src);
    for (let i = 0; i < 60 * 60; i += 1) step(w.s, w.src);
    const [a, b] = await Promise.all([turn(month, w), turn(month, w)]);
    expect([a.s === w.s, b.s === w.s].filter(Boolean)).toHaveLength(1); // one call made the switch, the other kept the world it had
    expect(api.runs().map((r) => r.seed)).toEqual([101, 102]);
    const src: VitalsSource = createSyntheticSource(101, true);
    const ward: Sim = createSim(src);
    ward.clockS = 10 * MONTH_MIN * 60;
    expect(month.due(ward)).toBe(false);
  }, 300_000);

  it("the new world is in place before the run is asked for, and the save comes at the moment of acceptance, before anything else is sent", async () => {
    const api = fake();
    const { month } = loop(api, 60);
    const w: World = freshHospital(60);
    await api.sync.start(w.s, w.src);
    for (let i = 0; i < 60 * 60; i += 1) step(w.s, w.src);
    const from = api.posts.length;
    const seen: string[] = [];
    let now: World = w;
    await month.turn(w, (x) => { now = x; seen.push(`swap at ${api.posts.length - from}`); });
    const after = api.posts.slice(from).map((p) => (p.path === "/sim/runs" ? "ask" : p.path === "accepted" ? `accepted, world seed ${now.s.hospital!.seed}, may save ${month.maySave()}` : p.path));
    const ask = after.indexOf("ask");
    expect(seen).toEqual([`swap at ${ask}`]); // the swap came before the request for the new run
    expect(after[ask + 1]).toBe("accepted, world seed 102, may save true"); // at acceptance the runner's world is the new one, and it may save
    expect(after[ask + 2]).toBe("/sim/runs/8/batch"); // only then the new run's first batch
  }, 300_000);

  it("killed after the API took the new run, with a last file from before the boundary: the restart starts the next month and does not loop", async () => {
    const api = fake();
    const { month } = loop(api, 120);
    let w: World = freshHospital(60);
    await api.sync.start(w.s, w.src);
    w = await minutes(w, 118, month, api.sync);
    const file = saveWard(w.s, w.src, api.sync.run); // the last file: minute 118 of 120, run 7
    w = await minutes(w, 2, month, api.sync); // the switch: run 8, seed 102, accepted; the process is killed before any save
    expect([api.sync.run.runId, w.s.hospital!.seed]).toEqual([8, 102]);

    // The runner starts again on the old file. The API now refuses run 7: a newer run exists.
    const saved = loadWard(file);
    const api2 = fake();
    api2.net.nextRun = 9;
    api2.net.superseded.add(7);
    const again = loop(api2, 120);
    expect(again.month.due(saved.s)).toBe(false); // minute 118: the month is not over in this file
    await api2.sync.resume(saved.s, saved.src, saved.run);
    let now: World = { s: saved.s, src: saved.src };
    now = await minutes(now, 1, again.month, api2.sync);
    expect(api2.sync.stopped).toBe("superseded"); // what made the runner exit, and the container start it again, for ever
    expect(await again.month.recover(now, (x) => (now = x))).toBe(true);
    expect([now.s.hospital!.seed, minuteOf(now.s), api2.sync.run.runId, api2.sync.stopped]).toEqual([102, 0, 9, null]);
    expect(again.month.maySave()).toBe(true);
    expect(api2.runs().map((r) => r.seed)).toEqual([102]);
    expect(again.log[0]).toMatch(/^The old run was replaced near the month's end \(minute 119\)/);
    // It goes on in the new run, and a second restart from the file written now would simply resume it.
    now = await minutes(now, 10, again.month, api2.sync);
    expect([minuteOf(now.s), api2.sync.stopped]).toEqual([10, null]);
  }, 300_000);

  it("superseded in the middle of a month is somebody else's newer run: no recovery, the runner stops as before", async () => {
    const api = fake();
    const { month, log } = loop(api, 120);
    let w: World = freshHospital(60);
    await api.sync.start(w.s, w.src);
    w = await minutes(w, 120 - MONTH_GRACE_MIN - 2, month, api.sync);
    api.net.superseded.add(7);
    w = await minutes(w, 1, month, api.sync);
    expect(minuteOf(w.s)).toBe(120 - MONTH_GRACE_MIN - 1); // one minute short of "near the end"
    expect(api.sync.stopped).toBe("superseded");
    let now = w;
    expect(await month.recover(w, (x) => (now = x))).toBe(false);
    expect(now).toBe(w);
    expect(api.runs()).toHaveLength(1);
    expect(log).toEqual([]);
  }, 300_000);

  it("a request that hangs gives up, and the sync goes on at the next flush", async () => {
    // A request that never answers by itself: it ends only when its signal says so.
    const hung = ((_: string, init: RequestInit) => new Promise((_ok, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const t0 = Date.now();
    await expect(withTimeout(hung, 30)("http://api/x")).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
    // In the sync a request that fails this way is a network error: nothing is lost, nothing stops.
    let calls = 0;
    const f = withTimeout(((_: string, init: RequestInit) => new Promise((resolve, reject) => {
      calls += 1;
      if (calls === 1) init.signal!.addEventListener("abort", () => reject(new Error("timeout")));
      else resolve(new Response(calls === 2 ? '{"run_id":7}' : null, { status: calls === 2 ? 201 : 204 }));
    })) as unknown as typeof fetch, 30);
    const sync = createSync({ apiUrl: "http://api", key: "k", clientId: "t", fetch: f });
    const w = freshHospital(60);
    await sync.start(w.s, w.src); // the first request hangs and is given up
    expect([sync.run.runId, sync.stopped]).toEqual([null, null]);
    await sync.flush();
    expect(sync.run.runId).toBe(7);
  }, 60_000);

  it("the runner saves at acceptance, checks before any write, recovers from superseded, and times its requests out", () => {
    const head = readFileSync("src/headless.ts", "utf8");
    expect(head).toContain('const sync = createSync({ apiUrl, key, clientId: "ward-runner", fetch: withTimeout(fetch, 30_000), onRun: () => save() });');
    expect(head).toContain("if (hospital && !month.maySave()) return;");
    expect(head).toContain("const newMonth = hospital && saved !== null && month.due(s);");
    expect(head).toContain("await month.turn({ s, src }, swap);");
    expect(head).toContain('if (hospital && sync.stopped === "superseded" && (await month.recover({ s, src }, swap))) return save();');
    expect(head).toContain("fresh: (at, seed) => freshHospital(at, scenario, seed)");
    const save = head.slice(head.indexOf("function save() {"), head.indexOf("savedAt = Date.now();"));
    expect(save.indexOf("month.maySave()")).toBeLessThan(save.indexOf("writeFileSync")); // the check comes before any write
    const flush = head.slice(head.indexOf("async function flush() {"), head.indexOf("process.exit(1);", head.indexOf("async function flush() {")));
    expect(flush.indexOf("month.recover(")).toBeGreaterThan(-1); // the recovery is tried before the exit
  });
});
