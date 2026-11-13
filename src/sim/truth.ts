// Tells the API when each simulated deterioration episode began (owner decision `dashboard-7`,
// wire contract-truth v1). Only the headless runner creates a poster. Pure: no React, no bridge.
// Reading the truth and posting never write to the sim.

import type { SavedSource } from "./source";

export interface Episode {
  patient_id: string;
  kind: string;
  start_minute: number;
  full_minute: number;
}

export interface Acked {
  minute: number | null;
  patients: ReadonlySet<string>;
}

export interface TruthOptions {
  apiUrl: string;
  key: string;
  fetch: typeof fetch;
  /** Wall time in ms. */
  now: () => number;
  /** One short line. Holds only the run id and a status. */
  log: (line: string) => void;
}

const KINDS = ["respiratory", "tachycardic", "hypotensive"];
const MAX_ROWS = 200;
const EVERY_MS = 10_000;
const RETRY_MS = 60_000;
const TIMEOUT_MS = 10_000;

type Stream = { episode: { kind: string } | null; injectAt: number | null; rampMin: number };

/** Episodes of these patients that have started at `minute`. Atrial fibrillation is never read. */
export function startedEpisodes(saved: SavedSource, ids: string[], minute: number): Episode[] {
  const out: Episode[] = [];
  for (const id of ids) {
    const t = saved.streams[id] as Stream | undefined;
    if (!t || t.episode === null || t.injectAt === null || t.injectAt > minute) continue;
    out.push({ patient_id: id, kind: t.episode.kind, start_minute: Math.floor(t.injectAt), full_minute: Math.ceil(t.injectAt + t.rampMin) });
  }
  return out;
}

const wellFormed = (e: Episode) =>
  typeof e.patient_id === "string" &&
  e.patient_id !== "" &&
  KINDS.includes(e.kind) &&
  Number.isInteger(e.start_minute) &&
  Number.isInteger(e.full_minute) &&
  e.start_minute >= 0 &&
  e.full_minute >= e.start_minute;

export function createTruthPoster({ apiUrl, key, fetch: send, now, log }: TruthOptions) {
  let runKey = ""; // run id and registration number: another pair is another run
  let runId: number | null = null;
  let sent = new Map<string, string>(); // patient id -> the row as posted
  let dropped = new Set<string>(); // rows refused here, so each gets one log line
  // Rows offered and not yet sent. Kept after the patient leaves the ward: a started episode never changes.
  let waiting = new Map<string, Episode>();
  let latest: Acked = { minute: null, patients: new Set() };
  let stoppedRun = false;
  let lastPostAt = -Infinity;
  let retryAt = 0;
  let inflight = false;

  const line = (run: number, status: string | number) => log(`episodes run ${run}: ${status}`);

  /** Takes the episodes now started and the sync's acknowledgements. Rows the API cannot know yet wait. */
  function offer(run: number | null, generation: number, episodes: Episode[], acked: Acked) {
    if (`${run}:${generation}` !== runKey) {
      runKey = `${run}:${generation}`;
      runId = run;
      sent = new Map();
      dropped = new Set();
      waiting = new Map();
      stoppedRun = false;
      lastPostAt = -Infinity;
      retryAt = 0;
    }
    latest = acked;
    const seen = new Set<string>();
    for (const e of episodes) {
      const row = { patient_id: e.patient_id, kind: e.kind, start_minute: e.start_minute, full_minute: e.full_minute }; // the four fields only
      const text = JSON.stringify(row);
      const refused = !wellFormed(row) ? text : seen.has(row.patient_id) ? `${text}|duplicate` : null;
      if (refused !== null) {
        if (!dropped.has(refused) && run !== null) line(run, "dropped"); // never sent, never retried
        dropped.add(refused);
        continue;
      }
      seen.add(row.patient_id);
      if (sent.get(row.patient_id) !== text) waiting.set(row.patient_id, row);
    }
    // At most 200 rows wait: the oldest start goes first.
    if (waiting.size > MAX_ROWS) {
      const oldest = [...waiting.values()].sort((a, b) => a.start_minute - b.start_minute);
      for (const e of oldest.slice(0, waiting.size - MAX_ROWS)) waiting.delete(e.patient_id);
      if (run !== null) line(run, "dropped"); // one line for the whole overflow
    }
  }

  /** Posts at most one body. Never throws, never blocks the caller that does not await it. */
  async function tick() {
    const run = runId;
    const here = runKey;
    if (run === null || stoppedRun || inflight || waiting.size === 0) return;
    const t = now();
    if (t - lastPostAt < EVERY_MS || t < retryAt) return;
    // The acknowledged minute and patient are checked now, whether or not the patient is still on the ward.
    const rows = [...waiting.values()]
      .filter((e) => latest.minute !== null && latest.minute >= e.start_minute && latest.patients.has(e.patient_id))
      .sort((a, b) => a.start_minute - b.start_minute)
      .slice(0, MAX_ROWS);
    if (rows.length === 0) return;
    lastPostAt = t;
    inflight = true;
    let status = 0; // 0: no answer
    try {
      const response = await send(`${apiUrl}/sim/runs/${run}/episodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Ingest-Key": key },
        body: JSON.stringify({ episodes: rows }),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = response.status;
    } catch {
      // a network error or a timeout: kept, retried
    }
    inflight = false;
    if (here !== runKey) return; // the run changed while the post was out
    const done = () => {
      for (const r of rows) {
        sent.set(r.patient_id, JSON.stringify(r));
        if (waiting.get(r.patient_id)?.start_minute === r.start_minute) waiting.delete(r.patient_id);
      }
    };
    if (status >= 200 && status < 300) done();
    else if (status === 409) {
      stoppedRun = true;
      line(run, status);
    } else if (status === 422) {
      done(); // dropped, no retry
      line(run, status);
    } else retryAt = now() + RETRY_MS; // 403, 404, 503, network error, timeout, anything else
  }

  return { offer, tick };
}
