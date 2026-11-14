import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { stepZoom, wheelZoom } from "./camera";
import { floorSummary } from "./building";
import { createVitals, feedVitals, pageView, riskBySel, type HospitalVitals } from "./sim/hospital/vitals";
import { floorOf } from "./hospital-panels";
import { fetchOpenWard, nextGate, screen, startOpenPoll, toLive, type Gate, type OpenWard } from "./open-view";
import { BedTimeline, Inspector, SelectList, selectTargets, stamp, TopBar, VIEW_API, ZoomBar } from "./panels";
import { wardSnapshot } from "./bridge/snapshot";
import { createRenderer, type Renderer } from "./render/draw";
import { createStackRenderer, nextLevel, type LevelEvent } from "./render/stack";
import { buildQuery, buildWorld, drawSeed, NAMED, parseQuery, seedText } from "./scenarios";
import { commandNotice, sendCommand, type CommandBody } from "./sim/commands";
import { createSim, minuteOf, STAFF, step, type Sim, type Stay } from "./sim/sim";
import { createSyntheticSource, FIXTURE_SEED, SYNTHETIC_RULES, type VitalsSource } from "./sim/source";
import { createSync, STOP_TEXT } from "./sim/sync";
import { AnalyticsBoundary } from "./insights/Boundary";
import { createWardStats, feed, summary } from "./sim/ward-stats";
import { createReader, ease, finishedStays, servedNowMs, type LiveView, type StayRow } from "./sim/view";
import { createViewClock, frameDt, frameTicks } from "./clock";
import { createPerf, perfLine, whileVisible } from "./perf";

const DRAW_MS = 1000 / 61; // at most one painted frame per 60 Hz refresh: a 120 Hz display draws every other frame
const POLL_MS = 2000; // as often as the runner publishes
const STAYS_MS = 30_000; // slower: each read of the stays writes an audit row

type Point = { x: number; y: number };

// Viewer mode's source: it reads nothing and has no inject, startAf or admit, so the panels offer none of them.
const VIEW_SOURCE: VitalsSource = { synthetic: true, rules: SYNTHETIC_RULES, seeds: () => [], read: () => null, cuff: () => null };

const DAY_STEPS = 1440 * 60; // sim.ts skipDay: MINUTES_PER_DAY (1440, not exported) x 60 steps a minute at speed 60
const SKIP_CHUNK_MS = 12; // the page paints between chunks of this long
// A hospital world needs no API and is never a viewer. Nothing is saved by the page, so a reload starts fresh.
const HOSPITAL = !VIEW_API && !import.meta.env.VITE_API_URL;
// Once per page load: a restart replaces its own run.
let CLIENT_ID: string | null = null;
// The Analytics page loads when it is first opened. ward-stats.ts stays in this chunk: its history starts with the run.
const loadInsights = () => import("./insights/Insights");
let Insights = lazy(loadInsights);
const pageOf = () => (window.location.hash === "#analytics" ? ("analytics" as const) : ("simulation" as const));
const PERF = new URLSearchParams(window.location.search).has("perf"); // the timing readout (perf.ts); off, none of it runs

// What the standalone page runs: a named scenario, and a seed that replaces both fixed seeds (null: the scenario's own).
type Pick = { id: string; seed: number | null };

function newWorld(pick: Pick): { s: Sim; src: VitalsSource } {
  if (VIEW_API) return { s: createReader()({ shared: null, patients: [] }), src: VIEW_SOURCE }; // empty until the first answer
  if (HOSPITAL) return buildWorld(pick.id, pick.seed);
  const src = createSyntheticSource(FIXTURE_SEED, true);
  return { s: createSim(src), src };
}

function SignIn({ onToken }: { onToken: (token: string) => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget); // read once, so the passphrase is never kept in state
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${VIEW_API}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clinician_id: form.get("clinician"), passphrase: form.get("passphrase") }),
      });
      const token = response.ok ? ((await response.json()) as { token?: unknown }).token : null;
      if (typeof token === "string") return onToken(token);
      setError(
        response.status === 401
          ? "Sign-in failed"
          : response.status === 429
            ? "Too many attempts. Try again later."
            : "Sign-in is not available",
      );
    } catch {
      setError("Cannot reach the ward");
    }
    setBusy(false);
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>BioSentry ward sim</h1>
        <span className="pill">W4</span>
      </header>
      <form className="panel bp signin" onSubmit={submit}>
        <label>
          Clinician
          <select name="clinician">
            {STAFF.map(([id, name, title]) => (
              <option key={id} value={id}>
                {name}, {title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Passphrase
          <input type="password" name="passphrase" autoComplete="current-password" required />
        </label>
        <button type="submit" disabled={busy}>
          Sign in
        </button>
        <p className="error" role="alert">
          {error}
        </p>
      </form>
    </div>
  );
}

export function App() {
  // In memory only: a reload signs out.
  const [token, setToken] = useState<string | null>(null);
  // No token in a viewer build: ask the open route once.
  const [gate, setGate] = useState<Gate>("trying");
  const [first, setFirst] = useState<OpenWard | null>(null);
  useEffect(() => {
    if (!VIEW_API || token !== null || gate !== "trying") return;
    let off = false;
    void fetchOpenWard({ fetch: window.fetch.bind(window), base: VIEW_API }).then((r) => {
      if (off) return;
      if (r.ok) setFirst(r.body);
      setGate((g) => nextGate(g, r.ok ? "probe_ok" : "probe_fail"));
    });
    return () => void (off = true);
  }, [token, gate]);
  const shown = screen(VIEW_API, token, gate, first);
  if (shown === "loading") return <p className="tag">loading</p>;
  if (shown === "signin") return <SignIn onToken={setToken} />;
  const onSignedOut = () => {
    setToken(null);
    setGate((g) => nextGate(g, "signed_out"));
  };
  const watch = shown === "watch" && first ? { first, onBody: setFirst, onGone: () => setGate((g) => nextGate(g, "poll_gone")), onLeave: () => setGate((g) => nextGate(g, "leave")) } : undefined;
  return <Ward token={token} onSignedOut={onSignedOut} watch={watch} />;
}

type Watch = { first: OpenWard; onBody: (w: OpenWard) => void; onGone: () => void; onLeave: () => void };

function Ward({ token, onSignedOut, watch }: { token: string | null; onSignedOut: () => void; watch?: Watch }) {
  const [pick, setPick] = useState<Pick>(() => parseQuery(window.location.search)); // only the standalone page reads it
  const [world, setWorld] = useState(() => newWorld(pick));
  const statsRef = useRef(createWardStats()); // beside the world, not in it: replaced with the world, fed after every step. A viewer never feeds it.
  // The vitals engine (display only), beside the world and replaced with it on every restart. Made only in the standalone hospital build.
  // `world` is the Sim it belongs to: a frame that still holds another Sim feeds nothing into it.
  const vitalsRef = useRef<{ world: Sim; v: HospitalVitals } | null>(null);
  if (HOSPITAL && world.s.hospital && vitalsRef.current?.world !== world.s) vitalsRef.current = { world: world.s, v: createVitals() };
  const [page, setPage] = useState(pageOf);
  useEffect(() => {
    const onHash = () => setPage(pageOf());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const [viewClock] = useState(createViewClock);
  const [view, setView] = useState<number | null>(null); // hospital world: null is the building, else the floor pulled out
  const [skipping, setSkipping] = useState(false);
  const skippingRef = useRef(false);
  const skipTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => {
    clearTimeout(skipTimer.current); // unmount: stop a skip in flight
    skippingRef.current = false;
  }, []);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [viewNotice, setViewNotice] = useState<string | null>(null);
  const [canControl, setCanControl] = useState(false); // viewer mode: the last answer said this clinician may control the runner
  const [commandText, setCommandText] = useState<string | null>(null);
  const commandTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const syncRef = useRef<ReturnType<typeof createSync>>(null);
  const worldRef = useRef(world);
  worldRef.current = world;
  const [selected, setSelected] = useState<string | null>(null);
  const [timeline, setTimeline] = useState(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [, refresh] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer>(null);
  const hoveredRef = useRef<string | null>(null);
  // Viewer mode: where each staff member is drawn, was drawn at the last answer, and is heading.
  const glideRef = useRef({ at: 0, from: new Map<string, Point>(), to: new Map<string, Point>(), drawn: new Map<string, Point>() });

  // Writes each world to the database API, when one is configured.
  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL;
    if (!apiUrl || VIEW_API || world.s.hospital) return; // a viewer writes nothing; a hospital world is never synced (attach.ts header)
    // Not randomUUID, which needs a secure context (plain-HTTP LAN fails).
    CLIENT_ID ??= Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    const sync = createSync({
      apiUrl,
      key: import.meta.env.VITE_INGEST_KEY ?? "",
      clientId: CLIENT_ID,
      fetch: window.fetch.bind(window),
    });
    syncRef.current = sync;
    void sync.start(world.s, world.src);
    const timer = setInterval(() => void sync.flush(), 1000);
    return () => {
      clearInterval(timer);
      syncRef.current = null;
    };
  }, [world]);

  // Watching with no token: the open answer replaces the drawn ward. No other request is made.
  useEffect(() => {
    if (!watch) return;
    const read = createReader();
    const apply = (w: OpenWard) => {
      const sim = read(toLive(w));
      viewClock.take(sim.clockS, sim.speed, sim.ended, performance.now());
      const glide = glideRef.current;
      glideRef.current = { ...glide, at: performance.now(), from: new Map(glide.drawn), to: new Map(sim.staff.map((m) => [m.id, { x: m.x, y: m.y }])) };
      setWorld({ s: sim, src: VIEW_SOURCE });
      setViewNotice(w.sim ? null : "No live ward yet");
    };
    // Each valid answer also replaces `first` in App.
    apply(watch.first);
    return startOpenPoll({
      fetch: window.fetch.bind(window),
      base: VIEW_API!,
      onBody: (w) => {
        watch.onBody(w);
        apply(w);
      },
      onDown: () => {
        viewClock.down();
        setViewNotice("Not updating");
      }, // the last ward stays drawn
      onGone: watch.onGone,
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Viewer mode: each answer replaces the drawn ward.
  useEffect(() => {
    if (!VIEW_API || watch) return;
    const read = createReader();
    let off = false;
    let finished: Stay[] = [];
    let staysAt = -Infinity;
    const pollStays = async (sim: Sim, nowMs: number) => {
      try {
        const response = await fetch(`${VIEW_API}/wards/W4/stays`, { headers: { Authorization: `Bearer ${token}` } });
        if (response.ok) finished = finishedStays((await response.json()) as StayRow[], sim, nowMs);
      } catch {
        // the last list stays
      }
    };
    const poll = async () => {
      try {
        const response = await fetch(`${VIEW_API}/wards/W4/live`, { headers: { Authorization: `Bearer ${token}` } });
        if (off) return;
        if (response.status === 401) return onSignedOut();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const live = (await response.json()) as LiveView;
        if (off) return;
        const sim = read(live);
        viewClock.take(sim.clockS, sim.speed, sim.ended, performance.now());
        // Not awaited: the stays show from the next answer, and a slow read never holds the ward back.
        if (live.shared && performance.now() - staysAt >= STAYS_MS) {
          staysAt = performance.now();
          void pollStays(sim, servedNowMs(live, Date.now()));
        }
        sim.stays = [...finished.filter((x) => !sim.patients.some((p) => p.id === x.id)), ...sim.stays];
        const glide = glideRef.current;
        glideRef.current = { ...glide, at: performance.now(), from: new Map(glide.drawn), to: new Map(sim.staff.map((m) => [m.id, { x: m.x, y: m.y }])) };
        setWorld({ s: sim, src: VIEW_SOURCE });
        setViewNotice(live.shared ? null : "No live ward yet");
        setCanControl(live.can_control === true);
      } catch {
        if (!off) {
          viewClock.down();
          setViewNotice("Not updating"); // the last ward stays drawn
        }
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      off = true;
      clearInterval(timer);
    };
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const canvas = canvasRef.current!;
    const renderer: Renderer = HOSPITAL ? createStackRenderer(canvas, () => viewRef.current, () => (vitalsRef.current ? riskBySel(vitalsRef.current.v) : {})) : createRenderer(canvas);
    rendererRef.current = renderer;
    if (import.meta.env.DEV) Object.assign(window, { __ward: worldRef, __step: step }); // for manual checks
    const holder = canvas.parentElement!;
    const observer = new ResizeObserver(() => {
      if (holder.clientWidth > 0) renderer.resize(holder.clientWidth, holder.clientHeight, window.devicePixelRatio || 1); // 0 while hidden
    });
    observer.observe(holder);

    // Off-screen (the narrow layout scrolled past it) nothing is drawn; the sim steps on as before.
    let onScreen = true;
    const seen = new IntersectionObserver((entries) => void (onScreen = entries[entries.length - 1].isIntersecting));
    seen.observe(holder);
    const redraw = () => renderer.redraw();
    canvas.addEventListener("contextrestored", redraw);
    document.fonts?.addEventListener("loadingdone", redraw); // the tags' pixel font arrives after the first frames

    let raf = 0;
    let last = performance.now();
    let spare = 0;
    let wasHidden = false; // set on every visibility change: the first frame after it gives the sim no time
    const onVisibility = () => void (wasHidden = true);
    document.addEventListener("visibilitychange", onVisibility);
    let lastDraw = -Infinity;
    let pending = 0; // seconds not yet given to the renderer: it eases and moves trolleys by the time since its last frame
    const loop = (now: number) => {
      const dt = frameDt(now - last, wasHidden);
      wasHidden = false;
      last = now;
      pending += Math.min(dt, 0.25); // the renderer eases by this: it never gets more than a quarter second at once
      const { s, src } = worldRef.current;
      const [t0, m0] = PERF ? [performance.now(), minuteOf(s)] : [0, 0];
      const [ticks, left] = frameTicks(spare, dt);
      spare = left;
      for (let i = 0; i < ticks; i++) {
        if (!VIEW_API && !skippingRef.current) {
          step(s, src); // a viewer draws the runner's ward and never advances one
          feed(statsRef.current, s, src);
          if (vitalsRef.current?.world === s) feedVitals(vitalsRef.current.v, s.hospital!, s.clockS);
        }
      }
      if (perf) perf.step(performance.now() - t0, minuteOf(s) - m0);
      if (VIEW_API) {
        // Staff glide from where they are drawn to their newest answer. Only the reader's own Sim is written.
        const glide = glideRef.current;
        for (const m of s.staff) {
          const to = glide.to.get(m.id);
          if (!to) continue;
          const at = ease(glide.from.get(m.id), to, (now - glide.at) / POLL_MS);
          glide.drawn.set(m.id, at);
          [m.x, m.y] = [at.x, at.y];
        }
      }
      if (onScreen && now - lastDraw >= DRAW_MS) {
        const f0 = PERF ? performance.now() : 0;
        const painted = renderer.frame(s, selectedRef.current, hoveredRef.current, pending, now / 1000);
        perf?.frame(now, performance.now() - f0, painted);
        lastDraw = Math.max(lastDraw + DRAW_MS, now - DRAW_MS); // not `now`: that would halve 75 to 144 Hz displays
        pending = 0;
      } else {
        perf?.frame(now, null, false);
        if (!onScreen) {
          s.moves.length = 0; // nobody sees them; a backlog would all arrive in one frame on return
          pending = Math.min(pending, 0.25);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const perf = PERF ? createPerf() : null;
    const perfReport = () => perf!.report(performance.now(), [canvas.width, canvas.height]);
    if (perf) Object.assign(window, { __perf: perfReport });
    const perfLog = perf ? setInterval(() => console.log(perfLine(perfReport())), 5000) : undefined;
    // The panels follow the sim 4 times a second while the page is seen, and only when something they show changed.
    // clockS moves every step, so a running sim refreshes as it always did; a paused or ended one stops re-rendering.
    // A viewer's staff glide between answers without changing any of these, so a viewer always refreshes.
    let shownKey: unknown[] = [];
    const panelKey = () => {
      const { s } = worldRef.current;
      return [s, s.clockS, s.speed, s.ended, s.log[s.log.length - 1], s.patients.length, s.tasks.length, s.stays.length, s.hospital?.lastMinute, skippingRef.current, syncRef.current?.stopped, renderer.userZoom()];
    };
    const stopPanels = whileVisible(document, () => {
      redraw(); // shown again: the canvas may have been dropped while hidden
      const timer = setInterval(() => {
        // Following a person: the open floor changes to the one they are on (the camera follows within it every frame).
        const { s } = worldRef.current;
        const sel = selectedRef.current;
        if (HOSPITAL && sel !== null && s.hospital && viewRef.current !== null) {
          const f = renderer.floorOf?.(s, sel) ?? floorOf(s.hospital, sel);
          if (f !== null && f !== viewRef.current) setView(f);
        }
        const key = panelKey();
        if (!VIEW_API && key.length === shownKey.length && key.every((v, i) => v === shownKey[i])) return;
        shownKey = key;
        refresh((n) => n + 1);
      }, 250);
      return () => clearInterval(timer);
    });
    // The dashboard reads this ward from /api (vite.config.ts). A static host has no /api: ignore.
    const publish = setInterval(() => {
      const { s, src } = worldRef.current;
      if (VIEW_API || s.hospital) return; // the dashboard feed is ward-only
      fetch("/api/snapshot", { method: "POST", body: JSON.stringify(wardSnapshot(s, src.synthetic)) }).catch(
        () => {},
      );
    }, 2000);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      stopPanels();
      seen.disconnect();
      canvas.removeEventListener("contextrestored", redraw);
      document.fonts?.removeEventListener("loadingdone", redraw);
      clearInterval(publish);
      clearInterval(perfLog);
      observer.disconnect();
    };
  }, []);

  // Viewer mode: the runner takes the command and the next answer shows it. Nothing is changed here.
  const send = canControl
    ? async (body: CommandBody) => {
        const status = await sendCommand(VIEW_API!, token, body);
        if (status === 401) return onSignedOut();
        setCommandText(commandNotice(status));
        clearTimeout(commandTimer.current);
        commandTimer.current = setTimeout(() => setCommandText(null), 6000);
      }
    : undefined;

  const select = (id: string | null) => {
    setSelected(id);
    setTimeline(false);
    const h = worldRef.current.s.hospital;
    if (id !== null && h) setView(floorOf(h, id) ?? viewRef.current); // a panel link or the list goes to that thing's floor
  };
  // Hospital world: the stage's three levels (building, floor, thing). The table is nextLevel in render/stack.ts.
  const go = (e: LevelEvent) => {
    const next = nextLevel({ view: viewRef.current, selected: selectedRef.current }, e);
    setView(next.view);
    if (next.selected !== selectedRef.current) {
      setSelected(next.selected);
      setTimeline(false);
    }
  };
  const goRef = useRef(go);
  goRef.current = go;

  const restart = (next = pick) => {
    rendererRef.current?.reset();
    select(null);
    statsRef.current = createWardStats();
    setWorld(newWorld(next));
    if (HOSPITAL) {
      setPick(next);
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${buildQuery(window.location.search, next.id, next.seed)}${window.location.hash}`);
    }
  };

  const vitals = vitalsRef.current?.world === world.s ? vitalsRef.current.v : null;
  const floors = world.s.hospital ? floorSummary(world.s.hospital, { ...Object.fromEntries(world.s.patients.map((p) => [p.id, p.decision.kind === "ranked" ? p.decision.news2.risk : null])), ...(vitals ? riskBySel(vitals) : {}) }) : [];

  // The same steps as skipDay (sim.ts), in chunks so the page stays responsive. Hospital worlds only.
  const skipDayChunked = () => {
    const { s, src } = worldRef.current;
    if (skippingRef.current || s.ended || !src.admit) return;
    skippingRef.current = true;
    setSkipping(true);
    const speed = s.speed;
    s.speed = 60;
    let left = DAY_STEPS;
    const run = () => {
      if (worldRef.current.s !== s) { // the world was restarted meanwhile
        skippingRef.current = false;
        return setSkipping(false);
      }
      s.speed = 60;
      const until = performance.now() + SKIP_CHUNK_MS;
      while (left > 0 && performance.now() < until) {
        for (let i = 0; i < 200 && left > 0; i += 1, left -= 1) {
          step(s, src);
          feed(statsRef.current, s, src);
          if (vitalsRef.current?.world === s) feedVitals(vitalsRef.current.v, s.hospital!, s.clockS);
        }
      }
      s.moves.length = 0; // as skipDay: a day of trolleys at once would only be noise
      if (left > 0) return void (skipTimer.current = setTimeout(run, 0));
      s.speed = speed;
      skippingRef.current = false;
      setSkipping(false);
    };
    skipTimer.current = setTimeout(run, 0);
  };

  // The keyboard list re-renders only when its buttons would change (select reads only refs and state setters).
  const listKey = JSON.stringify(selectTargets(world.s));
  const selectList = useMemo(() => <SelectList s={world.s} onSelect={select} />, [world.s, listKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const canvasCentre = () => {
    const c = canvasRef.current!;
    return [c.clientWidth / 2, c.clientHeight / 2] as const;
  };
  const zoomBy = (action: "in" | "out" | "fit") => {
    const r = rendererRef.current;
    if (!r) return;
    if (selectedRef.current !== null) select(null); // the user takes the camera back from the selection
    if (action === "fit") return r.fit();
    const [cx, cy] = canvasCentre();
    r.zoomAt(stepZoom(r.userZoom(), action === "in" ? 1 : -1), cx, cy, false);
  };
  const zoomByRef = useRef(zoomBy);
  zoomByRef.current = zoomBy;

  // + - 0, and Escape (hospital world: up one level), unless the key belongs to a form control.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, select, textarea, [contenteditable]")) return;
      if (e.key === "Escape" && HOSPITAL) return goRef.current("escape");
      const action = e.key === "+" || e.key === "=" ? "in" : e.key === "-" ? "out" : e.key === "0" ? "fit" : null;
      if (action) zoomByRef.current(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Canvas: ctrl+wheel and pinch zoom about the cursor. A drag of more than a few pixels pans and is not a click.
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);
  useEffect(() => {
    const canvas = canvasRef.current!;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = rendererRef.current;
      if (!r) return;
      if (selectedRef.current !== null) select(null);
      const rect = canvas.getBoundingClientRect();
      r.zoomAt(wheelZoom(r.userZoom(), e.deltaY, e.deltaMode), e.clientX - rect.left, e.clientY - rect.top, true);
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => canvas.removeEventListener("wheel", wheel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const targetAt = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return (
      rendererRef.current?.hit(world.s, event.clientX - rect.left, event.clientY - rect.top) ?? null
    );
  };

  return (
    <div className="app">
      <TopBar
        page={page}
        s={world.s}
        src={world.src}
        notice={viewNotice ?? commandText ?? (syncRef.current?.stopped ? STOP_TEXT[syncRef.current.stopped] : null)}
        onSignIn={watch?.onLeave}
        onSignOut={VIEW_API && token !== null ? onSignedOut : undefined}
        readClock={VIEW_API ? () => (viewClock.has() ? viewClock.read(performance.now()) : worldRef.current.s.clockS) : undefined}
        onReset={VIEW_API ? send && (() => void send({ kind: "reset", patient_id: null, speed: null })) : () => restart()}
        onSpeed={send && ((speed) => void send({ kind: "set_speed", patient_id: null, speed }))}
        hospital={
          world.s.hospital
            ? {
                skipping, onSkip: skipDayChunked, scenario: pick.id, scenarios: NAMED,
                seedText: seedText(pick.id, pick.seed),
                onScenario: (id) => { setView(null); restart({ id, seed: pick.seed }); },
                onShuffle: HOSPITAL ? () => { setView(null); restart({ id: pick.id, seed: drawSeed(() => crypto.getRandomValues(new Uint32Array(1))[0]) }); } : undefined,
              }
            : undefined
        }
      />
      {page === "analytics" && (
        <main className="main insightsmain">
          {watch ? (
            <p className="insights">Sign in to see ward analytics</p>
          ) : (
            <AnalyticsBoundary onError={() => (Insights = lazy(loadInsights))}>
            <Suspense fallback={<p className="tag">loading</p>}>
              <Insights
                mode={VIEW_API ? "viewer" : HOSPITAL ? "hospital" : "ward"}
                summary={VIEW_API ? null : summary(statsRef.current)}
                patients={world.s.patients}
                label={(m) => stamp(world.src, m)}
                vitals={vitalsRef.current?.world === world.s ? pageView(vitalsRef.current.v) : null}
              />
            </Suspense>
            </AnalyticsBoundary>
          )}
        </main>
      )}
      <main className="main" hidden={page === "analytics"}>
        <div className="floor">
          <canvas
            ref={canvasRef}
            aria-label={
              watch
                ? "Isometric view of ward W4, read-only."
                : HOSPITAL
                ? "Isometric view of the hospital building. Choosing a floor slides it out of the building. Use the floor buttons, and the list after this view for ward W4, to select by keyboard."
                : "Isometric view of ward W4. Use the list after this view to select by keyboard."
            }
            onClick={(e) => {
              if (justDragged.current) return void (justDragged.current = false);
              if (watch) return; // nothing to select without a token
              const id = targetAt(e);
              if (!HOSPITAL) return select(id);
              if (id?.startsWith("floor:")) return go({ slab: Number(id.slice(6)) });
              if (id && viewRef.current !== null) return go({ thing: id, floor: viewRef.current });
              go(id === "" ? "empty" : "outside");
            }}
            onPointerDown={(e) => {
              if (!e.isPrimary) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              dragRef.current = { x: e.clientX, y: e.clientY, moved: false };
              justDragged.current = false;
            }}
            onPointerMove={(e) => {
              const d = dragRef.current;
              if (!d || !e.isPrimary) return;
              if (e.buttons === 0) return void (dragRef.current = null); // the release was missed
              const r = rendererRef.current;
              if (!r?.canPan()) return; // at the default view a sloppy click is still a click
              const [dx, dy] = [e.clientX - d.x, e.clientY - d.y];
              if (!d.moved && Math.hypot(dx, dy) <= 4) return;
              if (!d.moved) {
                d.moved = true;
                if (selectedRef.current !== null) select(null);
              }
              r.pan(dx, dy);
              [d.x, d.y] = [e.clientX, e.clientY];
            }}
            onPointerUp={(e) => {
              if (!e.isPrimary) return;
              justDragged.current = dragRef.current?.moved ?? false;
              dragRef.current = null;
              // The click, if any, follows at once; a drag that ends without one must not eat the next.
              if (justDragged.current) setTimeout(() => (justDragged.current = false), 0);
            }}
            onPointerCancel={() => (dragRef.current = null)}
            onMouseMove={(e) => {
              if (watch) return; // no hover, so no name tag
              hoveredRef.current = targetAt(e);
              e.currentTarget.style.cursor = hoveredRef.current ? "pointer" : "default";
            }}
          />
          {HOSPITAL && (
            <div className="stagebar rail" role="group" aria-label="Floors">
              {[{ floor: null, label: "All", name: "All floors" }, ...floors.map((f) => ({ floor: f.floor, label: f.label, name: `${f.name}: ${f.units.map((u) => u.name).join(" and ")}` }))].map((f) => (
                <button key={f.label} className={view === f.floor ? "on" : ""} aria-pressed={view === f.floor} aria-label={f.name} title={f.name} onClick={() => go({ rail: f.floor })}>
                  {f.label}
                </button>
              ))}
            </div>
          )}
          <ZoomBar pct={Math.round((rendererRef.current?.userZoom() ?? 1) * 100)} onZoom={zoomBy} disabled={HOSPITAL && view === null} />
          {!watch && selectList}
          {timeline && <BedTimeline s={world.s} src={world.src} onSelect={select} onClose={() => setTimeline(false)} />}
        </div>
        <Inspector key={selected ?? ""} s={world.s} src={world.src} selected={selected} onSelect={select} onTimeline={() => setTimeline(true)} floors={floors} building={HOSPITAL && view === null} send={send} watching={!!watch} vitals={vitals} />
      </main>
      <footer className="notice">
        <span>Advisory only. BioSentry does not replace a monitor alarm.</span>
        <span>Staff loop: demo design, not a product feature.</span>
        {world.s.hospital && <span>Hospital layer: synthetic. Staffing outside W4 drives observation rounds only; care there is not modelled.</span>}
      </footer>
    </div>
  );
}
