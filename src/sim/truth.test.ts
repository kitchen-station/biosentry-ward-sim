/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSim, injectDeterioration, minuteOf, setSpeed, step, type Sim } from "./sim";
import { createSyntheticSource, FIXTURE_SEED, type SavedSource } from "./source";
import { createSync } from "./sync";
import { createTruthPoster, startedEpisodes, type Acked, type Episode } from "./truth";

const KEY = "secret-ingest-key-123";
const stream = (injectAt: number | null, kind: string | null = "respiratory", rampMin = 60) => ({
  injectAt,
  episode: kind === null ? null : { kind },
  rampMin,
  afFrom: null,
  afUntil: 0,
});
const saved = (streams: Record<string, object>, af: string[] = []): SavedSource =>
  ({ seed: 1, flow: false, flowRng: 0, admitted: 0, af, anchors: {}, streams }) as SavedSource;
const ep = (patient_id: string, start_minute: number, full_minute = start_minute + 60, kind = "respiratory"): Episode => ({ patient_id, kind, start_minute, full_minute });
const acked = (minute: number | null, ...patients: string[]): Acked => ({ minute, patients: new Set(patients) });

/** A poster on a fake clock and a fake fetch. `answer` is the status, or a function that throws or hangs. */
function setup(answer: number | (() => Promise<Response>) = 204) {
  const clock = { t: 100_000 };
  const logs: string[] = [];
  const calls: { url: string; init: RequestInit; body: { episodes: Episode[] } }[] = [];
  const net = { answer };
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(init.body as string) });
    return typeof net.answer === "number" ? new Response(null, { status: net.answer }) : net.answer();
  }) as unknown as typeof fetch;
  const poster = createTruthPoster({ apiUrl: "http://api", key: KEY, fetch: f, now: () => clock.t, log: (l) => logs.push(l) });
  return { clock, logs, calls, net, poster };
}

describe("startedEpisodes", () => {
  it("sends the four fields, floor of the start and ceil of the full minute", () => {
    const out = startedEpisodes(saved({ a: stream(431.9, "tachycardic", 66.2) }), ["a"], 500);
    expect(out).toEqual([{ patient_id: "a", kind: "tachycardic", start_minute: 431, full_minute: 499 }]);
    expect(Object.keys(out[0]).sort()).toEqual(["full_minute", "kind", "patient_id", "start_minute"]);
  });

  it("is empty before the start, with no episode, with no start, or for a patient not asked about", () => {
    const s = saved({ a: stream(100.5), b: stream(null), c: stream(10, null), gone: stream(1) });
    expect(startedEpisodes(s, ["a", "b", "c"], 100)).toEqual([]);
    expect(startedEpisodes(s, ["a", "b", "c"], 101).map((e) => e.patient_id)).toEqual(["a"]);
  });

  it("never reads atrial fibrillation", () => {
    const s = saved({ a: { ...stream(null, null), afFrom: 5, afUntil: 90 } }, ["a"]);
    expect(startedEpisodes(s, ["a"], 1000)).toEqual([]);
  });

  it("sends a start that a command moved earlier with its final value only", () => {
    const src = createSyntheticSource(FIXTURE_SEED);
    const s = createSim(src);
    const ids = s.patients.map((p) => p.id);
    expect(startedEpisodes(src.save!(ids), ids, minuteOf(s))).toEqual([]); // the fixture ward has none
    injectDeterioration(s, src, "p-002");
    const out = startedEpisodes(src.save!(ids), ids, minuteOf(s));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ patient_id: "p-002", start_minute: 0 });
  });
});

describe("the poster: when it posts", () => {
  it("posts nothing with no rows, and never an empty body", async () => {
    const { poster, calls } = setup();
    poster.offer(7, 0, [], acked(10, "a"));
    await poster.tick();
    expect(calls).toHaveLength(0);
  });

  it("waits for the acknowledged minute and the acknowledged patient", async () => {
    const { poster, calls, clock } = setup();
    poster.offer(7, 0, [ep("a", 50)], acked(null, "a"));
    await poster.tick();
    poster.offer(7, 0, [ep("a", 50)], acked(49, "a"));
    await poster.tick();
    poster.offer(7, 0, [ep("a", 50)], acked(60, "b"));
    await poster.tick();
    expect(calls).toHaveLength(0);
    clock.t += 1;
    poster.offer(7, 0, [ep("a", 50)], acked(50, "a"));
    await poster.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://api/sim/runs/7/episodes");
  });

  it("posts at most 200 rows, oldest start first, and keeps at most 200 waiting: the oldest overflow is dropped with one line", async () => {
    const { poster, calls, logs } = setup();
    const rows = Array.from({ length: 205 }, (_, i) => ep(`p${i}`, 300 - i));
    poster.offer(7, 0, rows, acked(400, ...rows.map((r) => r.patient_id)));
    await poster.tick();
    expect(calls[0].body.episodes).toHaveLength(200);
    expect(calls[0].body.episodes[0].start_minute).toBe(101); // p199: p200 to p204 (the oldest) were dropped
    expect(logs).toEqual(["episodes run 7: dropped"]);
  });

  it("posts a backlog of more than 200 waiting rows over two bodies", async () => {
    const { poster, calls, clock } = setup(503);
    const rows = Array.from({ length: 200 }, (_, i) => ep(`p${i}`, 300 - i));
    const all = acked(400, ...rows.map((r) => r.patient_id));
    poster.offer(7, 0, rows.slice(0, 150), all);
    await poster.tick(); // 503: kept
    poster.offer(7, 0, rows.slice(150), all); // the first 150 left the ward
    clock.t += 60_000;
    await poster.tick();
    expect(calls).toHaveLength(2);
    expect(calls[1].body.episodes).toHaveLength(200);
  });

  it("marks 204 as sent: the next tick posts nothing", async () => {
    const { poster, calls, clock } = setup();
    const a = acked(60, "a");
    poster.offer(7, 0, [ep("a", 50)], a);
    await poster.tick();
    clock.t += 20_000;
    poster.offer(7, 0, [ep("a", 50)], a);
    await poster.tick();
    expect(calls).toHaveLength(1);
  });

  it("posts at most once every 10 s", async () => {
    const { poster, calls, clock, net } = setup();
    net.answer = 204;
    poster.offer(7, 0, [ep("a", 50)], acked(60, "a", "b"));
    await poster.tick();
    clock.t += 9_999;
    poster.offer(7, 0, [ep("a", 50), ep("b", 51)], acked(60, "a", "b"));
    await poster.tick();
    expect(calls).toHaveLength(1);
    clock.t += 1;
    await poster.tick();
    expect(calls).toHaveLength(2);
    expect(calls[1].body.episodes.map((e) => e.patient_id)).toEqual(["b"]);
  });

  it("starts clean on a new run id", async () => {
    const { poster, calls, clock } = setup();
    poster.offer(7, 0, [ep("a", 50)], acked(60, "a"));
    await poster.tick();
    clock.t += 10_000;
    poster.offer(8, 0, [ep("a", 50)], acked(60, "a"));
    await poster.tick();
    expect(calls.map((c) => c.url)).toEqual(["http://api/sim/runs/7/episodes", "http://api/sim/runs/8/episodes"]);
  });

  it("does nothing with no run id", async () => {
    const { poster, calls } = setup();
    poster.offer(null, 0, [ep("a", 50)], acked(60, "a"));
    await poster.tick();
    expect(calls).toHaveLength(0);
  });

  it("a fresh poster (a restart) posts the started episodes of present patients, not of one who left", async () => {
    const ward = saved({ here: stream(10), gone: stream(10) });
    const { poster, calls } = setup();
    poster.offer(7, 0, startedEpisodes(ward, ["here"], 100), acked(100, "here"));
    await poster.tick();
    expect(calls[0].body.episodes.map((e) => e.patient_id)).toEqual(["here"]);
  });
});

describe("the poster: each answer", () => {
  it.each([403, 404, 503])("keeps the rows on %i and retries no sooner than 60 s", async (status) => {
    const { poster, calls, clock, net, logs } = setup(status);
    const a = acked(60, "a");
    poster.offer(7, 0, [ep("a", 50)], a);
    await poster.tick();
    clock.t += 59_999;
    poster.offer(7, 0, [ep("a", 50)], a);
    await poster.tick();
    expect(calls).toHaveLength(1);
    clock.t += 1;
    net.answer = 204;
    await poster.tick();
    expect(calls).toHaveLength(2);
    expect(logs).toEqual([]);
  });

  it("keeps the rows after a network error and after a timeout, and retries after 60 s", async () => {
    const { poster, calls, clock, net } = setup(() => Promise.reject(new Error("offline")));
    const a = acked(60, "a");
    poster.offer(7, 0, [ep("a", 50)], a);
    await poster.tick();
    clock.t += 30_000;
    await poster.tick();
    expect(calls).toHaveLength(1);
    net.answer = () => Promise.reject(new DOMException("timed out", "TimeoutError"));
    clock.t += 30_000;
    await poster.tick();
    expect(calls).toHaveLength(2);
    clock.t += 59_000;
    await poster.tick();
    expect(calls).toHaveLength(2);
    clock.t += 1_000;
    await poster.tick();
    expect(calls).toHaveLength(3);
  });

  it("stops for the run on 409 with one line, and starts again for a new run", async () => {
    const { poster, calls, clock, logs } = setup(409);
    const a = acked(60, "a");
    poster.offer(7, 0, [ep("a", 50)], a);
    await poster.tick();
    for (let i = 0; i < 3; i += 1) {
      clock.t += 120_000;
      poster.offer(7, 0, [ep("a", 50)], a);
      await poster.tick();
    }
    expect(calls).toHaveLength(1);
    expect(logs).toEqual(["episodes run 7: 409"]);
    poster.offer(8, 0, [ep("a", 50)], a);
    await poster.tick();
    expect(calls).toHaveLength(2);
  });

  it("drops the body on 422 with one line and never retries it", async () => {
    const { poster, calls, clock, logs } = setup(422);
    const a = acked(60, "a");
    poster.offer(7, 0, [ep("a", 50)], a);
    await poster.tick();
    clock.t += 120_000;
    poster.offer(7, 0, [ep("a", 50)], a);
    await poster.tick();
    expect(calls).toHaveLength(1);
    expect(logs).toEqual(["episodes run 7: 422"]);
  });
});

describe("the poster: a row waits for its acknowledgement", () => {
  it("is posted after the patient left the ward, 61 s after a 404", async () => {
    const { poster, calls, clock, net } = setup(404);
    const a = acked(60, "a", "b");
    poster.offer(7, 0, [ep("a", 50)], a);
    await poster.tick();
    expect(calls).toHaveLength(1);
    clock.t += 1_000;
    poster.offer(7, 0, [], a); // a has left: later offers do not hold a
    clock.t += 60_000;
    poster.offer(7, 0, [ep("b", 55)], a);
    net.answer = 204;
    await poster.tick();
    expect(calls).toHaveLength(2);
    expect(calls[1].body.episodes.map((e) => e.patient_id)).toEqual(["a", "b"]);
  });

  it("still needs the acknowledged minute and patient when it is posted", async () => {
    const { poster, calls, clock } = setup();
    poster.offer(7, 0, [ep("a", 50)], acked(40, "a"));
    poster.offer(7, 0, [], acked(40, "a"));
    clock.t += 10_000;
    await poster.tick();
    expect(calls).toHaveLength(0);
  });

  it("is not posted after the run id changes", async () => {
    const { poster, calls } = setup();
    poster.offer(7, 0, [ep("a", 50)], acked(60, "a"));
    poster.offer(8, 0, [], acked(60, "a"));
    await poster.tick();
    expect(calls).toHaveLength(0);
  });

  it("starts clean on the same run id with a new registration, and a 409 stop does not carry over", async () => {
    const { poster, calls, clock, net } = setup(409);
    const a = acked(60, "a");
    poster.offer(7, 1, [ep("a", 50)], a);
    await poster.tick();
    clock.t += 120_000;
    await poster.tick();
    expect(calls).toHaveLength(1); // stopped
    net.answer = 204;
    poster.offer(7, 2, [ep("a", 50)], a);
    await poster.tick();
    expect(calls).toHaveLength(2);
    poster.offer(7, 3, [], a); // new registration: the old row is gone
    clock.t += 10_000;
    await poster.tick();
    expect(calls).toHaveLength(2);
  });

  it("never posts twice at once: a fetch that never settles, 10 s later, is still one call", async () => {
    const { poster, calls, clock } = setup(() => new Promise<Response>(() => {}));
    poster.offer(7, 0, [ep("a", 50)], acked(60, "a"));
    void poster.tick();
    clock.t += 10_000;
    void poster.tick();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
  });

  it("ignores the answer of a post for an earlier run", async () => {
    let release!: (r: Response) => void;
    const { poster, calls, net } = setup(() => new Promise<Response>((r) => (release = r)));
    const a = acked(60, "a");
    poster.offer(7, 0, [ep("a", 50)], a);
    const held = poster.tick();
    poster.offer(8, 0, [ep("a", 50)], a);
    release(new Response(null, { status: 204 }));
    await held;
    net.answer = 204;
    await poster.tick();
    expect(calls.map((c) => c.url)).toEqual(["http://api/sim/runs/7/episodes", "http://api/sim/runs/8/episodes"]);
  });
});

describe("the poster: refuses a body that would break the wire contract", () => {
  const bad: [string, Episode][] = [
    ["a kind outside the three", ep("a", 50, 110, "atrial_fibrillation")],
    ["a fractional start", ep("a", 50.5, 110)],
    ["a fractional full minute", ep("a", 50, 110.5)],
    ["a negative start", ep("a", -1, 10)],
    ["full before start", ep("a", 50, 49)],
  ];
  it.each(bad)("drops a row with %s: one line, never sent", async (_, row) => {
    const { poster, calls, clock, logs } = setup();
    for (let i = 0; i < 3; i += 1) {
      poster.offer(7, 0, [row, ep("ok", 20)], acked(100, "a", "ok"));
      await poster.tick();
      clock.t += 10_000;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].body.episodes.map((e) => e.patient_id)).toEqual(["ok"]);
    expect(logs).toEqual(["episodes run 7: dropped"]);
  });

  it("sends a patient once per body: a duplicate is dropped with one line", async () => {
    const { poster, calls, logs } = setup();
    poster.offer(7, 0, [ep("a", 50), ep("a", 60)], acked(100, "a"));
    poster.offer(7, 0, [ep("a", 50), ep("a", 60)], acked(100, "a"));
    await poster.tick();
    expect(calls[0].body.episodes).toEqual([ep("a", 50)]);
    expect(logs).toEqual(["episodes run 7: dropped"]);
  });

  it("sends nothing when every row is refused", async () => {
    const { poster, calls } = setup();
    poster.offer(7, 0, [ep("a", 50, 40)], acked(100, "a"));
    await poster.tick();
    expect(calls).toHaveLength(0);
  });
});

describe("the poster: key safety", () => {
  it("builds the URL from the one base, and sends redirect error, a timeout and the key only in X-Ingest-Key", async () => {
    const { poster, calls } = setup();
    poster.offer(7, 0, [ep("a", 50)], acked(60, "a"));
    await poster.tick();
    const { url, init, body } = calls[0];
    expect(url).toBe("http://api/sim/runs/7/episodes");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({ "Content-Type": "application/json", "X-Ingest-Key": KEY });
    expect(Object.keys(body)).toEqual(["episodes"]);
    expect(init.body).not.toContain(KEY);
    expect(url).not.toContain(KEY);
  });

  it("logs only the run id and the status: no key, body or header", async () => {
    const lines: string[] = [];
    for (const status of [409, 422]) {
      const { poster, logs } = setup(status);
      poster.offer(7, 0, [ep("a", 50), ep("x", 5, 4)], acked(60, "a", "x"));
      await poster.tick();
      lines.push(...logs);
    }
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).toMatch(/^episodes run 7: (409|422|dropped)$/);
      expect(l).not.toContain(KEY);
    }
  });
});

describe("a failing or hanging episodes post", () => {
  it("does not block the sync's flush or a tick loop", async () => {
    const src = createSyntheticSource(FIXTURE_SEED);
    const s = createSim(src);
    const syncCalls: string[] = [];
    const syncFetch = (async (url: string) => {
      syncCalls.push(url);
      return url.endsWith("/sim/runs") ? new Response('{"run_id":7}', { status: 201 }) : new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const sync = createSync({ apiUrl: "http://api", key: KEY, clientId: "c", fetch: syncFetch });
    await sync.start(s, src);
    injectDeterioration(s, src, "p-002");
    const { poster, calls, net } = setup(() => new Promise<Response>(() => {})); // never answers
    const ids = s.patients.map((p) => p.id);
    const loop = async () => {
      for (let i = 0; i < 3; i += 1) {
        step(s, src);
        await sync.flush();
        poster.offer(sync.run.runId, sync.generation, startedEpisodes(src.save!(ids), ids, minuteOf(s)), sync.acked);
        void poster.tick();
      }
    };
    await loop(); // resolves although the post hangs
    expect(calls).toHaveLength(1); // one in flight, not one per tick
    expect(syncCalls.filter((u) => u.endsWith("/batch")).length).toBeGreaterThanOrEqual(3);
    net.answer = 404;
    expect(sync.stopped).toBeNull();
  });

  it("a rejecting fetch never throws out of tick", async () => {
    const { poster } = setup(() => Promise.reject(new Error("boom")));
    poster.offer(7, 0, [ep("a", 50)], acked(60, "a"));
    await expect(poster.tick()).resolves.toBeUndefined();
  });
});

describe("reading the truth never changes the sim", () => {
  const TICKS = 6 * 3600; // six simulated hours at 60x
  function ward(read: boolean) {
    const src = createSyntheticSource(FIXTURE_SEED, true);
    const s: Sim = createSim(src);
    setSpeed(s, 60);
    s.outbox = { observations: [], bins: [], events: [], admissions: [], departures: [], sent: new Map() };
    injectDeterioration(s, src, "p-002"); // the same command in both runs, so there is truth to read
    let read_ = 0;
    for (let i = 0; i < TICKS; i += 1) {
      step(s, src);
      if (read) {
        const ids = s.patients.map((p) => p.id);
        read_ += startedEpisodes(src.save!(ids), ids, minuteOf(s)).length;
      }
    }
    const ids = s.patients.map((p) => p.id);
    return {
      read_,
      state: JSON.stringify([
        src.save!(ids),
        s.patients.map((p) => [p.id, p.decision, p.rank, p.trend, p.held, p.bp]),
        s.counts,
        s.flow,
        s.log,
        s.outbox,
      ], (_, v) => (v instanceof Map ? [...v] : v)),
    };
  }
  it("ends with the same state as a run that never reads it", () => {
    const plain = ward(false);
    const reading = ward(true);
    expect(reading.read_).toBeGreaterThan(0);
    expect(reading.state).toBe(plain.state);
  }, 60_000);
});

describe("the runner's use of the truth poster", () => {
  const code = readFileSync("src/headless.ts", "utf8");
  it("offers only after sync.flush(), only while the sync has not stopped, inside try/catch", () => {
    const flush = code.slice(code.indexOf("async function flush()"));
    expect(flush.indexOf("await sync.flush();")).toBeGreaterThan(-1);
    const afterFlush = flush.indexOf("await sync.flush();");
    const guard = flush.indexOf("if (!sync.stopped) {");
    const offer = flush.indexOf("offerTruth();");
    expect(afterFlush).toBeLessThan(guard);
    expect(guard).toBeLessThan(offer);
    expect(offer).toBeLessThan(flush.indexOf("process.exit(1)"));
    expect(code.match(/offerTruth\(\)/g)).toHaveLength(2); // the definition and this one call
    const def = code.slice(code.indexOf("function offerTruth()"), code.indexOf("async function flush()"));
    expect(def).toMatch(/try \{[\s\S]*poster\.offer\([\s\S]*void poster\.tick\(\);[\s\S]*\} catch/);
    expect(def).toContain("sync.generation");
    expect(code.match(/poster\.(offer|tick)\(/g)).toHaveLength(2); // no other call site
  });
});

describe("who may import the truth module", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
    });
  it("only src/headless.ts and the truth tests", () => {
    const allowed = new Set(["src/headless.ts", "src/sim/truth.test.ts"]);
    const all = files("src").filter((f) => !allowed.has(f));
    for (const must of ["src/App.tsx", "src/trial.ts", "src/hospital-trial.ts", "src/compare.ts", "src/lab-worker.ts", "src/realism.ts"]) {
      expect(all, must).toContain(must); // the scan reaches the files that matter
    }
    const importing = all.filter((f) => /["'][^"']*\/truth(\.tsx?)?["']/.test(readFileSync(f, "utf8")));
    expect(importing).toEqual([]);
  });
});
