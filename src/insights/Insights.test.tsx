import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WardSummary } from "../sim/ward-stats";
import Insights, { type Mode, type Person } from "./Insights";

const hours = (unit: string, n: number) => Array.from({ length: n }, (_, hour) => ({ hour, unit, census: 3 + (hour % 4), arrivals: 2, admitted_in: 1, discharged: 1, transferred_in: 0, transferred_out: 1 }));
const levelRow = (m: number) => ({ m, low: 5, low_medium: 2, medium: 1, high: 1, not_ranked: 1, beds: 10 });
const summary: WardSummary = {
  version: 1, ward: "W4", synthetic: true, binMin: 15, fromMin: 0, toMin: 600,
  levels: [0, 60, 120, 180, 480, 540, 600].map(levelRow), // a jump between 180 and 480
  shifts: [{ start: -480, alerts: 3, patientMin: 5400, partial: true }, { start: 240, alerts: 7, patientMin: 8100, partial: false }],
  stays: [{ inMin: 10, outMin: 700, outcome: "discharged" }, { inMin: 20, outMin: 3000, outcome: "higher_care" }],
  episodes: null, staff: null,
  hospital: {
    units: [{ id: "ER", name: "Emergency", floor: 0, beds: 12 }, { id: "W4", name: "Ward 4", floor: 4, beds: 18 }],
    hours: [...hours("ER", 30), ...hours("W4", 30)],
  },
};
const person: Person = {
  id: "n-1", name: "Test Person", bed: "4A",
  stay: { id: "n-1", name: "Test Person", bed: "4A", context: "", rn: "", md: null, inMin: 10, outMin: null, outcome: null, peak: 6, peakRisk: "high", scores: [1, 2, null, 6, 3], events: [{ minute: 30, text: "Assessed" }, { minute: 90, text: "Called a physician" }] },
  history: { heart_rate: [80, 82, null, 90], respiratory_rate: [16, 18, 20, 21], spo2: [97, 96, 95, 94], temperature: [36.8, 36.9, 37.1, 37.4] },
};
const label = (m: number) => `t${m}`;
const render = (mode: Mode, s: WardSummary | null, patients: Person[] = [person]) => renderToStaticMarkup(<Insights mode={mode} summary={s} patients={patients} label={label} />);
const count = (html: string, text: string) => html.split(text).length - 1;
const text = (html: string) => html.replace(/<[^>]+>/g, " ");

describe("the Analytics page", () => {
  const html = render("hospital", summary);

  it("has the title, the top line once, and the sections in order", () => {
    expect(html).toContain("<h2>Analytics</h2>");
    expect(count(html, "Synthetic hospital. Simulated patients. No outcome claim.")).toBe(1);
    const at = ["Hospital</h3>", "Ward W4</h3>", "NEWS2 exists on W4 only", "Person</h3>"].map((s) => html.indexOf(s));
    expect(at.every((x) => x > 0) && [...at].sort((a, b) => a - b).join() === at.join()).toBe(true);
    const names = ["Beds in use", "In and out", "NEWS2 levels", "Alerts per patient per shift", "Beds in use", "Length of stay", "NEWS2 by hour", "What happened", "Vitals, last 3 h"];
    const heads = [...html.matchAll(/<h4>([^<]*)<\/h4>/g)].map((m) => m[1]);
    expect(heads).toEqual(names);
  });

  it("makes each chart a figure with a one-line caption", () => {
    expect(count(html, "<figure")).toBe(9);
    expect(count(html, "<figcaption>")).toBe(9);
    expect(html).toContain("Alert = NEWS2 5 or more (demo line)");
    expect(html).toContain("Per unit, per hour");
    expect(html).toContain("Counts from the simulator");
  });

  it("shows a jump as a gap labelled skipped, and a part shift as faded", () => {
    expect(html).toContain(">skipped<");
    expect(html).toContain("part shift");
  });

  it("prints no number that is not in the data", () => {
    const given = new Set<string>();
    const walk = (v: unknown) => {
      if (typeof v === "number") given.add(String(v));
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(summary);
    walk(person);
    for (const m of [30, 90]) given.add(String(m)); // through label()
    // Fixed words with digits: names of things, the 3 h window, the demo line, the dashed line at 5.
    const fixed = text(html).replace(/W4|NEWS2|SpO2|3 h|NEWS2 5 or more|Dashed line: 5/g, " ");
    const printed = [...fixed.matchAll(/\d+(\.\d+)?/g)].map((m) => m[0]);
    expect(printed.length).toBeGreaterThan(20);
    expect(printed.filter((n) => !given.has(n))).toEqual([]);
  });

  it("says No data yet, once per chart, for an empty summary", () => {
    const empty = render("hospital", { ...summary, levels: [], shifts: [], stays: [], hospital: null }, []);
    expect(count(empty, "No data yet")).toBe(9);
    expect(empty).not.toContain("NaN");
    expect(count(render("hospital", null, []), "No data yet")).toBe(9);
  });

  it("shows one line for the hospital in a ward-only build", () => {
    const ward = render("ward", summary);
    expect(ward).toContain("This page simulates ward W4 only.");
    expect(count(ward, "<h4>")).toBe(7);
    expect(ward).not.toContain("Emergency");
  });

  it("shows Not available from the runner yet for the hospital and ward charts in the viewer, and still draws the person", () => {
    const viewer = render("viewer", null);
    expect(count(viewer, "Not available from the runner yet")).toBe(6);
    expect(viewer).toContain("Last score: 3");
    expect(viewer).not.toContain("No data yet");
  });

  it("escapes markup in a unit name, a person's name and an event line", () => {
    const bad = '<img src=x onerror=alert(1)>';
    const hostile = render(
      "hospital",
      { ...summary, hospital: { ...summary.hospital!, units: [{ id: "ER", name: bad, floor: 0, beds: 12 }] } },
      [{ ...person, name: bad, stay: { ...person.stay, events: [{ minute: 1, text: "<script>alert(1)</script>" }] } }],
    );
    expect(hostile).not.toMatch(/<img|<script/);
    expect(hostile).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(hostile).toContain("&lt;script&gt;");
  });

  it("has no link, no style string, and only fixed class names", () => {
    expect(html).not.toMatch(/href=|\sstyle=/);
    const classes = new Set([...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]));
    expect([...classes].sort()).toEqual(["chart", "fig", "floorrow", "insights", "legend", "unit"]);
  });

  it("uses no dangerouslySetInnerHTML and no dependency", () => {
    for (const f of ["Insights.tsx", "charts.tsx"]) {
      const src = readFileSync(`src/insights/${f}`, "utf8");
      expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
      expect([...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).filter((m) => !m.startsWith("."))).toEqual(f === "Insights.tsx" ? ["react"] : []);
    }
  });
});
