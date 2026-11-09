import { useEffect, useRef, useState } from "react";
import { BedTimeline, Inspector, SelectList, TopBar } from "./panels";
import { wardSnapshot } from "./bridge/snapshot";
import { createRenderer } from "./render/draw";
import { createSim, step, type Sim } from "./sim/sim";
import { createSyntheticSource, FIXTURE_SEED, type VitalsSource } from "./sim/source";
import { createSync, STOP_TEXT } from "./sim/sync";

const TICK = 1 / 60;

// shortcut: the database API takes a fixed roster at run start, so a live ward keeps its 12 patients until it can register admissions.
function newWorld(): { s: Sim; src: VitalsSource } {
  const src = createSyntheticSource(FIXTURE_SEED, !import.meta.env.VITE_API_URL);
  return { s: createSim(src), src };
}

export function App() {
  const [world, setWorld] = useState(() => newWorld());
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

  // Writes each world to the database API, when one is configured.
  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL;
    if (!apiUrl) return;
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
        step(s, src);
        spare -= TICK;
      }
      renderer.frame(s, selectedRef.current, hoveredRef.current, dt, now / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const panels = setInterval(() => refresh((n) => n + 1), 250);
    // The dashboard reads this ward from /api (vite.config.ts). A static host has no /api: ignore.
    const publish = setInterval(() => {
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
        notice={syncRef.current?.stopped ? STOP_TEXT[syncRef.current.stopped] : null}
        onReset={restart}
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
