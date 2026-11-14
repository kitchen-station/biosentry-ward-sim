import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WINDOW_AFTER_FULL_MIN, type WardSummary } from "../sim/ward-stats";
import { VITAL_CARD } from "../panels";
import { FIRST_DAY, UNIT_LABEL } from "../hospital-labels";
import Insights, { type Mode, type Person, type VitalsView } from "./Insights";

const hours = (unit: string, n: number) => Array.from({ length: n }, (_, hour) => ({ hour, unit, census: 3 + (hour % 4), arrivals: 2, admitted_in: 1, discharged: 1, transferred_in: 0, transferred_out: 1 }));
const levelRow = (m: number) => ({ m, low: 5, low_medium: 2, medium: 1, high: 1, not_ranked: 1, beds: 10 });
const summary: WardSummary = {
  version: 1, ward: "W4", synthetic: true, binMin: 15, fromMin: 0, toMin: 600,
  levels: [0, 60, 120, 180, 480, 540, 600].map(levelRow), // a jump between 180 and 480
  // 41 and 47: their sum, 88, is nowhere in this data, so a printed sum fails the no-new-number test
  shifts: [{ start: -480, alerts: 41, patientMin: 5400, partial: true }, { start: 240, alerts: 47, patientMin: 8100, partial: false }],
  stays: [{ inMin: 10, outMin: 700, outcome: "discharged" }, { inMin: 20, outMin: 3000, outcome: "higher_care" }],
  episodes: [
    { start: 300.4, kind: "sepsis_like", alertMin: 315, minutesBetween: 15, windowOpen: false },
    { start: 120, kind: "sepsis_like", alertMin: null, minutesBetween: null, windowOpen: false },
    { start: 590, kind: "sepsis_like", alertMin: null, minutesBetween: null, windowOpen: true },
  ],
  staff: null,
  hospital: {
    units: [{ id: "ER", name: "Emergency", floor: 0, beds: 12 }, { id: "MED3A", name: "Medicine 3A", floor: 3, beds: 20 }, { id: "MED3B", name: "Medicine 3B", floor: 3, beds: 20 }, { id: "SURG5A", name: "Surgery 5A", floor: 5, beds: 16 }, { id: "ICU", name: "Intensive care", floor: 2, beds: 8 }, { id: "W4", name: "Ward 4", floor: 4, beds: 18 }],
    hours: ["ER", "MED3A", "MED3B", "SURG5A", "ICU", "W4"].flatMap((u) => hours(u, 30)),
  },
};
// Hours 0 to `last`: the newest hour is still filling, so the page draws hours 0 to last - 1. 57 and 4321 are in no other fixture.
const hourRows = (last: number): VitalsView["hourly"] =>
  Array.from({ length: last + 1 }, (_, hour) => ["ER", "MED3A", "MED3B", "SURG5A", "ICU"].map((unit) => (unit === "ICU"
    ? { hour, unit, low: 0, low_medium: 0, medium: 0, high: 0, not_ranked: 0, read: 8 + (hour % 3) }
    : { hour, unit, low: 3 + (hour % 2), low_medium: 1, medium: 1, high: hour % 2, not_ranked: 1, read: 6 + 2 * (hour % 2) + (hour % 2) }))).flat();
const vitals: VitalsView = { created: 57, reads: 4321, hourly: hourRows(29) };
const person: Person = {
  id: "n-1", name: "Test Person", bed: "4A",
  stay: { id: "n-1", name: "Test Person", bed: "4A", context: "", rn: "", md: null, inMin: 10, outMin: null, outcome: null, peak: 6, peakRisk: "high", scores: [1, 2, null, 6, 3], events: [{ minute: 30, text: "Assessed" }, { minute: 90, text: "Called a physician" }] },
  history: { heart_rate: [80, 82, null, 134.75734533816004], respiratory_rate: [16, 18, 20, 21], spo2: [97, 96, 95, 94], temperature: [36.8, 36.9, 37.1, 37.46039487245385] },
};
const label = (m: number) => `t${m}`;
const render = (mode: Mode, s: WardSummary | null, patients: Person[] = [person], v: VitalsView | null = vitals) => renderToStaticMarkup(<Insights mode={mode} summary={s} patients={patients} label={label} vitals={v} />);
const count = (html: string, text: string) => html.split(text).length - 1;
const text = (html: string) => html.replace(/<[^>]+>/g, " ");

describe("the Analytics page", () => {
  const html = render("hospital", summary);

  it("has the title, the top line once, and the sections in order", () => {
    expect(html).toContain("<h2>Analytics</h2>");
    expect(count(html, "Synthetic hospital. Simulated patients. No outcome claim.")).toBe(1);
    const at = ["Hospital</h3>", "Every unit</h3>", "Ward W4</h3>", "Everything in this section is ward W4&#x27;s own record.", "Person</h3>"].map((s) => html.indexOf(s));
    expect(at.every((x) => x > 0) && [...at].sort((a, b) => a - b).join() === at.join()).toBe(true);
    const names = ["Beds in use", "In and out", "NEWS2 levels, every unit", "Intensive care: people read at each whole hour", "NEWS2 levels", "Alerts per patient per shift", "Beds in use", "Length of stay", "NEWS2 by hour", "What happened", "Vitals, last 3 h"];
    const heads = [...html.matchAll(/<h4>([^<]*)<\/h4>/g)].map((m) => m[1]);
    expect(heads).toEqual(names);
  });

  it("makes each chart a figure with a one-line caption", () => {
    expect(count(html, "<figure")).toBe(11);
    expect(count(html, "<figcaption>")).toBe(11);
    expect(html).toContain("Alert = NEWS2 5 or more (demo line)");
    expect(html).toContain("Per unit, per hour");
    expect(html).toContain("Counts from the simulator");
  });

  it("prints a vital as the vital cards do, not as a raw float", () => {
    expect(html).toContain("Heart rate 135 /min");
    expect(html).toContain("Temperature 37.5 °C");
    expect(html).not.toMatch(/\d\.\d{4,}/);
  });

  it("scales a vital's line to its own range", () => {
    const lines = [...html.matchAll(/aria-label="Resp. rate"[^>]*>.*?<polyline points="([^"]+)"/g)];
    const ys = lines[0][1].split(" ").map((p) => Number(p.split(",")[1]));
    expect(Math.min(...ys)).toBeLessThan(15); // the top of a 40 px box, not squashed against it
    expect(Math.max(...ys)).toBeGreaterThan(25);
  });

  it("explains an empty length of stay, and labels the morgue as places", () => {
    expect(render("hospital", { ...summary, stays: [] })).toContain("No finished stay yet (stays that began before the run are not counted)");
    const morgue = render("hospital", { ...summary, hospital: { ...summary.hospital!, units: [{ id: "MORGUE", name: "Morgue", floor: 0, beds: 6 }], hours: hours("MORGUE", 5) } });
    expect(text(morgue)).toMatch(/Morgue: \d+ of 6 places/);
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
    walk(vitals);
    walk(person);
    for (const m of [30, 90]) given.add(String(m)); // through label()
    given.add(String(WINDOW_AFTER_FULL_MIN)); // the window rule line, read from the constant
    for (const e of summary.episodes!) given.add(String(Math.floor(e.start))); // a start prints as a whole-minute clock time
    // A vital printed by the ward's own formatter (VITAL_CARD digits) from a datum.
    for (const [k, xs] of Object.entries(person.history)) for (const x of xs) if (x !== null) given.add(x.toFixed(VITAL_CARD[k as keyof typeof VITAL_CARD].digits));
    // Fixed words with digits: names of things, the 3 h window, the demo line, the dashed line at 5.
    const unitNames = summary.hospital!.units.map((u) => u.name).join("|"); // "Medicine 3A" holds a digit; its unit data is given
    const fixed = text(html).replace(new RegExp(`${unitNames}|W4|NEWS2|SpO2|3 h|NEWS2 5 or more|Dashed line: 5`, "g"), " ");
    const printed = [...fixed.matchAll(/\d+(\.\d+)?/g)].map((m) => m[0]);
    expect(printed.length).toBeGreaterThan(20);
    expect(printed.filter((n) => !given.has(n))).toEqual([]);
  });

  it("says No data yet, once per chart, for an empty summary", () => {
    const empty = render("hospital", { ...summary, levels: [], shifts: [], stays: [], hospital: null }, [], null);
    expect(count(empty, "No data yet")).toBe(10); // 8 and the two Every unit figures
    expect(count(empty, "No finished stay yet (stays that began before the run are not counted)")).toBe(1);
    expect(empty).not.toContain("NaN");
    expect(count(render("hospital", null, [], null), "No data yet")).toBe(10);
  });

  it("shows one line for the hospital in a ward-only build", () => {
    const ward = render("ward", summary);
    expect(ward).toContain("This page simulates ward W4 only.");
    expect(count(ward, "<h4>")).toBe(7);
    expect(ward).not.toContain("Emergency");
  });

  it("shows Not available from the runner yet for the hospital and ward charts in the viewer, and still draws the person", () => {
    const viewer = render("viewer", null);
    expect(count(viewer, "Not available from the runner yet")).toBe(4); // the four ward charts
    expect(count(viewer, "The runner runs ward W4 only.")).toBe(1); // one line for the whole Hospital section
    expect(viewer).not.toContain("Emergency");
    expect(viewer).toContain("Last score: 3");
    expect(viewer).not.toContain("No data yet");
  });

  it("shows no Every unit section in a ward-only or viewer build, even when given vitals", () => {
    for (const mode of ["ward", "viewer"] as const) {
      const out = render(mode, mode === "ward" ? summary : null);
      expect(out).not.toContain("Every unit");
      expect(out).not.toContain("every unit");
      expect(out).not.toContain("Vital-sign streams");
    }
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
    expect([...classes].sort()).toEqual(["chart", "fig", "figs", "floorrow", "insights", "legend", "scroll", "unit"]);
  });

  it("uses no dangerouslySetInnerHTML and no dependency", () => {
    for (const f of ["Insights.tsx", "charts.tsx"]) {
      const src = readFileSync(`src/insights/${f}`, "utf8");
      expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
      expect([...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).filter((m) => !m.startsWith("."))).toEqual(["react"]);
    }
  });
});

describe("the simulated episodes table", () => {
  const ward = (html: string) => html.slice(html.indexOf("Ward W4</h3>"), html.indexOf("Person</h3>"));
  const html = render("hospital", summary);
  it("renders a table with a caption, column headers and one row per episode, newest first", () => {
    expect(html).toContain("<caption>Simulated episodes</caption>");
    expect(count(html, '<th scope="col">')).toBe(4);
    const rows = [...html.matchAll(/<tr><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><\/tr>/g)].map((m) => m.slice(1));
    expect(rows).toEqual([
      ["t590", "sepsis_like", "window still open", ""],
      ["t300", "sepsis_like", "t315", "15"],
      ["t120", "sepsis_like", "none in the window", ""],
    ]);
  });
  it("has the exact label and rule lines, and the empty and missing messages", () => {
    expect(html).toContain("Simulated episode, the simulator&#x27;s ground truth. A real ward never knows this. No outcome shown.");
    expect(html).toContain(`Alert = NEWS2 5 or more (demo line). Window: start to fully in, plus ${WINDOW_AFTER_FULL_MIN} min.`);
    expect(render("hospital", { ...summary, episodes: [] })).toContain("No simulated episode has started yet.");
    expect(render("hospital", { ...summary, episodes: null })).toContain("Not available here.");
    expect(render("hospital", { ...summary, episodes: null })).not.toContain("<table");
  });
  it("caps the rows on screen at 50 and says so", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ start: i, kind: "k", alertMin: null, minutesBetween: null, windowOpen: false }));
    const out = render("hospital", { ...summary, episodes: many });
    expect(count(out, "<td>none in the window</td>")).toBe(50);
    expect(out).toContain("Showing the newest 50 of 60");
  });
  it("uses no outcome or judgement word in the Ward section", () => {
    expect(ward(html)).not.toMatch(/\b(caught|missed|late|later|early|earlier|in time|benefit|saved|prevented|delayed|faster|better)\b/i); // whole words: "Simulated" holds "late"
  });
  it("prints the stored minutes between, not one worked out from a fractional start", () => {
    expect(html).toContain("<td>15</td>"); // start 300.4, first alert 315: the page must not print 14.6
    expect(text(html)).not.toContain("14.6");
    expect(html).not.toMatch(/Fully in|fullIn/);
  });
  it("shows an empty cell, not the word undefined, when kind is missing", () => {
    const out = render("hospital", { ...summary, episodes: [{ ...summary.episodes![0], kind: undefined as unknown as string }] });
    expect(out).toContain("<td></td>");
    expect(out).not.toContain("undefined");
  });
  it("escapes a hostile kind", () => {
    const bad = "<img src=x onerror=alert(1)>";
    const out = render("hospital", { ...summary, episodes: [{ ...summary.episodes![0], kind: bad }] });
    expect(out).not.toMatch(/<img/);
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
  it("shows no table in the viewer build", () => {
    const viewer = render("viewer", summary);
    expect(viewer).not.toContain("<table");
    expect(viewer).not.toContain("Simulated episode");
  });
});

describe("a summary that is missing pieces or holds odd numbers", () => {
  it("shows No data yet and does not throw for missing arrays", () => {
    const broken = { ...summary, levels: undefined, shifts: undefined, stays: undefined, hospital: { units: [] } } as unknown as WardSummary;
    const bare = { id: "x", name: "X", bed: "1A" } as unknown as Person;
    const out = render("hospital", broken, [bare], null);
    expect(count(out, "No data yet") + count(out, "No finished stay yet")).toBe(11);
    expect(() => render("hospital", { ...summary, hospital: { units: [{ id: "ER", name: "E", floor: 0, beds: 1 }] } } as unknown as WardSummary)).not.toThrow();
  });

  it("puts no NaN, Infinity or undefined in an attribute", () => {
    const odd = [NaN, Infinity, -Infinity, 1e308, -1e308];
    const row = (m: number, v: number) => ({ m, low: v, low_medium: v, medium: v, high: v, not_ranked: v, beds: v });
    const bad: WardSummary = {
      ...summary,
      levels: odd.map((v, i) => row(i * 60, v)),
      shifts: odd.map((v, i) => ({ start: i, alerts: v, patientMin: v, partial: false })),
      stays: odd.map((v) => ({ inMin: v, outMin: v, outcome: "discharged" as const })),
      hospital: { units: [{ id: "ER", name: "E", floor: 0, beds: NaN }], hours: odd.map((v, i) => ({ hour: i, unit: "ER", census: v, arrivals: v, admitted_in: v, discharged: v, transferred_in: v, transferred_out: v })) },
    };
    const p = { ...person, stay: { ...person.stay, scores: odd, events: odd.map((v) => ({ minute: v, text: "e" })) }, history: { heart_rate: odd, respiratory_rate: odd, spo2: odd, temperature: odd } };
    const out = render("hospital", bad, [p]);
    const attrs = [...out.matchAll(/\s[\w:-]+="([^"]*)"/g)].map((m) => m[1]);
    expect(attrs.length).toBeGreaterThan(100);
    const badAttr = [...out.matchAll(/<[^>]*="[^"]*(NaN|Infinity|undefined)[^"]*"[^>]*>/g)].map((m) => m[0]);
    expect(badAttr).toEqual([]);
  });
});

describe("the Every unit section", () => {
  const every = (h: string) => h.slice(h.indexOf("Every unit</h3>"), h.indexOf("Ward W4</h3>"));
  const html = render("hospital", summary);
  const sec = every(html);

  it("sits between Hospital and Ward W4, with one small multiple per ranked unit and one line for intensive care", () => {
    expect([...sec.matchAll(/<h4>([^<]*)<\/h4>/g)].map((m) => m[1])).toEqual(["NEWS2 levels, every unit", "Intensive care: people read at each whole hour"]);
    for (const u of ["Emergency", "Medicine 3A", "Medicine 3B", "Surgery 5A"]) expect(sec).toContain(`<span>${u}</span>`);
    for (const id of ["ER", "MED3A", "MED3B", "SURG5A"]) expect(sec).toContain(UNIT_LABEL[id as "ER"]!);
    expect(sec).toContain(`${UNIT_LABEL.ER} Includes the waiting room.`);
    expect(sec).toContain(`Vitals, no NEWS2: NEWS2 is a ward score. ${UNIT_LABEL.ICU}`);
    expect(sec).toContain("Per unit, at each whole hour: people at each NEWS2 level. Same generator as W4, not fitted to each unit. Display only: care does not read it.");
    expect(count(sec, 'aria-label="NEWS2 levels per hour"')).toBe(0); // W4's own label is not reused
    expect(count(sec, "<svg")).toBeGreaterThanOrEqual(4 + 1 + 5); // four bar charts, one line, the legend swatches
  });

  it("draws complete hours only: the newest hour is still filling", () => {
    const bars = (rows: VitalsView["hourly"]) => count(every(render("hospital", summary, [person], { ...vitals, hourly: rows })), "<title>low");
    expect(bars(hourRows(29))).toBe(4 * 29);
    expect(bars(hourRows(0))).toBe(0);
  });

  it("prints the count line exactly, and never says thousands", () => {
    expect(html).toContain("<p>Vital-sign streams opened outside ward W4: 57 (one per person per visit). Readings: 4321.</p>");
    expect(text(html)).not.toMatch(/thousand/i);
    expect(render("hospital", summary, [person], null)).not.toContain("Vital-sign streams");
  });

  it("shows the first-day note under 24 hours and not after", () => {
    expect(count(render("hospital", summary, [person], { ...vitals, hourly: hourRows(6) }), FIRST_DAY)).toBe(1);
    expect(count(render("hospital", summary, [person], { ...vitals, hourly: hourRows(23) }), FIRST_DAY)).toBe(1);
    expect(sec).not.toContain(FIRST_DAY);
  });

  it("says No data yet before the first complete hour, for both figures, and still prints the count line", () => {
    const out = render("hospital", summary, [person], { created: 3, reads: 9, hourly: hourRows(0) });
    expect(count(every(out), "No data yet")).toBe(2);
    expect(out).toContain("Readings: 9.");
  });

  it("shows a missing hour as a gap labelled skipped", () => {
    const rows = hourRows(29).filter((r) => r.hour !== 10);
    expect(every(render("hospital", summary, [person], { ...vitals, hourly: rows }))).toContain(">skipped<");
  });

  it("uses no outcome or judgement word", () => {
    expect(sec).not.toMatch(/\b(caught|missed|late|later|early|earlier|in time|benefit|saved|prevented|delayed|faster|better|died|death|mortality|survival)\b/i);
  });

  it("does not throw for odd numbers", () => {
    const odd = [NaN, Infinity, -1e308];
    const out = render("hospital", summary, [person], { created: NaN, reads: Infinity, hourly: odd.flatMap((v, hour) => ["ER", "ICU"].map((unit) => ({ hour: hour + 1, unit, low: v, low_medium: v, medium: v, high: v, not_ranked: v, read: v }))).concat([{ hour: 9, unit: "ER", low: 1, low_medium: 1, medium: 1, high: 1, not_ranked: 1, read: 5 }]) });
    expect(out).not.toMatch(/="[^"]*(NaN|Infinity|undefined)[^"]*"/);
  });
});
