import { describe, expect, it } from "vitest";
import { loadWard, saveWard } from "./persist";
import { createSim, record, step, type Sim } from "./sim";
import { createSyntheticSource, FIXTURE_SEED, type VitalsSource } from "./source";

const RUN = { runId: 7, origin: "2026-11-11T00:00:00.000Z", cursor: 4 };
const TICKS_PER_DAY = 1440 * 60; // at 60x, one tick is one sim second

function ward() {
  const src = createSyntheticSource(FIXTURE_SEED, true);
  const s = createSim(src);
  s.outbox = { observations: [], bins: [], events: [], admissions: [], departures: [], sent: new Map() };
  for (const p of s.patients) record(s, p, 0);
  return { s, src };
}
const run = (s: Sim, src: VitalsSource, ticks: number) => {
  for (let i = 0; i < ticks; i += 1) step(s, src);
};
const plain = (s: Sim) => JSON.parse(JSON.stringify({ ...s, outbox: s.outbox && { ...s.outbox, sent: [...s.outbox.sent] } }));

describe("a saved ward", () => {
  it("continues exactly as the ward that was never stopped", () => {
    const a = ward();
    run(a.s, a.src, 3 * TICKS_PER_DAY);
    const text = saveWard(a.s, a.src, RUN);
    const b = loadWard(text);
    expect(b.run).toEqual(RUN);
    expect(b.s.flow.admitted).toBeGreaterThan(0); // patients have come and gone before the save
    expect(b.s.flow.discharged).toBeGreaterThan(0);
    for (const p of b.s.patients) expect(b.s.stays).toContain(p.stay); // one object again, not a copy
    a.s.outbox!.observations.length = 0;
    expect(saveWard(a.s, a.src, RUN).length).toBeLessThan(1_000_000); // with the queue sent, as the runner saves it

    for (const w of [a, b]) {
      w.s.outbox!.observations.length = 0; // as after a flush: only what the next days queue is compared
      w.s.outbox!.bins.length = 0;
      run(w.s, w.src, 2 * TICKS_PER_DAY);
    }
    // sent holds departed patients on the uninterrupted side only: a save drops them.
    const here = new Set(b.s.patients.map((p) => p.id));
    const sent = (s: Sim) => [...s.outbox!.sent].filter(([key]) => here.has(key.split("/")[0])).sort();
    expect(sent(b.s)).toEqual(sent(a.s));
    a.s.outbox!.sent = b.s.outbox!.sent = new Map();
    expect(plain(b.s)).toEqual(plain(a.s));
    expect(b.s.flow.admitted).toBeGreaterThan(loadWard(text).s.flow.admitted); // and the days after held admissions
  }, 120_000);

  it("reads a ward saved before the action cursor existed as cursor 0", () => {
    const { s, src } = ward();
    const saved = JSON.parse(saveWard(s, src, RUN));
    delete saved.run.cursor;
    expect(loadWard(JSON.stringify(saved)).run).toEqual({ ...RUN, cursor: 0 });
  });

  it("refuses text it cannot continue from", () => {
    expect(() => loadWard("{")).toThrow(/not valid JSON/);
    expect(() => loadWard('{"version":2}')).toThrow(/version 2/);
    const { s, src } = ward();
    const saved = JSON.parse(saveWard(s, src, RUN));
    saved.sim.stays = [];
    expect(() => loadWard(JSON.stringify(saved))).toThrow(/no open stay/);
    expect(() => saveWard(s, { ...src, save: undefined }, RUN)).toThrow(/cannot be saved/);
  });
});
