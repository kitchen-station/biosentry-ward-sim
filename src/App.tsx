import { useEffect, useRef, useState } from "react";
import { CommandCenter, StaffStrip, TopBar, type Tab } from "./panels";
import { createRenderer } from "./render/draw";
import { createSim, FIXTURE_SEED, step, type Sim } from "./sim/sim";
import { createSyntheticSource, type VitalsSource } from "./sim/source";

const TICK = 1 / 60;

function newWorld(): { s: Sim; src: VitalsSource } {
  const src = createSyntheticSource(FIXTURE_SEED);
  return { s: createSim(src), src };
}

export function App() {
  const [world, setWorld] = useState(newWorld);
  const worldRef = useRef(world);
  worldRef.current = world;
  const [tab, setTab] = useState<Tab>("ranked");
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [, refresh] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ReturnType<typeof createRenderer>>(null);
  const hoveredRef = useRef<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const renderer = createRenderer(canvas, worldRef.current.s);
    rendererRef.current = renderer;
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
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(panels);
      observer.disconnect();
    };
  }, []);

  const select = (id: string) => {
    setSelected(id);
    setTab("chart");
  };

  const reset = () => {
    rendererRef.current?.reset();
    setSelected(null);
    setWorld(newWorld());
  };

  const bedAt = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return (
      rendererRef.current?.hit(world.s, event.clientX - rect.left, event.clientY - rect.top) ?? null
    );
  };

  return (
    <div className="app">
      <TopBar s={world.s} synthetic={world.src.synthetic} onReset={reset} />
      <main className="main">
        <div className="floor">
          <canvas
            ref={canvasRef}
            aria-label="Isometric view of ward W4. Use the ranked list to select a patient by keyboard."
            onClick={(e) => {
              const id = bedAt(e);
              if (id) select(id);
            }}
            onMouseMove={(e) => {
              hoveredRef.current = bedAt(e);
              e.currentTarget.style.cursor = hoveredRef.current ? "pointer" : "default";
            }}
          />
        </div>
        <CommandCenter
          s={world.s}
          src={world.src}
          tab={tab}
          setTab={setTab}
          selected={selected}
          onSelect={select}
        />
      </main>
      <StaffStrip s={world.s} />
      <footer className="notice">
        <span>Advisory only. BioSentry does not replace a monitor alarm.</span>
        <span>Staff loop: demo design, not a product feature.</span>
      </footer>
    </div>
  );
}
