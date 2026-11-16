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

describe("the public page's switch between the two worlds", () => {
  const worlds = { here: "ward", ward: "/", hospital: "/hospital/" } as const;
  it("shows a two-way switch with each world named, the one on screen pressed", () => {
    const html = bar({ worlds });
    expect(html).toContain("Live ward W4 (server)");
    expect(html).toContain("Whole hospital (demo in your browser)");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Live ward W4 \(server\)/);
    expect(bar({ worlds: { ...worlds, here: "hospital" } })).toMatch(/aria-pressed="true"[^>]*>Whole hospital/);
    expect(bar({})).not.toContain("Live ward W4 (server)");
  });
  it("each world has its own clock label", () => {
    expect(bar({ worlds })).toContain("Server ward clock");
    expect(bar({ worlds: { ...worlds, here: "hospital" } })).toContain("Demo hospital clock");
  });
  it("App gives the switch to the viewer build and to the hospital page as deployed, and to no other page", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    // Watching a server that runs the whole hospital, the page is that hospital and shows no switch.
    expect(app).toContain('worlds={watch && hosp ? undefined : VIEW_API ? { here: "ward", ward: import.meta.env.BASE_URL, hospital: `${import.meta.env.BASE_URL}hospital/` } : HOSPITAL && import.meta.env.BASE_URL === "/hospital/" ? { here: "hospital", ward: "/", hospital: import.meta.env.BASE_URL } : undefined}');
  });
  it("the hospital page says it is simulated in the browser, not the server's ward", () => {
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
    expect(html).toContain("walk a loop. That loop is demo design");
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

describe("the deploy builds the hospital page with no API address and no key", () => {
  const yml = readFileSync(".github/workflows/ci.yml", "utf8").split("\n");
  const at = yml.findIndex((l) => l.trim() === "- run: npm run build:hospital");
  const next = yml.findIndex((l, i) => i > at && l.trim().startsWith("- "));
  it("has the step after the ward page's build and before the upload, with no env block", () => {
    const build = yml.findIndex((l) => l.trim() === "- run: npm run build");
    const upload = yml.findIndex((l) => l.includes("wrangler"));
    expect(build).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(build);
    expect(next).toBe(upload);
    expect(yml.slice(at, next).join("\n")).not.toMatch(/env:|VITE_[A-Z_]+\s*:/);
  });
  it("no workflow line sets the ingest key or the dashboard feed address", () => {
    expect(yml.filter((l) => /^\s*VITE_(INGEST_KEY|API_URL)\s*:/.test(l))).toEqual([]);
  });
  it("the script builds under /hospital/ into dist/hospital, so the ward page's files are not replaced", () => {
    const script = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts["build:hospital"];
    expect(script).toContain("--base /hospital/");
    expect(script).toContain("--outDir dist/hospital");
  });
});
