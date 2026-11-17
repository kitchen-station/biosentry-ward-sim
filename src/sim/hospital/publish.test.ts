// The hospital's other units go to the API as patients (hospital-contract v1). The engine stays display only.
import { describe, expect, it } from "vitest";
import { loadWard, saveWard } from "../persist";
import { injectDeterioration, step, type Sim } from "../sim";
import type { VitalsSource } from "../source";
import { createSync } from "../sync";
import { freshHospital } from "./fresh";
import { publishHospital } from "./publish";
import { UNIT_STAFF } from "./staff";
import { createVitals, feedVitals, type HospitalVitals } from "./vitals";

const RUN = { runId: null, origin: "", cursor: 0, commandCursor: 0 };
type Body = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function fake() {
  const posts: { path: string; body: Body }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const path = url.replace("http://api", "");
    if (init.method !== "POST") return new Response("{}", { status: 200 });
    posts.push({ path, body: JSON.parse(init.body as string) });
    return path === "/sim/runs" ? new Response('{"run_id":7}', { status: 201 }) : new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return { posts, sync: createSync({ apiUrl: "http://api", key: "k", clientId: "t", fetch: f }) };
}

/** What the runner does each interval at 60x: 60 steps (one sim minute), the engine after each, then publish. */
function minutes(s: Sim, src: VitalsSource, v: HospitalVitals | null, n: number) {
  for (let m = 0; m < n; m += 1) {
    for (let t = 0; t < 60; t += 1) { step(s, src); if (v) feedVitals(v, s.hospital!, s.clockS); }
    if (v) publishHospital(s, v);
  }
}
const withoutQueue = (s: Sim, src: VitalsSource) => { const o = JSON.parse(saveWard(s, src, RUN)); delete o.outbox; return o; };

let memo: ReturnType<typeof runDay> | undefined;
async function runDay() {
  const a = freshHospital(60);
  const b = freshHospital(60);
  const { sync, posts } = fake();
  await sync.start(b.s, b.src);
  const v = createVitals();
  for (let hour = 0; hour < 24; hour += 1) {
    minutes(a.s, a.src, null, 60);
    minutes(b.s, b.src, v, 60);
    await sync.flush();
  }
  return { a, b, v, posts };
}
const day = () => (memo ??= runDay());
const batches = (posts: { path: string; body: Body }[]) => posts.filter((p) => p.path.endsWith("/batch")).map((p) => p.body);

describe("the other units, published", () => {
  it("one seeded day with the engine and the publisher and without them gives the same hospital and saved state, apart from the queue", async () => {
    const { a, b } = await day();
    expect(withoutQueue(b.s, b.src)).toEqual(withoutQueue(a.s, a.src));
    expect(b.s.hospital).toEqual(a.s.hospital);
  }, 300_000);

  it("every stay has its own id, a unit, a person, one of that unit's two staff nurses and its physician; rows follow their admission; beds are free when taken", async () => {
    const { posts } = await day();
    const adm = batches(posts).flatMap((x) => x.admissions ?? []);
    const other = adm.filter((a: Body) => a.unit);
    expect(other.length).toBeGreaterThan(100); // the ER's residents at the start and a day of arrivals
    expect(new Set(adm.map((a: Body) => a.id)).size).toBe(adm.length);
    expect(new Set(other.map((a: Body) => a.unit))).toContain("ER");
    for (const a of other) {
      expect(a.person).toMatch(/^h-/);
      const staff = UNIT_STAFF[a.unit];
      expect(staff.nurses.map((n) => n[0])).toContain(a.rn); // never the charge nurse: the API adds that one itself
      expect(a.md).toBe(staff.md[0]);
    }
    // The two nurses take turns: over a day in the emergency room neither has more than two thirds of the arrivals.
    const er = other.filter((a: Body) => a.unit === "ER");
    const first = er.filter((a: Body) => a.rn === UNIT_STAFF.ER.nurses[0][0]).length;
    expect(first / er.length).toBeGreaterThan(1 / 3);
    expect(first / er.length).toBeLessThan(2 / 3);
    // Rows come after their admission, in the order sent.
    const known = new Set<string>(posts[0].body.patients.map((p: Body) => p.id));
    for (const x of batches(posts)) {
      for (const a of x.admissions ?? []) known.add(a.id);
      for (const o of x.observations ?? []) expect(known.has(o.patient_id)).toBe(true);
      for (const o of x.bins ?? []) expect(known.has(o.patient_id)).toBe(true);
    }
    // A bed is held by one stay at a time in a unit.
    const open = new Map<string, string>();
    for (const x of batches(posts)) {
      for (const d of x.departures ?? []) for (const [k, id] of open) if (id === d.patient_id) open.delete(k);
      for (const a of x.admissions ?? []) {
        const key = `${a.unit ?? "W4"}/${a.bed}`;
        if (a.unit) expect(open.has(key)).toBe(false);
        open.set(key, a.id);
      }
    }
  }, 300_000);

  it("a move is the old stay ending 'transferred' to the new unit, then a new stay of the same person there", async () => {
    const { posts } = await day();
    const all = batches(posts);
    const adm = all.flatMap((x) => x.admissions ?? []);
    const dep = all.flatMap((x) => x.departures ?? []);
    const moves = dep.filter((d: Body) => d.outcome === "transferred" && adm.some((a: Body) => a.id === d.patient_id)); // a published stay ending in a move
    expect(moves.length).toBeGreaterThan(0);
    for (const d of moves) {
      const from = adm.find((a: Body) => a.id === d.patient_id)!;
      // into W4 the other half is the ward's own admission, which names no unit
      expect(adm.some((a: Body) => a.person === from.person && a.id !== from.id && (d.to_unit === "W4" ? !a.unit : a.unit === d.to_unit))).toBe(true);
    }
    for (const d of dep) expect(["discharged", "transferred", "died"]).toContain(d.outcome);
  }, 300_000);

  it("a restart from a saved state with the queue publishes no stay twice", async () => {
    const w = freshHospital(60);
    const one = fake();
    await one.sync.start(w.s, w.src);
    const v = createVitals();
    minutes(w.s, w.src, v, 8 * 60);
    await one.sync.flush();
    const before = new Set(batches(one.posts).flatMap((x) => (x.admissions ?? []).map((a: Body) => a.id)));
    expect(before.size).toBeGreaterThan(50);
    const loaded = loadWard(saveWard(w.s, w.src, RUN));
    const v2 = createVitals(); // the engine is not saved
    const again = fake();
    await again.sync.resume(loaded.s, loaded.src, { ...loaded.run, runId: 7 });
    minutes(loaded.s, loaded.src, v2, 4 * 60);
    await again.sync.flush();
    const after = batches(again.posts).flatMap((x) => x.admissions ?? []);
    for (const a of after) expect(before.has(a.id)).toBe(false);
  }, 300_000);

  it("a person who came from the ER to W4 and leaves it after a restart gets a new stay id, not the ER stay's", async () => {
    const w = freshHospital(60, "pitch"); // the pitch ward, which this test was written on: in the typical default this patient is not moved to the ICU inside the 6 hours below
    const one = fake();
    await one.sync.start(w.s, w.src);
    const v = createVitals();
    let person: string | undefined;
    for (let h = 0; h < 72 && !person; h += 1) {
      minutes(w.s, w.src, v, 60);
      person = Object.entries(w.s.outbox!.stays ?? {}).find(([, r]) => r.id === null && r.k >= 1)?.[0]; // an ER stay, then W4
    }
    expect(person).toBeDefined();
    await one.sync.flush();
    const before = new Set(batches(one.posts).flatMap((x) => (x.admissions ?? []).map((a: Body) => a.id)));
    const k = w.s.outbox!.stays![person!].k;
    const loaded = loadWard(saveWard(w.s, w.src, RUN));
    const again = fake();
    await again.sync.resume(loaded.s, loaded.src, { ...loaded.run, runId: 7 });
    const v2 = createVitals(); // a new engine opens no stream for a person on W4
    minutes(loaded.s, loaded.src, v2, 3);
    expect(loaded.s.outbox!.stays![person!]).toMatchObject({ id: null, unit: "W4", k }); // the record and its counter are kept
    // Now they are sent up to the ICU.
    const q = loaded.s.hospital!.people.find((x) => x.id === person)!;
    const patient = loaded.s.patients.find((x) => x.id === q.w4Id)!;
    injectDeterioration(loaded.s, loaded.src, patient.id);
    patient.dueMin = -48 * 60;
    loaded.s.tasks = [];
    for (let m = 0; m < 6 * 60 && loaded.s.patients.includes(patient); m += 1) minutes(loaded.s, loaded.src, v2, 1);
    await again.sync.flush();
    const adm = batches(again.posts).flatMap((x) => x.admissions ?? []).filter((a: Body) => a.person === person);
    expect(adm.length).toBeGreaterThan(0); // the ICU stay
    for (const a of adm) expect(before.has(a.id)).toBe(false);
  }, 300_000);

  it("a stay's rows are not sent before its admission, when a batch cuts the admissions", async () => {
    const w = freshHospital(60);
    const { sync, posts } = fake();
    await sync.start(w.s, w.src);
    const out = w.s.outbox!;
    const row = (i: number) => ({ ...out.admissions[0] ?? posts[0].body.patients[0], id: `x-${i}`, minute: 1 });
    for (let i = 0; i < 250; i += 1) out.admissions.push(row(i));
    for (const i of [0, 249]) out.observations.push({ patient_id: `x-${i}`, code: "heart_rate", minute: 1, source: "device", quality: "ok", num: 70 });
    await sync.flush();
    const sent = batches(posts);
    const at = (id: string) => sent.findIndex((x) => (x.admissions ?? []).some((a: Body) => a.id === id));
    const obsAt = (id: string) => sent.findIndex((x) => (x.observations ?? []).some((o: Body) => o.patient_id === id));
    expect(at("x-249")).toBeGreaterThan(at("x-0")); // the batch size really cut them
    expect(obsAt("x-0")).toBeGreaterThanOrEqual(at("x-0"));
    expect(obsAt("x-249")).toBeGreaterThanOrEqual(at("x-249"));
  }, 300_000);
});
