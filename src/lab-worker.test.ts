import { execFileSync, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BASE, buildArgv, capCheck, CHANGE, claimDelay, type Deps, PAIRS, parseBase, proxyRefusal, reportWaits, routeUrl, runWorker, stderrReason, validateJob, W4_RULES } from "./lab-worker";

const KEY = "k-SECRET-9f3a";
const W4 = { id: 12, kind: "compare", mode: "w4", seed: 4, days: 30, baseline: "news2_total_ge_5", change: "news2_chart_trigger" };
const HOSP = { id: 3, kind: "compare", mode: "hospital", seed: 1, days: 2, baseline: "typical", change: "staffing=doh-standard" };
const BASE_URL = new URL("http://api:8000/");
const OK_JSON = '{"mode":"w4"}';

type Answer = number | Error | object | string; // a status, a throw, a job, or raw 200 text
interface Rig {
  logs: string[];
  calls: { url: string; init: RequestInit }[];
  spawns: { cmd: string; args: string[]; opts: any }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  children: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  removed: string[];
  sleeps: number[];
  reports: { id: string; body: any }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  clock: { t: number };
}

/** Runs the whole loop on fakes until the claims are used up, then stops it. Every case goes through the key check. */
async function drive(o: { claims: Answer[]; reports?: Answer[]; exit?: (c: any, fire: () => void, stop: () => void, r: Rig) => void; reportMs?: number; files?: Record<string, string>; mkdtemp?: boolean }): Promise<Rig> {
  const r: Rig = { logs: [], calls: [], spawns: [], children: [], removed: [], sleeps: [], reports: [], clock: { t: 0 } };
  const stops: Array<() => Promise<void> | void> = [];
  const stop = () => Promise.all(stops.map((f) => f()));
  const timers: Array<() => void> = [];
  const fs = new Map<string, string>();
  const claims = [...o.claims];
  const reports = [...(o.reports ?? [])];
  const answer = (a: Answer | undefined, fallback: number) => {
    if (a instanceof Error) throw a;
    if (typeof a === "number") return new Response(null, { status: a === 204 ? 204 : a });
    if (a === undefined) return new Response(null, { status: fallback });
    return new Response(typeof a === "string" ? a : JSON.stringify(a), { status: 200 });
  };
  const fetchFake = (async (url: string, init: RequestInit) => {
    r.calls.push({ url, init });
    if (url.endsWith("/sim/lab/claim")) {
      if (claims.length === 0) {
        void stop();
        return answer(204, 204);
      }
      return answer(claims.shift(), 204);
    }
    r.clock.t += o.reportMs ?? 0;
    r.reports.push({ id: url.split("/")[6], body: JSON.parse(init.body as string) });
    return answer(reports.shift(), 204);
  }) as unknown as typeof fetch;
  let n = 0;
  const deps: Deps = {
    base: BASE_URL,
    key: KEY,
    root: "/root",
    fetch: fetchFake,
    spawn: ((cmd: string, args: string[], opts: unknown) => {
      r.spawns.push({ cmd, args, opts });
      const c: any = new EventEmitter(); // eslint-disable-line @typescript-eslint/no-explicit-any
      c.stderr = new EventEmitter();
      c.kill = vi.fn(() => setImmediate(() => c.emit("close", null, "SIGKILL")));
      r.children.push(c);
      const out = args[args.length - 1];
      setImmediate(() => {
        if (o.exit) return o.exit(c, () => timers[0](), () => void stop(), r);
        for (const [name, text] of Object.entries(o.files ?? { "compare.json": OK_JSON, "compare.txt": "x\nsynthetic, not validated\n" })) fs.set(join(out, name), text);
        c.emit("close", 0, null);
      });
      return c;
    }) as unknown as Deps["spawn"],
    mkdtemp: async (prefix) => {
      if (o.mkdtemp === false) throw new Error("no space");
      return `${prefix}${++n}`;
    },
    rm: async (p) => void r.removed.push(p),
    readFile: async (p) => {
      if (!fs.has(p)) throw new Error("ENOENT");
      return fs.get(p)!;
    },
    tmpdir: () => "/tmp",
    sleep: async (ms) => {
      r.sleeps.push(ms);
      r.clock.t += ms;
    },
    timer: (_ms, fn) => {
      timers.push(fn);
      return () => {};
    },
    now: () => r.clock.t,
    log: (l) => r.logs.push(l),
    onStop: (fn) => void stops.push(fn),
  };
  await runWorker(deps);
  // P2/R22: the key is in the header only.
  for (const c of r.calls) expect((c.init.headers as Record<string, string>)["X-Ingest-Key"]).toBe(KEY);
  expect(r.logs.join("\n")).not.toContain(KEY);
  for (const s of r.spawns) {
    expect(s.args.join("\n")).not.toContain(KEY);
    expect(Object.values(s.opts.env).join("\n")).not.toContain(KEY);
  }
  return r;
}

describe("proxyRefusal", () => {
  const line = (n: string) => `lab: a proxy variable is set (${n}); the worker does not send the ingest key through a proxy`;
  it("names the first variable found, in the contract order, never its value", () => {
    for (const n of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NODE_USE_ENV_PROXY"]) {
      const out = proxyRefusal({ [n]: "http://secret-proxy:1" }, []);
      expect(out).toBe(line(n));
      expect(out).not.toContain("secret-proxy");
    }
    expect(proxyRefusal({ all_proxy: "x", HTTPS_PROXY: "x" }, [])).toBe(line("HTTPS_PROXY"));
  });
  it("ignores empty values, and refuses the flag in execArgv or NODE_OPTIONS", () => {
    expect(proxyRefusal({ HTTP_PROXY: "", PATH: "/bin" }, ["--no-warnings"])).toBeNull();
    expect(proxyRefusal({}, ["--use-env-proxy"])).toBe(line("--use-env-proxy"));
    expect(proxyRefusal({ NODE_OPTIONS: "--use-env-proxy" }, [])).toBe(line("--use-env-proxy"));
  });
});

describe("base address and routes", () => {
  it("takes only http(s) addresses with no credentials, query or fragment", () => {
    expect(parseBase("http://api:8000")!.href).toBe("http://api:8000/");
    expect(parseBase("https://x.example/p")!.href).toBe("https://x.example/p/");
    for (const bad of [undefined, "", "api:8000", "ftp://x", "file:///etc", "http://u@x", "http://u:p@x", "http://x?a=1", "http://x#f", "javascript:1"]) expect(parseBase(bad), String(bad)).toBeNull();
  });
  it("keeps the origin of the base for any id or base", () => {
    const base = parseBase("http://api:8000")!;
    expect(routeUrl(base, "claim")).toBe("http://api:8000/sim/lab/claim");
    expect(routeUrl(base, "report", 12)).toBe("http://api:8000/sim/lab/runs/12/report");
    const hostile = ["//evil.com/x", "http://evil.com", "..\\..", "../../x", "1@evil.com", "\\\\evil.com", "%2f%2fevil.com", "?x#y", NaN, -1, 1e300, "a b"];
    for (const id of hostile) expect(new URL(routeUrl(base, "report", id as number)).origin).toBe(base.origin);
    for (const raw of ["http://a.com@evil.com", "http://api:8000//evil.com", "http://api:8000/..//evil.com", "http://[::1]:1", "http://api:8000/%2f%2fevil.com", "HTTP://API:8000"]) {
      const b = parseBase(raw);
      if (b) for (const id of hostile) expect(new URL(routeUrl(b, "report", id as number)).origin).toBe(b.origin);
    }
  });
});

describe("validateJob", () => {
  const refused = (patch: object) => validateJob({ ...W4, ...patch });
  it("accepts a W4 job and builds the argv from fixed strings", () => {
    const v = validateJob(W4) as { id: number; args: string[] };
    expect(buildArgv(v.args, "/tmp/lab-1/out")).toEqual(["dist/compare/compare.js", "--seed", "4", "--days", "30", "--baseline", "rule=news2_total_ge_5", "--change", "rule=news2_chart_trigger", "--out", "/tmp/lab-1/out"]);
    expect(W4_RULES.size).toBe(21);
  });
  it("accepts the nine hospital pairs and no other", () => {
    let n = 0;
    for (const [baseline, changes] of PAIRS) {
      for (const change of changes) {
        const v = validateJob({ ...HOSP, baseline, change }) as { args: string[] };
        expect(buildArgv(v.args, "O")).toEqual(["dist/compare/compare.js", "--seed", "1", "--days", "2", "--baseline", BASE.get(baseline), "--change", CHANGE.get(change), "--out", "O"]);
        n++;
      }
    }
    expect(n).toBe(9);
    expect(CHANGE.get("staffing=doh-standard")).toBe("staffing=scenarios/hospital/doh-standard.json");
    expect(CHANGE.get("doctors=typical")).toBe("doctors=scenarios/hospital/typical.json");
  });
  it("refuses with the first failing field, one case per row", () => {
    const rows: [object, string][] = [
      [{ kind: undefined }, "kind"], [{ kind: "Compare" }, "kind"], [{ kind: "question" }, "kind"],
      [{ mode: "x" }, "mode"], [{ mode: undefined }, "mode"],
      [{ seed: "4" }, "seed"], [{ seed: true }, "seed"], [{ seed: null }, "seed"], [{ seed: 4.5 }, "seed"], [{ seed: -1 }, "seed"], [{ seed: 2147483648 }, "seed"],
      [{ days: 0 }, "days"], [{ days: 31 }, "days"], [{ days: 60 }, "days"], [{ days: "3" }, "days"],
      [{ baseline: "news2_total_ge_21" }, "baseline"], [{ baseline: "__proto__" }, "baseline"], [{ baseline: "constructor" }, "baseline"], [{ baseline: 5 }, "baseline"],
      [{ change: "news2_total_ge_5" }, "change"], [{ change: "toString" }, "change"], [{ change: "__proto__" }, "change"], [{ change: "rule=news2_chart_trigger" }, "change"],
      [{ kind: "x", mode: "x", seed: "x" }, "kind"],
    ];
    for (const [patch, field] of rows) expect(refused(patch), JSON.stringify(patch)).toEqual({ id: 12, refused: field });
    const h = (patch: object) => validateJob({ ...HOSP, ...patch });
    for (const [patch, field] of [
      [{ baseline: "nope" }, "baseline"], [{ baseline: "constructor" }, "baseline"],
      [{ baseline: "doh-standard", change: "nurses=doh-standard" }, "change"], [{ baseline: "typical", change: "nurses=typical" }, "change"],
      [{ change: "transferOutAfterH=doh-standard" }, "change"], [{ change: "beds=doh-standard" }, "change"], [{ change: "toString" }, "change"],
    ] as [object, string][]) expect(h(patch), JSON.stringify(patch)).toEqual({ id: 3, refused: field });
  });
  it("accepts 4.0, 4e0 and -0 by value", () => {
    for (const text of ['{"seed":4.0}', '{"seed":4e0}', '{"seed":-0}']) {
      const v = validateJob({ ...W4, ...JSON.parse(text) }) as { args: string[] };
      expect(v.args[2]).toMatch(/^\d+$/);
    }
  });
  it("calls a body without a usable id bad", () => {
    for (const id of [0, -1, 1.5, "12", 2 ** 53, undefined, null]) expect(validateJob({ ...W4, id })).toEqual({ bad: true });
    for (const b of [null, [], "x", 5, undefined]) expect(validateJob(b)).toEqual({ bad: true });
    expect(validateJob({ ...W4, id: 2 ** 53 - 1 })).toHaveProperty("args");
  });
  it("ignores a field it does not know", () => {
    expect(validateJob({ ...W4, path: "/etc", shell: "rm -rf /" })).toEqual(validateJob(W4));
  });
});

describe("small pure parts", () => {
  it("counts caps in code points", () => {
    expect(capCheck("é".repeat(524288), "")).toBe(true);
    expect(capCheck("a".repeat(524289), "")).toBe(false);
    expect(capCheck("", "a".repeat(131073))).toBe(false);
    expect(capCheck("", "\u{1F600}".repeat(131072))).toBe(true); // one astral char counts 1
  });
  it("cleans compare's refusal line", () => {
    expect(stderrReason("compare: bad\n")).toBe("compare: bad");
    expect(stderrReason("compare: bad\r\n")).toBe("compare: bad");
    expect(stderrReason("(node:1) Warning: x\ncompare: bad\n")).toBe("compare: bad");
    expect([...stderrReason(`compare: ${"a".repeat(400)}`)!]).toHaveLength(300);
    expect(stderrReason("compare: a‮b\tc\u0085d e")).toBe("compare: abcde");
    expect(stderrReason("")).toBeNull();
    expect(stderrReason("something else\n")).toBeNull();
  });
  it("backs off 30, 60, 120, 240, 300, 300 s", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => claimDelay("error", n))).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
    expect(claimDelay("idle", 0)).toBe(30_000);
    expect(claimDelay("denied", 0)).toBe(300_000);
  });
});

describe("the loop, on fakes", () => {
  it("claims, runs, reports and claims again at once, on only the two routes", async () => {
    const r = await drive({ claims: [W4] });
    expect(r.calls.map((c) => c.url)).toEqual(["http://api:8000/sim/lab/claim", "http://api:8000/sim/lab/runs/12/report", "http://api:8000/sim/lab/claim"]);
    expect(r.sleeps).toEqual([]); // no sleep between a report and the next claim
    expect(r.logs).toEqual(["lab: worker started, claiming from http://api:8000/", "lab: job 12 claimed", "lab: job 12 done", "lab: report for job 12 answered 204"]);
  });
  it("sends the claim with no body, the key header, no redirect and a timeout", async () => {
    const r = await drive({ claims: [W4] });
    const [claim, report] = r.calls;
    expect(claim.init).toMatchObject({ method: "POST", headers: { "X-Ingest-Key": KEY }, redirect: "error" });
    expect(claim.init.body).toBeUndefined();
    expect(claim.init.signal).toBeInstanceOf(AbortSignal);
    expect(report.init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json", "X-Ingest-Key": KEY }, redirect: "error" });
    expect(report.init.signal).toBeInstanceOf(AbortSignal);
  });
  it("spawns node with the exact argv and options for a W4 job, and the child env is only PATH", async () => {
    const r = await drive({ claims: [W4] });
    const s = r.spawns[0];
    expect(s.cmd).toBe(process.execPath);
    expect(s.args).toEqual(["dist/compare/compare.js", "--seed", "4", "--days", "30", "--baseline", "rule=news2_total_ge_5", "--change", "rule=news2_chart_trigger", "--out", "/tmp/lab-1/out"]);
    expect(s.opts).toEqual({ cwd: "/root", shell: false, stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH ?? "" } });
    expect(Object.keys(s.opts.env)).toEqual(["PATH"]);
  });
  it("spawns all nine hospital pairs with the table paths", async () => {
    const jobs = [...PAIRS].flatMap(([baseline, cs], i) => cs.map((change, j) => ({ ...HOSP, id: i * 3 + j + 1, baseline, change })));
    const r = await drive({ claims: jobs });
    expect(r.spawns).toHaveLength(9);
    for (const [i, s] of r.spawns.entries()) expect(s.args.slice(5, 9)).toEqual(["--baseline", BASE.get(jobs[i].baseline), "--change", CHANGE.get(jobs[i].change)]);
  });
  it("ignores an extra job field and runs with the exact argv", async () => {
    const r = await drive({ claims: [{ ...W4, path: "/etc" }] });
    expect(r.spawns[0].args).toHaveLength(11);
    expect(r.spawns[0].args.join(" ")).not.toContain("/etc");
  });
  it("refuses a bad job before running: nothing spawned, no temp folder", async () => {
    const r = await drive({ claims: [{ ...W4, days: 31 }] });
    expect(r.spawns).toHaveLength(0);
    expect(r.removed).toEqual([]);
    expect(r.reports).toEqual([{ id: "12", body: { state: "refused", reason: "the worker does not accept this job: days" } }]);
    expect(r.logs).toContain("lab: job 12 refused before running (days)");
  });
  it("posts the two files unchanged on exit 0", async () => {
    const r = await drive({ claims: [W4], files: { "compare.json": " {\"mode\": \"w4\"}\n", "compare.txt": "a\r\nsynthetic, not validated\n" } });
    expect(r.reports[0].body).toEqual({ state: "done", compare_json: ' {"mode": "w4"}\n', compare_txt: "a\r\nsynthetic, not validated\n" });
  });
  it("fails when an output file is missing or over the cap", async () => {
    const missing = (reason: string, files: Record<string, string>) => drive({ claims: [W4], files }).then((r) => expect(r.reports[0].body).toEqual({ state: "failed", reason }));
    await missing("the compare output is missing", { "compare.txt": "x" });
    await missing("the compare output is missing", { "compare.json": "{}" });
    await missing("the compare output is over the size cap", { "compare.json": "a".repeat(524289), "compare.txt": "x" });
    await missing("the compare output is over the size cap", { "compare.json": "{}", "compare.txt": "a".repeat(131073) });
  });
  it("reports compare's own refusal on exit 2, and a code failure otherwise", async () => {
    const exit = (code: number | null, sig: string | null, err = "") => (c: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (err) c.stderr.emit("data", err);
      c.emit("close", code, sig);
    };
    const body = async (e: ReturnType<typeof exit>) => (await drive({ claims: [W4], exit: e })).reports[0].body;
    expect(await body(exit(2, null, "compare: change: same\n"))).toEqual({ state: "refused", reason: "compare: change: same" });
    expect(await body(exit(2, null, "(warn)\r\ncompare: x\r\n"))).toEqual({ state: "refused", reason: "compare: x" });
    expect(await body(exit(2, null, ""))).toEqual({ state: "failed", reason: "compare exited with code 2" });
    expect(await body(exit(2, null, "other\n"))).toEqual({ state: "failed", reason: "compare exited with code 2" });
    expect(await body(exit(1, null, "compare: failed: x\n"))).toEqual({ state: "failed", reason: "compare exited with code 1" });
    expect(await body(exit(3, null))).toEqual({ state: "failed", reason: "compare exited with code 3" });
    expect(await body(exit(255, null))).toEqual({ state: "failed", reason: "compare exited with code 255" });
    expect(await body(exit(null, "SIGKILL"))).toEqual({ state: "failed", reason: "compare exited with code 137" });
  });
  it("fails with `did not start` on a spawn error, a spawn throw, or no temp folder", async () => {
    const start = { state: "failed", reason: "compare did not start" };
    expect((await drive({ claims: [W4], exit: (c) => { c.emit("error", new Error("ENOENT")); c.emit("close", 0, null); } })).reports[0].body).toEqual(start);
    const none = await drive({ claims: [W4], mkdtemp: false });
    expect(none.reports[0].body).toEqual(start);
    expect(none.spawns).toHaveLength(0);
  });
  it("kills at the limit and reports it, whatever exit follows", async () => {
    const r = await drive({ claims: [W4], exit: (c, fire) => { fire(); c.stderr.emit("data", "compare: x"); } });
    expect(r.children[0].kill).toHaveBeenCalledWith("SIGKILL");
    expect(r.reports[0].body).toEqual({ state: "failed", reason: "compare did not finish within 15 minutes" });
  });
  it("removes the temp folder once on every path", async () => {
    const paths: Array<Parameters<typeof drive>[0]> = [
      { claims: [W4] },
      { claims: [W4], files: {} },
      { claims: [W4], exit: (c) => c.emit("close", 2, null) },
      { claims: [W4], exit: (c) => c.emit("error", new Error("x")) },
      { claims: [W4], exit: (_c, fire) => fire() },
      { claims: [W4], reports: [409] },
      { claims: [W4], reports: [422] },
      { claims: [W4], reports: [new Error("down"), new Error("down"), new Error("down"), new Error("down"), new Error("down")] },
    ];
    for (const p of paths) expect((await drive(p)).removed, JSON.stringify(Object.keys(p))).toEqual(["/tmp/lab-1"]);
  });
  it("treats 204, 404, 409 and 422 as final: one call, no rerun", async () => {
    for (const status of [204, 404, 409, 422]) {
      const r = await drive({ claims: [W4], reports: [status] });
      expect(r.reports).toHaveLength(1);
      expect(r.spawns).toHaveLength(1);
      expect(r.logs).toContain(`lab: report for job 12 answered ${status}`);
    }
  });
  it("retries a failed report up to 5 tries with the contract waits", async () => {
    const down = new Error("down");
    const ok = await drive({ claims: [W4], reports: [down, 500, down, 503, 204] });
    expect(ok.reports).toHaveLength(5);
    expect(ok.sleeps).toEqual(reportWaits);
    const six = await drive({ claims: [W4], reports: [down, down, down, down, down, 204] });
    expect(six.reports).toHaveLength(5);
    expect(six.logs).toContain("lab: report for job 12 dropped after 5 tries");
    expect(six.spawns).toHaveLength(1);
  });
  it("starts no try once ten minutes have passed", async () => {
    const r = await drive({ claims: [W4], reports: [500, 500, 500, 500, 500], reportMs: 200_000 });
    expect(r.reports).toHaveLength(3); // tries end at 200 s, 430 s and 690 s
    expect(r.logs).toContain("lab: report for job 12 dropped after 3 tries");
  });
  it("backs off on claim faults and resets on 200 or 204, with one log per streak", async () => {
    const r = await drive({ claims: [500, new Error("x"), 404, "not json", [1], 204, 500] });
    expect(r.sleeps).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 30_000, 30_000]);
    expect(r.logs.filter((l) => l.includes("unreachable"))).toEqual([
      "lab: the API is unreachable or answered 500; next claim in 30 s",
      "lab: the API is unreachable or answered 500; next claim in 30 s",
    ]);
    expect(r.logs.filter((l) => l.includes("not a job"))).toHaveLength(2);
    expect(r.spawns).toHaveLength(0);
  });
  it("waits 5 minutes on 403 and 503 and logs once per streak", async () => {
    const r = await drive({ claims: [403, 403, 503, 503] });
    expect(r.sleeps).toEqual([300_000, 300_000, 300_000, 300_000]);
    expect(r.logs.filter((l) => l.includes("(403)"))).toHaveLength(1);
    expect(r.logs.filter((l) => l.includes("(503)"))).toHaveLength(1);
  });
  it("sends no report for a claim with no usable id", async () => {
    const r = await drive({ claims: [{ ...W4, id: 2 ** 53 }, { ...W4, id: "12" }] });
    expect(r.reports).toEqual([]);
    expect(r.spawns).toHaveLength(0);
  });
  it("never claims while compare runs", async () => {
    let claimsWhileRunning = 0;
    await drive({ claims: [W4], exit: (c, _f, _s, r) => { claimsWhileRunning = r.calls.length; c.emit("close", 0, null); } });
    expect(claimsWhileRunning).toBe(1); // only the claim that gave the job
  });
  it("on a stop kills the child, removes the folder and reports nothing", async () => {
    const r = await drive({ claims: [W4], exit: (_c, _f, stop) => stop() });
    expect(r.children[0].kill).toHaveBeenCalledWith("SIGKILL");
    expect(r.removed).toContain("/tmp/lab-1");
    expect(r.reports).toEqual([]);
  });
  it("never logs the key, even when a fetch throws an error that holds it", async () => {
    const boom = new Error(`fetch failed for X-Ingest-Key: ${KEY}`);
    const a = await drive({ claims: [boom, W4], reports: [boom, 204] });
    expect(a.reports).toHaveLength(2);
    expect(a.logs.join("\n")).not.toContain(KEY);
    expect(a.logs.join("\n")).not.toContain("fetch failed");
  });
});

describe("the built worker", () => {
  const root = mkdtempSync(join(tmpdir(), "lab-e2e-"));
  const env = (extra: Record<string, string>) => ({ PATH: process.env.PATH ?? "", ...extra });

  it("runs a W4 job from the image layout, then stops on SIGTERM; refuses with no env or a proxy", { timeout: 180_000 }, async () => {
    try {
      for (const name of ["compare", "lab-worker"]) {
        const outDir = name === "compare" ? "dist/compare" : "dist/lab";
        execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--ssr", `src/${name}.ts`, "--outDir", join(root, outDir), "--emptyOutDir", "--logLevel", "warn"], { stdio: "pipe" });
      }
      cpSync("scenarios/hospital", join(root, "scenarios/hospital"), { recursive: true });
      const worker = join(root, "dist/lab/lab-worker.js");

      const none = spawnSync(process.execPath, [worker], { env: env({}), encoding: "utf8", timeout: 30_000 });
      expect([none.status, none.stderr]).toEqual([2, "Set BIOSENTRY_API_URL and BIOSENTRY_INGEST_KEY.\n"]);
      const proxied = spawnSync(process.execPath, [worker], { env: env({ BIOSENTRY_API_URL: "http://127.0.0.1:1", BIOSENTRY_INGEST_KEY: KEY, HTTPS_PROXY: "http://secret-proxy:3" }), encoding: "utf8", timeout: 30_000 });
      expect([proxied.status, proxied.stderr]).toEqual([2, "lab: a proxy variable is set (HTTPS_PROXY); the worker does not send the ingest key through a proxy\n"]);

      const seen: { url: string; key: unknown; body: string }[] = [];
      let claims = 0;
      let second!: () => void;
      const afterReport = new Promise<void>((r) => (second = r));
      const server = createServer((req, res) => {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
          seen.push({ url: req.url ?? "", key: req.headers["x-ingest-key"], body });
          if (req.url === "/sim/lab/claim" && ++claims === 1) return void res.writeHead(200).end(JSON.stringify({ id: 1, kind: "compare", mode: "w4", seed: 4, days: 1, baseline: "news2_total_ge_5", change: "news2_chart_trigger" }));
          if (req.url === "/sim/lab/claim") second(); // after the report: the folder is already removed
          res.writeHead(204).end();
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const tmp = mkdtempSync(join(tmpdir(), "lab-tmp-"));
      const child = spawn(process.execPath, [worker], { env: env({ BIOSENTRY_API_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, BIOSENTRY_INGEST_KEY: KEY, TMPDIR: tmp }) });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      const exited = new Promise<number | null>((r) => child.on("close", r));
      try {
        await afterReport;
        const report = seen.find((s) => s.url.endsWith("/report"))!;
        expect(report.url).toBe("/sim/lab/runs/1/report");
        expect(report.key).toBe(KEY);
        const body = JSON.parse(report.body);
        expect(body.state).toBe("done");
        expect(JSON.parse(body.compare_json).mode).toBe("w4");
        expect(body.compare_txt.endsWith("synthetic, not validated\n")).toBe(true);
        child.kill("SIGTERM");
        expect(await exited).toBe(0);
        expect(readdirSync(tmp)).toEqual([]);
        expect(stdout).not.toContain(KEY);
      } finally {
        child.kill("SIGKILL");
        server.close();
        rmSync(tmp, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
