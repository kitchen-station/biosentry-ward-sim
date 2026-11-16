// The large view of an analytics figure: the chart at full width and the numbers behind it.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { obsScore, SCORE_BANDS, timeInBands, TOTAL_BANDS, totalBand } from "../obs-bands";
import Insights, { inWindow, WINDOWS, type Person, type Series } from "./Insights";

const hist = (xs: (number | null)[]) => xs;
const person = {
  id: "p-1", name: "Reyes, Ana", bed: "4A",
  stay: { scores: [2, 3, null, 5, 6, 7, 8, 4], events: [] },
  history: { heart_rate: hist([88, 92, 95, null, 112, 118]), respiratory_rate: hist([16, 18, 21, 22, 25, 26]), spo2: hist([97, 96, 95, 94, 93, 91]), temperature: hist([36.8, 37.0, 37.4, 38.2, 38.6, 39.2]) },
  bpHistory: [118, null, null, 104, null, 96],
} as unknown as Person;
const page = (large: string | null) => renderToStaticMarkup(<Insights mode="ward" summary={null} patients={[person]} label={(m) => `min ${m}`} large={large} />);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const big = (html: string) => /<figure class="fig enlarged"[^>]*>(.*?)<\/figure>/s.exec(html)?.[1] ?? "";

describe("the time a series sat in each band, and the window", () => {
  it("counts readings per band and turns them into minutes; gaps are not counted", () => {
    expect(timeInBands([16, 18, null, 22, 26, "skip", 26], 15, (v) => SCORE_BANDS[obsScore("respiratory_rate", v)], SCORE_BANDS)).toEqual([
      { band: "score 0", minutes: 30 }, { band: "score 1", minutes: 0 }, { band: "score 2", minutes: 15 }, { band: "score 3", minutes: 30 },
    ]);
    expect(timeInBands([2, 5, 6, 7, 9, null], 60, totalBand, TOTAL_BANDS)).toEqual([{ band: "0 to 4", minutes: 60 }, { band: "5 or 6", minutes: 120 }, { band: "7 or more", minutes: 120 }]);
  });

  it("a window is the series' last points for that long", () => {
    const s: Series = { name: "x", stepMin: 15, values: [1, 2, 3, 4, 5, 6, 7, 8] };
    expect(inWindow(s, 60)).toEqual([5, 6, 7, 8]);
    expect(inWindow(s, null)).toHaveLength(8);
    expect(inWindow({ ...s, stepMin: 60 }, 180)).toEqual([6, 7, 8]);
    expect(WINDOWS.map(([w]) => w)).toEqual(["Last 1 h", "Last 3 h", "Last 6 h", "Last 12 h", "Last 24 h", "All the page holds"]);
  });
});

describe("a figure made large", () => {
  it("normally no figure is large, and a figure with a chart offers it", () => {
    const html = page(null);
    expect(html).not.toContain('class="fig enlarged"');
    expect(html).not.toContain("<table");
    expect([...html.matchAll(/<button type="button" aria-expanded="false">Larger, with numbers<\/button>/g)]).toHaveLength(2); // NEWS2 by hour and the vitals: the two with data here
  });

  it("a figure with nothing to draw offers nothing", () => {
    const html = renderToStaticMarkup(<Insights mode="viewer" summary={null} patients={[]} label={(m) => `${m}`} />);
    expect(html).not.toContain("Larger, with numbers"); // "Not served" and "No data yet" figures have no chart to enlarge
  });

  it("the large vitals figure keeps its charts and adds the numbers: readings, last, lowest, middle, highest and the time in each score band", () => {
    const html = page("Vitals, last 3 h");
    const fig = big(html);
    expect(html).toContain('<figure class="fig enlarged" role="dialog" aria-label="Vitals, last 3 h, large view">');
    expect([...fig.matchAll(/class="chart obs"/g)]).toHaveLength(5);
    expect(fig).toContain('<button type="button" aria-expanded="true">Close (Esc)</button>');
    expect(fig).toContain("<caption>The numbers behind this chart. A summary of this page, not a NEWS2 practice.</caption>");
    const rows = [...fig.matchAll(/<tr><th scope="row">(.*?)<\/th>(.*?)<\/tr>/g)].map((m) => [m[1], ...[...m[2].matchAll(/<td>(.*?)<\/td>/g)].map((c) => c[1])]);
    expect(rows).toEqual([
      ["Respirations", "6", "26 breaths/min", "16 breaths/min", "22 breaths/min", "26 breaths/min", "score 0: 30 min, score 1: 0 min, score 2: 30 min, score 3: 30 min"],
      ["SpO2 (scale 1)", "6", "91 %", "91 %", "95 %", "97 %", "score 0: 30 min, score 1: 30 min, score 2: 15 min, score 3: 15 min"],
      ["Systolic BP", "3", "96 mmHg", "96 mmHg", "104 mmHg", "118 mmHg", "score 0: 15 min, score 1: 15 min, score 2: 15 min, score 3: 0 min"],
      ["Pulse", "5", "118 beats/min", "88 beats/min", "95 beats/min", "118 beats/min", "score 0: 15 min, score 1: 30 min, score 2: 30 min, score 3: 0 min"],
      ["Temperature", "6", "39.2 °C", "36.8 °C", "37.8 °C", "39.2 °C", "score 0: 45 min, score 1: 30 min, score 2: 15 min, score 3: 0 min"],
    ]);
    expect([...fig.matchAll(/<option value="[^"]*"[^>]*>([^<]+)<\/option>/g)].map((m) => m[1])).toEqual(WINDOWS.map(([w]) => w));
    // Only this figure is large.
    expect([...html.matchAll(/class="fig enlarged"/g)]).toHaveLength(1);
  });

  it("the large NEWS2 figure counts the hours at 0 to 4, at 5 or 6 and at 7 or more", () => {
    const fig = big(page("NEWS2 by hour"));
    expect(text(fig)).toContain("NEWS2 total 7 4 2 5 8 0 to 4: 3 h, 5 or 6: 2 h, 7 or more: 2 h");
  });

  it("Escape closes it before the page's own Escape, and the large view writes nothing and asks nothing", () => {
    const src = readFileSync("src/insights/Insights.tsx", "utf8");
    const effect = src.slice(src.indexOf("if (open === null) return;"), src.indexOf("}, [open]);"));
    expect(effect).toContain('if (e.key !== "Escape") return;');
    expect(effect).toContain("e.preventDefault();"); // the page's key handler ignores a key that was already handled
    expect(effect).toContain('document.addEventListener("keydown", onKey, true);');
    expect(effect).toContain('document.removeEventListener("keydown", onKey, true);');
    expect(src).not.toMatch(/fetch\(|localStorage|sessionStorage/);
    expect(readFileSync("src/App.tsx", "utf8")).toContain("if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;");
  });
});
