// The month loop of a hospital run (owner: "a real hospital for a month, over and over"). At ward day 30 the run closes and a
// new run starts with the next seed and the same scenario. Pure but for the sync it is given: no file, no clock, no network of
// its own, so the boundary and a restart at the boundary are tested without a server.
//
// What keeps it safe:
//  - The seed of a month is the seed before it plus one, so the sequence can be repeated from the first seed. Each switch is logged.
//  - The state file is written again only once the API has accepted the new run (`maySave`), and the runner writes it at that
//    very moment (the sync's `onRun`), with the new world already in place (`swap` is called before the run is asked for).
//  - A runner that starts on a file whose month is over does not continue the old run: it starts the next month at once
//    (`due` at start-up).
//  - A runner whose last file is from just before the month's end, and whose old run the API now refuses as superseded,
//    was killed after the API took the new run and before the file was written. It does not exit (the container would start
//    it into the same refusal for ever): it starts the next month (`recover`). The same seed again, in a newer run. The API
//    holds one live run, the newest, so there are never two.
import { minuteOf, say, type Sim, type Speed } from "../sim";
import type { VitalsSource } from "../source";

export const MONTH_DAYS = 30;
export const MONTH_MIN = MONTH_DAYS * 1440;
/** How close to its end a month must be for a "superseded" answer to mean "the next month was already started". The runner saves every 10 s: at 60x that is 10 ward minutes. */
export const MONTH_GRACE_MIN = 60;

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
  const nearEnd = (s: Sim) => !!s.hospital && minuteOf(s) >= monthMin - MONTH_GRACE_MIN;

  async function next(old: World, swap: (w: World) => void): Promise<void> {
    const was = old.s.hospital!.seed;
    const fresh = d.fresh(old.s.speed, was + 1);
    fresh.s.rounds = old.s.rounds;
    // The old run is told it ended, with whatever is still queued. Best effort: a server that is down hears of the new run later.
    old.s.ended = true;
    await d.sync.flush();
    waiting = true;
    d.log(`Month ended at minute ${minuteOf(old.s)}: seed ${was} closes, seed ${was + 1} starts`);
    say(fresh.s, `New month: hospital seed ${was + 1}`);
    swap(fresh); // before the run is asked for: a save at the moment of acceptance writes the new world
    await d.sync.start(fresh.s, fresh.src);
  }
  const once = async (f: () => Promise<void>) => {
    busy = true;
    try {
      await f();
    } finally {
      busy = false;
    }
  };

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
    /** Call after stepping. When the month is over, starts the next one: `swap` gets the new world. One switch at a time. */
    async turn(w: World, swap: (w: World) => void): Promise<void> {
      if (busy || !due(w.s)) return;
      await once(() => next(w, swap));
    },
    /**
     * The API refused this world's run as superseded. True: the month was at its end, so the next month is started and the
     * runner goes on. False: a newer run from somewhere else took over in mid-month; the runner stops, as it always did.
     */
    async recover(w: World, swap: (w: World) => void): Promise<boolean> {
      if (busy || !nearEnd(w.s)) return busy;
      d.log(`The old run was replaced near the month's end (minute ${minuteOf(w.s)}): the next month was started before a stop, so it starts again`);
      await once(() => next(w, swap));
      return true;
    },
  };
}
