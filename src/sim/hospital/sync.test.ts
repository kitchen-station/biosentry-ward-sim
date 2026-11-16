// A hospital run writes to the API: ward W4 and its moves, in a run that lists every unit (hospital-contract v1, sections 2 and 3).
import { describe, expect, it } from "vitest";
import typical from "../../../scenarios/hospital/typical.json?raw";
import { applyAction, type Action } from "../actions";
import { BEDS } from "../map";
import { loadWard, saveWard } from "../persist";
import { createSim, setSpeed, step, type Outbox, type Sim } from "../sim";
import { createSyntheticSource, type VitalsSource } from "../source";
import { createSync } from "../sync";
import { createHospitalSim } from "./attach";
import { freshHospital } from "./fresh";
import { parseScenario } from "./scenario";

const TYPICAL = parseScenario(typical);
const RUN = { runId: null, origin: "", cursor: 0, commandCursor: 0 };
const HOLD_MIN = 48 * 60;

/** A fetch that records every POST body and answers like the API. */
function fake() {
  const posts: { path: string; body: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const f = (async (url: string, init: RequestInit) => {
    const path = url.replace("http://api", "");
    if (init.method !== "POST") return new Response("{}", { status: 200 });
    posts.push({ path, body: JSON.parse(init.body as string) });
    return path === "/sim/runs" ? new Response('{"run_id":7}', { status: 201 }) : new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return { posts, sync: createSync({ apiUrl: "http://api", key: "k", clientId: "t", fetch: f }) };
}

const withoutQueue = (s: Sim, src: VitalsSource) => {
  const o = JSON.parse(saveWard(s, src, RUN));
  delete o.outbox;
  return o;
};

// One seeded day, with and without the sync. It is the longest thing here, so it runs once.
let dayRun: ReturnType<typeof runDay> | undefined;
async function runDay() {
  const a = freshHospital(60);
  const b = freshHospital(60);
  const { sync, posts } = fake();
  await sync.start(b.s, b.src);
  for (let hour = 0; hour < 24; hour += 1) {
    for (let t = 0; t < 3600; t += 1) { step(a.s, a.src); step(b.s, b.src); } // 60x: one step is one sim second
    await sync.flush();
  }
  return { a, b, posts };
}
const day = () => (dayRun ??= runDay());

describe("a hospital run that writes to the API", () => {
  it("one seeded day with the sync and without it gives the same hospital and the same saved state, apart from the queue", async () => {
    const { a, b, posts } = await day();
    expect(withoutQueue(b.s, b.src)).toEqual(withoutQueue(a.s, a.src));
    expect(b.s.hospital).toEqual(a.s.hospital);
    expect(posts.filter((p) => p.path.endsWith("/batch")).length).toBeGreaterThan(20); // it really sent
  }, 300_000);

  it("a restart from a state saved with the queue continues exactly as an uninterrupted synced run", async () => {
    const a = freshHospital(60);
    const b = freshHospital(60);
    await fake().sync.start(a.s, a.src);
    await fake().sync.start(b.s, b.src);
    for (let i = 0; i < 5 * 3600 + 17; i += 1) { step(a.s, a.src); step(b.s, b.src); }
    const loaded = loadWard(saveWard(b.s, b.src, RUN));
    expect(loaded.s.outbox).toBeDefined();
    for (let i = 0; i < 3600; i += 1) { step(a.s, a.src); step(loaded.s, loaded.src); }
    expect(withoutQueue(loaded.s, loaded.src)).toEqual(withoutQueue(a.s, a.src));
  }, 300_000);

  it("registers every unit but the morgue, W4 first, and gives each W4 patient the hospital person", async () => {
    const { s, src } = freshHospital(60);
    const { sync, posts } = fake();
    await sync.start(s, src);
    const body = posts[0].body;
    expect(posts[0].path).toBe("/sim/runs");
    expect(body.units).toEqual([
      { id: "W4", name: "Ward W4", floor: 4, kind: "ranked" },
      { id: "ER", name: "Emergency Room", floor: 0, kind: "shown" },
      { id: "ICU", name: "Intensive Care", floor: 2, kind: "unranked" },
      { id: "MED3A", name: "Medicine 3A", floor: 3, kind: "ranked" },
      { id: "MED3B", name: "Medicine 3B", floor: 1, kind: "ranked" },
      { id: "SURG5A", name: "Surgery 5A", floor: 5, kind: "ranked" },
    ]);
    expect(body.patients).toHaveLength(12);
    for (const p of body.patients) {
      expect(p.person).toBe(s.hospital!.people.find((x) => x.w4Id === p.id)!.id);
      expect(p.unit).toBeUndefined(); // no unit means the home unit, W4
    }
  });

  it("a ward-only run registers no units and no persons, as before", async () => {
    const src = createSyntheticSource(101, true);
    const s = createSim(src);
    const { sync, posts } = fake();
    await sync.start(s, src);
    expect(posts[0].body.units).toBeUndefined();
    expect(JSON.stringify(posts[0].body)).not.toContain('"person"');
  });

  it("sends a W4 move to the ICU as 'transferred' with to_unit ICU, and a discharge as before", () => {
    const scenario = { ...TYPICAL, startOccupancy: 0.5, units: { ...TYPICAL.units, ICU: { ...TYPICAL.units.ICU, beds: 2 } } };
    const src = createSyntheticSource(101, true);
    const s = createHospitalSim(src, scenario, 101);
    setSpeed(s, 60);
    s.outbox = { observations: [], bins: [], events: [], admissions: [], departures: [], sent: new Map() } satisfies Outbox;
    const [sick, well] = [s.patients[0], s.patients.find((p) => p.decision.kind === "ranked" && p.decision.news2.total < 5)!]; // NEWS2 9 at the start
    sick.dueMin = -HOLD_MIN;
    well.dueMin = 0;
    s.tasks = [];
    for (let i = 0; i < 120 * 60 && s.outbox!.departures.length < 2; i += 1) step(s, src);
    const out = s.outbox!.departures;
    expect(out.find((d) => d.patient_id === sick.id)).toMatchObject({ outcome: "transferred", to_unit: "ICU" });
    expect(out.find((d) => d.patient_id === well.id)).toEqual({ patient_id: well.id, minute: expect.any(Number), outcome: "discharged" });
    expect(sick.stay.outcome).toBe("higher_care"); // the hospital and the stay history keep the ward's own word
  });

  it("every admission of the day carries the hospital person, and no departure uses the old word for a move", async () => {
    const { b, posts } = await day();
    const batches = posts.filter((p) => p.path.endsWith("/batch")).map((p) => p.body);
    const admissions = batches.flatMap((x) => x.admissions ?? []);
    const people = new Set([...b.s.hospital!.people, ...b.s.hospital!.gone].map((p) => p.id));
    expect(admissions.length).toBeGreaterThan(0);
    for (const a of admissions) expect(people.has(a.person)).toBe(true);
    for (const d of batches.flatMap((x) => x.departures ?? [])) {
      expect(["discharged", "transferred"]).toContain(d.outcome);
      expect(d.to_unit === undefined).toBe(d.outcome !== "transferred");
    }
  }, 300_000);

  it("an admission asked for another unit is not placed on W4; one for W4 or no unit is", () => {
    const { s, src } = freshHospital(60);
    const taken = new Set(s.patients.map((p) => p.bed));
    const bed = BEDS.find((b) => !taken.has(b.label))!.label;
    const base = { seq: 1, kind: "admit_patient", patient_id: "p-new", clinician_id: "md-santos", score: null, systolic: null, diastolic: null, acvpu: null, on_oxygen: null, spo2_scale: null, name: "Test Person", age: 50, sex: "F", bed, context: "x" } as Action;
    applyAction(s, src, { ...base, unit: "ER" });
    expect(s.patients.some((p) => p.id === "p-new")).toBe(false);
    expect(s.log.at(-1)!.text).toMatch(/not placed, only W4/);
    applyAction(s, src, { ...base, unit: null });
    expect(s.patients.some((p) => p.id === "p-new")).toBe(true);
  });
});
