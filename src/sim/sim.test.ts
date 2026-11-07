import { describe, expect, it } from "vitest";
import { arbitrate, rankWard, type Ranked } from "./arbiter";
import { BEDS, findPath, HOMES, nurseStand, physicianStand, STATIONS } from "./map";
import { roundHalfUp, scoreNews2, type News2Inputs } from "./news2";
import {
  applyPatch,
  createSim,
  detachPatch,
  injectDeterioration,
  minuteOf,
  patientById,
  recordBp,
  setSpeed,
  step,
  vitalQuality,
  type Sim,
} from "./sim";
import { createReplaySource, type ReplayStay } from "./replay";
import { createSyntheticSource, FIXTURE_SEED, SEATS, type VitalsSource } from "./source";
import fixture from "./synthetic.json";

const fx = fixture as unknown as {
  ranked: { id: string; score: number; escalation_reasons: { text: string }[] }[];
  abstained: { id: string; reason: string; instruction: string }[];
  labels: Record<string, { expected_news2: number | null }>;
};

const start = (seed = FIXTURE_SEED) => {
  const src = createSyntheticSource(seed);
  return { src, s: createSim(src) };
};

function run(s: Sim, src: VitalsSource, simMinutes: number) {
  const until = s.clockS + simMinutes * 60;
  while (s.clockS < until) step(s, src);
}

const base: News2Inputs = {
  respiratory_rate: 16,
  spo2: 97,
  spo2_scale: 1,
  supplemental_o2: false,
  systolic_bp: 120,
  heart_rate: 70,
  consciousness: "A",
  temperature: 36.8,
};

describe("NEWS2", () => {
  it("rounds half-up as written", () => {
    expect(roundHalfUp(36.05, 1)).toBe(36.1);
    expect(roundHalfUp(8.5, 0)).toBe(9);
  });

  it("applies scale 2 by oxygen status", () => {
    const score = (over: Partial<News2Inputs>) => {
      const r = scoreNews2({ ...base, spo2_scale: 2, ...over });
      if (r.kind !== "score") throw new Error("abstained");
      return r.parameters.find((p) => p.parameter === "spo2")!.score;
    };
    expect(score({ spo2: 95, supplemental_o2: true })).toBe(2);
    expect(score({ spo2: 95, supplemental_o2: false })).toBe(0);
  });

  it("abstains on a zero-filled SpO2 but scores a heart rate of zero", () => {
    expect(scoreNews2({ ...base, spo2: 0 }).kind).toBe("abstained");
    expect(scoreNews2({ ...base, heart_rate: 0 }).kind).toBe("score");
  });
});

describe("parity with the BioSentry fixture at minute 0", () => {
  const { s } = start();
  const ranked = s.patients.filter((p) => p.decision.kind === "ranked");

  it("scores all ten ranked patients exactly", () => {
    expect(ranked).toHaveLength(10);
    for (const p of ranked) {
      expect((p.decision as Ranked).news2.total, p.id).toBe(fx.labels[p.id].expected_news2);
    }
  });

  it("gives the same escalation reasons", () => {
    for (const row of fx.ranked) {
      const d = patientById(s, row.id).decision as Ranked;
      expect(d.reasons, row.id).toEqual(row.escalation_reasons.map((r) => r.text));
    }
  });

  it("ranks in fixture order, level before total", () => {
    const order = rankWard(s.patients.map((p) => p.decision)).ranked.map((d) => d.patientId);
    expect(order).toEqual(fx.ranked.map((r) => r.id));
    expect(patientById(s, "p-008").rank).toBeLessThan(patientById(s, "p-007").rank!);
  });

  it("gives the same NOT RANKED text", () => {
    for (const row of fx.abstained) {
      const d = patientById(s, row.id).decision;
      expect(d).toMatchObject({ kind: "not_ranked", reason: row.reason, instruction: row.instruction });
    }
  });

  it("starts p-011 degraded, with the fixture signal quality of 67 percent", () => {
    const p = patientById(s, "p-011");
    expect(vitalQuality(p, "heart_rate", 0)).toBe("degraded");
    expect(Math.round((100 * p.signal.reduce((a, b) => a + b, 0)) / p.signal.length)).toBe(67);
  });

  it("arbitrates an unusable input into a named instruction", () => {
    const d = arbitrate("x", scoreNews2({ ...base, heart_rate: null }));
    expect(d).toMatchObject({
      reason: "Heart rate missing",
      instruction: "Check the patch is applied and the signal is verified",
    });
  });
});

describe("map", () => {
  it("reaches every bedside from every home", () => {
    for (const home of Object.values(HOMES)) {
      for (const bed of BEDS) {
        expect(() => findPath(home, nurseStand(bed))).not.toThrow();
        expect(() => findPath(home, physicianStand(bed))).not.toThrow();
      }
    }
  });

  it("puts every fixture bed on the map", () => {
    const { s } = start();
    for (const p of s.patients) expect(BEDS.some((b) => b.label === p.bed), p.bed).toBe(true);
    expect(STATIONS.screen).toEqual([14, 6]);
  });
});

describe("simulation", () => {
  it("is deterministic for a seed and differs across seeds", () => {
    const go = (seed: number) => {
      const { s, src } = start(seed);
      run(s, src, 180);
      injectDeterioration(s, src, "p-007");
      detachPatch(s, "p-012");
      run(s, src, 180);
      return JSON.stringify(s);
    };
    expect(go(1)).toBe(go(1));
    expect(go(1)).not.toBe(go(2));
  });

  it("queues the opening assessments and works them in rank order", () => {
    const { s } = start();
    expect(s.tasks.map((t) => t.patient).sort()).toEqual(
      ["p-001", "p-002", "p-003", "p-006", "p-008"].sort(),
    );
  });

  it("ranks p-004 once a blood pressure is recorded", () => {
    const { s, src } = start();
    recordBp(s, "p-004", { systolic: 128, diastolic: 76 });
    run(s, src, 30);
    expect(patientById(s, "p-004").decision.kind).toBe("ranked");
  });

  it("ranks p-005 only after eight usable minutes", () => {
    const { s, src } = start();
    applyPatch(s, "p-005");
    const p = patientById(s, "p-005");
    while (!p.patch) step(s, src);
    const applied = minuteOf(s);
    while (p.decision.kind !== "ranked" && minuteOf(s) < applied + 30) step(s, src);
    expect(p.decision.kind).toBe("ranked");
    expect(minuteOf(s) - applied).toBeGreaterThanOrEqual(7);
  });

  it("takes a detached patch through degraded to NOT RANKED", () => {
    const { s, src } = start();
    const p = patientById(s, "p-012");
    detachPatch(s, p.id);
    let sawDegraded = false;
    while (p.decision.kind === "ranked" && minuteOf(s) < 60) {
      step(s, src);
      sawDegraded ||= vitalQuality(p, "heart_rate", minuteOf(s)) === "degraded";
    }
    expect(sawDegraded).toBe(true);
    expect(p.decision).toMatchObject({ kind: "not_ranked", reason: "No device data" });
  });

  it("drops p-011 to NOT RANKED about ten minutes in", () => {
    const { s, src } = start();
    run(s, src, 12);
    expect(patientById(s, "p-011").decision.kind).toBe("not_ranked");
  });

  it("brings a physician to the bedside after an injected deterioration", () => {
    const { s, src } = start();
    injectDeterioration(s, src, "p-007");
    const md = s.staff.find((m) => m.id === patientById(s, "p-007").md)!;
    let reviewed = false;
    while (!reviewed && minuteOf(s) < 400) {
      step(s, src);
      reviewed = md.stage === "work" && md.task?.patient === "p-007";
    }
    expect(reviewed).toBe(true);
  });

  it("keeps score changes from churning the ward", () => {
    const rates = [1, 2, 3, 4].map((seed) => {
      const { s, src } = start(seed);
      setSpeed(s, 60);
      const total = (id: string) => {
        const d = patientById(s, id).decision;
        return d.kind === "ranked" ? d.news2.total : null;
      };
      const ids = ["p-002", "p-003", "p-006", "p-007", "p-008", "p-009", "p-010", "p-012"];
      let last = ids.map(total);
      let changes = 0;
      for (let minute = 0; minute < 24 * 60; minute += 1) {
        run(s, src, 1);
        const now = ids.map(total);
        changes += now.filter((v, i) => v !== last[i]).length;
        last = now;
      }
      return changes / 24;
    });
    const mean = rates.reduce((a, b) => a + b) / rates.length;
    expect(mean).toBeLessThan(6);
  });
});

describe("replay", () => {
  const every5 = (from: number, to: number, value: number) => {
    const out: [number, number][] = [];
    for (let m = from; m <= to; m += 5) out.push([m, value]);
    return out;
  };
  const stayFor = (id: string): ReplayStay => ({
    id,
    dx: "CHF",
    age: "> 89",
    sex: "F",
    unit: "MICU",
    to: "Floor",
    durationMin: 720,
    hr: every5(-30, 720, 80),
    rr: every5(-30, 720, 16),
    spo2: every5(-30, 720, 97),
    temp: [[-200, 36.8], [120, 98.3]],
    bp: [[-10, 120, 70], [60, 85, 50]],
    o2: [[-10, 0], [30, 1]],
    gcs: [[-10, 15], [90, 12]],
  });
  const file = {
    dataset: "test",
    licence: "test",
    stays: SEATS.map((_, i) => stayFor(String(1000 + i))),
  };
  const open = () => {
    const src = createReplaySource(file);
    return { src, s: createSim(src) };
  };

  it("ranks 5-minute data, with an old charted temperature still valid", () => {
    const { s } = open();
    expect(s.patients.every((p) => p.decision.kind === "ranked")).toBe(true);
    expect(s.patients[0].decision).toMatchObject({ news2: { total: 0 } });
  });

  it("does not count quiet charted minutes as rejected samples", () => {
    const { s, src } = open();
    run(s, src, 60);
    expect(s.counts.received).toBeGreaterThan(100);
    expect(s.counts.rejected).toBe(0);
  });

  it("takes oxygen, BP and consciousness from the chart as they change", () => {
    const { s, src } = open();
    run(s, src, 95);
    const p = s.patients[0];
    expect(p.onOxygen).toBe(true);
    expect(p.bp).toEqual({ systolic: 85, diastolic: 50 });
    expect(p.consciousness).toBe("C");
    expect(p.decision).toMatchObject({ news2: { total: 8 } });
  });

  it("rejects a Fahrenheit value in the Celsius column at the gate", () => {
    const { s, src } = open();
    run(s, src, 125);
    expect(s.counts.rejected).toBeGreaterThan(0);
    expect(s.patients[0].held.temperature).toBe(36.8);
  });

  it("drops a patient once the charted temperature is 8 hours old", () => {
    const { s, src } = open();
    run(s, src, 290);
    expect(s.patients[0].decision).toMatchObject({
      kind: "not_ranked",
      reason: "Temperature missing",
    });
  });

  it("stops at the end of the stay", () => {
    const { s, src } = open();
    run(s, src, 719);
    const before = s.log.length;
    for (let i = 0; i < 200; i += 1) step(s, src);
    expect(s.ended).toBe(true);
    expect(s.log.length).toBeGreaterThan(before);
  });

  it("offers no deterioration button", () => {
    expect(createReplaySource(file).inject).toBeUndefined();
  });
});
