import { describe, expect, it } from "vitest";
import { duration } from "../panels";
import { createSim, flowStats, skipDay, step } from "./sim";
import { createSync } from "./sync";
import { createSyntheticSource, FIXTURE_SEED } from "./source";

const ward = () => {
  const src = createSyntheticSource(FIXTURE_SEED, true);
  return { src, s: createSim(src) };
};

describe("patient stays", () => {
  it("opens a stay for everyone already on the ward, arrival unknown", () => {
    const { s } = ward();
    expect(s.stays).toHaveLength(s.patients.length);
    expect(s.stays.every((x) => x.inMin === 0 && x.outMin === null)).toBe(true);
    expect(flowStats(s).averageStayMin).toBeNull();
  });

  it("keeps stays consistent as patients come and go", () => {
    const { s, src } = ward();
    for (let day = 0; day < 10; day += 1) skipDay(s, src);
    expect(s.flow.admitted).toBeGreaterThan(0);
    expect(s.stays.filter((x) => x.outMin !== null)).toHaveLength(s.flow.discharged + s.flow.transferred);
    const open = s.stays.filter((x) => x.outMin === null);
    expect(open.map((x) => x.id).sort()).toEqual(s.patients.map((p) => p.id).sort());
    expect(new Set(open.map((x) => x.bed)).size).toBe(open.length); // one patient per bed
    for (const x of s.stays) {
      if (x.outMin !== null) {
        expect(x.outMin).toBeGreaterThanOrEqual(x.inMin);
        expect(["discharged", "higher_care"]).toContain(x.outcome);
      }
    }
    expect(s.stays.some((x) => x.peak !== null && x.scores.length > 0)).toBe(true);
    expect(flowStats(s).averageStayMin).toBeGreaterThan(0);
    expect(s.moves).toHaveLength(0);
  }, 120_000);

  it("does not skip on a ward without patient flow", () => {
    const src = createSyntheticSource(FIXTURE_SEED);
    const s = createSim(src);
    skipDay(s, src);
    expect(s.clockS).toBe(0);
    step(s, src);
    expect(s.stays).toHaveLength(s.patients.length);
  });

  it("sends each move to the database once, and keeps it until it is accepted", async () => {
    const { s, src } = ward();
    const batches: { admissions: { id: string; minute: number; bins: unknown[] }[]; departures: { patient_id: string; outcome: string }[] }[] = [];
    let up = false;
    const fake = (async (url: string, init: { body: string }) => {
      if (!up) return new Response("", { status: 500 }); // an outage is retried; a 503 at registration means the key was refused
      if (url.endsWith("/sim/runs")) return Response.json({ run_id: 1 });
      batches.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const sync = createSync({ apiUrl: "http://api", key: "k", clientId: "stays-test", fetch: fake });
    await sync.start(s, src);
    for (let day = 0; day < 8; day += 1) skipDay(s, src);
    await sync.flush(); // refused: nothing lost
    expect(batches).toHaveLength(0);
    up = true;
    await sync.flush();
    const admitted = batches.flatMap((b) => b.admissions);
    const departed = batches.flatMap((b) => b.departures);
    expect(admitted.map((a) => a.id).sort()).toEqual(s.stays.filter((x) => x.inMin > 0).map((x) => x.id).sort());
    expect(departed.map((d) => d.patient_id).sort()).toEqual(s.stays.filter((x) => x.outMin !== null).map((x) => x.id).sort());
    expect(admitted.length).toBeGreaterThan(0);
    expect(admitted[0].bins.length).toBeGreaterThan(0);
    await sync.flush();
    expect(batches.flatMap((b) => b.admissions)).toHaveLength(admitted.length);
  }, 120_000);

  it("writes durations plainly", () => {
    expect(duration(12)).toBe("12m");
    expect(duration(185)).toBe("3h 5m");
    expect(duration(1440 * 5 + 180)).toBe("5d 3h");
  });
});
