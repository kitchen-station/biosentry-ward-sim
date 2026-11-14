import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpenWard, nextGate, parseOpenWard, readCapped, screen, startOpenPoll, toLive, type Gate, type OpenWard } from "./open-view";
import { createReader } from "./sim/view";
import { createSim } from "./sim/sim";
import { createSyntheticSource, FIXTURE_SEED, SYNTHETIC_RULES, type VitalsSource } from "./sim/source";

vi.stubEnv("VITE_VIEW_API_URL", "http://api");
const { Inspector, TopBar } = await import("./panels");

const BASE = "http://api";
const staff = (key: number, role = "rn") => ({ key, role, x: 5.5, y: 6, facing: "front", walking: true, moved: 3, stage: "message", timer: 1.5 });
const good = (): Record<string, unknown> => ({
  ward: "W4",
  synthetic: true,
  can_control: false,
  sim: { clockS: 100, speed: 10, ended: false, staff: [staff(0), staff(1, "charge_rn"), staff(2, "md")], moves: [{ seq: 4, bed: "4A", kind: "out" }] },
  beds: [
    { bed: "4A", state: "ranked", rank: 1, risk: "high" },
    { bed: "2B", state: "not_ranked", rank: null, risk: null },
  ],
});
const text = (o: unknown) => JSON.stringify(o);
const ok = (o: unknown = good()) => new Response(text(o), { status: 200 });

afterEach(() => vi.useRealTimers());

describe("parser", () => {
  it("accepts a good body and reads a missing rank or risk as null", () => {
    expect(parseOpenWard(text(good()))?.beds).toHaveLength(2);
    const b = good();
    b.beds = [{ bed: "4A", state: "ranked" }];
    expect(parseOpenWard(text(b))?.beds[0]).toMatchObject({ rank: null, risk: null });
    expect(parseOpenWard(text({ ...good(), sim: null }))?.sim).toBeNull();
  });

  const broken: [string, (b: any) => void][] = [
    ["ward", (b) => (b.ward = "W5")],
    ["synthetic", (b) => (b.synthetic = false)],
    ["can_control", (b) => (b.can_control = true)],
    ["sim type", (b) => (b.sim = 3)],
    ["clock over bound", (b) => (b.sim.clockS = 1e9 + 1)],
    ["clock negative", (b) => (b.sim.clockS = -1)],
    ["speed", (b) => (b.sim.speed = 5)],
    ["ended", (b) => (b.sim.ended = "no")],
    ["21 staff", (b) => (b.sim.staff = Array.from({ length: 21 }, (_, i) => staff(i % 20)))],
    ["10000 staff", (b) => (b.sim.staff = Array.from({ length: 10000 }, (_, i) => staff(i % 20)))],
    ["dup key", (b) => (b.sim.staff[1].key = 0)],
    ["key range", (b) => (b.sim.staff[0].key = 20)],
    ["role", (b) => (b.sim.staff[0].role = "admin")],
    ["x range", (b) => (b.sim.staff[0].x = 101)],
    ["y null", (b) => (b.sim.staff[0].y = null)],
    ["facing", (b) => (b.sim.staff[0].facing = "left")],
    ["walking", (b) => (b.sim.staff[0].walking = 1)],
    ["moved", (b) => (b.sim.staff[0].moved = 2e9)],
    ["stage", (b) => (b.sim.staff[0].stage = "sleep")],
    ["timer", (b) => (b.sim.staff[0].timer = 1e7)],
    ["21 moves", (b) => (b.sim.moves = Array.from({ length: 21 }, (_, i) => ({ seq: i + 1, bed: "4A", kind: "in" })))],
    ["seq zero", (b) => (b.sim.moves[0].seq = 0)],
    ["seq float", (b) => (b.sim.moves[0].seq = 1.5)],
    ["move kind", (b) => (b.sim.moves[0].kind = "discharged")],
    ["move bed markup", (b) => (b.sim.moves[0].bed = "<img src=x onerror=1>")],
    ["bed markup", (b) => (b.beds[0].bed = "<img src=x onerror=1>")],
    ["bed too long", (b) => (b.beds[0].bed = "A".repeat(21))],
    ["dup bed", (b) => (b.beds[1].bed = "4A")],
    ["101 beds", (b) => (b.beds = Array.from({ length: 101 }, (_, i) => ({ bed: `B${i}`, state: "not_ranked", rank: null, risk: null })))],
    ["state", (b) => (b.beds[0].state = "x")],
    ["rank 0", (b) => (b.beds[0].rank = 0)],
    ["rank over count", (b) => (b.beds[0].rank = 3)],
    ["risk", (b) => (b.beds[0].risk = "critical")],
    ["not_ranked with risk", (b) => (b.beds[1].risk = "low")],
    ["beds missing", (b) => delete b.beds],
  ];
  it.each(broken)("refuses the whole body: %s", (_n, f) => {
    const b = good();
    f(b);
    expect(parseOpenWard(text(b))).toBeNull();
  });

  it("accepts clockS at the bound", () => {
    const b = good() as any;
    b.sim.clockS = 1e9;
    expect(parseOpenWard(text(b))).not.toBeNull();
  });

  it("refuses non-finite numbers, not JSON and an array top", () => {
    expect(parseOpenWard(text(good()).replace('"clockS":100', '"clockS":1e999'))).toBeNull(); // JSON.parse gives Infinity
    expect(parseOpenWard("nope")).toBeNull();
    expect(parseOpenWard("[]")).toBeNull();
  });

  it("ignores unknown keys and never reads or keeps them (rule 7)", () => {
    const raw = text(good()).replace("{", '{"name":"Juan Dela Cruz","vitals":[1],"__proto__":{"polluted":1},');
    const w = parseOpenWard(raw)!;
    expect(w).not.toBeNull();
    expect(Object.keys(w).sort()).toEqual(["beds", "can_control", "sim", "synthetic", "ward"]);
    expect(JSON.stringify(w)).not.toContain("Juan");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const sx = good() as any;
    sx.sim.staff[0].name = "Maria Santos";
    expect(JSON.stringify(parseOpenWard(text(sx)))).not.toContain("Maria");
  });
});

describe("the size cap", () => {
  it("refuses 65,537 bytes, by count and by content-length", async () => {
    expect(await readCapped(new Response("x".repeat(65_537)))).toBeNull();
    expect(await readCapped(new Response("x".repeat(65_536)))).toHaveLength(65_536);
    expect(await readCapped(new Response("{}", { headers: { "content-length": "65537" } }))).toBeNull();
  });
});

describe("fetchOpenWard and the request (rules 1, 3, 5)", () => {
  it("sends a simple credential-free GET: no headers key, omit, no-store, redirect error", async () => {
    const f = vi.fn(async (..._a: Parameters<typeof fetch>) => ok());
    const r = await fetchOpenWard({ fetch: f as unknown as typeof fetch, base: BASE });
    expect(r.ok).toBe(true);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("http://api/wards/W4/open-view");
    expect(init).toMatchObject({ credentials: "omit", cache: "no-store", redirect: "error" });
    expect(init).not.toHaveProperty("headers");
    expect(init).not.toHaveProperty("method");
    expect(init).not.toHaveProperty("body");
  });

  it("classifies the answer", async () => {
    const run = (r: () => Promise<Response>) => fetchOpenWard({ fetch: r as unknown as typeof fetch, base: BASE });
    const status = (s: number) => run(async () => new Response("{}", { status: s }));
    expect(await status(404)).toEqual({ ok: false, kind: "gone" });
    expect(await status(405)).toEqual({ ok: false, kind: "gone" });
    expect(await status(401)).toEqual({ ok: false, kind: "gone" });
    expect(await status(500)).toEqual({ ok: false, kind: "down" });
    expect(await status(503)).toEqual({ ok: false, kind: "down" });
    expect(await run(async () => Promise.reject(new TypeError("net")))).toEqual({ ok: false, kind: "down" });
    expect(await run(async () => new Response("garbage"))).toEqual({ ok: false, kind: "gone" });
    expect(await run(async () => new Response("x".repeat(70_000)))).toEqual({ ok: false, kind: "gone" });
    expect(await run(async () => ok({ ...good(), ward: "W5" }))).toEqual({ ok: false, kind: "gone" });
  });

  it("times out after 5 s even when fetch ignores the signal", async () => {
    vi.useFakeTimers();
    const p = fetchOpenWard({ fetch: (() => new Promise(() => {})) as unknown as typeof fetch, base: BASE });
    await vi.advanceTimersByTimeAsync(4999);
    let done = false;
    void p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ ok: false, kind: "down" });
  });

  it("the timeout aborts the request, so a hung one does not stay open", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const f = (_u: string, init: RequestInit) => ((signal = init.signal ?? undefined), new Promise<Response>(() => {}));
    const p = fetchOpenWard({ fetch: f as unknown as typeof fetch, base: BASE });
    await vi.advanceTimersByTimeAsync(4999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ ok: false, kind: "down" });
    expect(signal?.aborted).toBe(true);
  });
});

describe("the poll (rules 5, 8)", () => {
  it("asks 2 s after the last answer, never overlaps, only the open route, and stops", async () => {
    vi.useFakeTimers();
    const urls: string[] = [];
    let inflight = 0;
    let maxInflight = 0;
    const f = vi.fn(async (u: string) => {
      urls.push(u);
      maxInflight = Math.max(maxInflight, ++inflight);
      await new Promise((r) => setTimeout(r, 5000)); // slow answer
      inflight -= 1;
      return ok();
    });
    const bodies = vi.fn();
    const stop = startOpenPoll({ fetch: f as unknown as typeof fetch, base: BASE, onBody: bodies, onDown: vi.fn(), onGone: vi.fn() });
    await vi.advanceTimersByTimeAsync(1999);
    expect(f).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000 + 1999); // answered at 7000, next due at 9000
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(maxInflight).toBe(1);
    expect(urls.every((u) => u === "http://api/wards/W4/open-view")).toBe(true);
    stop();
    const n = f.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f).toHaveBeenCalledTimes(n);
  });

  it("stop() aborts the request in flight and ignores its late answer", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let answer!: (r: Response) => void;
    const f = vi.fn((_u: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>((r) => (answer = r));
    });
    const onBody = vi.fn();
    const stop = startOpenPoll({ fetch: f as unknown as typeof fetch, base: BASE, onBody, onDown: vi.fn(), onGone: vi.fn() });
    await vi.advanceTimersByTimeAsync(2000);
    expect(signal?.aborted).toBe(false);
    stop();
    expect(signal?.aborted).toBe(true);
    answer(ok());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onBody).not.toHaveBeenCalled();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("keeps polling after a failure, 2 s after it, and stops for good on a gone answer", async () => {
    vi.useFakeTimers();
    const answers = [() => Promise.reject(new Error("x")), () => Promise.resolve(new Response("", { status: 404 })), () => Promise.resolve(ok())];
    const f = vi.fn(() => answers.shift()!());
    const [onDown, onGone] = [vi.fn(), vi.fn()];
    startOpenPoll({ fetch: f as unknown as typeof fetch, base: BASE, onBody: vi.fn(), onDown, onGone });
    await vi.advanceTimersByTimeAsync(2000);
    expect(onDown).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(onGone).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("the gate (rows of the state table)", () => {
  const rows: [Gate, Parameters<typeof nextGate>[1], Gate][] = [
    ["trying", "probe_ok", "watch"],
    ["trying", "probe_fail", "signin"],
    ["watch", "poll_gone", "signin"],
    ["watch", "leave", "signin"],
    ["watch", "probe_ok", "watch"],
    ["signin", "probe_ok", "signin"],
    ["signin", "poll_gone", "signin"],
    ["signin", "signed_out", "trying"],
    ["watch", "signed_out", "trying"],
  ];
  it.each(rows)("%s + %s -> %s", (g, e, n) => expect(nextGate(g, e)).toBe(n));

  it("screen: no flash, no open route with a token, standalone untouched", () => {
    const first = parseOpenWard(text(good()));
    expect(screen("http://api", null, "trying", null)).toBe("loading");
    expect(screen("http://api", null, "watch", first)).toBe("watch");
    expect(screen("http://api", null, "watch", null)).toBe("signin"); // no body, no watching
    expect(screen("http://api", null, "signin", null)).toBe("signin");
    for (const g of ["trying", "watch", "signin"] as const) {
      expect(screen("http://api", "tok", g, null)).toBe("ward");
      expect(screen(undefined, null, g, null)).toBe("ward");
    }
  });
});

describe("the drawn ward (rules 2, 6)", () => {
  const w = parseOpenWard(text(good())) as OpenWard;
  const live = toLive(w);
  const sim = createReader()(live);

  it("names a figure only by its role word", () => {
    expect(sim.staff.map((m) => m.name)).toEqual(["Nurse", "Charge nurse", "Physician"]);
    const all = JSON.stringify(sim);
    for (const bad of ["Santos", "Reyes", "Dela Cruz", "Manalo", "Aquino", "rn-", "md-santos"]) expect(all).not.toContain(bad);
    expect(sim.staff.every((m) => m.title === "" && m.task === null && m.id.startsWith("open-"))).toBe(true);
  });

  it("drops bed labels that are not on the map, so the drawing cannot throw", () => {
    const b = good() as any;
    b.beds.push({ bed: "Z9", state: "not_ranked", rank: null, risk: null });
    b.sim.moves.push({ seq: 5, bed: "Z9", kind: "in" });
    const l = toLive(parseOpenWard(text(b))!);
    expect(l.patients.map((p) => p.view.bed)).toEqual(["4A", "2B"]);
    expect(l.shared!.moves.map((m) => m.bed)).toEqual(["4A"]);
  });

  it("a bed with no rank or risk is grey and has no rank; kind out is a discharge trolley", () => {
    expect(sim.patients[1].decision.kind).toBe("not_ranked");
    expect(sim.patients[1].rank).toBeNull();
    expect(sim.patients[0].rank).toBe(1);
    expect(live.shared!.moves[0].kind).toBe("discharged");
    const b = good() as any;
    b.beds[0].rank = null; // risk set, rank null: still no tag
    expect(toLive(parseOpenWard(text(b))!).patients[0].view.rank).toBeNull();
  });

  it("an empty sim answer draws the beds with no shared view", () => {
    expect(toLive({ ...w, sim: null }).shared).toBeNull();
  });
});

describe("sign out", () => {
  const src: VitalsSource = { synthetic: true, rules: SYNTHETIC_RULES, seeds: () => [], read: () => null, cuff: () => null };
  const s = createSim(createSyntheticSource(FIXTURE_SEED, true));
  it("the top bar shows Sign out only when given the handler, and the button calls it", () => {
    expect(renderToStaticMarkup(createElement(TopBar, { s, src, notice: null }))).not.toContain("Sign out");
    expect(renderToStaticMarkup(createElement(TopBar, { s, src, notice: null, onSignIn: () => {} }))).not.toContain("Sign out");
    const el = TopBar({ s, src, notice: null, onSignOut: () => {} });
    expect(renderToStaticMarkup(el)).toContain("<button>Sign out</button>");
  });
  it("a sign-out tries the open route again; sign-in once shown is kept", () => {
    expect(nextGate("signin", "signed_out")).toBe("trying");
    expect(nextGate("trying", "probe_ok")).toBe("watch");
    expect(nextGate("trying", "probe_fail")).toBe("signin");
  });
  it("App passes the handler only to a signed-in viewer", () => {
    expect(readFileSync("src/App.tsx", "utf8")).toContain("onSignOut={VIEW_API && token !== null ? onSignedOut : undefined}");
  });
});

describe("no control, no storage, no console (rules 3, 4, 9)", () => {
  const VIEW_SOURCE: VitalsSource = { synthetic: true, rules: SYNTHETIC_RULES, seeds: () => [], read: () => null, cuff: () => null };
  const s = createSim(createSyntheticSource(FIXTURE_SEED, true));

  it("the top bar offers sign-in and no speed or reset; the watch panel has no patient buttons", () => {
    const bar = renderToStaticMarkup(createElement(TopBar, { s, src: VIEW_SOURCE, notice: null, onSignIn: () => {} }));
    expect(bar).toContain("Sign in to control");
    expect(bar).toContain("Watching, read-only");
    for (const word of ["Pause", "Reset"]) expect(bar).not.toContain(word);
    // The speed shows as read-only text. A speed button or the speed group must not appear.
    for (const word of ["1x", "10x", "60x"]) expect(bar).not.toContain(`>${word}</button>`);
    expect(bar).not.toContain('aria-label="Simulation speed"');
    expect(bar).toMatch(/<span class="pill" title="Simulation speed">60x<\/span>/);
    expect(bar.match(/<button/g)).toHaveLength(1); // the sign-in button only
    for (const x of ["<select", "<input", 'role="button"', 'role="radio"', 'role="slider"']) expect(bar).not.toContain(x);
    // The pill is not inside a button.
    expect([...bar.matchAll(/<button[\s\S]*?<\/button>/g)].map((m) => m[0]).join("")).not.toMatch(/\d+x|Paused/);
    const panel = renderToStaticMarkup(createElement(Inspector, { s, src: VIEW_SOURCE, selected: null, onSelect: () => {}, onTimeline: () => {}, watching: true }));
    expect(panel).toContain("Watching W4");
    expect(panel).not.toContain("<button");
    expect(panel).not.toContain("NR"); // a watcher never sees an NR tag
  });

  it("App.tsx and open-view.ts hold no browser storage, and open-view.ts never logs", () => {
    const storage = /localStorage|sessionStorage|indexedDB|document\.cookie|caches\./;
    for (const file of ["src/open-view.ts", "src/App.tsx"]) expect(code(file)).not.toMatch(storage);
    expect(readFileSync("src/open-view.ts", "utf8")).not.toMatch(/console\./);
  });

  // Comments are cut first, so a guard kept only in a comment fails.
  const code = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const app = () => code("src/App.tsx");
  const before = (src: string, guard: string, thing: string) => {
    const [g, x] = [src.indexOf(guard), src.indexOf(thing)];
    expect(g).toBeGreaterThan(-1);
    expect(x).toBeGreaterThan(g);
  };

  it("the frame loop keeps its hidden-tab wiring and the renderer's quarter-second clamp", () => {
    for (const s of ['document.addEventListener("visibilitychange", onVisibility)', "frameDt(now - last, wasHidden)", "pending += Math.min(dt, 0.25)"]) expect(app()).toContain(s);
    expect(code("src/flip.tsx")).toContain("onEnd={setDone}");
    expect(code("src/flip.tsx")).toContain("onAnimationEnd={() => onEnd?.(n)}");
  });

  it("the viewer clock is fed at two places and frozen at two", () => {
    expect(app().match(/viewClock\.take\(/g)).toHaveLength(2);
    expect(app().match(/viewClock\.down\(\)/g)).toHaveLength(2);
  });

  it("the /live effect and the probe effect keep their guards", () => {
    before(app(), "if (!VIEW_API || watch) return;", "/wards/W4/live");
    before(app(), 'if (!VIEW_API || token !== null || gate !== "trying") return;', "fetchOpenWard(");
  });

  it("click, hover and the select list are off while watching", () => {
    const a = app();
    const click = a.slice(a.indexOf("onClick={(e) => {"), a.indexOf("onPointerDown"));
    before(click, "if (watch) return", "targetAt(e)");
    const move = a.slice(a.indexOf("onMouseMove="), a.indexOf("/>", a.indexOf("onMouseMove=")));
    before(move, "if (watch) return", "targetAt(e)");
    expect(a).toContain("{!watch && selectList}");
    expect(a.match(/\{selectList\}/g)).toBeNull();
  });

  it("the watch effect only reads the open route: no other request, no command, no token", () => {
    const a = app();
    const start = a.indexOf("if (!watch) return;");
    const watchEffect = a.slice(start, a.indexOf("}, []);", start));
    expect(start).toBeGreaterThan(-1);
    expect(watchEffect).toContain("startOpenPoll(");
    expect(watchEffect).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|sendCommand|\/live|\/stays|\/session|Authorization|token/);
    before(watchEffect, "watch.onBody(w)", "apply(w)"); // App keeps the latest body for a return from Analytics
    expect(a.match(/\bsendCommand\(/g)).toHaveLength(1); // the one call that needs a token
    expect(a).not.toMatch(/XMLHttpRequest|sendBeacon/);
  });

  // shortcut: pinned. main's App.tsx has 4 fetch( calls: /session, /stays, /live, /api/snapshot. Update only for a call that needs a token or is not for the open route.
  const MAIN_FETCH_CALLS = 4;
  it("App.tsx has no new fetch, and only open-view.ts names the open route", () => {
    expect(app().match(/\bfetch\(/g)).toHaveLength(MAIN_FETCH_CALLS);
    expect(app()).not.toMatch(/wards\/[^\n]*open-view/);
    expect(code("src/open-view.ts").match(/\/open-view`/g)).toHaveLength(1);
    expect(code("src/open-view.ts").match(/\bf\(/g)).toHaveLength(1);
  });
});
