/// <reference types="node" />
// The headless trial runner: one scenario, one seed, a number of days; no API, no wall clock.
//   npx vite build --ssr src/trial.ts --outDir dist/trial --logLevel warn
//   node dist/trial/trial.js --scenario scenarios/default.json --seed 1 --days 3 --out <new folder>
// TRIAL_SIM_COMMIT (7 to 40 lowercase hex characters, else "unknown") is the only environment variable read.
// Exit 0 on success; exit 2 with one line on stderr for bad arguments, a refused or unreadable scenario, or an
// output folder that cannot be used. Every check that can refuse runs before the trial, and nothing is written then.

import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_SCENARIO_BYTES, parseScenario, runTrial, TrialRefusal, type Scenario, type TrialFiles } from "./sim/trial";

const FLAGS = ["--scenario", "--seed", "--days", "--out"];
const USAGE = `usage: trial ${FLAGS.map((f) => `${f} <value>`).join(" ")}`;
const refuse = (message: string): never => {
  throw new TrialRefusal(message);
};
const codeOf = (e: unknown) => (e as NodeJS.ErrnoException).code ?? "error";

function integer(flag: string, text: string, min: number, max: number) {
  if (!/^\d{1,10}$/.test(text) || Number(text) < min || Number(text) > max) refuse(`${flag} must be an integer from ${min} to ${max}`);
  return Number(text);
}

/** True when this module is the program being run, also when it was started through a symlink. */
export function isMain(argv1: string | undefined, moduleUrl: string) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/** The commit the build passes in. Anything else, a name or a megabyte of text included, becomes "unknown". */
export const simCommit = (value: string | undefined) => (value !== undefined && /^[0-9a-f]{7,40}$/.test(value) ? value : "unknown");

type Fs = Pick<typeof import("node:fs"), "statSync" | "readFileSync">;
/** The size is checked from the file's stat before it is read, and only a regular file is opened (a FIFO would block). */
export function readScenarioFile(file: string, fs: Fs = { statSync, readFileSync }): { bytes: Buffer; scenario: Scenario } {
  let bytes: Buffer;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return refuse("scenario: not a regular file");
    if (stat.size > MAX_SCENARIO_BYTES) return refuse(`scenario: file is over ${MAX_SCENARIO_BYTES} bytes`);
    bytes = fs.readFileSync(file);
  } catch (e) {
    if (e instanceof TrialRefusal) throw e;
    return refuse(`scenario: cannot read the file (${codeOf(e)})`);
  }
  return { bytes, scenario: parseScenario(bytes.toString("utf8")) };
}

/** Refuses an output folder that cannot be used. Returns true when it has to be created. */
export function checkOut(out: string) {
  let stat;
  try {
    stat = lstatSync(out);
  } catch (e) {
    if (codeOf(e) !== "ENOENT") return refuse(`--out: cannot be inspected (${codeOf(e)})`);
  }
  if (stat) {
    // A link could lead anywhere, so it is never followed; nor is an existing file touched.
    if (stat.isSymbolicLink()) return refuse("--out: is a symbolic link");
    if (!stat.isDirectory()) return refuse("--out: exists and is not a folder");
    try {
      if (readdirSync(out).length > 0) return refuse("--out: folder exists and is not empty");
      accessSync(out, constants.W_OK | constants.X_OK);
    } catch (e) {
      if (e instanceof TrialRefusal) throw e;
      return refuse(`--out: folder cannot be used (${codeOf(e)})`);
    }
    return false;
  }
  const parent = dirname(out);
  try {
    if (!statSync(parent).isDirectory()) return refuse("--out: parent is not a folder");
    accessSync(parent, constants.W_OK | constants.X_OK);
  } catch (e) {
    if (e instanceof TrialRefusal) throw e;
    return refuse(codeOf(e) === "ENOENT" ? "--out: parent folder does not exist" : `--out: parent folder cannot be used (${codeOf(e)})`);
  }
  return true;
}

type Io = { open: (path: string) => number; write: (fd: number, text: string) => void; close: (fd: number) => void };
const realIo: Io = { open: (path) => openSync(path, "wx"), write: (fd, text) => void writeFileSync(fd, text), close: closeSync };

/**
 * Writes each file new ("wx": an existing file or link is never opened). A file counts as this run's as soon as its
 * open succeeds, so on any failure every file this call created, the half-written one included, is removed.
 */
export function writeFiles(out: string, files: TrialFiles, io: Io = realIo) {
  const made: string[] = [];
  let failure: unknown;
  for (const [name, text] of Object.entries(files)) {
    let fd: number;
    try {
      fd = io.open(join(out, name));
    } catch (e) {
      failure = e; // nothing of ours was created under this name, so it is not removed
      break;
    }
    made.push(name);
    try {
      io.write(fd, text);
    } catch (e) {
      failure = e;
    }
    try {
      io.close(fd);
    } catch (e) {
      failure ??= e;
    }
    if (failure) break;
  }
  if (!failure) return;
  for (const name of made) {
    try {
      unlinkSync(join(out, name));
    } catch {
      /* the refusal below still says what failed first */
    }
  }
  return refuse(`--out: write failed (${codeOf(failure)})`);
}

/** Runs a trial and writes its four files into `--out`. Throws TrialRefusal for anything it will not do. */
export function run(argv: string[], env: Record<string, string | undefined> = process.env, write = writeFiles) {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!FLAGS.includes(flag) || args.has(flag) || argv[i + 1] === undefined) refuse(USAGE);
    args.set(flag, argv[i + 1]);
  }
  if (args.size !== FLAGS.length) refuse(USAGE);
  const seed = integer("--seed", args.get("--seed")!, 0, 2 ** 31 - 1);
  const days = integer("--days", args.get("--days")!, 1, 60);
  const { bytes, scenario } = readScenarioFile(args.get("--scenario")!);
  const out = resolve(args.get("--out")!);
  const create = checkOut(out);

  const files = runTrial({
    scenario,
    seed,
    days,
    scenarioSha256: createHash("sha256").update(bytes).digest("hex"), // of the file's bytes, not of the parsed object
    simCommit: simCommit(env.TRIAL_SIM_COMMIT),
    nodeMajor: Number(process.versions.node.split(".")[0]),
  });
  // Not recursive: only --out itself is created.
  if (create) {
    try {
      mkdirSync(out);
    } catch (e) {
      refuse(`--out: cannot create the folder (${codeOf(e)})`);
    }
  }
  try {
    write(out, files);
  } catch (e) {
    if (create) {
      try {
        rmdirSync(out);
      } catch {
        /* not empty: something else put a file there, leave it */
      }
    }
    throw e;
  }
}

if (isMain(process.argv[1], import.meta.url)) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof TrialRefusal)) throw error;
    console.error(error.message);
    process.exit(2);
  }
}
