// Fits the synthetic generator to real open data and writes src/sim/fitted.json: aggregate
// statistics only, never a recording or a single patient's values.
// Usage: npm run fit -- <folder holding eicu-crd-demo-2.0.1, bidmc-1.0.0, mitdb-1.0.0, afdb-1.0.0>

import { createReadStream, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("Usage: npm run fit -- <datasets folder>");

const inner = (name) => join(root, name, readdirSync(join(root, name)).find((f) => !f.startsWith(".")));
const SLOT = 5; // eICU's periodic vitals arrive every 5 minutes
const WINDOW = 72; // 6 hours of slots
const MIN_COVER = 0.8;
const VITALS = ["heart_rate", "respiratory_rate", "spo2", "temperature"];
const COLUMN = { heart_rate: "heartrate", respiratory_rate: "respiration", spo2: "sao2", temperature: "temperature" };
const PLAUSIBLE = { heart_rate: [30, 200], respiratory_rate: [6, 40], spo2: [70, 100], temperature: [34.5, 40.5] };
// Windows whose medians look like a ward patient. ICU levels are not used; only movement around them.
const WARD_LIKE = { heart_rate: [50, 110], respiratory_rate: [10, 24], spo2: [92, 100] };
const CORE = ["heart_rate", "respiratory_rate", "spo2"];

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => sum(xs) / xs.length;
const sorted = (xs) => [...xs].sort((a, b) => a - b);
const quantile = (xs, q) => {
  const s = sorted(xs);
  const at = (s.length - 1) * q;
  const low = Math.floor(at);
  return s[low] + (s[Math.ceil(at)] - s[low]) * (at - low);
};
const median = (xs) => quantile(xs, 0.5);
const round = (x) => Number(x.toPrecision(4));
const table = (xs) => Array.from({ length: 21 }, (_, i) => round(quantile(xs, i / 20)));
const present = (xs) => xs.filter((x) => x !== null && x !== undefined);

function parseCsvLine(line) {
  const out = [];
  let cell = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cell);
      cell = "";
    } else cell += ch;
  }
  out.push(cell);
  return out;
}

async function eachRow(folder, name, visit) {
  const stream = createReadStream(`${folder}/${name}.csv.gz`).pipe(createGunzip());
  let header = null;
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!header) header = parseCsvLine(line);
    else {
      const cells = parseCsvLine(line);
      visit(Object.fromEntries(header.map((key, i) => [key, cells[i]])));
    }
  }
}

// ---- eICU: how vitals move over hours, and what deterioration looks like ----

const eicu = inner("eicu-crd-demo-2.0.1");
const patients = new Map();
await eachRow(eicu, "patient", (r) => patients.set(r.patientunitstayid, r));
const hospitals = sorted([...new Set([...patients.values()].map((p) => Number(p.hospitalid)))]);
const heldOut = new Set(hospitals.filter((_, i) => i % 4 === 3));

const stays = new Map();
await eachRow(eicu, "vitalPeriodic", (r) => {
  const slot = Math.round(Number(r.observationoffset) / SLOT);
  if (slot < 0) return;
  const stay = stays.get(r.patientunitstayid) ?? new Map();
  stays.set(r.patientunitstayid, stay);
  const row = stay.get(slot) ?? {};
  stay.set(slot, row);
  for (const v of VITALS) {
    const value = r[COLUMN[v]] === "" ? NaN : Number(r[COLUMN[v]]);
    if (value >= PLAUSIBLE[v][0] && value <= PLAUSIBLE[v][1]) row[v] = value;
  }
});
const cuffs = new Map();
await eachRow(eicu, "vitalAperiodic", (r) => {
  if (r.noninvasivesystolic === "") return;
  const list = cuffs.get(r.patientunitstayid) ?? [];
  cuffs.set(r.patientunitstayid, list);
  list.push([Number(r.observationoffset), Number(r.noninvasivesystolic), r.noninvasivediastolic === "" ? NaN : Number(r.noninvasivediastolic)]);
});

const wardSpans = new Map(); // stay id -> start slots of its ward-like windows
const diastolicRatios = [];
const baselines = { heart_rate: [], respiratory_rate: [], spo2: [], temperature: [], systolic: [], pulsePressure: [] };

/** Six-hour windows that look like a ward patient, each vital centred on its own window mean. */
function wardWindows(group) {
  const windows = [];
  for (const [id, stay] of stays) {
    const held = heldOut.has(Number(patients.get(id)?.hospitalid));
    if (held !== (group === "holdout")) continue;
    const last = Math.max(...stay.keys());
    for (let start = 0; start + WINDOW <= last; start += WINDOW) {
      const raw = Object.fromEntries(
        VITALS.map((v) => [v, Array.from({ length: WINDOW }, (_, i) => stay.get(start + i)?.[v] ?? null)]),
      );
      const covered = (v) => present(raw[v]).length >= WINDOW * MIN_COVER;
      if (!CORE.every(covered)) continue;
      if (!CORE.every((v) => median(present(raw[v])) >= WARD_LIKE[v][0] && median(present(raw[v])) <= WARD_LIKE[v][1])) continue;
      const centred = {};
      for (const v of VITALS) {
        if (!covered(v)) continue;
        const m = mean(present(raw[v]));
        centred[v] = raw[v].map((x) => (x === null ? null : x - m));
      }
      windows.push(centred);
      if (group === "train") {
        for (const v of VITALS) if (covered(v)) baselines[v].push(median(present(raw[v])));
        const inside = (cuffs.get(id) ?? []).filter(([o, sys]) => o >= start * SLOT && o < (start + WINDOW) * SLOT && sys >= 60 && sys <= 240);
        if (inside.length >= 2) {
          baselines.systolic.push(median(inside.map((c) => c[1])));
          diastolicRatios.push(...inside.filter((c) => Number.isFinite(c[2]) && c[2] > 0).map((c) => c[2] / c[1]));
          const pulse = inside.filter((c) => Number.isFinite(c[2])).map((c) => c[1] - c[2]);
          if (pulse.length) baselines.pulsePressure.push(median(pulse));
        }
      }
      wardSpans.set(id, [...(wardSpans.get(id) ?? []), start]);
    }
  }
  return windows;
}

/** Pooled covariance of a and b at a lag in slots, over every window holding both. */
function pooledCov(windows, a, b, lag) {
  let total = 0;
  let count = 0;
  for (const w of windows) {
    if (!w[a] || !w[b]) continue;
    for (let i = 0; i + lag < WINDOW; i += 1) {
      if (w[a][i] !== null && w[b][i + lag] !== null) {
        total += w[a][i] * w[b][i + lag];
        count += 1;
      }
    }
  }
  return count ? total / count : NaN;
}

const clampTau = (tau) => Math.min(180, Math.max(5, Number.isFinite(tau) && tau > 0 ? tau : 180));

/** Fit C(k) = sd^2 exp(-k SLOT / tau) on lags 1 and 2, leaving lag 0 to the fast noise. */
function fitOu(c0, c1, c2) {
  const tau = clampTau(SLOT / Math.log(c1 / c2));
  return { tau, sd: Math.sqrt(Math.min(c0, c1 * Math.exp(SLOT / tau))) };
}

/** Principal-axis factoring: one factor, its share of each standardised vital. */
function oneFactor(matrix) {
  const n = matrix.length;
  const m = matrix.map((row) => [...row]);
  let vec = Array(n).fill(1 / Math.sqrt(n));
  let eig = 0;
  for (let round = 0; round < 60; round += 1) {
    for (let step = 0; step < 50; step += 1) {
      const next = m.map((row) => sum(row.map((x, j) => x * vec[j])));
      eig = Math.hypot(...next);
      vec = next.map((x) => x / eig);
    }
    for (let i = 0; i < n; i += 1) m[i][i] = Math.min(0.95, eig * vec[i] ** 2);
  }
  const sign = Math.sign(vec[0]) || 1;
  return vec.map((x) => sign * x * Math.sqrt(eig));
}

function windowSummary(windows) {
  const out = {};
  for (const v of VITALS) {
    const having = windows.filter((w) => w[v]);
    if (having.length < 20) continue;
    out[v] = {
      windows: having.length,
      sd: round(Math.sqrt(pooledCov(having, v, v, 0))),
      lag5Corr: round(pooledCov(having, v, v, 1) / pooledCov(having, v, v, 0)),
      medianWindowSd: round(median(having.map((w) => Math.sqrt(mean(present(w[v]).map((x) => x * x)))))),
    };
  }
  return out;
}

const train = wardWindows("train");
const holdoutWindows = wardWindows("holdout");
const slow = {};
for (const v of VITALS) {
  if (train.filter((w) => w[v]).length < 20) continue;
  slow[v] = fitOu(pooledCov(train, v, v, 0), pooledCov(train, v, v, 1), pooledCov(train, v, v, 2));
}
const fittedVitals = Object.keys(slow);
const corr = fittedVitals.map((a) =>
  fittedVitals.map((b) => (a === b ? 1 : pooledCov(train, a, b, 1) / (slow[a].sd * slow[b].sd))),
);
const loadings = oneFactor(corr);

// The shared factor's own time constant, from a score built on the three core vitals.
const coreAt = CORE.map((v) => fittedVitals.indexOf(v));
const scored = train.map((w) => ({
  z: Array.from({ length: WINDOW }, (_, i) => {
    if (CORE.some((v) => w[v][i] === null)) return null;
    return sum(CORE.map((v, k) => (loadings[coreAt[k]] * w[v][i]) / slow[v].sd));
  }),
}));
const latentTau = fitOu(pooledCov(scored, "z", "z", 0), pooledCov(scored, "z", "z", 1), pooledCov(scored, "z", "z", 2)).tau;

// How much steadier or more variable one patient is than another.
const relativeSd = train
  .map((w) => mean(CORE.map((v) => Math.log(Math.sqrt(mean(present(w[v]).map((x) => x * x))) / slow[v].sd))))
  .filter(Number.isFinite); // a flat SpO2 window has zero variance
const spreadMean = mean(relativeSd);
const patientSpreadLog = Math.sqrt(mean(relativeSd.map((x) => (x - spreadMean) ** 2)));

// ---- Blood pressure: cuff readings a known gap apart, inside ward-like windows ----

function cuffPairs(group) {
  const pairs = [];
  for (const [id, starts] of wardSpans) {
    if (heldOut.has(Number(patients.get(id)?.hospitalid)) !== (group === "holdout")) continue;
    const list = [...(cuffs.get(id) ?? [])].sort((a, b) => a[0] - b[0]);
    for (const start of starts) {
      const inside = list.filter(([o, sys]) => o >= start * SLOT && o < (start + WINDOW) * SLOT && sys >= 60 && sys <= 240);
      for (let i = 0; i < inside.length; i += 1) {
        for (let j = i + 1; j < inside.length; j += 1) {
          const gap = inside[j][0] - inside[i][0];
          if (gap >= 3) pairs.push({ gap, sys: inside[j][1] - inside[i][1], dia: inside[j][2] - inside[i][2] });
        }
      }
    }
  }
  return pairs;
}

const GAP_BINS = [[3, 10], [10, 20], [20, 40], [40, 75], [75, 120], [120, 180], [180, 270], [270, 360]];
const binned = (pairs) =>
  GAP_BINS.map(([low, high]) => {
    const inBin = pairs.filter((p) => p.gap >= low && p.gap < high);
    return { gap: mean(inBin.map((p) => p.gap)), half: mean(inBin.map((p) => (p.sys * p.sys) / 2)), n: inBin.length };
  }).filter((b) => b.n >= 50);

/** D(gap) = noise^2 + sd^2 (1 - exp(-gap/tau)): least squares over a grid of tau. */
function fitStructure(bins) {
  let best = null;
  for (let tau = 10; tau <= 720; tau += 5) {
    const x = bins.map((b) => 1 - Math.exp(-b.gap / tau));
    const xm = mean(x);
    const ym = mean(bins.map((b) => b.half));
    const slope = sum(x.map((v, i) => (v - xm) * (bins[i].half - ym))) / sum(x.map((v) => (v - xm) ** 2));
    const intercept = Math.max(0, ym - slope * xm);
    if (slope <= 0) continue;
    const error = sum(x.map((v, i) => (intercept + slope * v - bins[i].half) ** 2));
    if (!best || error < best.error) best = { tau, noise: Math.sqrt(intercept), sd: Math.sqrt(slope), error };
  }
  if (!best) throw new Error("Blood pressure structure function did not fit");
  return best;
}

const trainPairs = cuffPairs("train");
const holdoutPairs = cuffPairs("holdout");
const bpFit = fitStructure(binned(trainPairs));
const usable = trainPairs.filter((p) => Number.isFinite(p.dia));
const diaSlope = sum(usable.map((p) => p.sys * p.dia)) / sum(usable.map((p) => p.sys * p.sys));
const diaResidual = Math.sqrt(mean(usable.map((p) => (p.dia - diaSlope * p.sys) ** 2)) / 2);
const stepSdAround = (pairs, low, high) => {
  const inBin = pairs.filter((p) => p.gap >= low && p.gap < high);
  return { stepSd: round(Math.sqrt(mean(inBin.map((p) => p.sys * p.sys)))), pairs: inBin.length };
};

// ---- Deterioration: our own physiological rise events, not a dataset label ----

const band = (x, bands) => bands.find(([limit]) => x <= limit)[1];
const scoreOf = {
  heart_rate: (x) => band(x, [[40, 3], [50, 1], [90, 0], [110, 1], [130, 2], [Infinity, 3]]),
  respiratory_rate: (x) => band(x, [[8, 3], [11, 1], [20, 0], [24, 2], [Infinity, 3]]),
  spo2: (x) => band(x, [[91, 3], [93, 2], [95, 1], [Infinity, 0]]),
};
const RISE = 4;
const SUSTAIN_H = 2;
const BASE_H = 6;
const LOOK_BACK_H = 48;
const PEAK_H = 6;
const HOUR_SLOTS = 12;
const inRange = (row) => CORE.every((v) => row[v] >= WARD_LIKE[v][0] && row[v] <= WARD_LIKE[v][1]);

const episodes = [];
for (const [id, stay] of stays) {
  if (heldOut.has(Number(patients.get(id)?.hospitalid))) continue;
  // Hourly medians, because ward deterioration runs over hours and a 5-minute rule finds only fast swings.
  const hours = new Map();
  for (let h = 0; h * HOUR_SLOTS <= Math.max(...stay.keys()); h += 1) {
    const row = {};
    for (const v of CORE) {
      const values = present(Array.from({ length: HOUR_SLOTS }, (_, k) => stay.get(h * HOUR_SLOTS + k)?.[v]));
      if (values.length >= HOUR_SLOTS / 2) row[v] = median(values);
    }
    if (CORE.every((v) => v in row)) hours.set(h, { ...row, score: sum(CORE.map((v) => scoreOf[v](row[v]))) });
  }
  const span = (from, length) => present(Array.from({ length }, (_, k) => hours.get(from + k)));
  const medianRow = (rows) => Object.fromEntries(CORE.map((v) => [v, median(rows.map((r) => r[v]))]));
  const last = Math.max(-1, ...hours.keys());

  let nextAllowed = 0;
  for (let h = BASE_H; h <= last - SUSTAIN_H; h += 1) {
    if (h < nextAllowed) continue;
    // The calmest ward-like six hours in the last two days is the baseline.
    let base = null;
    for (let b = Math.max(0, h - LOOK_BACK_H); b + BASE_H <= h; b += 1) {
      const rows = span(b, BASE_H);
      if (rows.length < BASE_H - 1) continue;
      const score = median(rows.map((r) => r.score));
      const vitals = medianRow(rows);
      if (score <= 2 && inRange(vitals) && (!base || score <= base.score)) base = { score, vitals, end: b + BASE_H };
    }
    if (!base) continue;
    const after = Array.from({ length: SUSTAIN_H }, (_, k) => hours.get(h + k));
    if (!after.every((row) => row && row.score >= base.score + RISE)) continue;
    let onset = base.end;
    for (let k = h - 1; k >= base.end; k -= 1) {
      const nearby = span(k - 1, 3);
      if (nearby.length && median(nearby.map((r) => r.score)) <= base.score + 1) {
        onset = k;
        break;
      }
    }
    const peak = span(h, PEAK_H);
    const top = peak.reduce((a, b) => (b.score > a.score ? b : a));
    const peakAt = h + peak.indexOf(top);
    const respiratory = scoreOf.respiratory_rate(top.respiratory_rate) + scoreOf.spo2(top.spo2) >= scoreOf.heart_rate(top.heart_rate) * 2;
    const near = (minute, span2, column) => {
      const readings = (cuffs.get(id) ?? []).filter((c) => Math.abs(c[0] - minute) <= span2 && Number.isFinite(c[column])).map((c) => c[column]);
      return readings.length ? median(readings) : NaN;
    };
    const hourMinute = (x) => x * HOUR_SLOTS * SLOT;
    episodes.push({
      kind: respiratory ? "respiratory" : "tachycardic",
      delta: Object.fromEntries(CORE.map((v) => [v, top[v] - base.vitals[v]])),
      systolic: near(hourMinute(peakAt), 60, 1) - near(hourMinute(base.end - 3), 180, 1),
      diastolic: near(hourMinute(peakAt), 60, 2) - near(hourMinute(base.end - 3), 180, 2),
      minutes: Math.max(30, (peakAt - onset) * 60),
    });
    nextAllowed = h + 24;
  }

  // Hypotension shows only in the cuff, so the rule above can never select it.
  const list = [...(cuffs.get(id) ?? [])].sort((a, b) => a[0] - b[0]).filter((c) => c[1] >= 60 && c[1] <= 240);
  let cuffAllowed = 0;
  for (let i = 0; i + 1 < list.length; i += 1) {
    const [t, sys] = list[i];
    if (t < cuffAllowed) continue;
    const before = list.filter(([o]) => o >= t - 360 && o <= t - 60);
    if (before.length < 3) continue;
    const baseSys = median(before.map((c) => c[1]));
    if (baseSys < 100 || baseSys > 180) continue;
    if (sys > baseSys - 20 || sys > 100 || list[i + 1][1] > 100 || list[i + 1][0] - t > 120) continue;
    const hour = Math.floor(t / 60);
    const baseRows = span(hour - 6, 5);
    const nowRows = span(hour, 2);
    if (baseRows.length < 3 || !nowRows.length || median(baseRows.map((r) => r.score)) > 2) continue;
    let onset = t - 60;
    for (let k = i - 1; k >= 0 && list[k][0] >= t - 2880; k -= 1) {
      if (list[k][1] >= baseSys - 5) {
        onset = list[k][0];
        break;
      }
    }
    const baseVitals = medianRow(baseRows);
    const nowVitals = medianRow(nowRows);
    const baseDia = median(before.map((c) => c[2]).filter(Number.isFinite));
    episodes.push({
      kind: "hypotensive",
      delta: Object.fromEntries(CORE.map((v) => [v, nowVitals[v] - baseVitals[v]])),
      systolic: sys - baseSys,
      diastolic: list[i][2] - baseDia,
      minutes: Math.max(30, t - onset),
    });
    cuffAllowed = t + 1440;
  }
}

const deterioration = ["respiratory", "tachycardic", "hypotensive"].map((kind) => {
  const group = episodes.filter((e) => e.kind === kind);
  if (group.length < 5) throw new Error(`Only ${group.length} ${kind} episodes; too few to summarise`);
  const finite = (key) => group.map((e) => e[key]).filter(Number.isFinite);
  return {
    kind,
    episodes: group.length,
    rampMinutes: table(group.map((e) => e.minutes)),
    heart_rate: round(median(group.map((e) => e.delta.heart_rate))),
    respiratory_rate: round(median(group.map((e) => e.delta.respiratory_rate))),
    spo2: round(median(group.map((e) => e.delta.spo2))),
    systolic: round(median(finite("systolic"))),
    diastolic: round(median(finite("diastolic"))),
    pressureEpisodes: finite("systolic").length,
  };
});

// ---- BIDMC: spot-reading noise a minute apart, faster than eICU's slots can show ----

const bidmc = join(inner("bidmc-1.0.0"), "bidmc_csv");
const noiseDiffs = { heart_rate: [], respiratory_rate: [], spo2: [] };
for (const file of readdirSync(bidmc).filter((f) => f.endsWith("_Numerics.csv"))) {
  const lines = readFileSync(join(bidmc, file), "utf8").trim().split("\n").slice(1).map((l) => l.split(",").map(Number));
  for (const [v, col] of [["heart_rate", 1], ["respiratory_rate", 3], ["spo2", 4]]) {
    for (let i = 0; i + 60 < lines.length; i += 60) {
      const a = lines[i][col];
      const b = lines[i + 60][col];
      if (a > 0 && b > 0) noiseDiffs[v].push(b - a);
    }
  }
}
const noise = Object.fromEntries(
  Object.entries(noiseDiffs).map(([v, diffs]) => {
    const limit = quantile(diffs.map(Math.abs), 0.99); // monitor artefact, not physiology
    const kept = diffs.filter((d) => Math.abs(d) <= limit);
    return [v, round(Math.sqrt(mean(kept.map((d) => d * d)) / 2))];
  }),
);

// ---- WFDB annotations: MIT-BIH ectopy and AFDB atrial fibrillation ----

/** A WFDB annotation file: 16-bit little-endian words of a 6-bit code and 10-bit interval. */
function readAnnotations(buffer) {
  const out = [];
  let time = 0;
  let i = 0;
  while (i + 1 < buffer.length) {
    const word = buffer.readUInt16LE(i);
    i += 2;
    const code = word >> 10;
    const interval = word & 1023;
    if (code === 0 && interval === 0) break;
    if (code === 59) {
      time += buffer.readUInt16LE(i) * 65536 + buffer.readUInt16LE(i + 2);
      i += 4;
    } else if (code === 63) {
      out.at(-1).aux = buffer.toString("latin1", i, i + interval).replace(/\0+$/, "");
      i += interval + (interval & 1);
    } else if (code < 60) {
      time += interval;
      out.push({ time, code });
    }
  }
  return out;
}

const records = (folder, extension) =>
  readdirSync(folder).filter((f) => f.endsWith(extension)).map((f) => f.slice(0, -extension.length));
const IS_BEAT = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 34, 35, 37, 38, 41]);
const PVC = 5;
const PREMATURE_ATRIAL = new Set([4, 7, 8, 9]);
const PACED_RECORDS = new Set(["102", "104", "107", "217"]);

const mit = inner("mitdb-1.0.0");
const MIT_HZ = 360;
const ectopyPerHour = [];
const coupling = [];
for (const record of records(mit, ".atr")) {
  // The 200 series was chosen for rare arrhythmias; the 100 series is the unselected sample.
  if (PACED_RECORDS.has(record) || Number(record) >= 200) continue;
  const beats = readAnnotations(readFileSync(join(mit, `${record}.atr`))).filter((a) => IS_BEAT.has(a.code));
  const hours = (beats.at(-1).time - beats[0].time) / MIT_HZ / 3600;
  ectopyPerHour.push(beats.filter((b) => b.code === PVC || PREMATURE_ATRIAL.has(b.code)).length / hours);
  for (let i = 8; i + 1 < beats.length; i += 1) {
    if (beats[i].code !== PVC) continue;
    if (beats.slice(i - 8, i).some((b) => b.code !== 1) || beats[i + 1].code !== 1) continue;
    const usual = (beats[i - 1].time - beats[i - 8].time) / 7;
    coupling.push((beats[i].time - beats[i - 1].time) / usual);
  }
}

const af = inner("afdb-1.0.0");
const AF_HZ = 250;
const afRatios = [];
const sinusRatios = [];
const afEpisodeMinutes = [];
const afMinuteSd = [];
const rateRatio = [];
for (const record of records(af, ".atr")) {
  const marks = readAnnotations(readFileSync(join(af, `${record}.atr`))).filter((a) => a.aux?.startsWith("("));
  const beats = readAnnotations(readFileSync(join(af, `${record}.qrs`))).filter((a) => IS_BEAT.has(a.code)).map((a) => a.time);
  if (!marks.length || beats.length < 100) continue;
  const end = beats.at(-1);
  const spans = marks.map((m, i) => ({ rhythm: m.aux.slice(1), start: m.time, end: marks[i + 1]?.time ?? end }));
  const rates = { AFIB: [], N: [] };
  for (const span of spans) {
    if (span.rhythm !== "AFIB" && span.rhythm !== "N") continue;
    // 30 seconds is the clinical minimum for an AF episode. A record's last span is kept though cut off:
    // leaving it out would remove the longest episodes.
    const minutes = (span.end - span.start) / AF_HZ / 60;
    if (span.rhythm === "AFIB" && minutes >= 0.5) afEpisodeMinutes.push(minutes);
    const rr = [];
    for (let i = 1; i < beats.length; i += 1) {
      if (beats[i - 1] >= span.start && beats[i] <= span.end) {
        const seconds = (beats[i] - beats[i - 1]) / AF_HZ;
        if (seconds >= 0.25 && seconds <= 3) rr.push(seconds);
      }
    }
    const sink = span.rhythm === "AFIB" ? afRatios : sinusRatios;
    for (let i = 0; i + 8 <= rr.length; i += 8) {
      const part = rr.slice(i, i + 8);
      const local = mean(part);
      for (const x of part) sink.push(x / local);
      rates[span.rhythm].push(60 / local);
    }
    if (span.rhythm === "AFIB" && rr.length > 200) {
      // Beats-per-minute of successive ~75-beat groups, about one sim sample each.
      const groups = [];
      for (let i = 0; i + 75 <= rr.length; i += 75) groups.push(60 / mean(rr.slice(i, i + 75)));
      const m = mean(groups);
      afMinuteSd.push(Math.sqrt(mean(groups.map((x) => (x - m) ** 2))));
    }
  }
  if (rates.AFIB.length >= 20 && rates.N.length >= 20) rateRatio.push(median(rates.AFIB) / median(rates.N));
}

// LTAFDB adds day-long records, so episodes are less cut off than in AFDB's ten hours.
const longAf = join(root, "ltafdb-1.0.0");
const LTAF_HZ = 128;
for (const record of records(longAf, ".atr")) {
  const notes = readAnnotations(readFileSync(join(longAf, `${record}.atr`)));
  const marks = notes.filter((a) => a.aux?.startsWith("("));
  marks.forEach((m, i) => {
    const minutes = ((marks[i + 1]?.time ?? notes.at(-1).time) - m.time) / LTAF_HZ / 60;
    if (m.aux.startsWith("(AFIB") && minutes >= 0.5) afEpisodeMinutes.push(minutes);
  });
}

const output = {
  provenance: {
    note: "Aggregate statistics only. Dynamics come from ICU stays, used around ward-like baselines; no ward data was available.",
    sources: {
      "eICU-CRD Demo 2.0.1": "ODbL v1.0",
      "BIDMC PPG and Respiration 1.0.0": "ODC-By v1.0",
      "MIT-BIH Arrhythmia 1.0.0": "ODC-By v1.0",
      "MIT-BIH Atrial Fibrillation 1.0.0": "ODC-By v1.0",
      "Long Term AF Database 1.0.0": "ODC-By v1.0",
    },
    licence: "ODbL v1.0",
    trainHospitals: hospitals.length - heldOut.size,
    heldOutHospitals: heldOut.size,
  },
  vitals: Object.fromEntries(
    fittedVitals.map((v, i) => [
      v,
      {
        sd: round(slow[v].sd),
        tauMin: round(slow[v].tau),
        loading: round(loadings[i] * slow[v].sd),
        noise: noise[v] ?? null,
      },
    ]),
  ),
  bloodPressure: {
    sd: round(bpFit.sd),
    tauMin: bpFit.tau,
    noise: round(bpFit.noise),
    diastolicPerSystolic: round(diaSlope),
    diastolicNoise: round(diaResidual),
    diastolicRatioRange: [round(quantile(diastolicRatios, 0.01)), round(quantile(diastolicRatios, 0.99))],
  },
  baseline: Object.fromEntries(Object.entries(baselines).map(([k, xs]) => [k, table(xs)])),
  latentTauMin: round(latentTau),
  patientSpreadLog: round(patientSpreadLog),
  deterioration,
  rhythm: {
    ectopyPerHour: table(ectopyPerHour),
    pvcCouplingRatio: round(median(coupling)),
    afRrRatio: table(afRatios),
    sinusRrRatio: table(sinusRatios),
    afEpisodeMinutes: table(afEpisodeMinutes),
    afMinuteHrSd: round(median(afMinuteSd)),
    afRateRatio: round(median(rateRatio)),
  },
  holdout: {
    ...windowSummary(holdoutWindows),
    systolic: { at15to45min: stepSdAround(holdoutPairs, 15, 45), at120to240min: stepSdAround(holdoutPairs, 120, 240) },
  },
  train: windowSummary(train),
};

writeFileSync("src/sim/fitted.json", `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ windows: { train: train.length, holdout: holdoutWindows.length }, episodes: episodes.length, ...output }, null, 1));
