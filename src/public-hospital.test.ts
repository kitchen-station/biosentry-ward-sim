import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createSim } from "./sim/sim";
import { createSyntheticSource, FIXTURE_SEED } from "./sim/source";

const { TopBar } = await import("./panels");
const s = createSim(createSyntheticSource(FIXTURE_SEED, true));
const src = createSyntheticSource(FIXTURE_SEED, true);
const bar = (props: object) => renderToStaticMarkup(createElement(TopBar, { s, src, notice: null, ...props } as never));
const hospital = { skipping: false, onSkip: () => {}, scenario: "pitch", scenarios: [], onScenario: () => {}, seedText: "seed" };

describe("the public page's link to the hospital", () => {
  it("shows a Hospital link only when given an address", () => {
    expect(bar({ hospitalHref: "/hospital/" })).toContain('<a href="/hospital/">Hospital</a>');
    expect(bar({})).not.toContain("<a href");
  });
  it("App passes the address to a viewer build only", () => {
    expect(readFileSync("src/App.tsx", "utf8")).toContain("hospitalHref={VIEW_API ? `${import.meta.env.BASE_URL}hospital/` : undefined}");
  });
  it("the hospital page as deployed has a link back to the ward page, and no other page does", () => {
    expect(bar({ backHref: "/" })).toContain('<a href="/">Back to ward W4</a>');
    expect(bar({})).not.toContain("Back to ward W4");
    expect(readFileSync("src/App.tsx", "utf8")).toContain('backHref={HOSPITAL && import.meta.env.BASE_URL === "/hospital/" ? "/" : undefined}');
  });
  it("the hospital page says it is simulated in the browser, not the server's ward", () => {
    expect(bar({ hospital })).toContain("Simulated in your browser, not the server&#x27;s ward W4");
    expect(bar({})).not.toContain("Simulated in your browser");
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
