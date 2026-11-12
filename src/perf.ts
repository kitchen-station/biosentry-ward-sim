// The page's own timing, for ?perf in the URL only (App.tsx). Render code may not read a clock, so the clock is here.
// Nothing is drawn: the numbers go to the console every 5 s and to window.__perf().

export interface PerfReport {
  seconds: number;
  frames: number; // animation frames
  drawn: number; // frames the renderer painted
  frameMs: { avg: number; p95: number }; // renderer.frame, painted or skipped
  intervalMs: { avg: number; p95: number }; // between animation frames
  stepMsPerSimMinute: number | null;
  backing: [number, number];
}

const stats = (xs: number[]) => {
  if (xs.length === 0) return { avg: 0, p95: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const r = (x: number) => Math.round(x * 100) / 100;
  return { avg: r(xs.reduce((a, b) => a + b, 0) / xs.length), p95: r(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]) };
};

export function createPerf() {
  let frames = 0;
  let drawn = 0;
  let frameMs: number[] = [];
  let intervals: number[] = [];
  let stepMs = 0;
  let simMinutes = 0;
  let from: number | null = null;
  let lastAt: number | null = null;
  return {
    /** One animation frame at `at` (ms); `ms` the time in renderer.frame, null when it was not called. */
    frame(at: number, ms: number | null, painted: boolean) {
      from ??= at;
      if (lastAt !== null) intervals.push(at - lastAt);
      lastAt = at;
      frames += 1;
      if (ms !== null) frameMs.push(ms);
      if (painted) drawn += 1;
    },
    step(ms: number, minutes: number) {
      stepMs += ms;
      simMinutes += minutes;
    },
    /** The numbers since the last report, then starts again. */
    report(at: number, backing: [number, number]): PerfReport {
      const out: PerfReport = {
        seconds: Math.round((at - (from ?? at)) / 10) / 100,
        frames,
        drawn,
        frameMs: stats(frameMs),
        intervalMs: stats(intervals),
        stepMsPerSimMinute: simMinutes > 0 ? Math.round((stepMs / simMinutes) * 1000) / 1000 : null,
        backing,
      };
      [frames, drawn, frameMs, intervals, stepMs, simMinutes, from] = [0, 0, [], [], 0, 0, at];
      return out;
    },
  };
}

export const perfLine = (r: PerfReport) =>
  `[perf] ${r.seconds} s: frames ${r.frames}, drawn ${r.drawn} (${r.seconds > 0 ? Math.round(r.drawn / r.seconds) : 0}/s), frame ms avg ${r.frameMs.avg} p95 ${r.frameMs.p95}, interval ms avg ${r.intervalMs.avg} p95 ${r.intervalMs.p95}, step ms per sim minute ${r.stepMsPerSimMinute ?? "-"}, backing ${r.backing[0]}x${r.backing[1]}`;

/** Runs `start` while the page is visible and stops what it started while hidden. Returns the final stop. */
export function whileVisible(doc: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">, start: () => () => void): () => void {
  let stop: (() => void) | null = doc.hidden ? null : start();
  const change = () => {
    if (doc.hidden) {
      stop?.();
      stop = null;
    } else stop ??= start();
  };
  doc.addEventListener("visibilitychange", change);
  return () => {
    doc.removeEventListener("visibilitychange", change);
    stop?.();
  };
}
