// Writes the sim to the BioSentry database API: one run per world, then a batch of what changed.
// Plain and headless: fetch is a parameter. A network error or 5xx leaves the rows queued for the
// next flush and never reaches the sim. A refusal (another sim is live, this run was replaced, a
// wrong key) stops the sync for good: the sim carries on locally and `stopped` says why.

import type { Action } from "./actions";
import type { Command } from "./commands";
import type { Run } from "./persist";
import { minuteOf, patientRow, record, signalQuality, type Patient, type Sim } from "./sim";
import { FIXTURE_SEED, WARD_START_ISO, type VitalsSource } from "./source";

// The API's limits per batch, and the most rows kept while it is unreachable.
const BATCH = { observations: 20_000, bins: 20_000, events: 2_000, moves: 200 };
const MAX_QUEUED = 50_000;

export interface SyncOptions {
  apiUrl: string;
  key: string;
  /** Random, 1 to 64 characters, generated once per page load: a sim can replace its own run. */
  clientId: string;
  fetch: typeof fetch;
}

export type StopReason = "other_live" | "superseded" | "bad_key";

export const STOP_TEXT: Record<StopReason, string> = {
  other_live: "Not saved: another ward simulation is live",
  superseded: "Not saved: a newer simulation replaced this one",
  bad_key: "Not saved: the API refused the ingest key",
};

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

const lastSample = (p: Patient) => {
  const latest = Math.max(...Object.values(p.heldAt).map((m) => m ?? -Infinity));
  return Number.isFinite(latest) ? latest : null;
};

export function createSync({ apiUrl, key, clientId, fetch: send }: SyncOptions) {
  let s: Sim | null = null;
  let registration: object | null = null;
  let runId: number | null = null;
  let origin = "";
  const cursor = { actions: 0, commands: 0 }; // the highest clinician action and viewer command read
  let sentEnded = false;
  let busy = false;
  const pulling = { actions: false, commands: false };
  let dropped = 0;
  let stopped: StopReason | null = null;
  // What the API has acknowledged for the current registration. Read-only for callers: see `acked`.
  let ackedMinute: number | null = null;
  const ackedPatients = new Set<string>();
  let registered: string[] = []; // the ids the registration carries
  let generation = 0; // counts register() calls: an answer for an older one acknowledges nothing

  async function post(path: string, body: object) {
    const response = await send(`${apiUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Ingest-Key": key },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new HttpError(response.status);
    return response;
  }

  function trim() {
    const out = s!.outbox!;
    for (const rows of [out.observations, out.bins, out.events]) {
      const extra = rows.length - MAX_QUEUED;
      if (extra > 0) {
        rows.splice(0, extra); // the oldest go first
        dropped += extra;
      }
    }
  }

  function stop(reason: StopReason) {
    stopped = reason;
    s!.outbox = undefined; // the queue is dropped and the sim stops filling it
  }

  /** Sends at least one batch, even an empty one: the server frees a run that sends none for 30 s. */
  async function drain() {
    const sim = s!;
    const out = sim.outbox!;
    const pending = () =>
      out.observations.length + out.bins.length + out.events.length + out.admissions.length + out.departures.length > 0;
    do {
      const observations = out.observations.splice(0, BATCH.observations);
      const bins = out.bins.splice(0, BATCH.bins);
      const events = out.events.splice(0, BATCH.events);
      const admissions = out.admissions.splice(0, BATCH.moves);
      const departures = out.departures.splice(0, BATCH.moves);
      const minute = minuteOf(sim);
      const ended = sim.ended && !pending();
      const tookAll = !pending(); // this batch holds everything queued when it was cut
      const generationSent = generation;
      try {
        await post(`/sim/runs/${runId}/batch`, {
          minute,
          ended,
          counts: sim.counts,
          patients: sim.patients.map((p) => ({
            id: p.id,
            trend: p.trend,
            signal_quality: signalQuality(p),
            last_sample_minute: lastSample(p),
          })),
          observations,
          bins,
          events,
          admissions,
          departures,
        });
      } catch (error) {
        out.observations.unshift(...observations);
        out.bins.unshift(...bins);
        out.events.unshift(...events);
        out.admissions.unshift(...admissions);
        out.departures.unshift(...departures);
        throw error;
      }
      if (s !== sim) return; // start() gave the sync another world meanwhile: this one's rows are not sent
      if (generation === generationSent) {
        for (const a of admissions) ackedPatients.add(a.id);
        if (tookAll) ackedMinute = minute;
      }
      sentEnded = ended;
    } while (pending() || sim.ended !== sentEnded);
  }

  /** Sends what is queued. One request at a time; a failure is retried by the next call. */
  async function flush() {
    if (busy || !s || stopped || sentEnded) return;
    busy = true;
    const world = s;
    try {
      trim();
      if (runId === null) {
        try {
          const id = ((await (await post("/sim/runs", registration!)).json()) as { run_id: number }).run_id;
          if (s !== world) return; // start() began another run while this one registered: the next flush registers that one
          runId = id;
          for (const p of registered) ackedPatients.add(p);
        } catch (error) {
          if (s !== world) return; // as below: an answer for a world the sync has since left
          if (error instanceof HttpError && error.status === 409) return stop("other_live");
          if (error instanceof HttpError && (error.status === 403 || error.status === 503)) return stop("bad_key");
          throw error;
        }
      }
      await drain();
    } catch (error) {
      // Only for the world this flush sent: a refusal of the old world's rows says nothing about the new world or its run.
      if (s !== world) return;
      if (error instanceof HttpError && error.status === 409) stop("superseded");
      // The database no longer has this run (it was reset): the next flush registers the ward as it is now.
      else if (error instanceof HttpError && error.status === 404 && runId !== null) register(s);
      // Otherwise the rows stay queued.
    } finally {
      busy = false;
    }
  }

  /** Prepares a new run for the ward as it is now: every patient's current state, and an empty queue. */
  function register(world: Sim) {
    const minute = minuteOf(world);
    runId = null;
    generation += 1;
    ackedMinute = null;
    ackedPatients.clear();
    registered = world.patients.map((p) => p.id);
    cursor.actions = cursor.commands = 0;
    world.outbox = { observations: [], bins: [], events: [], admissions: [], departures: [], sent: new Map(), nurseTimes: true };
    for (const p of world.patients) record(world, p, minute);
    const initial = world.outbox.observations.splice(0);
    registration = {
      client_id: clientId,
      source: "synthetic",
      seed: FIXTURE_SEED,
      origin,
      patients: world.patients.map((p) => patientRow(p, initial.filter((o) => o.patient_id === p.id), minute - (minute % 15))),
    };
  }

  /** Begins a run for this world: queues the sim's changes and registers its minute-0 state. */
  async function start(world: Sim, src: VitalsSource) {
    s = src.synthetic ? world : null; // only the synthetic ward is stored; a real dataset must never register
    if (!s) return;
    sentEnded = false;
    stopped = null;
    origin = WARD_START_ISO; // ward time, not the real clock: a stored time is then what the ward's clock shows (audit gap 1)
    register(world);
    await flush();
  }

  /** Continues a saved ward in its run: keeps the queue it was saved with and registers nothing. */
  async function resume(world: Sim, src: VitalsSource, run: Run) {
    s = src.synthetic ? world : null;
    if (!s) return;
    sentEnded = false;
    stopped = null;
    origin = run.origin;
    if (run.runId === null || !world.outbox) register(world); // saved before the API ever answered
    else {
      runId = run.runId;
      // A ward saved before nurse times existed: what it last sent is remembered by value alone. Remember it with its time,
      // or the first minute after the resume would send every nurse-charted value again as if just taken.
      if (!world.outbox.nurseTimes) {
        const sent = world.outbox.sent;
        for (const p of world.patients) {
          const timed = (code: string, value: unknown, at: number | null) => {
            if (sent.get(`${p.id}/${code}`) === JSON.stringify(value)) sent.set(`${p.id}/${code}`, JSON.stringify([value, at]));
          };
          if (p.bp) timed("blood_pressure", p.bp, p.bpAt);
          timed("consciousness", p.consciousness, p.nurseAt);
          timed("supplemental_o2", p.onOxygen, p.nurseAt);
          timed("spo2_scale", p.spo2Scale, p.nurseAt);
        }
        world.outbox.nurseTimes = true;
      }
      // The run knows every patient whose admission is not still queued. No minute is known until a batch is acknowledged.
      const queued = new Set(world.outbox.admissions.map((a) => a.id));
      generation += 1;
      ackedMinute = null;
      ackedPatients.clear();
      for (const p of world.patients) if (!queued.has(p.id)) ackedPatients.add(p.id);
      cursor.actions = run.cursor;
      cursor.commands = run.commandCursor;
    }
    await flush();
  }

  /** Reads a feed of the run's rows past its cursor. One request at a time per feed; a failure is retried by the next call. */
  async function pullFeed<T extends { seq: number }>(feed: "actions" | "commands"): Promise<T[]> {
    const run = runId;
    if (pulling[feed] || !s || run === null || stopped) return [];
    pulling[feed] = true;
    try {
      const response = await send(`${apiUrl}/sim/runs/${run}/${feed}?after=${cursor[feed]}`, { headers: { "X-Ingest-Key": key } });
      if (!response.ok) throw new HttpError(response.status);
      const rows = ((await response.json()) as Record<string, T[]>)[feed];
      if (run !== runId || stopped) return []; // a flush replaced or stopped the run meanwhile
      for (const row of rows) cursor[feed] = Math.max(cursor[feed], row.seq);
      return rows;
    } catch (error) {
      // Only if the answer is for the run still current: one for a run start() has since replaced says nothing about the new one.
      if (error instanceof HttpError && error.status === 409 && run === runId) stop("superseded");
      // A 404 is left to the next flush: an API without this route answers 404 too, and registering on that would start a run every poll.
      return [];
    } finally {
      pulling[feed] = false;
    }
  }

  /** Reads what clinicians did on the dashboard since the last pull. */
  const pull = () => pullFeed<Action>("actions");

  /** Reads what clinicians sent from the viewer (speed, reset, a patient's controls) since the last pull. */
  const pullCommands = () => pullFeed<Command>("commands");

  /** Sends the ward as viewers draw it. Never queued: the next view replaces a missed one. */
  async function publish(body: object) {
    const run = runId;
    if (run === null || stopped) return;
    try {
      await post(`/sim/runs/${run}/view`, body);
    } catch (error) {
      if (error instanceof HttpError && error.status === 409 && run === runId) stop("superseded");
    }
  }

  return {
    start,
    resume,
    flush,
    pull,
    pullCommands,
    publish,
    /** What a saved ward needs to continue this run. */
    get run() {
      return { runId, origin, cursor: cursor.actions, commandCursor: cursor.commands };
    },
    /** What the API has acknowledged: the minute of the last batch that took the whole queue, and the patients it knows. Read-only. */
    get acked(): { minute: number | null; patients: ReadonlySet<string> } {
      return { minute: ackedMinute, patients: ackedPatients };
    },
    /** Counts registrations and resumes: the same run id with another number is another registration. Read-only. */
    get generation() {
      return generation;
    },
    get stopped() {
      return stopped;
    },
    get dropped() {
      return dropped;
    },
  };
}
