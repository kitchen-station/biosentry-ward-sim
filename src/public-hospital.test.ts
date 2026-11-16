import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createSim } from "./sim/sim";
import { createSyntheticSource, FIXTURE_SEED } from "./sim/source";

const { Inspector, TopBar } = await import("./panels");
const s = createSim(createSyntheticSource(FIXTURE_SEED, true));
const src = createSyntheticSource(FIXTURE_SEED, true);
const bar = (props: object) => renderToStaticMarkup(createElement(TopBar, { s, src, notice: null, ...props } as never));
const hospital = { skipping: false, onSkip: () => {}, scenario: "pitch", scenarios: [], onScenario: () => {}, seedText: "seed" };

describe("the public page is one page: no switch between worlds", () => {
  it("the top bar has no switch and no second clock label, whatever it is given", () => {
    for (const html of [bar({}), bar({ onSignIn: () => {} }), bar({ serverHospital: true }), bar({ hospital })]) {
      expect(html).not.toMatch(/Live ward W4 \(server\)|Whole hospital|aria-label="World"|Server ward clock|hospital clock/);
    }
  });
  it("no page code holds the switch or a link to /hospital/", () => {
    const [app, panels] = ["src/App.tsx", "src/panels.tsx"].map((f) => readFileSync(f, "utf8"));
    expect(app).not.toMatch(/worlds=|hospital\/`|"\/hospital\/"/);
    expect(panels).not.toMatch(/\bWORLDS\b|\bworlds\b|location\.assign/);
  });
  it("the pages a visitor or a clinician sees never say demo", () => {
    for (const f of ["src/App.tsx", "src/panels.tsx", "src/open-panels.tsx", "src/open-hospital.ts", "src/hospital-panels.tsx", "src/vital-cards.tsx", "src/person-timeline.tsx"]) expect([f, /demo/i.test(readFileSync(f, "utf8"))]).toEqual([f, false]);
  });
  it("the standalone page, now a developer's page, still says it is simulated in the browser", () => {
    expect(bar({ hospital })).toContain("Simulated in your browser, not the server&#x27;s ward W4");
    expect(bar({})).not.toContain("Simulated in your browser");
  });
});

describe("the side panel when watching", () => {
  const panel = (sim: typeof s, selected: string | null) => renderToStaticMarkup(createElement(Inspector, { s: sim, src, selected, onSelect: () => {}, onTimeline: () => {}, watching: true }));
  it("lists the beds highest rank first, and says what the page is, the speed in words, and where the dashboard is", () => {
    const n = s.patients.length;
    const sim = { ...s, speed: 10 as const, patients: s.patients.map((p, i) => ({ ...p, rank: n - i })) };
    const html = panel(sim, null);
    const order = [...html.matchAll(/Bed (\S+?)( ·|<)/g)].map((m) => m[1]);
    expect(order).toEqual([...s.patients].reverse().map((p) => p.bed)); // rank n-i: the last patient is rank 1
    expect(html).toContain("running live on the team server at 10x: 1 minute here is 10 ward minutes");
    expect(html).toContain("walk a set loop. It is not a product feature.");
  });
  it("a chosen bed shows its risk and rank and no name or vitals, with a way back", () => {
    const p = s.patients[0];
    const html = panel(s, `bed:${p.bed}`);
    expect(html).toContain(`Bed ${p.bed}`);
    expect(html).toContain("Back to the list");
    expect(html).toContain("Sign in to see this patient&#x27;s vitals.");
    expect(html).not.toContain(p.name);
  });
});

describe("the deploy uploads one page", () => {
  const yml = readFileSync(".github/workflows/ci.yml", "utf8").split("\n");
  it("builds the ward page and uploads it, with no second build between them", () => {
    const upload = yml.findIndex((l) => l.includes("wrangler"));
    const build = yml.findLastIndex((l, i) => i < upload && l.trim() === "- run: npm run build"); // the deploy job's own build, not the test job's
    expect(build).toBeGreaterThan(0);
    expect(yml.findIndex((l, i) => i > build && l.trim().startsWith("- "))).toBe(upload);
    expect(yml.join("\n")).not.toMatch(/build:hospital|dist\/hospital/);
  });
  it("no workflow line sets the ingest key or the dashboard feed address", () => {
    expect(yml.filter((l) => /^\s*VITE_(INGEST_KEY|API_URL)\s*:/.test(l))).toEqual([]);
  });
  it("no script builds a page under /hospital/", () => {
    const scripts = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(Object.keys(scripts)).not.toContain("build:hospital");
    expect(Object.values(scripts).join(" ")).not.toContain("--base /hospital/");
  });
});
