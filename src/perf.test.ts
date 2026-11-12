import { expect, it } from "vitest";
import { createPerf, perfLine, whileVisible } from "./perf";

it("whileVisible runs its timer only while the page is seen", () => {
  const listeners = new Set<() => void>();
  const doc = { hidden: false, addEventListener: (_: string, f: () => void) => listeners.add(f), removeEventListener: (_: string, f: () => void) => listeners.delete(f) };
  const log: string[] = [];
  const stop = whileVisible(doc as unknown as Document, () => (log.push("start"), () => log.push("stop")));
  const flip = (hidden: boolean) => ((doc.hidden = hidden), listeners.forEach((f) => f()));
  flip(true);
  flip(true);
  flip(false);
  flip(false);
  stop();
  expect(log).toEqual(["start", "stop", "start", "stop"]);
  expect(listeners.size).toBe(0);
  const hiddenAtStart = { ...doc, hidden: true };
  whileVisible(hiddenAtStart as unknown as Document, () => (log.push("never"), () => {}))();
  expect(log).not.toContain("never");
});

it("the perf readout counts frames, paints and intervals, then starts again", () => {
  const p = createPerf();
  p.frame(0, 1, true);
  p.frame(16, 2, false);
  p.frame(32, null, false);
  p.step(3, 2);
  const r = p.report(1000, [1968, 1459]);
  expect(r).toEqual({ seconds: 1, frames: 3, drawn: 1, frameMs: { avg: 1.5, p95: 2 }, intervalMs: { avg: 16, p95: 16 }, stepMsPerSimMinute: 1.5, backing: [1968, 1459] });
  expect(perfLine(r)).toContain("drawn 1 (1/s)");
  expect(p.report(2000, [1, 1])).toMatchObject({ frames: 0, drawn: 0, stepMsPerSimMinute: null });
});
