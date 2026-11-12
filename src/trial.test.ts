import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isMain, readScenarioFile, run, simCommit, writeFiles } from "./trial";
import { TrialRefusal, type TrialFiles } from "./sim/trial";

const scenario = "scenarios/default.json";
const sandbox = () => mkdtempSync(join(tmpdir(), "trial-test-"));
const args = (out: string, over: Record<string, string> = {}) =>
  Object.entries({ "--scenario": scenario, "--seed": "1", "--days": "1", "--out": out, ...over }).flat();
const message = (f: () => void) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(TrialRefusal);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
};
const manifest = (dir: string) => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const root0 = process.getuid?.() === 0; // root ignores file modes

describe("trial entry", () => {
  it("writes exactly four files inside --out and nothing beside it", () => {
    const root = sandbox();
    run(args(join(root, "out")), { TRIAL_SIM_COMMIT: "abc1234" });
    expect(readdirSync(root)).toEqual(["out"]);
    expect(readdirSync(join(root, "out")).sort()).toEqual(["cohort.csv", "episodes.csv", "manifest.json", "summary.json"]);
    const m = manifest(join(root, "out"));
    expect(m).toMatchObject({ sim_commit: "abc1234", days: 1, node_major: Number(process.versions.node.split(".")[0]) });
    expect(m.scenario_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(root, "out", "cohort.csv"), "utf8").split("\n")[0]).toContain("diastolic,bp_minute,consciousness");
  });

  it("gives the same files for the same arguments, and an empty existing folder is accepted", () => {
    const root = sandbox();
    mkdirSync(join(root, "b"));
    run(args(join(root, "a")), {});
    run(args(join(root, "b")), {});
    for (const f of readdirSync(join(root, "a"))) expect(readFileSync(join(root, "b", f), "utf8")).toBe(readFileSync(join(root, "a", f), "utf8"));
    expect(manifest(join(root, "a")).sim_commit).toBe("unknown");
  });

  it("records only a hex commit; a name, newlines or a megabyte become unknown", () => {
    for (const bad of ['Ocampo, Luz "x', "abc1234\n", "abc1234\nOcampo", "ABC1234", "abc123", "a".repeat(41), "g".repeat(10), "", "x".repeat(1_000_000), "a".repeat(1_000_000)]) {
      expect(simCommit(bad)).toBe("unknown");
    }
    for (const good of ["abc1234", "0123456789abcdef0123456789abcdef01234567"]) expect(simCommit(good)).toBe(good);
    expect(simCommit(undefined)).toBe("unknown");
    const root = sandbox();
    run(args(join(root, "out")), { TRIAL_SIM_COMMIT: 'Ocampo, Luz "x' });
    expect(manifest(join(root, "out")).sim_commit).toBe("unknown");
  });

  it("refuses a non-empty --out and leaves it as it was", () => {
    const root = sandbox();
    writeFileSync(join(root, "keep.txt"), "x");
    expect(message(() => run(args(root)))).toMatch(/not empty/);
    expect(readdirSync(root)).toEqual(["keep.txt"]);
  });

  it("refuses an --out that is a symlink, even to a non-empty folder, and an existing file", () => {
    const root = sandbox();
    mkdirSync(join(root, "target"));
    writeFileSync(join(root, "target", "keep.txt"), "x");
    symlinkSync(join(root, "target"), join(root, "link"));
    expect(message(() => run(args(join(root, "link"))))).toMatch(/symbolic link/);
    mkdirSync(join(root, "empty"));
    symlinkSync(join(root, "empty"), join(root, "link2"));
    expect(message(() => run(args(join(root, "link2"))))).toMatch(/symbolic link/);
    writeFileSync(join(root, "file"), "precious");
    expect(message(() => run(args(join(root, "file"))))).toMatch(/not a folder/);
    expect(readFileSync(join(root, "file"), "utf8")).toBe("precious");
    expect(readdirSync(join(root, "target"))).toEqual(["keep.txt"]);
    expect(readdirSync(join(root, "empty"))).toEqual([]);
  });

  it("never follows or overwrites what is already in --out, and removes only what it made", () => {
    const root = sandbox();
    const out = join(root, "out");
    mkdirSync(out);
    writeFileSync(join(root, "outside.txt"), "outside");
    symlinkSync(join(root, "outside.txt"), join(out, "summary.json")); // planted after the empty check
    writeFileSync(join(out, "other.txt"), "mine");
    const files: TrialFiles = { "manifest.json": "m", "cohort.csv": "c", "episodes.csv": "e", "summary.json": "s" };
    expect(message(() => writeFiles(out, files))).toMatch(/write failed \(EEXIST\)/);
    expect(readFileSync(join(root, "outside.txt"), "utf8")).toBe("outside");
    expect(readdirSync(out).sort()).toEqual(["other.txt", "summary.json"]); // the three files it made are gone
    writeFileSync(join(out, "manifest.json"), "old");
    expect(message(() => writeFiles(join(root, "out"), files))).toMatch(/EEXIST/);
    expect(readFileSync(join(out, "manifest.json"), "utf8")).toBe("old");
  });

  // The disk-full case: the open succeeds, then the write fails part-way and leaves a truncated file.
  const failing = (failAt: string) => ({
    open: (path: string) => openSync(path, "wx"),
    write: (fd: number, text: string) => {
      writeFileSync(fd, text.slice(0, 1));
      if (failAt && text === failAt) throw Object.assign(new Error("disk full"), { code: "EFBIG" });
      writeFileSync(fd, text.slice(1));
    },
    close: closeSync,
  });
  const files: TrialFiles = { "manifest.json": "mmm", "cohort.csv": "ccc", "episodes.csv": "eee", "summary.json": "sss" };

  it("removes the half-written file and the others it made, and touches nothing it did not make", () => {
    const root = sandbox();
    const out = join(root, "out");
    mkdirSync(out);
    writeFileSync(join(out, "other.txt"), "mine");
    expect(message(() => writeFiles(out, files, failing("ccc")))).toMatch(/write failed \(EFBIG\)/);
    expect(readdirSync(out)).toEqual(["other.txt"]);
    expect(readFileSync(join(out, "other.txt"), "utf8")).toBe("mine");
    writeFiles(out, files, failing("")); // and a clean write still works
    expect(readFileSync(join(out, "cohort.csv"), "utf8")).toBe("ccc");
  });

  it("removes a folder it created when the write fails, and leaves an existing empty one", () => {
    const root = sandbox();
    const failRun = (out: string) => run(args(out), {}, (dir, f) => writeFiles(dir, f, failing(f["episodes.csv"])));
    expect(message(() => failRun(join(root, "new")))).toMatch(/write failed \(EFBIG\)/);
    expect(readdirSync(root)).toEqual([]);
    mkdirSync(join(root, "empty"));
    expect(message(() => failRun(join(root, "empty")))).toMatch(/write failed/);
    expect(readdirSync(join(root, "empty"))).toEqual([]);
  });

  it("refuses a missing, file or read-only parent before the trial runs", { timeout: 20_000 }, () => {
    const root = sandbox();
    const started = Date.now();
    // 60 days would take about 45 s: a refusal that waited for the trial would fail the time check.
    expect(message(() => run(args(join(root, "no", "out"), { "--days": "60" })))).toMatch(/parent folder does not exist/);
    writeFileSync(join(root, "file"), "x");
    expect(message(() => run(args(join(root, "file", "out"), { "--days": "60" })))).toMatch(/cannot be inspected \(ENOTDIR\)/);
    if (!root0) {
      mkdirSync(join(root, "ro"));
      chmodSync(join(root, "ro"), 0o500);
      expect(message(() => run(args(join(root, "ro", "out"), { "--days": "60" })))).toMatch(/parent folder cannot be used \(EACCES\)/);
      chmodSync(join(root, "ro"), 0o700);
      expect(readdirSync(join(root, "ro"))).toEqual([]);
    }
    expect(Date.now() - started).toBeLessThan(5000);
    expect(readdirSync(root).sort()).toEqual(root0 ? ["file"] : ["file", "ro"]);
  });

  it("refuses a bad scenario and writes nothing", () => {
    const root = sandbox();
    const bad = join(root, "bad.json");
    writeFileSync(bad, JSON.stringify({ ...JSON.parse(readFileSync(scenario, "utf8")), beds: 30 }));
    expect(message(() => run(args(join(root, "out"), { "--scenario": bad })))).toMatch(/"beds"/);
    writeFileSync(bad, " ".repeat(16 * 1024 + 1));
    expect(message(() => run(args(join(root, "out"), { "--scenario": bad })))).toMatch(/over 16384/);
    expect(message(() => run(args(join(root, "out"), { "--scenario": join(root, "missing.json") })))).toMatch(/cannot read the file \(ENOENT\)/);
    expect(readdirSync(root).sort()).toEqual(["bad.json"]);
  });

  it("refuses an unreadable scenario with one line, not a stack trace", () => {
    if (root0) return; // root can read anything
    const root = sandbox();
    const locked = join(root, "locked.json");
    writeFileSync(locked, readFileSync(scenario));
    chmodSync(locked, 0);
    const line = message(() => run(args(join(root, "out"), { "--scenario": locked })));
    expect(line).toMatch(/cannot read the file \(EACCES\)/);
    expect(line).not.toContain("\n");
    expect(readdirSync(root).sort()).toEqual(["locked.json"]);
  });

  it("refuses a directory or a FIFO as the scenario at once, without opening it", () => {
    const root = sandbox();
    const started = Date.now();
    expect(message(() => run(args(join(root, "out"), { "--scenario": root })))).toMatch(/not a regular file/);
    const fifo = join(root, "fifo.json");
    execFileSync("mkfifo", [fifo]);
    expect(message(() => run(args(join(root, "out"), { "--scenario": fifo })))).toMatch(/not a regular file/);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(readdirSync(root).sort()).toEqual(["fifo.json"]);
  });

  it("checks the size from the stat before it reads the file", () => {
    const fs = {
      statSync: () => ({ isFile: () => true, size: 17 * 1024 }),
      readFileSync: () => {
        throw new Error("read must not be called");
      },
    } as unknown as Parameters<typeof readScenarioFile>[1];
    expect(message(() => readScenarioFile("anything.json", fs))).toMatch(/over 16384/);
  });

  it.each([
    [["--seed", "-1"], /--seed/],
    [["--seed", "2147483648"], /--seed/],
    [["--seed", "1.5"], /--seed/],
    [["--days", "0"], /--days/],
    [["--days", "61"], /--days/],
    [["--days", "abc"], /--days/],
  ])("refuses %j with one line", ([flag, value], pattern) => {
    const root = sandbox();
    expect(message(() => run(args(join(root, "out"), { [flag]: value })))).toMatch(pattern);
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses a missing, repeated or unknown flag", () => {
    const root = sandbox();
    const out = join(root, "out");
    expect(message(() => run(["--scenario", scenario, "--seed", "1", "--days", "1"]))).toMatch(/usage/);
    expect(message(() => run([...args(out), "--seed", "2"]))).toMatch(/usage/);
    expect(message(() => run([...args(out), "--net", "http://x"]))).toMatch(/usage/);
    expect(readdirSync(root)).toEqual([]);
  });

  it("knows it is the program when started through a symlink", () => {
    const root = sandbox();
    const real = resolve("src/trial.ts");
    symlinkSync(real, join(root, "link.ts"));
    mkdirSync(join(root, "dir"));
    symlinkSync(root, join(root, "dir", "up"));
    const url = pathToFileURL(real).href;
    expect(isMain(real, url)).toBe(true);
    expect(isMain(join(root, "link.ts"), url)).toBe(true);
    expect(isMain(join(root, "dir", "up", "link.ts"), url)).toBe(true);
    expect(isMain(resolve("src/sim/trial.ts"), url)).toBe(false);
    expect(isMain(join(root, "missing.ts"), url)).toBe(false);
    expect(isMain(undefined, url)).toBe(false);
  });

  // No network call can happen: the runner imports no network module, and this keeps it that way.
  it("uses no clock, randomness or network in its own code", () => {
    for (const file of ["src/trial.ts", "src/sim/trial.ts"]) {
      const code = readFileSync(file, "utf8");
      expect(code).not.toMatch(/Math\.random|Date\.now|new Date|performance\.now|fetch\(|node:(net|http|https|dns|tls|dgram|child_process)|XMLHttpRequest|WebSocket/);
    }
  });
});
