import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ORIGIN, sync } from "./sync-evaluation.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", env: { ...process.env, GIT_COMMITTER_DATE: "2026-05-06T12:00:00Z", GIT_AUTHOR_DATE: "2026-05-06T12:00:00Z" } });
const DIR = "frontend/src/data/evaluation";
const envelope = (section, format) => JSON.stringify({ format, section, provenance: {}, body: {}, notes: [] }) + "\n";

/** A checkout whose origin/main holds `files` (path -> text). */
function repo(files, url = "https://github.com/kitchen-station/BioSentry-Intelligence.git") {
  const dir = mkdtempSync(join(tmpdir(), "sync-src-"));
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", url);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "x");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  return dir;
}
const out = () => join(mkdtempSync(join(tmpdir(), "sync-out-")), "evaluation");
const listing = (dir, base = "") => (existsSync(dir) ? readdirSync(join(dir, base), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listing(dir, `${base}${e.name}/`) : [`${base}${e.name}`])) : []);
const quiet = () => {};

const GOOD = {
  [`${DIR}/research-agent.json`]: envelope("research-agent", "biosentry-evaluation/1"),
  [`${DIR}/notes.txt`]: "ignored",
  "models/manifest.json": '{"schema":1}\n',
  "models/tier_c/confidence_check/calibration.json": '{"q":0.019854247570037842}\n',
  "training/runs/student_vitals/m1-a.json": "{}\n",
  "training/runs/student_vitals/m1-a.json.sha256": "x",
  "training/runs/student_vitals/Bad_Name.json": "{}\n",
  "training/runs/student_vitals/sub/inner.json": "{}\n",
  "training/agent/runs/run1.json": "{}\n",
  "training/agent/runs/run1.scores.json": "{}\n",
  "training/agent/runs/run2.json": "{}\n",
};

// Each test builds temporary git repositories with many git calls, which is slow on a loaded machine.
describe("sync-evaluation", { timeout: 60_000 }, () => {
  it("copies byte for byte to both folders and writes the record", () => {
    const src = repo(GOOD);
    const o = out();
    const rec = sync(src, o, quiet);
    expect(listing(o).sort()).toEqual(
      [
        "research-agent.json",
        "repo/models/manifest.json",
        "repo/models/tier_c/confidence_check/calibration.json",
        "repo/training/runs/student_vitals/m1-a.json",
        "repo/training/agent/runs/run1.json",
        "repo/training/agent/runs/run1.scores.json",
        "sync.json",
      ].sort(),
    );
    expect(readFileSync(join(o, "repo/models/tier_c/confidence_check/calibration.json"), "utf8")).toBe(GOOD["models/tier_c/confidence_check/calibration.json"]);
    expect(readFileSync(join(o, "sync.json"), "utf8")).toBe(JSON.stringify(rec, null, 1) + "\n");
    expect(Object.keys(rec)).toEqual(["commit", "commit_date", "files", "repo"]);
    expect(rec.commit_date).toBe("2026-05-06");
    expect(rec.repo).toBe("kitchen-station/BioSentry-Intelligence");
    expect(rec.files.map((f) => f.path)).toEqual([...rec.files.map((f) => f.path)].sort());
    // each entry holds the sha256 and byte length of the source text this test wrote
    expect(rec.files).toHaveLength(6);
    for (const f of rec.files) {
      const bytes = Buffer.from(GOOD[f.path]);
      expect(f, f.path).toEqual({ bytes: bytes.length, path: f.path, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  });

  it("copies the two held-out files by name when they are on main", () => {
    const o = out();
    const rec = sync(repo({ ...GOOD, "models/tier_c/confidence_check/heldout.json": "{}\n", "models/tier_c/student_vitals/held_out.json": "{}\n" }), o, quiet);
    expect(rec.files.map((f) => f.path)).toEqual(expect.arrayContaining(["models/tier_c/confidence_check/heldout.json", "models/tier_c/student_vitals/held_out.json"]));
    expect(existsSync(join(o, "repo/models/tier_c/student_vitals/held_out.json"))).toBe(true);
  });

  it("accepts the https, ssh and plain forms of the origin", () => {
    for (const url of ["https://github.com/kitchen-station/BioSentry-Intelligence.git", "git@github.com:kitchen-station/BioSentry-Intelligence.git", "kitchen-station/BioSentry-Intelligence"]) {
      expect(ORIGIN.test(url), url).toBe(true);
      expect(sync(repo(GOOD, url), out(), quiet).files.length, url).toBe(6);
    }
  });

  it("gives the same bytes on a second run, and deletes a copy that left main", () => {
    const src = repo(GOOD);
    const o = out();
    sync(src, o, quiet);
    const first = readFileSync(join(o, "sync.json"), "utf8");
    sync(src, o, quiet);
    expect(readFileSync(join(o, "sync.json"), "utf8")).toBe(first);
    mkdirSync(join(o, "repo/models"), { recursive: true });
    writeFileSync(join(o, "repo/models/gone.json"), "{}");
    writeFileSync(join(o, "old.json"), "{}");
    sync(src, o, quiet);
    expect(existsSync(join(o, "old.json"))).toBe(false);
    expect(existsSync(join(o, "repo/models/gone.json"))).toBe(false);
  });

  it("skips an over-cap direct file with its stderr line", () => {
    const src = repo({ ...GOOD, "models/tier_b/baseline/params.json": " ".repeat(262145) });
    const lines = [];
    const o = out();
    sync(src, o, (l) => lines.push(l));
    expect(lines).toEqual(["skipped, over 256 KB: models/tier_b/baseline/params.json"]);
    expect(existsSync(join(o, "repo/models/tier_b/baseline/params.json"))).toBe(false);
  });

  const refused = (name, make, why) =>
    it(`refuses ${name} and writes nothing`, () => {
      const o = out();
      expect(() => sync(make(), o, quiet)).toThrow(why);
      expect(listing(o)).toEqual([]);
    });
  refused("a folder that is not a checkout", () => mkdtempSync(join(tmpdir(), "sync-none-")), /not a git checkout/);
  refused("a checkout with no origin/main", () => {
    const dir = repo(GOOD);
    git(dir, "update-ref", "-d", "refs/remotes/origin/main");
    return dir;
  }, /no origin\/main/);
  refused("the wrong origin", () => repo(GOOD, "https://example.com/other/repo.git"), /origin/);
  for (const url of ["https://evil.example/x/BioSentry-Intelligence.git", "https://github.com/someone-else/BioSentry-Intelligence", "https://github.com/kitchen-station/BioSentry-Intelligence-fork"])
    refused(`the origin ${url}`, () => repo(GOOD, url), /origin is not BioSentry-Intelligence/);
  refused("an oversize exported file", () => repo({ ...GOOD, [`${DIR}/pipeline.json`]: " ".repeat(262145) }), /over 256 KB/);
  refused("bad JSON", () => repo({ ...GOOD, [`${DIR}/pipeline.json`]: "{" }), /not UTF-8 JSON/);
  refused("a direct file that is bad JSON", () => repo({ ...GOOD, "models/manifest.json": "{" }), /not UTF-8 JSON/);
  refused("a wrong format", () => repo({ ...GOOD, [`${DIR}/pipeline.json`]: envelope("pipeline", "biosentry-evaluation/2") }), /wrong format or section/);
  refused("a wrong section", () => repo({ ...GOOD, [`${DIR}/pipeline.json`]: envelope("registry", "biosentry-evaluation/3") }), /wrong format or section/);
  refused("an unknown exported name", () => repo({ ...GOOD, [`${DIR}/extra.json`]: "{}" }), /unknown file/);
  refused("six run logs in one folder", () => repo(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`training/runs/reward_policy/m2-${i}.json`, "{}"]))), /more than 5 run logs/);
});
