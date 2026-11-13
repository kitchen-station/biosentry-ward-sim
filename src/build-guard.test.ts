import { describe, expect, it } from "vitest";
import { buildGuard, isCustomerSource, isDevModule, namesDevPath } from "../build-guard";

const ROOT = "/repo";
const fail = (m: string): never => {
  throw new Error(m);
};
const ctx = { error: fail };
const guard = () => {
  const p = buildGuard() as unknown as { configResolved: (c: { root: string }) => void; load: (this: typeof ctx, id: string) => unknown; transform: (this: typeof ctx, code: string, id: string) => unknown };
  p.configResolved({ root: ROOT });
  return p;
};
const load = (id: string) => guard().load.call(ctx, id);
const transform = (code: string, id = `${ROOT}/src/App.tsx`) => guard().transform.call(ctx, code, id);

describe("the customer build guard: load", () => {
  it("refuses every module of the developer page or the data, in any spelling", () => {
    for (const id of [
      `${ROOT}/src/analytics/sections.tsx`,
      `${ROOT}/src/analytics/analytics.css`,
      `${ROOT}/src/analytics/x.mjs`,
      `${ROOT}/src/data/evaluation/sync.json`,
      `${ROOT}/src/data/evaluation/sync.json?raw`,
      `${ROOT}/src/data/evaluation/sync.json?url`,
      `${ROOT}/src/data/evaluation/repo/models/manifest.json?inline`,
      `${ROOT}\\src\\analytics\\data.ts`,
    ])
      expect(() => load(id), id).toThrow(/developer page module in the customer build: /);
  });
  it("lets other modules load", () => {
    for (const id of [`${ROOT}/src/App.tsx`, `${ROOT}/src/sim/ward-stats.ts`, `${ROOT}/src/insights/Insights.tsx`, `${ROOT}/docs/analytics.md`, `${ROOT}/src/analytics-not/x.ts`, "\0virtual", `${ROOT}/node_modules/react/index.js`])
      expect(load(id), id).toBeNull();
  });
  it("knows the folders by prefix, not by substring", () => {
    expect(isDevModule(`${ROOT}/src/analyticsX/a.ts`, ROOT)).toBe(false);
    expect(isDevModule(`/other/src/analytics/a.ts`, ROOT)).toBe(false);
  });
});

describe("the customer build guard: transform", () => {
  it("refuses a customer file that names a path into the developer page or the data", () => {
    for (const code of [
      'import x from "../../data/evaluation/sync.json";',
      'import { Tag } from "../../analytics/sections";',
      'import("./analytics/Analytics");',
      "new URL(`./data/evaluation/sync.json`, import.meta.url)",
      'const p = "./data/" + "evaluation"; const q = "src/data/evaluation/" + name;',
      'import.meta.glob("../data/evaluation/**/*.json")',
      'import "./analytics/analytics.css";',
    ])
      expect(() => transform(code), code).toThrow(/developer page path in the customer build: src\/App\.tsx names/);
  });
  it("catches a path with the wrong letter case, as macOS and Windows resolve it", () => {
    expect(() => load(`${ROOT}/src/Analytics/sections.tsx`)).toThrow(/developer page module in the customer build/);
    expect(() => load(`${ROOT}/src/Data/Evaluation/pipeline.json`)).toThrow(/developer page module in the customer build/);
    expect(() => transform('import { Tag } from "./Analytics/sections";')).toThrow(/names "\.\/Analytics\/"/);
    expect(() => transform('import p from "./Data/Evaluation/pipeline.json";')).toThrow(/names "Data\/Evaluation"/);
  });
  it("does not refuse a URL that ends in analytics/", () => {
    for (const code of ['fetch("/wards/W4/analytics/")', "fetch(`${base}/analytics/${x}`)", 'fetch("/wards/W4/analytics")']) expect(transform(code), code).toBeNull();
  });
  it("lets innocent text through", () => {
    for (const code of ['location.hash = "#analytics";', "the ward analytics page", 'import { I } from "./insights/Insights";', 'const a = "analytics";', "docs/analytics.md"]) expect(transform(code), code).toBeNull();
    expect(namesDevPath("x")).toBeNull();
  });
  it("checks customer source only", () => {
    expect(isCustomerSource(`${ROOT}/src/sim/ward-stats.ts`, ROOT)).toBe(true);
    expect(isCustomerSource(`${ROOT}/src/analytics/data.ts`, ROOT)).toBe(false);
    expect(isCustomerSource(`${ROOT}/node_modules/x/analytics/a.js`, ROOT)).toBe(false);
    expect(isCustomerSource(`${ROOT}/build-guard.ts`, ROOT)).toBe(false);
    expect(isCustomerSource("\0x", ROOT)).toBe(false);
    // the developer page's own files may name their paths
    expect(transform('import.meta.glob("../data/evaluation/*.json")', `${ROOT}/src/analytics/data.ts`)).toBeNull();
  });
});
