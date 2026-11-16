import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applyCommand, commandNotice, freshWard, sendCommand, skipAhead, SKIP_QUEUE_MARK, skipMayGoOn, SKIPS, stepOneSecond, type Command } from "./commands";
import { createSim, minuteOf, patientById, step, type Sim } from "./sim";
import { createSync } from "./sync";
import { createSyntheticSource, FIXTURE_SEED } from "./source";

function ward() {
  const src = createSyntheticSource(FIXTURE_SEED, true);
  return { s: createSim(src), src };
}

let seq = 0;
const command = (kind: Command["kind"], patient_id: string | null, rest: Partial<Command> = {}): Command => ({
  seq: (seq += 1),
  kind,
  patient_id,
  clinician_id: "md-santos",
  speed: null,
  ...rest,
});
const lastLog = (s: Sim) => s.log.at(-1)!.text;

describe("a viewer command applied to the ward", () => {
  it("set_speed: sets the speed, pause included, and says who", () => {
    const { s, src } = ward();
    applyCommand(s, src, command("set_speed", null, { speed: 10 }));
    expect(s.speed).toBe(10);
    expect(lastLog(s)).toBe("Dr. Santos set the speed to 10x");
    applyCommand(s, src, command("set_speed", null, { speed: 0, clinician_id: "someone-else" }));
    expect(s.speed).toBe(0);
    expect(lastLog(s)).toBe("someone-else paused the ward");
  });

  it("set_speed: any other speed is ignored", () => {
    const { s, src } = ward();
    const before = JSON.stringify(s);
    for (const speed of [null, 5, 61, -1, 1.5]) applyCommand(s, src, command("set_speed", null, { speed }));
    expect(JSON.stringify(s)).toBe(before);
  });

  it("inject_deterioration and start_arrhythmia: start once, as the buttons do, with one log line each", () => {
    const { s, src } = ward();
    const p = s.patients[0];
    applyCommand(s, src, command("inject_deterioration", p.id));
    expect([p.injected, lastLog(s)]).toEqual([true, `Deterioration started for ${p.name}`]);
    const logged = s.log.length;
    expect(logged).toBe(1);
    applyCommand(s, src, command("inject_deterioration", p.id));
    expect(s.log).toHaveLength(logged); // already deteriorating: the button is off
    applyCommand(s, src, command("start_arrhythmia", p.id));
    expect(p.irregular).toBe(true);
    expect(s.log).toHaveLength(2);
    expect(lastLog(s)).toMatch(/^Atrial fibrillation for /);
    applyCommand(s, { ...src, inject: undefined, startAf: undefined }, command("start_arrhythmia", s.patients[1].id));
    expect(s.patients[1].irregular).toBe(false); // a source with no AF has no button
  });

  it("detach_patch then apply_patch: one request until the nurse has fitted it", () => {
    const { s, src } = ward();
    const p = s.patients.find((x) => x.patch)!;
    applyCommand(s, src, command("apply_patch", p.id));
    expect(s.tasks.some((t) => t.patient === p.id && t.kind === "apply_patch")).toBe(false); // already fitted
    applyCommand(s, src, command("detach_patch", p.id, { clinician_id: "rn-reyes" }));
    expect(p.patch).toBe(false);
    expect(s.log.map((l) => l.text)).toEqual([`Patch detached for ${p.name}`]);
    applyCommand(s, src, command("detach_patch", p.id));
    expect(s.log).toHaveLength(1); // nothing new: it was off
    applyCommand(s, src, command("apply_patch", p.id));
    applyCommand(s, src, command("apply_patch", p.id));
    expect(s.tasks.filter((t) => t.patient === p.id && t.kind === "apply_patch")).toHaveLength(1);
    for (let tick = 0; tick < 180 * 60 && !p.patch; tick += 1) step(s, src);
    expect(p.patch).toBe(true);
  });

  it("a nurse already on the way is not sent a second request", () => {
    const { s, src } = ward();
    const p = s.patients[0];
    applyCommand(s, src, command("detach_patch", p.id));
    applyCommand(s, src, command("apply_patch", p.id));
    for (let tick = 0; tick < 180 * 60 && !s.staff.some((m) => m.task?.patient === p.id && m.task.kind === "apply_patch"); tick += 1) step(s, src);
    expect(s.tasks.some((t) => t.patient === p.id && t.kind === "apply_patch")).toBe(false);
    const logged = s.log.length;
    applyCommand(s, src, command("apply_patch", p.id));
    expect(s.log).toHaveLength(logged);
    expect(s.tasks.some((t) => t.patient === p.id && t.kind === "apply_patch")).toBe(false);
  });

  it("a patient who is not on the ward is logged and skipped, never thrown", () => {
    const { s, src } = ward();
    const before = JSON.stringify({ ...s, log: [] });
    for (const kind of ["inject_deterioration", "start_arrhythmia", "detach_patch", "apply_patch"] as const) {
      expect(() => applyCommand(s, src, command(kind, "p-999"))).not.toThrow();
      expect(lastLog(s)).toBe(`Dr. Santos sent ${kind} for p-999, who is not on the ward`);
    }
    expect(() => applyCommand(s, src, command("apply_patch", null))).not.toThrow();
    expect(JSON.stringify({ ...s, log: [] })).toBe(before);
    expect(patientById(s, s.patients[0].id)).toBeDefined();
  });

  it("reset is left to the runner", () => {
    const { s, src } = ward();
    const before = JSON.stringify(s);
    applyCommand(s, src, command("reset", null));
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe("a new ward", () => {
  const minutes = (s: Sim, src: ReturnType<typeof ward>["src"], n: number) => {
    for (let tick = 0; tick < n * 60; tick += 1) step(s, src);
    return s.patients.map((p) => [p.id, p.held, p.injected]);
  };

  it("has its own source: a patient deteriorated in the old ward does not deteriorate again in it", () => {
    const old = freshWard(60);
    applyCommand(old.s, old.src, command("inject_deterioration", old.s.patients[0].id));
    minutes(old.s, old.src, 60);
    const fresh = freshWard(10);
    expect(fresh.s.speed).toBe(10);
    expect(fresh.src).not.toBe(old.src);
    fresh.s.speed = 60;
    const reference = freshWard(60);
    expect(minutes(fresh.s, fresh.src, 600)).toEqual(minutes(reference.s, reference.src, 600)); // as a ward nobody clicked on
  });
});

describe("sending a command from the viewer", () => {
  const reply = (status: number | Error) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const send = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (status instanceof Error) throw status;
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    return { calls, send };
  };

  it("posts the command with the clinician's token", async () => {
    const { calls, send } = reply(204);
    const body = { kind: "set_speed", patient_id: null, speed: 60 } as const;
    expect(await sendCommand("http://api", "tok", body, send)).toBe(204);
    expect(calls[0].url).toBe("http://api/wards/W4/sim/commands");
    expect(calls[0].init).toMatchObject({ method: "POST", headers: { Authorization: "Bearer tok", "Content-Type": "application/json" } });
    expect(JSON.parse(calls[0].init.body as string)).toEqual(body);
  });

  it("answers the status, and 0 when the API cannot be reached", async () => {
    const body = { kind: "reset", patient_id: null, speed: null } as const;
    for (const status of [401, 403, 404, 409]) expect(await sendCommand("http://api", "tok", body, reply(status).send)).toBe(status);
    expect(await sendCommand("http://api", "tok", body, reply(new Error("offline")).send)).toBe(0);
  });

  it("says why a command was not taken, in a few plain words", () => {
    expect(commandNotice(204)).toBeNull();
    expect(commandNotice(403)).toBe("Not sent: your role cannot control the ward");
    expect(commandNotice(404)).toBe("Not sent: no such ward or patient");
    expect(commandNotice(409)).toBe("Not sent: the ward is not live");
    expect(commandNotice(0)).toBe("Not sent: cannot reach the ward");
    expect(commandNotice(500)).toBe("Not sent: cannot reach the ward");
  });
});

describe("skip ahead", () => {
  const counted = (stopAfter = Infinity, hoursTaken = Infinity) => {
    const n = { tick: 0, minute: 0, hour: 0 };
    return { n, world: { tick: () => n.tick < stopAfter && ((n.tick += 1), true), minute: () => void (n.minute += 1), hour: async () => (n.hour += 1) <= hoursTaken } };
  };

  it("the four choices are the API's four, in ward minutes", () => {
    expect(SKIPS).toEqual([[60, "+1 h"], [360, "+6 h"], [720, "+12 h"], [1440, "+1 day"]]);
  });

  it("steps every ward second, publishes every ward minute and flushes every ward hour", async () => {
    for (const [minutes] of SKIPS) {
      const { n, world } = counted();
      expect(await skipAhead(minutes, world)).toBe(minutes * 60);
      expect(n).toEqual({ tick: minutes * 60, minute: minutes, hour: minutes / 60 });
    }
  });

  it("stops where the world can go no further, and still publishes and flushes what it stepped", async () => {
    const { n, world } = counted(3600 + 90); // an hour and a minute and a half, then the month is over
    expect(await skipAhead(1440, world)).toBe(3690);
    expect(n).toEqual({ tick: 3690, minute: 62, hour: 2 });
    const none = counted(0);
    expect(await skipAhead(60, none.world)).toBe(0);
    expect(none.n).toEqual({ tick: 0, minute: 0, hour: 0 }); // nothing stepped, nothing sent
  });

  it("an hour the API did not take stops the skip there: nothing more is stepped", async () => {
    const { n, world } = counted(Infinity, 2); // the third hour's flush is not taken
    expect(await skipAhead(1440, world)).toBe(3 * 3600);
    expect(n).toEqual({ tick: 3 * 3600, minute: 180, hour: 3 });
    // The rule: the whole queue was taken at this very minute, and little is queued.
    expect(skipMayGoOn(120, 120, 0)).toBe(true);
    expect(skipMayGoOn(120, 120, SKIP_QUEUE_MARK)).toBe(true);
    expect(skipMayGoOn(120, 120, SKIP_QUEUE_MARK + 1)).toBe(false);
    expect(skipMayGoOn(60, 120, 0)).toBe(false); // the last batch the API took was an hour ago
    expect(skipMayGoOn(null, 120, 0)).toBe(false); // nothing acknowledged yet
    expect(SKIP_QUEUE_MARK).toBeLessThan(50_000); // below what the sync keeps (MAX_QUEUED)
    expect(readFileSync("src/sim/sync.ts", "utf8")).toContain("const MAX_QUEUED = 50_000;");
  });

  it("the API goes down during a 1 day skip: the skip stops after the hour it did not take, and no row is dropped", async () => {
    let down = false;
    const f = (async (url: string, init?: RequestInit) => {
      if (down) throw new Error("offline");
      if (init?.method !== "POST") return new Response("{}", { status: 200 });
      return url.endsWith("/sim/runs") ? new Response('{"run_id":7}', { status: 201 }) : new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const run = async (minutes: number, goesDown: boolean) => {
      const { s, src } = freshWard(10);
      const sync = createSync({ apiUrl: "http://api", key: "k", clientId: "t", fetch: f });
      down = false;
      await sync.start(s, src);
      down = goesDown;
      const stepped = await skipAhead(minutes, {
        tick: () => (stepOneSecond(s, src), true),
        minute: () => {},
        hour: async () => {
          await sync.flush();
          const out = s.outbox!;
          return skipMayGoOn(sync.acked.minute, minuteOf(s), Math.max(out.observations.length, out.bins.length, out.events.length));
        },
      });
      return { stepped, s, sync };
    };
    const lost = await run(1440, true);
    expect(lost.stepped).toBe(3600); // one hour, then it stops: 23 hours are not stepped
    expect(lost.sync.dropped).toBe(0); // nothing trimmed
    expect(lost.s.outbox!.observations.length).toBeGreaterThan(0); // the hour is still queued, for when the API is back
    expect(lost.s.outbox!.observations.length).toBeLessThan(SKIP_QUEUE_MARK);
    expect(lost.sync.stopped).toBeNull(); // the run itself goes on
    // With the API up, the same rule lets a skip run whole and leaves nothing queued.
    const fine = await run(180, false);
    expect(fine.stepped).toBe(180 * 60);
    expect([fine.s.outbox!.observations.length, fine.sync.dropped, fine.sync.acked.minute]).toEqual([0, 0, minuteOf(fine.s)]);
  });

  it("one ward second sets the speed back even when the step throws", () => {
    const { s, src } = freshWard(10);
    Object.defineProperty(s, "patients", { get: () => { throw new Error("boom"); } });
    expect(() => stepOneSecond(s, src)).toThrow("boom");
    expect(s.speed).toBe(10); // a live run is never left at 60x
    const paused = freshWard(10);
    paused.s.speed = 0;
    const before = paused.s.clockS;
    stepOneSecond(paused.s, paused.src);
    expect([paused.s.speed, paused.s.clockS - before]).toEqual([0, 1]); // a paused ward is stepped too, and stays paused
  });

  it("with the runner's tick, a ward at 10x ends where an hour at 60x ends, and its speed is never changed", async () => {
    const a = freshWard(10);
    const speeds = new Set<number>();
    await skipAhead(60, {
      tick: () => (stepOneSecond(a.s, a.src), true),
      minute: () => void speeds.add(a.s.speed),
      hour: async () => (speeds.add(a.s.speed), true),
    });
    const b = freshWard(60);
    for (let tick = 0; tick < 3600; tick += 1) step(b.s, b.src);
    b.s.speed = 10;
    expect([...speeds]).toEqual([10]);
    expect(JSON.stringify(a.s)).toBe(JSON.stringify(b.s));
  });

  it("applyCommand leaves a skip to the runner, as it leaves a reset", () => {
    const { s, src } = ward();
    const before = JSON.stringify(s);
    applyCommand(s, src, command("skip", null, { minutes: 1440 }));
    expect(JSON.stringify(s)).toBe(before);
  });

  it("the page sends minutes with a skip, and says so when the API holds an earlier skip", async () => {
    const calls: RequestInit[] = [];
    const send = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(JSON.stringify({ detail: "An earlier skip has not been picked up by the simulation yet" }), { status: 409 });
    }) as unknown as typeof fetch;
    let detail = "";
    expect(await sendCommand("http://api", "tok", { kind: "skip", patient_id: null, speed: null, minutes: 360 }, send, (d) => (detail = d))).toBe(409);
    expect(JSON.parse(calls[0].body as string)).toEqual({ kind: "skip", patient_id: null, speed: null, minutes: 360 });
    expect(commandNotice(409, detail)).toBe("A skip is still being applied");
    expect(commandNotice(409, "The ward is not receiving data")).toBe("Not sent: the ward is not live"); // the other 409 keeps its line
    expect(commandNotice(403, detail)).toBe("Not sent: your role cannot control the ward");
  });

  it("the runner reads the feed again only after every command was applied, and does not tick while it skips", () => {
    const runner = readFileSync("src/headless.ts", "utf8");
    expect(runner).toMatch(/if \(applying\) return;\n  applying = true;\n  try \{\n    for \(const c of await sync\.pullCommands\(\)\)/);
    expect(runner).toContain('else if (c.kind === "skip") await skip(c.minutes ?? 0, c.clinician_id);');
    expect(runner).toContain("if (skipping) return; // the skip steps, publishes and flushes on its own");
    expect(runner.match(/sync\.pullCommands\(/g)).toHaveLength(1); // the one reader of the feed
    // A month that ends inside the skip stops it and is turned as always.
    expect(runner).toContain("if (s.ended || (hospital && month.due(s))) return false;");
    expect(runner).toMatch(/return false;\n      \},\n    \}\);\n    if \(hospital && month\.due\(s\)\) \{\n      await month\.turn\(\{ s, src \}, swap\);/);
    // Every step of a skip goes through the one function that sets the speed back, and every hour through the stop rule.
    expect(runner).toContain("stepOneSecond(s, src);");
    expect(runner).not.toMatch(/s\.speed = 60/);
    expect(runner).toMatch(/hour: async \(\) => \{\n        await flush\(\);/);
    expect(runner).toContain("if (skipMayGoOn(sync.acked.minute, minuteOf(s), queued)) return true;");
  });
});
