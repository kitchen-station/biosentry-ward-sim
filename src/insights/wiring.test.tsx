import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnalyticsBoundary } from "./Boundary";
import { TopBar } from "../panels";
import { createSim } from "../sim/sim";
import { createSyntheticSource, FIXTURE_SEED } from "../sim/source";

const src = createSyntheticSource(FIXTURE_SEED, true);
const s = createSim(src);
const app = readFileSync("src/App.tsx", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("the view switch", () => {
  it("is two links to the simulation and Analytics, and the page shown is marked", () => {
    const bar = renderToStaticMarkup(<TopBar s={s} src={src} notice={null} page="analytics" />);
    expect([...bar.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(["#simulation", "#analytics"]);
    expect(bar).toContain('href="#analytics" aria-current="page"');
    expect(bar).not.toMatch(/dev/i);
  });

  it("is left out when no page is given", () => {
    expect(renderToStaticMarkup(<TopBar s={s} src={src} notice={null} />)).not.toContain("<nav");
  });
});

describe("App.tsx", () => {
  it("feeds the stats after every step, in the frame loop and in the day skip, and makes new ones with a new world", () => {
    expect(app.match(/\bfeed\(/g)).toHaveLength(2);
    expect(app.match(/step\(s, src\);\s*feed\(statsRef\.current, s, src\);/g)).toHaveLength(2);
    // The frame loop feed sits in the branch that is not a viewer's.
    expect(app).toMatch(/if \(!VIEW_API && !skippingRef\.current\) \{\s*step\(s, src\);\s*feed\(/);
    expect(app).toMatch(/statsRef\.current = createWardStats\(\);\s*setWorld\(newWorld\(next\)\)/);
  });

  it("loads the page only when it is opened, keeps the ward mounted, and never feeds a viewer", () => {
    expect(app).toContain('import("./insights/Insights")');
    expect(app).toContain("lazy(loadInsights)");
    expect(app.match(/import\(/g)).toHaveLength(1);
    expect(app).toContain("{page === \"analytics\" && (");
    expect(app).toContain('hidden={page === "analytics"}');
    expect(app).toContain("summary={VIEW_API ? null : summary(statsRef.current)}");
    expect(app).toContain("!VIEW_API && !skippingRef.current");
  });

  it("shows a watcher only the sign-in line", () => {
    const at = app.indexOf("{watch ? (");
    expect(app.slice(at, at + 150)).toContain("Sign in to see ward analytics");
  });

  it("puts Suspense inside the Analytics error boundary, and the boundary only around that view", () => {
    const at = app.indexOf("<AnalyticsBoundary");
    expect(at).toBeGreaterThan(app.indexOf('{page === "analytics" && ('));
    expect(app.indexOf("<Suspense")).toBeGreaterThan(at);
    expect(app.indexOf("</Suspense>")).toBeLessThan(app.indexOf("</AnalyticsBoundary>"));
    expect(app.match(/<AnalyticsBoundary/g)).toHaveLength(1);
    expect(app).not.toMatch(/src\/analytics|\.\/analytics/);
  });
});

describe("the Analytics error boundary", () => {
  it("fails to a line, and tries again on a new mount", () => {
    expect(AnalyticsBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const b = new AnalyticsBoundary({ children: null });
    expect(renderToStaticMarkup(<>{b.render()}</>)).toBe("");
    b.state = { failed: true };
    expect(renderToStaticMarkup(<>{b.render()}</>)).toContain("Could not show analytics");
    expect(new AnalyticsBoundary({ children: null }).state).toEqual({ failed: false });
  });
});
