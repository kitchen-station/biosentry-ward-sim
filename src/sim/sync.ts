// Writes the sim to the BioSentry database API: one run per world, then a batch of what changed.
// Plain and headless: fetch is a parameter. A failed request leaves the rows queued for the next
// flush and never reaches the sim.

import { minuteOf, patientRow, record, signalQuality, type Patient, type Sim } from "./sim";
import { FIXTURE_SEED, type VitalsSource } from "./source";

// The API's limits per batch, and the most rows kept while it is unreachable.
const BATCH = { observations: 20_000, bins: 20_000, events: 2_000, moves: 200 };
const MAX_QUEUED = 50_000;
const CLIENT_ID = crypto.randomUUID(); // one per page load: the API lets a client replace only its own run

export interface SyncOptions {
  apiUrl: string;
  key: string;
  fetch: typeof fetch;
}

const lastSample = (p: Patient) => {
  const latest = Math.max(...Object.values(p.heldAt).map((m) => m ?? -Infinity));
  return Number.isFinite(latest) ? latest : null;
};

export function createSync({ apiUrl, key, fetch: send }: SyncOptions) {
  let s: Sim | null = null;
  let registration: object | null = null;
  let runId: number | null = null;
  let sentMinute = 0;
  let sentEnded = false;
  let busy = false;
  let dropped = 0;

  async function post(path: string, body: object) {
    const response = await send(`${apiUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Ingest-Key": key },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
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

  async function drain() {
    const sim = s!;
    const out = sim.outbox!;
    const pending = () =>
      out.observations.length + out.bins.length + out.events.length + out.admissions.length + out.departures.length > 0;
    while (pending() || minuteOf(sim) !== sentMinute || sim.ended !== sentEnded) {
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
      sentMinute = minute;
      sentEnded = ended;
    }
  }

  /** Sends what is queued. One request at a time; a failure is retried by the next call. */
  async function flush() {
    if (busy || !s) return;
    busy = true;
    try {
      trim();
      if (runId === null) runId = ((await (await post("/sim/runs", registration!)).json()) as { run_id: number }).run_id;
      await drain();
    } catch {
      // The rows stay queued.
    } finally {
      busy = false;
    }
  }

  /** Begins a run for this world: queues the sim's changes and registers its minute-0 state. */
  function start(world: Sim, src: VitalsSource) {
    s = world;
    runId = null;
    sentMinute = 0;
    sentEnded = false;
    world.outbox = { observations: [], bins: [], events: [], admissions: [], departures: [], sent: new Map() };
    for (const p of world.patients) record(world, p, 0);
    const initial = world.outbox.observations.splice(0);
    registration = {
      client_id: CLIENT_ID,
      source: src.synthetic ? "synthetic" : "eicu_demo",
      seed: src.synthetic ? FIXTURE_SEED : null,
      origin: new Date().toISOString(),
      patients: world.patients.map((p) => patientRow(p, initial.filter((o) => o.patient_id === p.id), 0)),
    };
    return flush();
  }

  return {
    start,
    flush,
    get dropped() {
      return dropped;
    },
  };
}
