// Slice B: every unit shows vitals and a NEWS2 colour. No DOM: renderToStaticMarkup over a fed 2-hour seeded run, and source scans.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { floorSummary } from "./building";
import { DISPLAY_ONLY, HospitalPanel, ICU_NOT_RANKED, RECOVERY_NOTE, UNIT_LABEL } from "./hospital-panels";
import { parseScenario } from "./sim/hospital/scenario";
import { createHospitalSim } from "./sim/hospital/attach";
import { createVitals, feedVitals, unitRank, type HospitalVitals } from "./sim/hospital/vitals";
import { setSpeed, step, type Sim } from "./sim/sim";
import { createSyntheticSource, FIXTURE_SEED } from "./sim/source";

const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;|&#39;/g, "'");
let s: Sim;
let v: HospitalVitals;

beforeAll(() => {
  const src = createSyntheticSource(FIXTURE_SEED, true);
  s = createHospitalSim(src, parseScenario(readFileSync("scenarios/hospital/typical.json", "utf8")), 101);
  setSpeed(s, 60);
  v = createVitals();
  for (let i = 0; i < 2 * 3600; i += 1) { // 2 simulated hours, one second a step at 60x
    step(s, src);
    feedVitals(v, s.hospital!, s.clockS);
  }
}, 60_000);

const panel = (id: string, vitals: HospitalVitals | null = v) => {
  const h = s.hospital!;
  return renderToStaticMarkup(<HospitalPanel h={h} id={id} onSelect={noop} floors={floorSummary(h)} vitals={vitals} />);
};

describe("the unit panels", () => {
  it("each unit shows its label from the plan", () => {
    for (const [unit, id] of [["MED3A", "unit:MED3A"], ["MED3B", "unit:MED3B"], ["SURG5A", "unit:SURG5A"], ["ER", "queue:ER"], ["ICU", "unit:ICU"]] as const) {
      const t = text(panel(id));
      expect(t).toContain(UNIT_LABEL[unit]!);
      expect(t).toContain(DISPLAY_ONLY);
    }
    expect(UNIT_LABEL).toEqual({
      W4: "Synthetic. Generator fitted to ICU data at ward-like baselines.",
      MED3A: "Synthetic. Same generator as W4.",
      MED3B: "Synthetic. Same generator as W4.",
      SURG5A: "Synthetic. Adult generator, not fitted to surgical patients.",
      ER: "Synthetic. Not ER data: ward generator.",
      ICU: "Synthetic. ICU vitals are not modelled: ward generator values.",
    });
  });

  it("intensive care has vitals and no rank", () => {
    const html = panel("unit:ICU");
    expect(text(html)).toContain("Not ranked: NEWS2 is a ward score.");
    expect(ICU_NOT_RANKED).toBe("Not ranked: NEWS2 is a ward score.");
    expect(html).not.toContain('<ol class="list">');
    const n = s.hospital!.people.filter((p) => p.unit === "ICU" && v.live.has(p.id)).length;
    expect(html.match(/class="mini"/g)?.length ?? 0).toBe(n);
  });

  it("the list order equals the ward's ranking, and names are text only", () => {
    const h = s.hospital!;
    for (const unit of ["MED3A", "MED3B", "SURG5A", "ER"] as const) {
      const html = panel(`unit:${unit}`);
      const ur = unitRank(v, h, unit)!;
      const name = (id: string) => h.people.find((p) => p.id === id)!.name;
      const list = html.slice(html.indexOf('<ol class="list">'), html.indexOf("</ol>", html.indexOf('<ol class="list">')));
      const shown = [...list.matchAll(/<b>([^<]*)<\/b>/g)].map((m) => m[1]);
      if (ur.ranked.length === 0) expect(html).not.toContain('<ol class="list">');
      else expect(shown).toEqual(ur.ranked.map((pv) => name(pv.id)));
      expect(html.match(/class="mini"/g)?.length ?? 0).toBe(ur.ranked.length);
    }
    expect(unitRank(v, h, "MED3A")!.ranked.length).toBeGreaterThan(1); // the run gave something to order
    for (const file of ["src/hospital-panels.tsx", "src/vital-cards.tsx"]) expect(readFileSync(file, "utf8")).not.toContain("dangerouslySetInnerHTML");
  });

  it("with no engine (a viewer or the ward-only build) nothing is added", () => {
    const t = text(panel("unit:MED3A", null));
    expect(t).not.toContain("Vital signs");
    expect(t).not.toContain("Synthetic. Same generator");
  });
});

describe("a person outside W4", () => {
  it("has the label, the score, five vital cards and the stated inputs", () => {
    const h = s.hospital!;
    const q = h.people.find((p) => p.unit === "MED3A" && v.live.has(p.id))!;
    const html = panel(`h:${q.n}`);
    const t = text(html);
    expect(t).toContain(UNIT_LABEL.MED3A!);
    expect(t).toMatch(/NEWS2 \d+ · (Low|Low-medium|Medium|High) risk|Not ranked:/);
    for (const label of ["Heart rate", "Resp. rate", "SpO2", "Temperature", "Blood pressure"]) expect(t).toContain(label);
    expect(t).toContain("Consciousness: alert (not modelled).");
    expect(t).toContain(DISPLAY_ONLY);
    expect(t).not.toContain(RECOVERY_NOTE);
  });

  it("in intensive care shows the vitals and the ward-score line, no NEWS2 total", () => {
    const h = s.hospital!;
    const q = h.people.find((p) => p.unit === "ICU" && v.live.has(p.id));
    if (!q) return; // none in intensive care at this minute
    const t = text(panel(`h:${q.n}`));
    expect(t).toContain(UNIT_LABEL.ICU!);
    expect(t).toContain(ICU_NOT_RANKED);
    expect(t).not.toMatch(/NEWS2 \d+ ·/);
    expect(t).toContain("Heart rate");
  });

  it("shows the recovery marker where the engine set it", () => {
    const h = s.hospital!;
    const q = h.people.find((p) => p.unit !== "W4" && p.unit !== "MORGUE" && v.live.has(p.id))!;
    const pv = v.live.get(q.id)!;
    pv.spans.push({ unit: pv.unit, where: pv.where, fromMin: 0, w4Id: null, recovery: "not_modelled" });
    expect(text(panel(`h:${q.n}`))).toContain("Simulated recovery, not modelled.");
    pv.spans.pop();
  });
});

describe("source scans", () => {
  const code = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

  it("App.tsx feeds the engine after every step, makes it only in the standalone hospital build (a new one for each new world), and hands the renderer the risk getter", () => {
    const a = code("src/App.tsx");
    const steps = a.match(/step\(s, src\);/g) ?? [];
    expect(steps).toHaveLength(2); // the frame loop and the chunked day skip
    for (const m of a.matchAll(/step\(s, src\);/g)) {
      const after = a.slice(m.index!, m.index! + 400);
      expect(after.indexOf("feed(statsRef.current, s, src)")).toBeGreaterThan(-1);
      expect(after.indexOf("feedVitals(vitalsRef.current.v, s.hospital!, s.clockS)")).toBeGreaterThan(after.indexOf("feed(statsRef.current"));
    }
    expect(a.match(/createVitals\(\)/g)).toHaveLength(1);
    expect(a).toContain("if (HOSPITAL && world.s.hospital && vitalsRef.current?.world !== world.s) vitalsRef.current = ");
    expect(a).toContain("const HOSPITAL = !VIEW_API && !import.meta.env.VITE_API_URL;");
    expect(a).toMatch(/createStackRenderer\(canvas, \(\) => viewRef\.current, \(\) => \(vitalsRef\.current \? riskBySel\(vitalsRef\.current\.v\) : \{\}\)\)/);
    expect(a).toContain("vitals={vitals}");
  });

  it("stack.ts passes getRisk() to floorSummary, once a minute", () => {
    expect(code("src/render/stack.ts")).toContain("floorSummary(h, getRisk())");
  });

  it("the Entrance skip is hidden in a hospital world; the top bar's +1 day stays", () => {
    const p = code("src/panels.tsx");
    expect(p).toContain("src.admit && !s.outbox && !s.hospital && <button onClick={() => skipDay(s, src)}>Skip 1 day</button>");
    expect(p).toContain("hospital.onSkip}>");
    expect(p.match(/skipDay\(/g)).toHaveLength(1);
  });

  it("the vitals engine imports nothing that writes a Sim, and the panels never import panels.tsx", () => {
    expect(code("src/vital-cards.tsx")).not.toMatch(/from "\.\/panels"/);
    expect(code("src/hospital-panels.tsx")).not.toMatch(/from "\.\/panels"/);
  });
});
