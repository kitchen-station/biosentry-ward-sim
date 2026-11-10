// Writes the sim to the BioSentry database API: one run per world, then a batch of what changed.
// Plain and headless: fetch is a parameter. A network error or 5xx leaves the rows queued for the
// next flush and never reaches the sim. A refusal (another sim is live, this run was replaced, a
// wrong key) stops the sync for good: the sim carries on locally and `stopped` says why.

import { minuteOf, patientRow, record, signalQuality, type Patient, type Sim } from "./sim";
import { FIXTURE_SEED, type VitalsSource } from "./source";

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
  let sentEnded = false;
  let busy = false;
  let dropped = 0;
  let stopped: StopReason | null = null;

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
      sentEnded = ended;
    } while (pending() || sim.ended !== sentEnded);
  }

  /** Sends what is queued. One request at a time; a failure is retried by the next call. */
  async function flush() {
    if (busy || !s || stopped || sentEnded) return;
    busy = true;
    try {
      trim();
      if (runId === null) {
        try {
          runId = ((await (await post("/sim/runs", registration!)).json()) as { run_id: number }).run_id;
        } catch (error) {
          if (error instanceof HttpError && error.status === 409) return stop("other_live");
          if (error instanceof HttpError && (error.status === 403 || error.status === 503)) return stop("bad_key");
          throw error;
        }
      }
      await drain();
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) stop("superseded");
      // Otherwise the rows stay queued.
    } finally {
      busy = false;
    }
  }

  /** Begins a run for this world: queues the sim's changes and registers its minute-0 state. */
  async function start(world: Sim, src: VitalsSource) {
    s = src.synthetic ? world : null; // only the synthetic ward is stored; a real dataset must never register
    if (!s) return;
    runId = null;
    sentEnded = false;
    stopped = null;
    world.outbox = { observations: [], bins: [], events: [], admissions: [], departures: [], sent: new Map() };
    for (const p of world.patients) record(world, p, 0);
    const initial = world.outbox.observations.splice(0);
    registration = {
      client_id: clientId,
      source: "synthetic",
      seed: FIXTURE_SEED,
      origin: new Date().toISOString(),
      patients: world.patients.map((p) => patientRow(p, initial.filter((o) => o.patient_id === p.id), 0)),
    };
    await flush();
  }

  return {
    start,
    flush,
    get stopped() {
      return stopped;
    },
    get dropped() {
      return dropped;
    },
  };
}
