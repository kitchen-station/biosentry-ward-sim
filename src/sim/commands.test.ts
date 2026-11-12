import { describe, expect, it } from "vitest";
import { applyCommand, commandNotice, sendCommand, type Command } from "./commands";
import { createSim, patientById, step } from "./sim";
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
const lastLog = (s: ReturnType<typeof ward>["s"]) => s.log.at(-1)!.text;

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

  it("inject_deterioration and start_arrhythmia: start once, as the buttons do", () => {
    const { s, src } = ward();
    const p = s.patients[0];
    applyCommand(s, src, command("inject_deterioration", p.id));
    expect([p.injected, lastLog(s)]).toEqual([true, `Deterioration started for ${p.name}`]);
    expect(s.log.at(-2)!.text).toBe(`Dr. Santos started deterioration for ${p.name}`);
    const logged = s.log.length;
    applyCommand(s, src, command("inject_deterioration", p.id));
    expect(s.log).toHaveLength(logged); // already deteriorating: the button is off
    applyCommand(s, src, command("start_arrhythmia", p.id));
    expect(p.irregular).toBe(true);
    expect(s.log.at(-2)!.text).toBe(`Dr. Santos started atrial fibrillation for ${p.name}`);
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
    expect(s.log.at(-2)!.text).toBe(`Reyes detached the patch for ${p.name}`);
    applyCommand(s, src, command("detach_patch", p.id));
    expect(lastLog(s)).toBe(`Patch detached for ${p.name}`); // nothing new: it was off
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
