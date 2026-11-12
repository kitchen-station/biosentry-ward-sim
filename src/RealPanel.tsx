import { useEffect, useRef } from "react";
import { BUCKETS, ROWS, SYNTHETIC_LINE } from "./real";

/** "What is real here": a modal panel in the app's panel style. Escape and the close button close it. */
export function RealPanel({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => opener?.focus();
  }, []);
  return (
    <div className="realback" onClick={onClose}>
      <aside
        className="panel realpanel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="real-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); onClose(); } // preventDefault keeps the app's own Escape from also firing
        }}
      >
        <div className="realhead">
          <h2 className="ptitle" id="real-title">What is real here</h2>
          <button ref={close} onClick={onClose}>Close</button>
        </div>
        <div className="scroll" tabIndex={0} aria-label="What is real here, details">
          <p className="story">{SYNTHETIC_LINE}</p>
          {BUCKETS.map((b) => (
            <section key={b.id}>
              <h3>{b.title}</h3>
              <ul className="reallist">
                {ROWS.filter((r) => r.bucket === b.id).map((r) => (
                  <li key={r.ref}>
                    <strong>{r.thing}</strong>{r.value ? `: ${r.value}.` : "."} {r.why}
                    <small> {r.ref}</small>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </aside>
    </div>
  );
}
