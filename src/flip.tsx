import { useRef, useState } from "react";

export const FLIP_GAP_MS = 400; // at most one flip per element in this long; the flip itself is --flip-ms in app.css

export interface FlipState {
  value: string;
  old: string | null;
  n: number;
  at: number;
}

/** Pure. The first value never flips. Too soon after a flip, the text changes in place. */
export function nextFlip(st: FlipState | null, value: string, nowMs: number): FlipState {
  if (st === null) return { value, old: null, n: 0, at: -Infinity };
  if (st.value === value) return st;
  if (nowMs - st.at < FLIP_GAP_MS) return { ...st, value };
  return { value, old: st.value, n: st.n + 1, at: nowMs };
}

/** The markup for a state. `done` is the flip number whose ghost has finished turning: it is gone from the DOM. */
export function FlipView({ st, done = 0, onEnd }: { st: FlipState; done?: number; onEnd?: (n: number) => void }) {
  const { n, old } = st;
  return (
    <span className="flipbox">
      {n > 0 && done !== n && (
        <span key={`o${n}`} className="flip-old" aria-hidden="true" onAnimationEnd={() => onEnd?.(n)}>
          {old}
        </span>
      )}
      <span key={n} className={n > 0 ? "flip" : undefined}>
        {st.value}
      </span>
    </span>
  );
}

/** The new value is in the DOM at once. The old one is a hidden ghost that turns away, then unmounts. Never use inside role="status" or "alert". */
export function Flip({ value }: { value: string | number }) {
  const st = useRef<FlipState | null>(null);
  const [done, setDone] = useState(0);
  st.current = nextFlip(st.current, String(value), performance.now());
  return <FlipView st={st.current} done={done} onEnd={setDone} />;
}
