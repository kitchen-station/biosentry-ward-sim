// Slice C: one person across moves. No DOM: pure helpers, renderToStaticMarkup and source scans.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { floorSummary } from "./building";
import { HospitalPanel, movesToday } from "./hospital-panels";
import { AFTER_W4, CAPPED, NEWS2_ICU, NOT_READ, RECOVERY_NOTE, TimelineView, W4_BREAK, sameTimeline, timelineSeries } from "./person-timeline";
import { createHospitalSim } from "./sim/hospital/attach";
import { PARAMS } from "./sim/hospital/params";
import { parseScenario } from "./sim/hospital/scenario";
import type { Hospital, EventRow } from "./sim/hospital/types";
import { CAPS, createVitals, feedVitals, type HospitalVitals, type PersonVitals, type Span, type VitalBin } from "./sim/hospital/vitals";
import { setSpeed, step, type Sim } from "./sim/sim";
import { createSyntheticSource, FIXTURE_SEED } from "./sim/source";

const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;|&#39;/g, "'");
const bin = (m: number, unit: VitalBin["unit"], v = 80): VitalBin => ({ m, unit, hr: v, rr: 16, spo2: 97, temp: 36.8, sbp: 120, news2: 3 });
const tl = (pv: PersonVitals, onSelect: (id: string) => void = noop) => ({ pv, last: pv.bins.at(-1)?.m, nSpans: pv.spans.length, onSelect });
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
  const html = renderToStaticMarkup(<TimelineView {...tl(fake([bin(0, "ER"), bin(15, "ER"), bin(90, "ICU"), bin(120, "ICU")], spans))} />);
  it("shows the W4 break with its button, the gap, the recovery note and the ICU score note", () => {
    const t = text(html);
    for (const x of [W4_BREAK, "Open the W4 stay", AFTER_W4, NOT_READ, RECOVERY_NOTE, NEWS2_ICU]) expect(t).toContain(x);
    expect(html).toContain("<button");
    expect([W4_BREAK, AFTER_W4, NOT_READ, RECOVERY_NOTE]).toEqual(["Ward W4: own record.", "New values from here: not continued from W4.", "Not read (skipped).", "Simulated recovery, not modelled."]);
    expect(t.indexOf(W4_BREAK)).toBeLessThan(t.indexOf(AFTER_W4));
  });
  it("the W4 button calls onSelect with the W4 id", () => {
    const onSelect = vi.fn();
    const tree = TimelineView(tl(fake([bin(0, "ER"), bin(90, "ICU")], spans), onSelect));
    const find = (n: any): any => (n && typeof n === "object" ? (n.type === "button" ? n : [].concat(n.props?.children ?? []).map(find).find(Boolean)) : undefined);
    const button = find(tree);
    expect(button).toBeDefined();
    button.props.onClick();
    expect(onSelect).toHaveBeenCalledWith("P-7");
  });
  it("draws nothing for non-finite values", () => {
    const bad = { ...bin(15, "ER"), hr: NaN, rr: Infinity };
    const out = renderToStaticMarkup(<TimelineView {...tl(fake([bin(0, "ER"), bad], [spans[0]]))} />);
    for (const x of ["NaN", "Infinity", "undefined"]) expect(out).not.toContain(x);
    expect(timelineSeries(fake([bin(0, "ER"), bad], [spans[0]])).hr).toEqual([80, null]);
  });
  it("redraws only for a new person, a new last bin or a new span count", () => {
    const a = tl(fake([bin(0, "ER")], [spans[0]]));
    expect(sameTimeline(a, { ...a, onSelect: () => {} })).toBe(true);
    expect(sameTimeline(a, { ...a, last: 15 })).toBe(false);
    expect(sameTimeline(a, { ...a, nSpans: 2 })).toBe(false);
    expect(sameTimeline(a, { ...a, pv: fake([], []) })).toBe(false);
  });
  it("says 'Last 200 h' only when capped", () => {
    expect(text(html)).not.toContain(CAPPED);
    const many = Array.from({ length: CAPS.bins }, (_, i) => bin(i * 15, "ER"));
    expect(text(renderToStaticMarkup(<TimelineView {...tl(fake(many, [spans[0]]))} />))).toContain("Last 200 h");
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
    expect(movesToday(h, "ER").count).toBe(1); // the placement at minute 10 left the ER
  });
  it("counts every way out of the ER, and the ICU line reads its beds from state", () => {
    const e = {
      lastMinute: 100, units: [{ id: "ICU", beds: 7 }], people: [], gone: [],
      events: [ev(10, "place", "MED3A", "MED3A"), ev(20, "place", "ICU", "ICU"), ev(30, "decide_home", "ER"), ev(40, "lwbs", "ER", "waited 3 h"), ev(50, "transfer_out", "ER", "boarded 9 h"), ev(60, "died", "ER", "workup"), ev(70, "died", "ICU", "bed"), ev(80, "transfer", "ICU", "W4 to ICU")],
    } as unknown as Hospital;
    const m = movesToday(e, "ER");
    expect(m.count).toBe(6);
    expect(m.split).toEqual([["Placed in a unit", 2], ["home", 1], ["left unseen", 1], ["transferred out", 1], ["died", 1]]);
    expect(movesToday(e, "MED3A").count).toBe(1); // a placement is counted once, at the ward
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

describe("a seeded run of three simulated days", () => {
  let s: Sim;
  let v: HospitalVitals;
  const DAYS = 3;
  beforeAll(() => {
    const src = createSyntheticSource(FIXTURE_SEED, true);
    s = createHospitalSim(src, parseScenario(readFileSync("scenarios/hospital/typical.json", "utf8")), 101);
    setSpeed(s, 60);
    v = createVitals();
    while (s.hospital!.lastMinute < DAYS * 1440 - 1) { step(s, src); feedVitals(v, s.hospital!, s.clockS); } // one simulated second a step
  }, 120_000);

  // The hospital clock's own day, from the start-of-day parameter.
  const day = (m: number) => Math.floor((m + PARAMS.clock.startMinuteOfDay.value) / 1440);

  it("moves today equals an independent recount, for every unit, and the ER's parts add up", () => {
    const h = s.hospital!;
    const today = day(Math.max(0, h.lastMinute));
    expect(today).toBeGreaterThanOrEqual(2);
    const rows = h.events.filter((e) => day(e.minute) === today);
    for (const u of h.units) {
      const m = movesToday(h, u.id);
      let n = 0;
      for (const e of rows) {
        if (u.id === "ER") { if (e.kind === "place" || (e.unit === "ER" && ["decide_home", "lwbs", "transfer_out", "died"].includes(e.kind))) n += 1; }
        else if (e.unit === u.id && ["place", "transfer", "discharge", "died", "transfer_out"].includes(e.kind)) n += 1;
        else if (e.kind === "transfer" && e.detail.startsWith(`${u.id} to `)) n += 1;
      }
      expect(m.count).toBe(n);
      expect(m.rows.length).toBe(Math.min(10, n));
    }
    const er = movesToday(h, "ER");
    const want = (k: string) => rows.filter((e) => e.kind === k && (k === "place" || e.unit === "ER")).length;
    expect(Object.fromEntries(er.split)).toEqual(Object.fromEntries([["Placed in a unit", want("place")], ["home", want("decide_home")], ["left unseen", want("lwbs")], ["transferred out", want("transfer_out")], ["died", want("died")]].filter(([, n]) => (n as number) > 0)));
    expect(er.split.reduce((a, [, n]) => a + n, 0)).toBe(er.count);
    expect(er.count).toBeGreaterThan(0);
  });

  it("every ER placement row is the ER's own: nobody is placed from another unit", () => {
    const code = readFileSync("src/sim/hospital/step.ts", "utf8");
    expect(code.match(/tryPlace\(c, p\)/g)).toHaveLength(2); // boarders, then ER decisions
  });

  it("shows 'Moves today' in each unit panel; the ER split; the ICU line reads its beds from state", () => {
    const h = s.hospital!;
    const panel = (hh: Hospital, id: string) => text(renderToStaticMarkup(<HospitalPanel h={hh} id={id} onSelect={noop} floors={floorSummary(h)} vitals={v} />));
    for (const id of ["unit:MED3A", "unit:MED3B", "unit:SURG5A", "unit:ICU", "unit:W4", "queue:ER"]) expect(panel(h, id)).toContain(`Moves today: ${movesToday(h, id.split(":")[1] as never).count}`);
    expect(panel(h, "queue:ER")).toContain(movesToday(h, "ER").split.map(([l, n]) => `${l} ${n}`).join(" · "));
    const line = (n: number) => `The ICU has ${n} beds. In this model a person leaves the ICU only by stepping down to a ward or by dying.`;
    expect(panel(h, "unit:ICU")).toContain(line(h.units.find((u) => u.id === "ICU")!.beds));
    const seven = { ...h, units: h.units.map((u) => (u.id === "ICU" ? { ...u, beds: 7 } : u)) } as Hospital;
    expect(panel(seven, "unit:ICU")).toContain(line(7));
    expect(panel(h, "unit:MED3A")).not.toContain("The ICU has");
  });

  it("finds a person with two or more bands in a real run and renders them", () => {
    const h = s.hospital!;
    const q = h.people.find((p) => p.unit !== "W4" && (v.live.get(p.id)?.spans.length ?? 0) >= 2 && v.live.get(p.id)!.visit === p.visit);
    expect(q).toBeDefined();
    const pv = v.live.get(q!.id)!;
    expect(timelineSeries(pv).bands.length).toBeGreaterThanOrEqual(2);
    const t = panel2(h, q!.n);
    expect(t).toContain("Whole stay");
    expect(t).toContain("Heart rate");
  });
  const panel2 = (h: Hospital, n: number) => text(renderToStaticMarkup(<HospitalPanel h={h} id={`h:${n}`} onSelect={noop} floors={floorSummary(h)} vitals={v} />));
});
