import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSim, minuteOf, record, setSpeed, step, type Patient } from "./sim";
import { createSyntheticSource, FIXTURE_SEED } from "./source";
import { createSync } from "./sync";

const DAY = 1440 * 60; // ticks at 60x

// The dashboard's "Obs due" rule (its frontend/src/components/risk.ts, obsDue): the set is as old as its oldest nurse-charted part,
// and it is due after 720 min at score 0, 240 at 1 to 4, 60 above that. High risk is continuous monitoring, never "overdue".
const every = (p: Patient) =>
  p.decision.kind !== "ranked" ? 240 : p.decision.news2.risk === "high" ? null : p.decision.news2.risk !== "low" ? 60 : p.decision.news2.total === 0 ? 720 : 240;
const setAt = (p: Patient) => (p.bp && p.bpAt !== null ? Math.min(p.nurseAt, p.bpAt) : p.nurseAt);

function ward(rounds: boolean, days: number, seed = FIXTURE_SEED) {
  const src = createSyntheticSource(seed, true);
  const s = createSim(src);
  if (rounds) s.rounds = true;
  setSpeed(s, 60);
  let overdue = 0;
  let all = 0;
  let worst = 0;
  let last = -1;
  for (let i = 0; i < days * DAY; i += 1) {
    step(s, src);
    const minute = minuteOf(s);
    if (minute === last) continue;
    last = minute;
    for (const p of s.patients) {
      const e = every(p);
      if (e === null) continue;
      all += 1;
      const late = minute - setAt(p) - e;
      if (late > 0) overdue += 1;
      worst = Math.max(worst, late);
    }
  }
  return { share: overdue / all, worst, assessed: s.log.filter((l) => l.text.includes(" assessed ")).length };
}

describe("routine observation rounds", () => {
  it("are off unless asked for", () => {
    const s = createSim(createSyntheticSource(FIXTURE_SEED, true));
    expect(s.rounds).toBeUndefined();
  });

  it("keep the nurse's set in date: overdue is rare with rounds and common without", () => {
    // Measured on this seed over 2 days: without rounds 52% of patient-minutes are overdue (worst 2175 min); with rounds 1.7% (worst 155 min).
    const off = ward(false, 2);
    const on = ward(true, 2);
    expect(off.share).toBeGreaterThan(0.3);
    expect(on.share).toBeLessThan(0.05);
    expect(on.worst).toBeLessThan(240);
    expect(on.assessed).toBeGreaterThan(off.assessed);
  }, 120_000);

  it("hold on another seed too", () => {
    expect(ward(true, 2, 7).share).toBeLessThan(0.05);
  }, 120_000);
});

describe("nurse-charted values and their time", () => {
  const world = (nurseTimes: boolean) => {
    const src = createSyntheticSource(FIXTURE_SEED, true);
    const s = createSim(src);
    s.outbox = { observations: [], bins: [], events: [], admissions: [], departures: [], sent: new Map(), ...(nurseTimes ? { nurseTimes: true } : {}) };
    const p = s.patients[1];
    record(s, p, 0);
    s.outbox.observations.length = 0;
    return { s, p };
  };
  const NURSE = ["blood_pressure", "consciousness", "supplemental_o2", "spo2_scale"];

  it("the same value taken again is sent again, with the minute it was taken", () => {
    const { s, p } = world(true);
    record(s, p, 30); // nothing was re-taken
    expect(s.outbox!.observations.filter((o) => NURSE.includes(o.code))).toEqual([]);
    p.nurseAt = p.bpAt = 100; // a nurse re-took the set and found the same values
    record(s, p, 100);
    const rows = s.outbox!.observations.filter((o) => NURSE.includes(o.code));
    expect(rows.map((o) => o.code).sort()).toEqual([...NURSE].sort());
    for (const o of rows) expect(o.minute).toBe(100);
    expect(rows.find((o) => o.code === "consciousness")!.txt).toBe(p.consciousness);
  });

  it("without the flag a value that did not change is not sent again (the golden test's outbox)", () => {
    const { s, p } = world(false);
    p.nurseAt = p.bpAt = 100;
    record(s, p, 100);
    expect(s.outbox!.observations.filter((o) => NURSE.includes(o.code))).toEqual([]);
  });

  it("the API sync asks for it, and the runner asks for rounds", async () => {
    const src = createSyntheticSource(FIXTURE_SEED, true);
    const s = createSim(src);
    const sync = createSync({ apiUrl: "http://api.test", key: "k", clientId: "c", fetch: async () => Promise.reject(new Error("offline")) });
    await sync.start(s, src);
    expect(s.outbox!.nurseTimes).toBe(true);
    const runner = readFileSync(new URL("../headless.ts", import.meta.url), "utf8");
    expect(runner).toContain("s.rounds = true;"); // the ward it loads or starts
    expect(runner).toContain("fresh.s.rounds = true;"); // the ward a reset starts
    expect(minuteOf(s)).toBe(0);
  });
});
