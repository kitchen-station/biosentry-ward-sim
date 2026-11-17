import { existsSync, readdirSync, readFileSync } from "node:fs";
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
  it("no source file the public build ships says demo", () => {
    // Every non-test file under src. Left out, each for a stated reason:
    //  - src/data/evaluation and src/analytics: the developer build only; the build guard keeps them out of the public build.
    //  - src/sim/synthetic.json: the other repository's sample ward, copied as it is. Its two "demo" fields are not read by any page (checked below).
    //  - the dataset's own name, "eICU-CRD Demo".
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
    const shipped = walk("src").filter((f) => !/\.test\.(ts|tsx|mjs)$/.test(f) && !f.startsWith("src/data/evaluation/") && !f.startsWith("src/analytics/") && f !== "src/sim/synthetic.json");
    expect(shipped.length).toBeGreaterThan(60);
    const hits = shipped.filter((f) => /demo/i.test(readFileSync(f, "utf8").replace(/eICU-CRD Demo|eicu-crd-demo/g, "")));
    expect(hits).toEqual([]);
    // The fixture's two fields that hold the word are never read: no source names them.
    const code = shipped.filter((f) => /\.tsx?$/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(code).not.toMatch(/Mechanism axes|fixture\.[\w.[\]]*mechanism|fx\.[\w.[\]]*mechanism/);
  });
  it("the standalone page, now a developer's page, still says it is simulated in the browser", () => {
    expect(bar({ hospital })).toContain(">Local simulation</span>");
    expect(bar({ hospital })).toContain("It is not the server&#x27;s run.");
    expect(bar({})).not.toContain("Local simulation");
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

describe("the old /hospital/ address", () => {
  it("redirects to the one page, and no file here sets a cache time on any page", () => {
    // Cloudflare Pages reads public/_redirects from the upload. Without it an unknown path answers 200 with the root page.
    expect(readFileSync("public/_redirects", "utf8")).toBe("/hospital /  301\n/hospital/* /  301\n");
    // The 7-day `s-maxage` seen on the old page was Cloudflare's own, for files of an earlier deployment: this repository has no _headers file.
    expect(existsSync("public/_headers")).toBe(false);
    expect(readdirSync("public")).toEqual(["_redirects"]);
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
