export const TICK = 1 / 60;
export const MAX_FRAME_S = 0.25; // a hidden tab must not fast-forward
export const READ_MS = 2000; // as POLL_MS (App.tsx) and OPEN_POLL_MS (open-view.ts)
export const AHEAD_MS = READ_MS + 1000; // a late read stops the clock here instead of guessing on

/** Wall seconds a frame gives the sim. */
export const frameDt = (elapsedMs: number) => Math.min(MAX_FRAME_S, elapsedMs / 1000);

/** Ticks owed after `dt` more seconds, and what carries over. Same arithmetic as the frame loop always had. */
export function frameTicks(spare: number, dt: number): [number, number] {
  let n = 0;
  spare += dt;
  while (spare >= TICK) {
    spare -= TICK;
    n++;
  }
  return [n, spare];
}

/** The viewer's clock: the last read run on at its speed, never more than AHEAD_MS ahead. Stopped: frozen. */
export function shownClock(lastClockS: number, lastSpeed: number, receivedAtMs: number, nowMs: number, stopped: boolean): number {
  if (stopped) return lastClockS;
  return lastClockS + (lastSpeed * Math.min(AHEAD_MS, Math.max(0, nowMs - receivedAtMs))) / 1000;
}

/** Holds the last read. It never runs backwards, except after a runner restart (a clock lower than the last read). */
export function createViewClock() {
  let last = { clockS: 0, speed: 0, receivedAt: 0, stopped: false };
  let shown = 0;
  return {
    take(clockS: number, speed: number, ended: boolean, atMs: number) {
      if (clockS < last.clockS) shown = 0; // a restart
      last = { clockS, speed, receivedAt: atMs, stopped: ended };
    },
    /** "Not updating": frozen until the next take. */
    down() {
      last = { ...last, stopped: true };
    },
    read(nowMs: number) {
      shown = Math.max(shown, shownClock(last.clockS, last.speed, last.receivedAt, nowMs, last.stopped));
      return shown;
    },
  };
}
