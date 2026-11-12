import { describe, expect, it } from "vitest";
import { createSim, minuteOf, record, setSpeed, step, type Sim } from "./sim";
import { createSyntheticSource, FIXTURE_SEED } from "./source";

const DAYS = 5;
const TICKS = DAYS * 1440 * 60; // at 60x one tick is one sim second

// The value changes only in a commit of its own, with the reason in the message: it moves when
// anything in the ward's seeded behaviour moves.
const FLOW = { admitted: 9, everOnOxygen: 4, discharged: 10, transferred: 0, turnedAway: 0, lastMinute: 7200 };
const COUNTS = { received: 56064, rejected: 7310, abstained: 1640 };
// Limit: one seed over five days. A fitted constant moved by a percent or two can leave every draw of this seed
// unchanged and pass here; those constants are guarded by published.test.ts and are never edited on judgement.
// 2026-11-12: temperature rise removed, see README sources.
const GOLDEN = "8749072d";

// FNV-1a 32-bit, written out so the test stays pure (no node:crypto).
const OFFSET = 0x811c9dc5;
const mix = (h: number, text: string) => {
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h;
};
const hex = (h: number) => (h >>> 0).toString(16).padStart(8, "0");

// What W4 would send the API, as integers (no names, no log text). Folded into the running hash and
// emptied every simulated hour, as a flush would, so memory stays flat.
function fold(h: number, out: NonNullable<Sim["outbox"]>) {
  const row = (...cells: (string | number | null | undefined)[]) => cells.map((c) => c ?? "").join("|");
  h = mix(h, `o${out.observations.length}`);
  for (const o of out.observations) {
    const num = o.num === undefined ? "" : o.code === "temperature" ? Math.round(o.num * 10) : o.num;
    h = mix(h, row(o.patient_id, o.code, o.minute, o.source, o.quality, num, o.num2, o.txt ?? o.absent_reason));
  }
  h = mix(h, `b${out.bins.length}`);
  for (const b of out.bins) h = mix(h, row(b.patient_id, b.vital, b.minute, b.value === null ? -1 : Math.round(b.value * 10)));
  h = mix(h, `a${out.admissions.length}`);
  for (const a of out.admissions) h = mix(h, row(a.id, a.minute));
  h = mix(h, `d${out.departures.length}`);
  for (const d of out.departures) h = mix(h, row(d.patient_id, d.minute, d.outcome));
  h = mix(h, `e${out.events.length}`);
  for (const e of out.events) h = mix(h, row(e.minute));
  for (const rows of [out.observations, out.bins, out.admissions, out.departures, out.events]) rows.length = 0;
  return h;
}

// Integer facts only, so a last-digit float difference between macOS and Linux cannot change it.
function runWard(seed: number) {
  const src = createSyntheticSource(seed, true);
  const s = createSim(src);
  setSpeed(s, 60);
  // As register() in sync.ts: without an outbox everything sent to the API would be unguarded.
  s.outbox = { observations: [], bins: [], events: [], admissions: [], departures: [], sent: new Map() };
  for (const p of s.patients) record(s, p, 0);
  let sent = fold(OFFSET, s.outbox);
  for (let i = 1; i <= TICKS; i += 1) {
    step(s, src);
    if (i % 3600 === 0) sent = fold(sent, s.outbox);
  }
  const flow = Object.fromEntries(
    ["admitted", "everOnOxygen", "discharged", "transferred", "turnedAway", "lastMinute"].map((k) => [k, s.flow[k as keyof Sim["flow"]]]),
  );
  const counts = { received: s.counts.received, rejected: s.counts.rejected, abstained: s.counts.abstained };
  const facts = {
    stays: s.stays.map((x) => [x.id, x.bed, x.inMin, x.outMin ?? -1, x.outcome ?? ""]),
    flow,
    counts,
    minute: minuteOf(s),
    patients: s.patients.map((p) => [
      p.id,
      p.bed,
      p.rank ?? -1,
      p.decision.kind === "ranked" ? p.decision.news2.total : -1,
    ]),
  };
  return { flow, counts, minute: minuteOf(s), hash: hex(mix(sent, JSON.stringify(facts))) };
}

describe("ward W4 golden run", () => {
  it("keeps its seeded behaviour", () => {
    const { flow, counts, minute, hash } = runWard(FIXTURE_SEED);
    expect(minute).toBe(DAYS * 1440);
    expect(flow).toEqual(FLOW);
    expect(counts).toEqual(COUNTS);
    expect(hash).toBe(GOLDEN);
  }, 120_000);

  it("gives the same hash twice in one process", () => {
    expect(runWard(FIXTURE_SEED).hash).toBe(runWard(FIXTURE_SEED).hash);
  }, 120_000);

  it("gives a different hash for a different seed", () => {
    expect(runWard(FIXTURE_SEED + 1).hash).not.toBe(GOLDEN);
  }, 120_000);
});
