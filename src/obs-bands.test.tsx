// The observation charts: the bands they shade are the scorer's own, the axis is fixed, a gap stays a gap.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EcgStrip } from "./ecg";
import { LineChart, ObsChart } from "./insights/charts";
import { OBS, obsScore, obsSpans, SCORE_COLOUR, summarise, TOTAL, type ObsVital } from "./obs-bands";
import { stayNumbers } from "./panels";
import { scoreNews2, type News2Inputs } from "./sim/news2";

const NORMAL: News2Inputs = { respiratory_rate: 16, spo2: 98, spo2_scale: 1, supplemental_o2: false, systolic_bp: 120, heart_rate: 70, consciousness: "A", temperature: 37.0 };
const scored = (inputs: Partial<News2Inputs>) => {
  const r = scoreNews2({ ...NORMAL, ...inputs });
  if (r.kind !== "score") throw new Error("abstained");
  return r;
};
const VITALS = Object.keys(OBS) as ObsVital[];

describe("the bands an observation chart shades", () => {
  it("are the scorer's: every value on every axis gets the score the scorer gives it", () => {
    let checked = 0;
    for (const vital of VITALS) {
      const { lo, hi, step } = OBS[vital];
      for (let i = 0; i <= Math.round((hi - lo) / step); i += 1) {
        const value = Number((lo + i * step).toFixed(1));
        const want = scored({ [vital]: value }).parameters.find((p) => p.parameter === vital)!.score;
        expect([vital, value, obsScore(vital, value)]).toEqual([vital, value, want]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(400);
  });

  it("cover each axis from bottom to top with no hole, and each band ends half a step above its highest value", () => {
    for (const vital of VITALS) {
      const spans = obsSpans(vital);
      expect(spans[0].from).toBe(OBS[vital].lo);
      expect(spans.at(-1)!.to).toBe(OBS[vital].hi);
      spans.slice(1).forEach((s, i) => expect(s.from).toBe(spans[i].to));
    }
    expect(obsSpans("respiratory_rate").map((s) => [s.from, s.to, s.score])).toEqual([[4, 8.5, 3], [8.5, 11.5, 1], [11.5, 20.5, 0], [20.5, 24.5, 2], [24.5, 36, 3]]);
    expect(obsSpans("temperature")[0]).toEqual({ from: 34, to: 35.05, score: 3 });
  });

  it("the total's marks are the scorer's: 5 or 6 is medium, 7 or more is high", () => {
    const total = (inputs: Partial<News2Inputs>) => { const r = scored(inputs); return [r.total, r.risk]; };
    expect(total({ heart_rate: 115, respiratory_rate: 22 })).toEqual([TOTAL.mediumFrom - 1, "low"]); // 2 + 2
    expect(total({ heart_rate: 115, respiratory_rate: 22, temperature: 38.5 })).toEqual([TOTAL.mediumFrom, "medium"]);
    expect(total({ heart_rate: 115, respiratory_rate: 22, temperature: 39.5 })).toEqual([TOTAL.highFrom - 1, "medium"]);
    expect(total({ heart_rate: 115, respiratory_rate: 22, temperature: 39.5, systolic_bp: 105 })).toEqual([TOTAL.highFrom, "high"]);
  });

  it("the numbers behind a chart: count, last, lowest, highest, middle; gaps are not counted", () => {
    expect(summarise([3, null, 9, "skip", 5, 1])).toEqual({ count: 4, last: 1, min: 1, max: 9, median: 4 });
    expect(summarise([null, "skip"])).toEqual({ count: 0, last: null, min: null, max: null, median: null });
  });
});

describe("one vital as an observation chart", () => {
  const spec = OBS.respiratory_rate;
  const draw = (values: (number | null | "skip")[]) =>
    renderToStaticMarkup(
      <ObsChart values={values} lo={spec.lo} hi={spec.hi} unit={spec.unit} label={spec.label} times={["45 min ago", "23 min ago", "now"]} height={120}
        bands={obsSpans("respiratory_rate").map((b) => ({ from: b.from, to: b.to, colour: b.score === 0 ? null : SCORE_COLOUR[b.score] }))}
        ticks={spec.bands.flatMap((b) => (b.upTo === null ? [] : [b.upTo]))} />,
    );
  const html = draw([16, 18, null, 22, 26]);

  it("shades the score bands in the RCP key and leaves score 0 unshaded", () => {
    expect([...html.matchAll(/<rect[^>]*fill="(#[0-9A-F]{6})"/g)].map((m) => m[1])).toEqual([SCORE_COLOUR[3], SCORE_COLOUR[1], SCORE_COLOUR[2], SCORE_COLOUR[3]]);
  });

  it("prints the unit, the band limits as axis numbers, the times and the last value", () => {
    const texts = [...html.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
    expect(texts).toEqual(["8", "11", "20", "24", "breaths/min", "last 26", "45 min ago", "23 min ago", "now"]);
    expect(html).toContain('aria-label="Respirations: last 26 breaths/min, 4 readings"');
  });

  it("marks every band limit but prints a number only where it has room, so close limits never overprint", () => {
    const bp = OBS.systolic_bp;
    const h = renderToStaticMarkup(<ObsChart values={[120]} lo={bp.lo} hi={bp.hi} unit={bp.unit} label={bp.label} height={120} bands={[]} ticks={bp.bands.flatMap((b) => (b.upTo === null ? [] : [b.upTo]))} />);
    expect([...h.matchAll(/<text[^>]*text-anchor="end"[^>]*>(\d+)<\/text>/g)].map((m) => m[1])).toEqual(["90", "110", "219"]); // 100 is 6 px from 90
    expect([...h.matchAll(/<line x1="27" x2="30"/g)]).toHaveLength(4); // all four limits are marked
  });

  it("puts a dot at every reading and joins only readings that follow each other: a missing one is a gap", () => {
    expect([...html.matchAll(/<circle /g)]).toHaveLength(4);
    const lines = [...html.matchAll(/<polyline points="([^"]+)"/g)].map((m) => m[1].split(" ").length);
    expect(lines).toEqual([2, 2]); // 16-18, then 22-26: nothing bridges the missing reading
    expect(draw([16, null, 18])).not.toContain("<polyline"); // two lone readings: two dots, no line
  });

  it("keeps a value at the same height whatever else is drawn, and draws one off the axis hollow on its edge", () => {
    const y = (h: string, i: number) => Number([...h.matchAll(/<circle cx="[^"]+" cy="([^"]+)"/g)][i][1]);
    expect(y(draw([16, 17, 16]), 0)).toBe(y(draw([16, 35, 5]), 0));
    const off = draw([16, 60]);
    expect(off).toMatch(/<circle[^>]*r="2.5" fill="none"/);
    expect(y(off, 1)).toBe(12); // the top edge of the plot
    expect(renderToStaticMarkup(<ObsChart values={[]} lo={0} hi={1} bands={[]} ticks={[]} unit="x" label="Empty" />)).toContain('aria-label="Empty: no reading"');
  });
});

describe("a count over time, a stay's scores and the heart trace", () => {
  it("a count chart numbers its axis from 0, marks the dashed level, names what is counted and prints the last value", () => {
    const html = renderToStaticMarkup(<LineChart values={[3, 7, null, 5]} refLine={10} unit="beds" label="Beds in use" />);
    expect([...html.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1])).toEqual(["0", "10", "beds", "last 5"]);
    expect(html).toContain('stroke-dasharray="3 3"');
  });

  it("a stay's score line comes with its numbers", () => {
    expect(stayNumbers([2, null, 7, 4])).toBe("last 4 · low 2 · high 7 · 3 hourly scores");
    expect(stayNumbers([5])).toBe("last 5 · low 5 · high 5 · 1 hourly score");
    expect(stayNumbers([null])).toBe("no score yet");
  });

  it("the heart trace says on the strip that it is an illustration, not a recording", () => {
    const html = renderToStaticMarkup(<EcgStrip hr={72} clockS={100} irregular={false} ectopyPerHour={0} />);
    expect(html).toContain(">Illustration, not a recording</text>");
    expect(html).toContain('aria-label="Illustration of a heart trace, drawn from the heart rate. Not a recording."');
    expect(html).not.toContain("aria-hidden");
  });
});
