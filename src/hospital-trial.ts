/// <reference types="node" />
// A repeatable hospital trial from the command line. Run with `npm run hospital-trial -- --scenario <file> --seed <n> --days <n> --out <dir>`.
// Format: docs/hospital-trial-format.md. Every check that can refuse runs before the trial; a refusal is one line on stderr and exit 2.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MAX_BYTES, parseScenario } from "./sim/hospital/scenario";
import { FORMAT_VERSION, runHospitalTrial, SPEED, WARM_UP_DAYS } from "./sim/hospital/trial";

class Refusal extends Error {}
const refuse = (message: string): never => { throw new Refusal(message); };
// Echoed text: at most 40 characters, control, format and separator characters shown as "?".
const clean = (text: string) => [...text].slice(0, 40).map((ch) => (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u.test(ch) ? "?" : ch)).join("");

const FLAGS = ["--scenario", "--seed", "--days", "--out"];
function parseArgs(argv: string[]): Record<string, string> {
  const got: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!FLAGS.includes(flag)) refuse(`unknown argument "${clean(flag)}"; use ${FLAGS.join(" ")}`);
    if (flag in got) refuse(`${flag} given twice`);
    if (i + 1 >= argv.length) refuse(`${flag} needs a value`);
    got[flag] = argv[i + 1];
  }
  for (const f of FLAGS) if (!(f in got)) refuse(`${f} is required`);
  return got;
}

function whole(flag: string, text: string, min: number, max: number): number {
  const n = /^(0|[1-9]\d{0,15})$/.test(text) ? Number(text) : NaN;
  return n >= min && n <= max ? n : refuse(`${flag} must be a whole number from ${min} to ${max}`);
}

/** The file's bytes, read with a cap: a file that grows or is not a plain file is refused. */
function readCapped(path: string): Buffer {
  let fd: number;
  try {
    // A pipe or device would hang or never end: only a regular file (a symlink to one is fine) is read. O_NONBLOCK covers a swap after the check.
    if (!statSync(path).isFile()) refuse("the scenario path is not a regular file");
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (e) {
    if (e instanceof Refusal) throw e;
    return refuse(`cannot read the scenario file "${clean(path)}"`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) refuse("the scenario path is not a file");
    if (st.size > MAX_BYTES) refuse(`scenario: file is over ${MAX_BYTES / 1024} KB`);
    const buf = Buffer.alloc(MAX_BYTES + 1);
    const n = readSync(fd, buf, 0, MAX_BYTES + 1, 0);
    if (n > MAX_BYTES) refuse(`scenario: file is over ${MAX_BYTES / 1024} KB`);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

const lstatOrNull = (path: string) => { try { return lstatSync(path); } catch { return null; } };

/** The output folder must be new or empty (never a symlink), and its nearest existing parent must be a folder. */
function checkOut(out: string) {
  const here = lstatOrNull(out);
  if (here) {
    if (here.isSymbolicLink()) refuse("--out is a symbolic link");
    if (!here.isDirectory()) refuse("--out exists and is not a folder");
    if (readdirSync(out).length > 0) refuse("--out is not empty");
    return;
  }
  let up = dirname(out);
  while (!lstatOrNull(up)) up = dirname(up);
  let ok = false;
  try { ok = statSync(up).isDirectory(); } catch { /* a dangling link */ }
  if (!ok) refuse("--out cannot be created: a parent is not a folder");
}

function main(): number {
  const a = parseArgs(process.argv.slice(2));
  const seed = whole("--seed", a["--seed"], 0, 2 ** 31 - 1);
  const days = whole("--days", a["--days"], 1, 60);
  const out = resolve(a["--out"]);
  const raw = readCapped(a["--scenario"]);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return refuse("scenario: not valid UTF-8");
  }
  let scenario;
  try {
    scenario = parseScenario(text);
  } catch (e) {
    return refuse((e as Error).message.split("\n")[0].slice(0, 200).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, "?"));
  }
  checkOut(out);

  const commit = process.env.TRIAL_SIM_COMMIT;
  const result = runHospitalTrial(seed, scenario, days);
  const manifest = {
    format_version: FORMAT_VERSION, synthetic: true, seed, days, speed: SPEED, scenario,
    scenario_sha256: createHash("sha256").update(raw).digest("hex"),
    sim_commit: commit !== undefined && /^[0-9a-f]{7,40}$/.test(commit) ? commit : "unknown",
    node_major: Number(process.versions.node.split(".")[0]),
    warm_up_days: WARM_UP_DAYS, hourly_rows: result.hourlyRows, event_rows: result.eventRows,
  };

  // Written next to --out and renamed at the end, so a failure leaves no partial result.
  mkdirSync(dirname(out), { recursive: true });
  const tmp = mkdtempSync(`${out}.tmp-`);
  try {
    writeFileSync(join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(join(tmp, "hourly.csv"), result.hourlyCsv);
    writeFileSync(join(tmp, "events.csv"), result.eventsCsv);
    writeFileSync(join(tmp, "summary.json"), result.summaryJson);
    renameSync(tmp, out); // over an empty folder this replaces it; on failure the user's folder is untouched
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  console.log(`hospital-trial: wrote ${out} (${result.hourlyRows} hourly rows, ${result.eventRows} events)`);
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  if (e instanceof Refusal) {
    console.error(`hospital-trial: ${e.message}`);
    process.exitCode = 2;
  } else {
    console.error(`hospital-trial: failed: ${clean((e as Error).message)}`);
    process.exitCode = 1;
  }
}
