// The month loop of a hospital run (owner: "a real hospital for a month, over and over"). At ward day 30 the run closes and a
// new run starts with the next seed and the same scenario. Pure but for the sync it is given: no file, no clock, no network of
// its own, so the boundary and a restart at the boundary are tested without a server.
//
// What keeps it safe:
//  - The seed of a month is the seed before it plus one, so the sequence can be repeated from the first seed. Each switch is logged.
//  - The state file is written again only once the API has accepted the new run (`maySave`). Until then the file on disk is
//    still the old month, at or past its last day.
//  - A runner that starts on such a file does not continue the old run: it starts the next month at once (`due` at start-up).
//    A crash between "the API accepted the new run" and "the file was replaced" therefore starts the same seed again, in a
//    newer run. The API holds one live run, the newest, so there are never two.
import { minuteOf, say, type Sim, type Speed } from "../sim";
import type { VitalsSource } from "../source";

export const MONTH_DAYS = 30;
export const MONTH_MIN = MONTH_DAYS * 1440;

export interface World { s: Sim; src: VitalsSource }
export interface MonthDeps {
  /** The runner's sync: `start` registers a new run for a world; `run.runId` is null until the API has accepted it. */
  sync: { start(s: Sim, src: VitalsSource): Promise<void>; flush(): Promise<void>; readonly run: { runId: number | null } };
  /** A new hospital of the same scenario at this seed and speed. */
  fresh: (speed: Speed, seed: number) => World;
  log: (line: string) => void;
  /** Tests only: a shorter month. */
  monthMin?: number;
}

export function createMonthLoop(d: MonthDeps) {
  const monthMin = d.monthMin ?? MONTH_MIN;
  let waiting = false; // a new month's run was asked for and the API has not accepted it yet
  let busy = false;
  const due = (s: Sim) => !!s.hospital && minuteOf(s) >= monthMin;

  async function next(old: World): Promise<World> {
    const was = old.s.hospital!.seed;
    const fresh = d.fresh(old.s.speed, was + 1);
    fresh.s.rounds = old.s.rounds;
    // The old run is told it ended, with whatever is still queued. Best effort: a server that is down hears of the new run later.
    old.s.ended = true;
    await d.sync.flush();
    waiting = true;
    d.log(`Month ended at minute ${minuteOf(old.s)}: seed ${was} closes, seed ${was + 1} starts`);
    say(fresh.s, `New month: hospital seed ${was + 1}`);
    await d.sync.start(fresh.s, fresh.src);
    return fresh;
  }

  return {
    /** The month of this world is over: at start-up, start the next one and do not continue the old run. */
    due,
    /** False while a new month's run waits for the API: the state file must stay the old month's. */
    maySave(): boolean {
      if (waiting && d.sync.run.runId !== null) {
        waiting = false;
        d.log(`New month accepted by the API: run ${d.sync.run.runId}`);
      }
      return !waiting;
    },
    /** Call after stepping. The world to go on with: the same one, or the next month's when this one is over. One switch at a time. */
    async turn(w: World): Promise<World> {
      if (busy || !due(w.s)) return w;
      busy = true;
      try {
        return await next(w);
      } finally {
        busy = false;
      }
    },
  };
}
