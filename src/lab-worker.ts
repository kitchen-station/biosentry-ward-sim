/// <reference types="node" />
// The lab worker: claims one compare job at a time from the BioSentry API (contract-d7), runs the built
// compare bundle on it, posts the two files it wrote, and claims again. Run with `npm run lab-worker`.
// It imports nothing from src/: a bundle inlines what it imports, and compare.ts runs its CLI when bundled.

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Field = "kind" | "mode" | "seed" | "days" | "baseline" | "change";
export type Body = { state: "done"; compare_json: string; compare_txt: string } | { state: "refused" | "failed"; reason: string };

export const W4_RULES = new Set([...Array.from({ length: 20 }, (_, i) => `news2_total_ge_${i + 1}`), "news2_chart_trigger"]);
const H = "scenarios/hospital/";
export const BASE = new Map([["typical", `${H}typical.json`], ["surge", `${H}surge.json`], ["doh-standard", `${H}doh-standard.json`]]);
const groups = (other: string) => ["staffing", "nurses", "doctors"].map((g) => `${g}=${other}`);
export const PAIRS = new Map([["typical", groups("doh-standard")], ["surge", groups("doh-standard")], ["doh-standard", groups("typical")]]);
export const CHANGE = new Map(["doh-standard", "typical"].flatMap((o) => groups(o).map((c) => [c, c.replace(o, `${H}${o}.json`)] as const)));

const LIMIT_MS = 900_000;
const CALL_MS = 20_000;
const CLAIM_CAP = 65_536; // judgement: a job is under 300 bytes
export const reportWaits = [30_000, 60_000, 120_000, 240_000];
const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NODE_USE_ENV_PROXY"];

/** The line to refuse to start with, or null. Names only, never a value: a proxy would see the ingest key. */
export function proxyRefusal(env: Record<string, string | undefined>, execArgv: string[]): string | null {
  // NODE_OPTIONS can carry the flag too, and node reads `_` as `-` in an option name.
  const flag = [...execArgv, ...(env.NODE_OPTIONS?.split(/\s+/) ?? [])].some((a) => /^--use-env-proxy(=|$)/.test(a.replaceAll("_", "-")));
  const name = PROXY_VARS.find((n) => env[n]) ?? (flag ? "--use-env-proxy" : null);
  return name && `lab: a proxy variable is set (${name}); the worker does not send the ingest key through a proxy`;
}

/** The one base address, or null. No credentials, query or fragment, so a request can only go where the operator pointed it. */
export function parseBase(raw: string | undefined): URL | null {
  let url: URL;
  if (/[?#]/.test(raw ?? "")) return null; // an empty `?` or `#` is dropped by URL, so the raw text is checked
  try {
    url = new URL(raw ?? "");
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  if (!url.pathname.endsWith("/")) url.pathname += "/"; // so a path prefix is kept
  return url;
}

/** Every request URL comes from here, resolved against the one base: the id is encoded and cannot change the host. */
export function routeUrl(base: URL, kind: "claim" | "report", id?: number): string {
  return new URL(kind === "claim" ? "sim/lab/claim" : `sim/lab/runs/${encodeURIComponent(String(id))}/report`, base).href;
}

const int = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** Checks a claimed job against the worker's own tables. `bad` means no usable id, so nothing can be reported. */
export function validateJob(body: unknown): { id: number; args: string[] } | { id: number; refused: Field } | { bad: true } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { bad: true };
  const j = body as Record<string, unknown>;
  const id = j.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return { bad: true };
  const no = (refused: Field) => ({ id, refused });
  const { seed, days, baseline, change } = j;
  if (j.kind !== "compare") return no("kind");
  if (j.mode !== "w4" && j.mode !== "hospital") return no("mode");
  if (!int(seed, 0, 2147483647)) return no("seed");
  if (!int(days, 1, 30)) return no("days"); // shortcut: 30 days, until run time is measured (compare allows 60)
  const head = ["dist/compare/compare.js", "--seed", String(seed), "--days", String(days)];
  if (j.mode === "w4") {
    if (typeof baseline !== "string" || !W4_RULES.has(baseline)) return no("baseline");
    if (typeof change !== "string" || !W4_RULES.has(change) || change === baseline) return no("change");
    return { id, args: [...head, "--baseline", `rule=${baseline}`, "--change", `rule=${change}`, "--out"] };
  }
  if (typeof baseline !== "string" || !BASE.has(baseline)) return no("baseline");
  if (typeof change !== "string" || !PAIRS.get(baseline)!.includes(change)) return no("change");
  return { id, args: [...head, "--baseline", BASE.get(baseline)!, "--change", CHANGE.get(change)!, "--out"] };
}

export const buildArgv = (args: string[], out: string) => [...args, out];
export const refusedBody = (field: Field): Body => ({ state: "refused", reason: `the worker does not accept this job: ${field}` });
export const failedBody = (reason: string): Body => ({ state: "failed", reason });
export const doneBody = (json: string, txt: string): Body => ({ state: "done", compare_json: json, compare_txt: txt });
// Code points, as the API counts characters.
export const capCheck = (json: string, txt: string) => [...json].length <= 524288 && [...txt].length <= 131072;

/** compare's own refusal line, cleaned and cut, or null when stderr has none. */
export function stderrReason(stderr: string): string | null {
  const line = stderr.slice(0, 65_536).split("\n").find((l) => l.startsWith("compare: "));
  return line === undefined ? null : [...line.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, "")].slice(0, 300).join("");
}

/** The line to refuse to start with when the key cannot go in a header as it is, or null. Never prints the key. */
export const keyRefusal = (key: string): string | null => (/[^\x21-\x7e]/.test(key) ? "lab: BIOSENTRY_INGEST_KEY holds a character that cannot go in a header" : null);

export type Outcome = "idle" | "denied" | "error";
export function claimDelay(outcome: Outcome, streak: number): number {
  if (outcome === "idle") return 30_000;
  if (outcome === "denied") return 300_000;
  return Math.min(30_000 * 2 ** (streak - 1), 300_000);
}

export interface Deps {
  base: URL;
  key: string;
  root: string; // the checkout root, set by the entry only
  fetch: typeof fetch;
  spawn: typeof spawn;
  mkdtemp(prefix: string): Promise<string>;
  rm(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
  tmpdir(): string;
  sleep(ms: number): Promise<void>;
  timer(ms: number, fn: () => void): () => void;
  now(): number;
  log(line: string): void;
  onStop(fn: () => Promise<void> | void): void;
}

interface Current {
  stopped: boolean;
  child?: { kill(signal: "SIGKILL"): unknown };
  tmp?: string;
}

const call = (deps: Deps, url: string, extra: RequestInit) =>
  // A redirect must not carry the key elsewhere, and a hung API must not stall the worker.
  deps.fetch(url, { method: "POST", ...extra, headers: { ...(extra.headers as object), "X-Ingest-Key": deps.key }, redirect: "error", signal: AbortSignal.timeout(CALL_MS) });

/** The kept stderr: once over the bound, a chunk is dropped, so it ends at most one chunk past it. */
export const keepStderr = (kept: string, chunk: unknown) => (kept.length < 65_536 ? kept + String(chunk) : kept);

// Only a claim 200 is read, and capped. Every other answer is dropped unread.
const drop = (res: Response) => {
  try {
    void res.body?.cancel().catch(() => {});
  } catch {
    // nothing to free
  }
};

async function readCapped(res: Response): Promise<string | null> {
  if (Number(res.headers.get("content-length")) > CLAIM_CAP) return drop(res), null;
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString("utf8");
    size += value.length;
    if (size > CLAIM_CAP) return void reader.cancel().catch(() => {}), null;
    chunks.push(value);
  }
}

type Claim = { out: "job"; body: unknown } | { out: "idle" | "denied" | "error"; status?: number; note?: string };

async function claim(deps: Deps): Promise<Claim> {
  try {
    const res = await call(deps, routeUrl(deps.base, "claim"), {});
    if (res.status !== 200) drop(res);
    if (res.status === 204) return { out: "idle" };
    if (res.status === 403 || res.status === 503) return { out: "denied", status: res.status };
    if (res.status !== 200) return { out: "error", status: res.status };
    const text = await readCapped(res);
    if (text === null) return { out: "error", note: "the claim answer was not a job" };
    try {
      return { out: "job", body: JSON.parse(text) };
    } catch {
      return { out: "error", note: "the claim answer was not a job" };
    }
  } catch {
    return { out: "error" }; // never the error: it can echo headers or URLs
  }
}

const SPAWN_FAIL = "compare did not start";

interface Ended {
  code: number | null;
  signal: string | null;
  stderr: string;
  fault?: "spawn" | "limit";
}

async function runCompare(deps: Deps, args: string[], out: string, cur: Current): Promise<Body> {
  const ended = await new Promise<Ended>((resolve) => {
    let stderr = "";
    let fault: Ended["fault"];
    let cancel = () => {};
    const end = (code: number | null, signal: string | null) => {
      cancel();
      resolve({ code, signal, stderr, fault });
    };
    try {
      const child = deps.spawn(process.execPath, buildArgv(args, out), { cwd: deps.root, shell: false, stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH ?? "" } });
      cur.child = child;
      child.stderr?.on("data", (d) => void (stderr = keepStderr(stderr, d)));
      child.on("error", () => {
        fault = "spawn";
        end(null, null);
      });
      child.on("close", end);
      cancel = deps.timer(LIMIT_MS, () => {
        fault ??= "limit";
        child.kill("SIGKILL");
      });
    } catch {
      fault = "spawn";
      end(null, null);
    }
  });
  cur.child = undefined;
  if (ended.fault === "spawn" || (ended.code === null && ended.signal === null)) return failedBody(SPAWN_FAIL);
  if (ended.fault === "limit") return failedBody("compare did not finish within 15 minutes");
  if (ended.code === 2) {
    const reason = stderrReason(ended.stderr);
    if (reason) return { state: "refused", reason };
  }
  if (ended.code !== 0) return failedBody(`compare exited with code ${ended.code ?? 128 + (constants.signals[ended.signal as keyof typeof constants.signals] ?? 0)}`);
  try {
    const [json, txt] = await Promise.all([deps.readFile(join(out, "compare.json")), deps.readFile(join(out, "compare.txt"))]);
    return capCheck(json, txt) ? doneBody(json, txt) : failedBody("the compare output is over the size cap");
  } catch {
    return failedBody("the compare output is missing");
  }
}

/** One report, retried on a network fault. Never throws. */
async function report(deps: Deps, id: number, body: Body, cur: Current): Promise<void> {
  const first = deps.now();
  let tries = 0;
  while (tries < 5 && !cur.stopped) {
    if (tries > 0) {
      if (deps.now() - first >= 600_000) break;
      await deps.sleep(reportWaits[tries - 1]);
      if (deps.now() - first >= 600_000 || cur.stopped) break;
    }
    tries++;
    try {
      const res = await call(deps, routeUrl(deps.base, "report", id), { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      drop(res);
      if ([204, 404, 409, 422].includes(res.status)) return deps.log(`lab: report for job ${id} answered ${res.status}`);
    } catch {
      // a failed try, whatever the cause
    }
  }
  deps.log(`lab: report for job ${id} dropped after ${tries} tries`);
}

async function runJob(deps: Deps, v: { id: number; args: string[] } | { id: number; refused: Field }, cur: Current) {
  const { id } = v;
  if ("refused" in v) {
    deps.log(`lab: job ${id} refused before running (${v.refused})`);
    return report(deps, id, refusedBody(v.refused), cur);
  }
  let body = failedBody(SPAWN_FAIL);
  try {
    try {
      cur.tmp = await deps.mkdtemp(join(deps.tmpdir(), "lab-"));
      body = await runCompare(deps, v.args, join(cur.tmp, "out"), cur);
    } catch {
      // body stays failed
    }
    if (!cur.stopped) {
      deps.log(`lab: job ${id} ${body.state === "done" ? "done" : body.state === "refused" ? "refused by compare" : `failed: ${body.reason}`}`);
      await report(deps, id, body, cur);
    }
  } finally {
    // A stop removes the folder itself.
    if (cur.tmp && !cur.stopped) await deps.rm(cur.tmp).catch(() => {});
    cur.tmp = undefined;
  }
}

export async function runWorker(deps: Deps): Promise<void> {
  const cur: Current = { stopped: false };
  // No report on a stop: a restart resumes nothing, and the API fails the run after 20 minutes.
  deps.onStop(async () => {
    cur.stopped = true;
    cur.child?.kill("SIGKILL");
    if (cur.tmp) await deps.rm(cur.tmp).catch(() => {});
  });
  deps.log(`lab: worker started, claiming from ${deps.base.href}`);
  let fails = 0;
  let last = "";
  while (!cur.stopped) {
    let c = await claim(deps);
    if (cur.stopped) break;
    let v: ReturnType<typeof validateJob> | undefined;
    if (c.out === "job") {
      v = validateJob(c.body);
      if ("bad" in v) c = { out: "error", note: "the claim answer was not a job" };
    }
    if (c.out === "job" && v && !("bad" in v)) {
      fails = 0;
      last = "job";
      deps.log(`lab: job ${v.id} claimed`);
      await runJob(deps, v, cur); // then claim again at once
    } else if (c.out === "idle") {
      fails = 0;
      last = "idle";
      await deps.sleep(claimDelay("idle", 0));
    } else if (c.out === "denied") {
      fails = 0;
      if (last !== String(c.status)) deps.log(c.status === 403 ? "lab: the API refused the ingest key (403)" : "lab: the API has no ingest key configured (503)");
      last = String(c.status);
      await deps.sleep(claimDelay("denied", 0));
    } else if (c.out === "error") {
      fails++;
      const wait = claimDelay("error", fails);
      if (c.note) deps.log(`lab: ${c.note}`);
      else if (last !== "error") deps.log(`lab: the API is unreachable or answered ${c.status ?? "nothing"}; next claim in ${wait / 1000} s`);
      last = "error";
      await deps.sleep(wait);
    }
  }
}

/** True when this module is the program being run, also when it was started through a symlink. */
function isMain(argv1: string | undefined, moduleUrl: string) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isMain(process.argv[1], import.meta.url)) {
  const refusal = proxyRefusal(process.env, process.execArgv);
  if (refusal) {
    console.error(refusal);
    process.exit(2);
  }
  const base = parseBase(process.env.BIOSENTRY_API_URL);
  const key = process.env.BIOSENTRY_INGEST_KEY;
  if (!base || !key) {
    console.error("Set BIOSENTRY_API_URL and BIOSENTRY_INGEST_KEY.");
    process.exit(2);
  }
  const keyLine = keyRefusal(key);
  if (keyLine) {
    console.error(keyLine);
    process.exit(2);
  }
  // The bundle is <root>/dist/lab/lab-worker.js, never the cwd.
  const root = fileURLToPath(new URL("../../", import.meta.url));
  for (const path of ["dist/compare/compare.js", ...[...BASE.values()]]) {
    if (!existsSync(join(root, path))) {
      console.error(`lab: ${path} is missing; run npm run lab-worker`);
      process.exit(2);
    }
  }
  const stops: Array<() => Promise<void> | void> = [];
  // Registered before the loop: as PID 1 in a container node ignores a signal with no handler.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      console.log("lab: stopping");
      await Promise.all(stops.map((f) => f()));
      process.exit(0);
    });
  }
  await runWorker({
    base,
    key,
    root,
    fetch,
    spawn,
    mkdtemp,
    rm: (path) => rm(path, { recursive: true, force: true }),
    readFile: (path) => readFile(path, "utf8"),
    tmpdir,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    timer: (ms, fn) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
    now: Date.now,
    log: (line) => console.log(line),
    onStop: (fn) => void stops.push(fn),
  });
}
