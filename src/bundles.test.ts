import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build as viteBuild } from "vite";
import { describe, expect, it } from "vitest";
import { FILES } from "./analytics/data";

const EVAL = "src/data/evaluation";
const list = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(join(d, e.name)) : [join(d, e.name)]));
const build = (args: string[], out: string) => {
  execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build", ...args, "--outDir", out, "--emptyOutDir", "--logLevel", "warn"], { stdio: "pipe" });
  return list(out).map((f) => ({ name: f.slice(out.length + 1), text: readFileSync(f, "utf8") }));
};

// One marker per evaluation file, read from the file: its longest plain string of 20+ characters, else its longest key of 12+.
// A candidate that the customer source also contains is skipped, so the marker is the data's own.
const customerSource = () => list("src").filter((f) => /\.(tsx?|css)$/.test(f) && !f.startsWith("src/analytics/") && !f.startsWith("src/data/") && !f.includes(".test.") && f !== "src/dev-main.tsx").map((f) => readFileSync(f, "utf8")).join("\n");
const PLAIN = /^[\x20-\x7e]+$/;
function dataMarkers(): { file: string; marker: string; skipped: number }[] {
  const others = customerSource();
  return list(EVAL).filter((f) => f.endsWith(".json")).map((file) => {
    const strings: string[] = [];
    const keys: string[] = [];
    const visit = (v: unknown) => {
      if (typeof v === "string") strings.push(v);
      else if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (keys.push(k), visit(x));
    };
    visit(JSON.parse(readFileSync(file, "utf8")));
    const ok = (t: string) => PLAIN.test(t) && !/["\\]/.test(t);
    const byLength = (xs: string[], n: number) => [...new Set(xs)].filter((t) => t.length >= n && ok(t)).sort((x, y) => y.length - x.length);
    const candidates = [...byLength(strings, 20), ...byLength(keys, 12)];
    const i = candidates.findIndex((c) => !others.includes(c));
    return { file, marker: candidates[i] ?? "", skipped: i };
  });
}

const DEV = ["Developer page", "Build records of the project", "biosentry-evaluation/"];
const SIM = ["Sign in", "No live ward yet"];
// The developer page's own styles, as built.
const DEV_CSS = ".analytics";

describe("the two builds", () => {
  it("the customer bundle has no developer page and no evaluation data; the developer bundle has no ward", { timeout: 180_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "bundles-"));
    try {
      const data = dataMarkers();
      expect(data).toHaveLength(list(EVAL).filter((f) => f.endsWith(".json")).length);
      for (const d of data) expect(d.marker, `no marker for ${d.file}`).not.toBe("");
      const skipped = data.filter((d) => d.skipped > 0).map((d) => `${d.file} (${d.skipped})`);
      if (skipped.length) console.info("markers that skipped a candidate:", skipped.join(", "));
      // Every file must stay out of the customer bundle. Only the files the page loads must be in the developer bundle.
      const loaded = data.filter((d) => d.file.slice(EVAL.length + 1) in FILES).map((d) => d.marker);
      expect(loaded.length).toBeGreaterThan(0);
      const all = [...DEV, DEV_CSS, ...data.map((d) => d.marker)];
      const inDev = [...DEV, DEV_CSS, ...loaded];
      const customer = build([], join(root, "customer"));
      const dev = build(["--config", "vite.dev.config.ts"], join(root, "dev"));
      expect(customer.some((f) => f.name.endsWith(".js"))).toBe(true);
      expect(dev.map((f) => f.name)).toContain("index.html");
      for (const f of customer) {
        expect(f.name, "chunk name").not.toMatch(/analytics|evaluation|developer/i);
        for (const m of all) expect(f.text.includes(m), `${f.name} has "${m}"`).toBe(false);
      }
      for (const m of inDev) expect(dev.some((f) => f.text.includes(m)), `dev bundle lacks "${m}"`).toBe(true);
      for (const m of SIM) {
        expect(customer.some((f) => f.text.includes(m)), `customer bundle lacks "${m}"`).toBe(true);
        for (const f of dev) expect(f.text.includes(m), `${f.name} has "${m}"`).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The build plugin (build-guard.ts) is the real guard. These builds go through it and must fail.
describe("the customer build refuses developer modules", () => {
  const tryBuild = async (code: string) => {
    const dir = mkdtempSync(join(tmpdir(), "guard-"));
    try {
      const entry = join(dir, "entry.ts");
      writeFileSync(entry, code);
      await viteBuild({ configFile: "vite.config.ts", logLevel: "silent", build: { write: false, rollupOptions: { input: entry } } });
      return "built";
    } catch (e) {
      return String((e as Error).message);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const JSON_PATH = join(process.cwd(), EVAL, "sync.json");
  it("refuses one named export of a data file, by absolute path", { timeout: 60_000 }, async () => {
    expect(await tryBuild(`import { commit } from ${JSON.stringify(JSON_PATH)};\nconsole.log(commit);`)).toContain("developer page module in the customer build: src/data/evaluation/sync.json");
  });
  it("refuses a module of the developer page", { timeout: 60_000 }, async () => {
    expect(await tryBuild(`import { Tag } from ${JSON.stringify(join(process.cwd(), "src/analytics/sections.tsx"))};\nconsole.log(Tag);`)).toContain("developer page module in the customer build: src/analytics/sections.tsx");
  });
  it("builds a clean entry (the harness itself works)", { timeout: 60_000 }, async () => {
    expect(await tryBuild("console.log(1);")).toBe("built");
  });
});
