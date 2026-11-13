import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
    expect(app.match(/step\(s, src\);\s*feed\(statsRef\.current, s, src\);/g)).toHaveLength(2);
    expect(app).toMatch(/statsRef\.current = createWardStats\(\);\s*setWorld\(newWorld\(name\)\)/);
  });

  it("loads the page only when it is opened, keeps the ward mounted, and never feeds a viewer", () => {
    expect(app).toContain('lazy(() => import("./insights/Insights"))');
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
});
