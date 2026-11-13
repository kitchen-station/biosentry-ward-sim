// Slice C: one person across moves. No DOM: pure helpers, renderToStaticMarkup and source scans.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { floorSummary } from "./building";
import { HospitalPanel, clock, movesToday } from "./hospital-panels";
import { CAPPED, NEWS2_ICU, NOT_READ, PersonTimeline, RECOVERY_NOTE, W4_BREAK, timelineSeries } from "./person-timeline";
import { createHospitalSim } from "./sim/hospital/attach";
import { parseScenario } from "./sim/hospital/scenario";
import type { Hospital, EventRow } from "./sim/hospital/types";
import { CAPS, createVitals, feedVitals, type HospitalVitals, type PersonVitals, type Span, type VitalBin } from "./sim/hospital/vitals";
import { setSpeed, step, type Sim } from "./sim/sim";
import { createSyntheticSource, FIXTURE_SEED } from "./sim/source";

const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;|&#39;/g, "'");
const bin = (m: number, unit: VitalBin["unit"], v = 80): VitalBin => ({ m, unit, hr: v, rr: 16, spo2: 97, temp: 36.8, sbp: 120, news2: 3 });
const fake = (bins: VitalBin[], spans: Span[]) => ({ bins, spans } as unknown as PersonVitals);

describe("timelineSeries", () => {
  const spans: Span[] = [
    { unit: "ER", where: "bed", fromMin: 0, w4Id: null },
    { unit: "W4", where: "bed", fromMin: 30, w4Id: "P-7" },
    { unit: "ICU", where: "bed", fromMin: 75, w4Id: null, recovery: "not_modelled" },
    { unit: "ICU", where: "bed", fromMin: 90, w4Id: null, gap: "not_read" },
    { unit: "ICU", where: "bed", fromMin: 105, w4Id: null },
  ];
  const bins = [bin(0, "ER"), bin(15, "ER"), bin(90, "ICU"), bin(105, "ICU"), bin(120, "ICU")];
  const t = timelineSeries(fake(bins, spans));

  it("has null on a W4 span and on a gap, and a 15 minute grid", () => {
    expect(t.minutes).toEqual([0, 15, 30, 45, 60, 75, 90, 105, 120]);
    expect(t.hr).toEqual([80, 80, null, null, null, null, 80, 80, 80]);
  });
  it("lists the bands in order, with the W4 id, the gap and the recovery mark", () => {
    expect(t.bands.map((b) => [b.unit, b.kind, b.fromMin, b.endMin])).toEqual([["ER", "read", 0, 30], ["W4", "w4", 30, 75], ["ICU", "read", 75, 90], ["ICU", "gap", 90, 105], ["ICU", "read", 105, 135]]);
    expect(t.bands[1].w4Id).toBe("P-7");
    expect(t.bands[2].recovery).toBe(true);
  });
  it("blanks NEWS2 in intensive care", () => {
    expect(t.news2).toEqual([3, 3, null, null, null, null, null, null, null]);
  });
  it("says capped at the engine's cap only", () => {
    expect(t.capped).toBe(false);
    const many = Array.from({ length: CAPS.bins }, (_, i) => bin(i * 15, "ER"));
    expect(timelineSeries(fake(many, [{ unit: "ER", where: "bed", fromMin: 0, w4Id: null }])).capped).toBe(true);
    expect(timelineSeries(fake([], [])).minutes).toEqual([]);
  });
});

describe("the timeline markup", () => {
  const spans: Span[] = [
    { unit: "ER", where: "bed", fromMin: 0, w4Id: null },
    { unit: "W4", where: "bed", fromMin: 30, w4Id: "P-7" },
    { unit: "ICU", where: "bed", fromMin: 75, w4Id: null, recovery: "not_modelled" },
    { unit: "ICU", where: "bed", fromMin: 90, w4Id: null, gap: "not_read" },
    { unit: "ICU", where: "bed", fromMin: 105, w4Id: null },
  ];
  const html = renderToStaticMarkup(<PersonTimeline pv={fake([bin(0, "ER"), bin(15, "ER"), bin(90, "ICU"), bin(120, "ICU")], spans)} onSelect={noop} />);
  it("shows the W4 break with its button, the gap, the recovery note and the ICU score note", () => {
    const t = text(html);
    for (const x of [W4_BREAK, "Open the W4 stay", NOT_READ, RECOVERY_NOTE, NEWS2_ICU]) expect(t).toContain(x);
    expect(html).toContain("<button");
    expect(RECOVERY_NOTE).toBe("Simulated recovery, not modelled.");
  });
  it("says 'Last 200 h' only when capped", () => {
    expect(text(html)).not.toContain(CAPPED);
    const many = Array.from({ length: CAPS.bins }, (_, i) => bin(i * 15, "ER"));
    expect(text(renderToStaticMarkup(<PersonTimeline pv={fake(many, [spans[0]])} onSelect={noop} />))).toContain("Last 200 h");
  });
  it("is text only", () => {
    expect(readFileSync("src/person-timeline.tsx", "utf8")).not.toContain("dangerouslySetInnerHTML");
  });
  it("keeps one copy of the recovery string", () => {
    expect(readFileSync("src/hospital-panels.tsx", "utf8")).not.toContain('"Simulated recovery, not modelled."');
  });
});

describe("movesToday", () => {
  const ev = (minute: number, kind: EventRow["kind"], unit: EventRow["unit"], detail = "", person = "h-000001"): EventRow =>
    ({ minute, person, visit: 1, w4_id: null, unit, kind, detail, news2_independent: true });
  const h = {
    lastMinute: 100, units: [], people: [], gone: [],
    events: [
      ev(10, "place", "ICU", "ICU"),
      ev(20, "transfer", "MED3A", "ICU to MED3A"),
      ev(30, "transfer", "ICU", "W4 to ICU"),
      ev(40, "transfer", "MED3A", "stretcher to bed"),
      ev(50, "discharge", "MED3A"),
      ev(60, "arrive", "ER", "walk-in"),
      ev(70, "died", "ICU", "bed"),
      ev(80, "transfer", "ICU", "MED3A to ICU after notice"),
    ],
  } as unknown as Hospital;
  it("counts place, transfer, discharge, died and transfer_out at the unit, and moves out by 'to'", () => {
    expect(movesToday(h, "MED3A").count).toBe(4); // ICU to MED3A, stretcher to bed, discharge, and 'MED3A to ICU' out
    expect(movesToday(h, "ICU").count).toBe(5); // 10 place, W4 to ICU, died, MED3A to ICU, and 'ICU to MED3A' out
    expect(movesToday(h, "ER").count).toBe(0);
  });
  it("shows the newest first", () => {
    expect(movesToday(h, "ICU").rows.map((r) => r.minute)).toEqual([80, 70, 30, 20, 10]);
  });
  it("pins the detail formats in step.ts", () => {
    const code = readFileSync("src/sim/hospital/step.ts", "utf8");
    for (const f of ['"W4 to ICU"', "`${p.unit} to ICU after notice`", "`ICU to ${id}`", '"stretcher to bed"']) expect(code).toContain(f);
    expect(code).toContain('if (!settled(p) || p.unit === "ICU") continue;\n    h.acc.by[p.unit].discharged += 1;'); // the ICU never discharges home
  });
});

describe("a seeded run", () => {
  let s: Sim;
  let v: HospitalVitals;
  beforeAll(() => {
    const src = createSyntheticSource(FIXTURE_SEED, true);
    s = createHospitalSim(src, parseScenario(readFileSync("scenarios/hospital/typical.json", "utf8")), 101);
    setSpeed(s, 60);
    v = createVitals();
    for (let i = 0; i < 24 * 60; i += 1) { step(s, src); feedVitals(v, s.hospital!, s.clockS); }
  }, 60_000);

  it("moves today equals an independent count of the day's rows", () => {
    const h = s.hospital!;
    for (const u of h.units) {
      const m = movesToday(h, u.id);
      const start = Math.floor((Math.max(0, h.lastMinute) + 420) / 1440) * 1440 - 420;
      let n = 0;
      for (const e of h.events) {
        if (e.minute < start) continue;
        if (e.unit === u.id && ["place", "transfer", "discharge", "died", "transfer_out"].includes(e.kind)) n += 1;
        else if (e.kind === "transfer" && e.detail.slice(0, u.id.length + 4) === `${u.id} to `) n += 1;
      }
      expect(m.count).toBe(n);
      expect(m.rows.length).toBe(Math.min(10, n));
    }
  });

  it("shows 'Moves today' in each unit panel, and the ICU line from the bed count", () => {
    const h = s.hospital!;
    const panel = (id: string) => text(renderToStaticMarkup(<HospitalPanel h={h} id={id} onSelect={noop} floors={floorSummary(h)} vitals={v} />));
    for (const id of ["unit:MED3A", "unit:MED3B", "unit:SURG5A", "unit:ICU", "unit:W4", "queue:ER"]) expect(panel(id)).toContain(`Moves today: ${movesToday(h, id.split(":")[1] as never).count}`);
    const beds = h.units.find((u) => u.id === "ICU")!.beds;
    expect(panel("unit:ICU")).toContain(`The ICU has ${beds} beds and never discharges home, so moves out are few.`);
    expect(panel("unit:MED3A")).not.toContain("never discharges home");
    expect(clock(0)).toContain("day 1");
  });

  it("finds a person with two or more bands and renders them", () => {
    const h = s.hospital!;
    const q = h.people.find((p) => p.unit !== "W4" && (v.live.get(p.id)?.spans.length ?? 0) >= 2 && v.live.get(p.id)!.visit === p.visit);
    expect(q).toBeDefined();
    const pv = v.live.get(q!.id)!;
    expect(timelineSeries(pv).bands.length).toBeGreaterThanOrEqual(2);
    const t = text(renderToStaticMarkup(<HospitalPanel h={h} id={`h:${q!.n}`} onSelect={noop} floors={floorSummary(h)} vitals={v} />));
    expect(t).toContain("Whole stay");
    expect(t).toContain("Heart rate");
  });
});

