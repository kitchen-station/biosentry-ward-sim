// Copies the dashboard's committed evaluation files into src/data/evaluation, and writes sync.json.
// Run: npm run sync:evaluation -- <path to the BioSentry-Intelligence checkout>
// It reads that checkout's origin/main through git only (remote get-url, rev-parse, log, ls-tree, show).
// It never fetches, checks out or writes there. Every check runs before the first write.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "kitchen-station/BioSentry-Intelligence";
// https, ssh and plain path forms of the one repository, with or without .git
export const ORIGIN = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)?kitchen-station\/BioSentry-Intelligence(?:\.git)?$/;
const MAX_BYTES = 262144;
const EXPORTED_DIR = "frontend/src/data/evaluation/";
const FORMATS = {
  pipeline: "biosentry-evaluation/3",
  evaluations: "biosentry-evaluation/4",
  simulator: "biosentry-evaluation/3",
  registry: "biosentry-evaluation/2",
  "research-agent": "biosentry-evaluation/1",
};
// The direct files, by name. No glob.
const DIRECT = [
  "models/manifest.json",
  "models/tier_b/baseline/params.json",
  "models/tier_b/reward_policy/policy.json",
  "models/tier_b/reward_policy/no_temperature/policy.json",
  "models/tier_c/confidence_check/calibration.json",
  "models/tier_c/confidence_check/calibration_no_temp.json",
  "models/tier_c/confidence_check/heldout.json", // D8: copied by name, the page prints nothing from it
  "models/tier_c/student_vitals/held_out.json", // D9
  "models/tier_c/student_vitals/metadata.json",
  "training/agent/runs/run1.json",
  "training/agent/runs/run1.scores.json",
];
const RUN_FOLDERS = ["training/runs/student_vitals/", "training/runs/reward_policy/", "training/runs/confidence_check/"];
const RUN_NAME = /^[a-z0-9][a-z0-9-]{0,63}\.json$/;
const MAX_RUNS = 5;

class Refusal extends Error {}
const refuse = (why) => {
  throw new Refusal(why);
};

export function sync(checkout, outDir, warn = (line) => console.error(line)) {
  const git = (...args) => {
    try {
      return execFileSync("git", ["-C", checkout, ...args], { encoding: "buffer", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return null;
    }
  };
  const text = (buf) => buf.toString("utf8").trim();
  if (!git("rev-parse", "--git-dir")) refuse("not a git checkout");
  const remote = git("remote", "get-url", "origin");
  if (!remote || !ORIGIN.test(text(remote))) refuse("origin is not BioSentry-Intelligence");
  const commitBuf = git("rev-parse", "--verify", "origin/main^{commit}");
  if (!commitBuf) refuse("no origin/main");
  const commit = text(commitBuf);
  if (!/^[0-9a-f]{40}$/.test(commit)) refuse("origin/main is not a commit");
  const date = text(git("log", "-1", "--format=%cs", commit) ?? Buffer.from(""));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) refuse("no commit date");

  const listing = git("ls-tree", "-z", "-l", commit, "--", EXPORTED_DIR, ...DIRECT, ...RUN_FOLDERS);
  if (!listing) refuse("cannot list origin/main");
  const entries = listing
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const m = /^(\d+) (\w+) [0-9a-f]+\s+(\d+|-)\t([^]+)$/.exec(line);
      return m ? { mode: m[1], type: m[2], size: Number(m[3]), path: m[4] } : refuse("unreadable listing");
    });
  const plain = (e) => e.mode === "100644" && e.type === "blob";

  // chosen: { path in the repo, copy path under outDir, exported name or null }
  const chosen = [];
  for (const e of entries.filter((x) => x.path.startsWith(EXPORTED_DIR))) {
    const name = e.path.slice(EXPORTED_DIR.length);
    if (!name.endsWith(".json")) continue; // other names are ignored
    const key = name.slice(0, -5);
    if (!Object.hasOwn(FORMATS, key)) refuse(`unknown file: ${e.path}`);
    if (!plain(e)) refuse(`not a plain file: ${e.path}`);
    if (e.size > MAX_BYTES) refuse(`over 256 KB: ${e.path}`);
    chosen.push({ path: e.path, copy: name, exported: key });
  }
  for (const path of DIRECT) {
    const e = entries.find((x) => x.path === path);
    if (!e) continue; // not on main yet
    if (!plain(e)) refuse(`not a plain file: ${path}`);
    if (e.size > MAX_BYTES) {
      warn(`skipped, over 256 KB: ${path}`);
      continue;
    }
    chosen.push({ path, copy: `repo/${path}`, exported: null });
  }
  for (const folder of RUN_FOLDERS) {
    const runs = entries.filter((x) => x.path.startsWith(folder) && !x.path.slice(folder.length).includes("/") && plain(x) && RUN_NAME.test(x.path.slice(folder.length)));
    if (runs.length > MAX_RUNS) refuse(`more than ${MAX_RUNS} run logs in ${folder}`);
    for (const e of runs) {
      if (e.size > MAX_BYTES) {
        warn(`skipped, over 256 KB: ${e.path}`);
        continue;
      }
      chosen.push({ path: e.path, copy: `repo/${e.path}`, exported: null });
    }
  }

  const files = chosen.map((f) => {
    const bytes = git("show", `${commit}:${f.path}`) ?? refuse(`cannot read ${f.path}`);
    let doc;
    try {
      doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      refuse(`not UTF-8 JSON: ${f.path}`);
    }
    if (f.exported && (doc?.format !== FORMATS[f.exported] || doc?.section !== f.exported)) refuse(`wrong format or section: ${f.path}`);
    return { ...f, bytes };
  });

  // All checks passed: write.
  const keep = new Set(files.map((f) => f.copy));
  for (const rel of jsonUnder(outDir)) if (!keep.has(rel) && rel !== "sync.json") rmSync(join(outDir, rel));
  for (const f of files) {
    mkdirSync(dirname(join(outDir, f.copy)), { recursive: true });
    writeFileSync(join(outDir, f.copy), f.bytes);
  }
  const record = {
    commit,
    commit_date: date,
    files: files
      .map((f) => ({ bytes: f.bytes.length, path: f.exported ? EXPORTED_DIR + f.copy : f.path, sha256: createHash("sha256").update(f.bytes).digest("hex") }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    repo: REPO,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "sync.json"), JSON.stringify(record, null, 1) + "\n");
  return record;
}

function jsonUnder(dir, base = "") {
  let names;
  try {
    names = readdirSync(join(dir, base), { withFileTypes: true });
  } catch {
    return [];
  }
  return names.flatMap((d) => (d.isDirectory() ? jsonUnder(dir, `${base}${d.name}/`) : d.name.endsWith(".json") ? [`${base}${d.name}`] : []));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error("usage: npm run sync:evaluation -- <BioSentry-Intelligence checkout>");
    process.exit(2);
  }
  try {
    const record = sync(process.argv[2], fileURLToPath(new URL("../src/data/evaluation/", import.meta.url)));
    console.log(`copied ${record.files.length} files from ${record.commit}`);
  } catch (e) {
    console.error(e instanceof Refusal ? `refused: ${e.message}` : `failed: ${e.message}`);
    process.exit(2);
  }
}
