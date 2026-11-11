import { useEffect, useRef, useState, type FormEvent } from "react";
import { BuildingView, floorSummary, UnitBoard } from "./building";
import { BedTimeline, Inspector, SelectList, TopBar, VIEW_API } from "./panels";
import { wardSnapshot } from "./bridge/snapshot";
import { createRenderer } from "./render/draw";
import { createHospitalSim } from "./sim/hospital/attach";
import { parseScenario } from "./sim/hospital/scenario";
import doh from "../scenarios/hospital/doh-standard.json?raw";
import surge from "../scenarios/hospital/surge.json?raw";
import typical from "../scenarios/hospital/typical.json?raw";
import { createSim, STAFF, step, type Sim, type Stay } from "./sim/sim";
import { createSyntheticSource, FIXTURE_SEED, SYNTHETIC_RULES, type VitalsSource } from "./sim/source";
import { createSync, STOP_TEXT } from "./sim/sync";
import { createReader, ease, finishedStays, type LiveView, type StayRow } from "./sim/view";

const TICK = 1 / 60;
const POLL_MS = 2000; // as often as the runner publishes
const STAYS_MS = 30_000; // slower: each read of the stays writes an audit row

type Point = { x: number; y: number };

// Viewer mode's source: it reads nothing and has no inject, startAf or admit, so the panels offer none of them.
const VIEW_SOURCE: VitalsSource = { synthetic: true, rules: SYNTHETIC_RULES, seeds: () => [], read: () => null, cuff: () => null };

const SCENARIOS: Record<string, string> = { typical, "doh-standard": doh, surge };
const HOSPITAL_SEED = 101;
// A hospital world needs no API and is never a viewer. Nothing is saved by the page, so a reload starts fresh.
const HOSPITAL = !VIEW_API && !import.meta.env.VITE_API_URL;

function newWorld(scenario = "typical"): { s: Sim; src: VitalsSource } {
  if (VIEW_API) return { s: createReader()({ shared: null, patients: [] }), src: VIEW_SOURCE }; // empty until the first answer
  const src = createSyntheticSource(FIXTURE_SEED, true);
  if (HOSPITAL) return { s: createHospitalSim(src, parseScenario(SCENARIOS[scenario]), HOSPITAL_SEED), src };
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
  if (VIEW_API && token === null) return <SignIn onToken={setToken} />;
  return <Ward token={token} onSignedOut={() => setToken(null)} />;
}

function Ward({ token, onSignedOut }: { token: string | null; onSignedOut: () => void }) {
  const [world, setWorld] = useState(() => newWorld());
  const [scenario, setScenario] = useState("typical");
  const [view, setView] = useState<number | null>(null); // hospital world: null is the building, else a floor
  const [panel, setPanel] = useState(true);
  const viewRef = useRef(view);
  viewRef.current = view;
  const onCanvas = !HOSPITAL || view === 4;
  const [viewNotice, setViewNotice] = useState<string | null>(null);
  const clientId = useRef<string>(null);
  const syncRef = useRef<ReturnType<typeof createSync>>(null);
  const worldRef = useRef(world);
  worldRef.current = world;
  const [selected, setSelected] = useState<string | null>(null);
  const [timeline, setTimeline] = useState(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [, refresh] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ReturnType<typeof createRenderer>>(null);
  const hoveredRef = useRef<string | null>(null);
  // Viewer mode: where each staff member is drawn, was drawn at the last answer, and is heading.
  const glideRef = useRef({ at: 0, from: new Map<string, Point>(), to: new Map<string, Point>(), drawn: new Map<string, Point>() });

  // Writes each world to the database API, when one is configured.
  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL;
    if (!apiUrl || VIEW_API || world.s.hospital) return; // a viewer writes nothing; a hospital world is never synced (attach.ts header)
    // Once per page load: a restart replaces its own run. Not randomUUID, which needs a secure context (plain-HTTP LAN fails).
    clientId.current ??= Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    const sync = createSync({
      apiUrl,
      key: import.meta.env.VITE_INGEST_KEY ?? "",
      clientId: clientId.current,
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

  // Viewer mode: each answer replaces the drawn ward.
  useEffect(() => {
    if (!VIEW_API) return;
    const read = createReader();
    let off = false;
    let finished: Stay[] = [];
    let staysAt = -Infinity;
    const pollStays = async (sim: Sim) => {
      try {
        const response = await fetch(`${VIEW_API}/wards/W4/stays`, { headers: { Authorization: `Bearer ${token}` } });
        if (response.ok) finished = finishedStays((await response.json()) as StayRow[], sim, Date.now());
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
        // Not awaited: the stays show from the next answer, and a slow read never holds the ward back.
        if (live.shared && performance.now() - staysAt >= STAYS_MS) {
          staysAt = performance.now();
          void pollStays(sim);
        }
        sim.stays = [...finished.filter((x) => !sim.patients.some((p) => p.id === x.id)), ...sim.stays];
        const glide = glideRef.current;
        glideRef.current = { ...glide, at: performance.now(), from: new Map(glide.drawn), to: new Map(sim.staff.map((m) => [m.id, { x: m.x, y: m.y }])) };
        setWorld({ s: sim, src: VIEW_SOURCE });
        setViewNotice(live.shared ? null : "No live ward yet");
      } catch {
        if (!off) setViewNotice("Not updating"); // the last ward stays drawn
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
    const renderer = createRenderer(canvas);
    rendererRef.current = renderer;
    if (import.meta.env.DEV) Object.assign(window, { __ward: worldRef, __step: step }); // for manual checks
    const holder = canvas.parentElement!;
    const observer = new ResizeObserver(() => {
      if (holder.clientWidth > 0) renderer.resize(holder.clientWidth, holder.clientHeight, window.devicePixelRatio || 1); // 0 while hidden
    });
    observer.observe(holder);

    let raf = 0;
    let last = performance.now();
    let spare = 0;
    const loop = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000); // a hidden tab must not fast-forward
      last = now;
      spare += dt;
      const { s, src } = worldRef.current;
      while (spare >= TICK) {
        if (!VIEW_API) step(s, src); // a viewer draws the runner's ward and never advances one
        spare -= TICK;
      }
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
      if (!HOSPITAL || viewRef.current === 4) renderer.frame(s, selectedRef.current, hoveredRef.current, dt, now / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const panels = setInterval(() => refresh((n) => n + 1), 250);
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
      clearInterval(panels);
      clearInterval(publish);
      observer.disconnect();
    };
  }, []);

  const select = (id: string | null) => {
    setSelected(id);
    setTimeline(false);
    if (id !== null) setPanel(true); // selecting while the panel is collapsed reopens it
  };

  const restart = (name = scenario) => {
    rendererRef.current?.reset();
    select(null);
    setWorld(newWorld(name));
  };

  const floors = world.s.hospital ? floorSummary(world.s.hospital, Object.fromEntries(world.s.patients.map((p) => [p.id, p.decision.kind === "ranked" ? p.decision.news2.risk : null]))) : [];
  const shown = view === null || view === 4 ? null : floors.find((f) => f.floor === view);

  const targetAt = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return (
      rendererRef.current?.hit(world.s, event.clientX - rect.left, event.clientY - rect.top) ?? null
    );
  };

  return (
    <div className="app">
      <TopBar
        s={world.s}
        src={world.src}
        notice={viewNotice ?? (syncRef.current?.stopped ? STOP_TEXT[syncRef.current.stopped] : null)}
        onReset={VIEW_API ? undefined : () => restart()}
        hospital={
          world.s.hospital
            ? {
                view, onView: setView, floors, scenario, scenarios: Object.keys(SCENARIOS), panel,
                onScenario: (name) => { setScenario(name); setView(null); restart(name); },
                onPanel: () => setPanel((p) => !p),
              }
            : undefined
        }
      />
      <main className={`main${world.s.hospital && !panel ? " collapsed" : ""}`}>
        {world.s.hospital && view === null && <BuildingView floors={floors} onPick={setView} />}
        {shown && <UnitBoard f={shown} onBack={() => setView(null)} />}
        <div className="floor" hidden={!onCanvas}>
          {world.s.hospital && view === 4 && (
            <button className="backbtn" onClick={() => setView(null)}>Building</button>
          )}
          <canvas
            ref={canvasRef}
            aria-label="Isometric view of ward W4. Use the list after this view to select by keyboard."
            onClick={(e) => select(targetAt(e))}
            onMouseMove={(e) => {
              hoveredRef.current = targetAt(e);
              e.currentTarget.style.cursor = hoveredRef.current ? "pointer" : "default";
            }}
          />
          <SelectList s={world.s} onSelect={select} />
          {timeline && <BedTimeline s={world.s} src={world.src} onSelect={select} onClose={() => setTimeline(false)} />}
        </div>
        {(!world.s.hospital || panel) && (
          <Inspector s={world.s} src={world.src} selected={selected} onSelect={select} onTimeline={() => setTimeline(true)} />
        )}
      </main>
      <footer className="notice">
        <span>Advisory only. BioSentry does not replace a monitor alarm.</span>
        <span>Staff loop: demo design, not a product feature.</span>
        {world.s.hospital && <span>Hospital layer: synthetic. Staffing outside W4 is shown, not modelled.</span>}
      </footer>
    </div>
  );
}
