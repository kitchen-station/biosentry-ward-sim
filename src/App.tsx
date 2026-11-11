import { useEffect, useRef, useState, type FormEvent } from "react";
import { BedTimeline, Inspector, SelectList, TopBar, VIEW_API } from "./panels";
import { wardSnapshot } from "./bridge/snapshot";
import { createRenderer } from "./render/draw";
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

function newWorld(): { s: Sim; src: VitalsSource } {
  if (VIEW_API) return { s: createReader()({ shared: null, patients: [] }), src: VIEW_SOURCE }; // empty until the first answer
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
  if (VIEW_API && token === null) return <SignIn onToken={setToken} />;
  return <Ward token={token} onSignedOut={() => setToken(null)} />;
}

function Ward({ token, onSignedOut }: { token: string | null; onSignedOut: () => void }) {
  const [world, setWorld] = useState(() => newWorld());
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
    if (!apiUrl || VIEW_API) return; // a viewer writes nothing
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
    const observer = new ResizeObserver(() =>
      renderer.resize(holder.clientWidth, holder.clientHeight, window.devicePixelRatio || 1),
    );
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
      renderer.frame(s, selectedRef.current, hoveredRef.current, dt, now / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const panels = setInterval(() => refresh((n) => n + 1), 250);
    // The dashboard reads this ward from /api (vite.config.ts). A static host has no /api: ignore.
    const publish = setInterval(() => {
      if (VIEW_API) return;
      const { s, src } = worldRef.current;
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
  };

  const restart = () => {
    rendererRef.current?.reset();
    select(null);
    setWorld(newWorld());
  };

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
        onReset={VIEW_API ? undefined : restart}
      />
      <main className="main">
        <div className="floor">
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
        <Inspector s={world.s} src={world.src} selected={selected} onSelect={select} onTimeline={() => setTimeline(true)} />
      </main>
      <footer className="notice">
        <span>Advisory only. BioSentry does not replace a monitor alarm.</span>
        <span>Staff loop: demo design, not a product feature.</span>
      </footer>
    </div>
  );
}
