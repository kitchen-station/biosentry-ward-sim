// The command line, run as a real process so exit codes and "writes nothing" are what a user sees.
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Every test here starts real node processes: a few seconds alone, far more on a busy machine. Only the time limit is raised.
vi.setConfig({ testTimeout: 60_000 });

let root: string, bin: string;
const SCEN = "scenarios/hospital/typical.json";
const run = (args: string[], env: Record<string, string> = {}, entry = bin) =>
  spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL", env: { PATH: process.env.PATH ?? "", ...env } });
const good = (out: string) => ["--scenario", SCEN, "--seed", "101", "--days", "1", "--out", out];
const refused = (r: ReturnType<typeof run>) => { expect(r.status).toBe(2); expect(r.stderr.trimEnd().split("\n")).toHaveLength(1); expect(r.stdout).toBe(""); };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hospital-trial-"));
  execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--ssr", "src/hospital-trial.ts", "--outDir", join(root, "dist"), "--emptyOutDir", "--logLevel", "warn"], { stdio: "pipe" });
  bin = join(root, "dist", "hospital-trial.js");
}, 120_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("hospital-trial command", () => {
  it("writes the four files and works through a symlink; the commit comes only from TRIAL_SIM_COMMIT", () => {
    const out = join(root, "ok");
    const link = join(root, "link.js");
    symlinkSync(bin, link);
    const r = run(good(out), { TRIAL_SIM_COMMIT: "abc1234" }, link);
    expect(r.status).toBe(0);
    expect(readdirSync(root).filter((n) => n.includes(".tmp-"))).toEqual([]);
    expect(readdirSync(out).sort()).toEqual(["events.csv", "hourly.csv", "manifest.json", "summary.json"]);
    const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(m).toMatchObject({ format_version: 1, synthetic: true, seed: 101, days: 1, speed: 60, warm_up_days: 3, sim_commit: "abc1234", hourly_rows: 168 });
    expect(m.scenario_sha256).toMatch(/^[0-9a-f]{64}$/);
    const out2 = join(root, "ok2");
    run(good(out2), { TRIAL_SIM_COMMIT: "ABC" });
    expect(JSON.parse(readFileSync(join(out2, "manifest.json"), "utf8")).sim_commit).toBe("unknown");
    const out3 = join(root, "ok3");
    run(good(out3), { TRIAL_SIM_COMMIT: "abc1234" });
    for (const f of ["events.csv", "hourly.csv", "summary.json", "manifest.json"]) expect(readFileSync(join(out3, f))).toEqual(readFileSync(join(out, f)));
  }, 60_000);

  it("refuses bad arguments with one line, exit 2, and writes nothing", () => {
    const out = join(root, "never");
    const cases = [
      [], good(out).slice(0, -2), [...good(out), "--extra", "1"], [...good(out), "--seed", "1"],
      good(out).map((a) => (a === "101" ? "-1" : a)), good(out).map((a) => (a === "101" ? "2147483648" : a)), good(out).map((a) => (a === "101" ? "1.5" : a)),
      good(out).map((a) => (a === "1" ? "61" : a)), good(out).map((a) => (a === "1" ? "0" : a)), good(out).map((a) => (a === "1" ? "x‮" : a)),
      ["--scenario", "no-such-file.json", ...good(out).slice(2)],
    ];
    for (const args of cases) refused(run(args));
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a bad scenario: unknown key, bad JSON, over the size cap, a folder", () => {
    const out = join(root, "never2");
    for (const [name, body] of [["unknown.json", '{"nope":1}'], ["bad.json", "{"], ["big.json", " ".repeat(17 * 1024)], ["w4.json", '{"units":{"W4":{}}}']]) {
      writeFileSync(join(root, name), body);
      refused(run(["--scenario", join(root, name), ...good(out).slice(2)]));
    }
    refused(run(["--scenario", root, ...good(out).slice(2)]));
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a FIFO as the scenario instead of hanging", () => {
    const fifo = join(root, "pipe.json");
    execFileSync("mkfifo", [fifo]);
    const out = join(root, "never3");
    const r = spawnSync(process.execPath, [bin, "--scenario", fifo, ...good(out).slice(2)], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
    expect(r.status).toBe(2);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a symlinked --out (to a folder, or dangling) with one line, and changes nothing", () => {
    const dir = join(root, "realdir");
    mkdirSync(dir);
    symlinkSync(dir, join(root, "tolink"));
    symlinkSync(join(root, "nowhere"), join(root, "dangling"));
    for (const o of [join(root, "tolink"), join(root, "dangling"), join(root, "dangling", "sub")]) refused(run(good(o)));
    expect(readdirSync(dir)).toEqual([]);
    expect(lstatSync(join(root, "tolink")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root, "nowhere"))).toBe(false);
  });

  it("accepts an existing empty --out and fills it", () => {
    const out = join(root, "emptyok");
    mkdirSync(out);
    expect(run(good(out)).status).toBe(0);
    expect(readdirSync(out)).toHaveLength(4);
  }, 60_000);

  it("refuses a non-empty --out and an --out under a file, changing nothing", () => {
    const full = join(root, "full");
    mkdirSync(full);
    writeFileSync(join(full, "keep.txt"), "x");
    refused(run(good(full)));
    expect(readdirSync(full)).toEqual(["keep.txt"]);
    const file = join(root, "afile");
    writeFileSync(file, "x");
    refused(run(good(join(file, "sub"))));
    refused(run(good(file)));
    expect(readFileSync(file, "utf8")).toBe("x");
    expect(readdirSync(root).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });
});
