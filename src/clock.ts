export const TICK = 1 / 60;
// Slow frames must not slow the clock: a visible page that gets one frame a second keeps its speed.
// 5 s bounds the catch-up burst after a stall. A hidden tab is handled by `wasHidden`, not by this cap.
export const MAX_FRAME_S = 5;
export const RESTART_S = 600; // a read this much lower than the last one is a runner restart
export const SNAP_WALL_S = 10; // a gap of more than this many wall seconds at the current speed snaps
export const READ_MS = 2000; // as POLL_MS (App.tsx) and OPEN_POLL_MS (open-view.ts)
export const AHEAD_MS = READ_MS + 1000; // a late read stops the clock here instead of guessing on

/** Wall seconds a frame gives the sim. The first frame after a hidden spell gives 0: a hidden tab must not fast-forward. */
export const frameDt = (elapsedMs: number, wasHidden = false) => (wasHidden ? 0 : Math.min(MAX_FRAME_S, elapsedMs / 1000));

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

/**
 * Holds the last read. The shown clock follows the last read run on at its speed, moving at most twice the speed.
 * It snaps on the first read, a restart, a pause, an end, a speed change, or a gap of over SNAP_WALL_S wall seconds.
 * It never runs backwards otherwise. A read lower by under RESTART_S is an old answer and is ignored.
 */
export function createViewClock() {
  let last = { clockS: 0, speed: 0, receivedAt: 0, stopped: false };
  let shown = 0;
  let lastNow: number | null = null;
  let snap = true;
  let started = false;
  return {
    take(clockS: number, speed: number, ended: boolean, atMs: number) {
      if (started) {
        if (clockS < last.clockS) {
          if (last.clockS - clockS < RESTART_S) return; // an older answer that landed late
          snap = true; // a restart
        } else if (speed === 0 || ended || speed !== last.speed) snap = true;
      }
      started = true;
      last = { clockS, speed, receivedAt: atMs, stopped: ended };
      if (snap) shown = clockS;
    },
    /** "Not updating": frozen until the next take. */
    down() {
      last = { ...last, stopped: true };
    },
    read(nowMs: number) {
      const target = shownClock(last.clockS, last.speed, last.receivedAt, nowMs, last.stopped);
      const dtS = lastNow === null ? 0 : Math.max(0, (nowMs - lastNow) / 1000);
      const gap = target - shown;
      if (snap || lastNow === null || gap > SNAP_WALL_S * last.speed) shown = target;
      else if (gap > 0) shown += Math.min(gap, 2 * last.speed * dtS);
      shown = Math.min(shown, last.clockS + (last.speed * AHEAD_MS) / 1000);
      snap = false;
      lastNow = nowMs;
      return shown;
    },
  };
}
