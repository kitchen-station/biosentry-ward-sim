// Fits the synthetic generator's dynamics constants from the eICU-CRD Demo and writes
// src/sim/calibration.json. Usage: npm run fit -- <folder holding the four .csv.gz files>
// Pooled numbers only: per-stay estimates are medianed and never written out.

import { writeFileSync } from "node:fs";
import { rows } from "./eicu-csv.mjs";

const folder = process.argv[2];
if (!folder) throw new Error("Usage: npm run fit -- <folder>");

const COLUMN = { heart_rate: "heartrate", respiratory_rate: "respiration", spo2: "sao2" };
const KEYS = Object.keys(COLUMN);
const CLAMPS = { heart_rate: [30, 200], respiratory_rate: [6, 40], spo2: [78, 100] }; // as in src/sim/source.ts
const CARDIAC = new Set(["Cardiac ICU", "CCU-CTICU", "CTICU", "CSICU"]);
const GRID = 5;
const MIN_SLOTS = 144; // 12 hours of 5-minute values per vital
const MIN_PAIRS = 100;
const HALF_WINDOW = 36; // slots each side: a 6-hour rolling median
const LAGS = [5, 15, 60, 180];
const HOLD_OUT_ONE_IN = 5;

// Previous hand-set values, printed beside the fit.
const OLD = {
  coupling: { heart_rate: 1.2, respiratory_rate: 0.35, spo2: -0.25 },
  wanderSd: { heart_rate: 2.5, respiratory_rate: 0.6, spo2: 0.4 },
  wanderTau: 20,
  latentTau: 45,
  circadianAmp: { heart_rate: 2.0, respiratory_rate: 0.3, spo2: 0 },
};

const median = (a) => quantile(a, 0.5);
function quantile(a, q) {
  const s = [...a].sort((x, y) => x - y);
  const at = (s.length - 1) * q;
  const lo = Math.floor(at);
  return s[lo] + (s[Math.ceil(at)] - s[lo]) * (at - lo);
}
const round = (x, digits = 3) => Number(x.toPrecision(digits));

/** Stable 1-in-5 hospital split, no randomness. */
function heldOut(hospital) {
  let h = 2166136261;
  for (const ch of hospital) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h % HOLD_OUT_ONE_IN === 0;
}

// ---- cohort ----

const patients = new Map();
await rows(folder, "patient", (r) => {
  const age = r.age === "> 89" ? 90 : Number(r.age);
  if (!(age >= 18) || r.unitdischargestatus !== "Alive") return;
  const [h, m] = r.unitadmittime24.split(":").map(Number);
  patients.set(r.patientunitstayid, { hospital: r.hospitalid, unit: r.unittype, admitHour: h + m / 60 });
});
const candidate = (r) => patients.has(r.patientunitstayid);

const gcs = new Map();
await rows(folder, "nurseCharting", (r) => {
  const value = Number(r.nursingchartvalue);
  if (r.nursingchartcelltypevallabel !== "Glasgow coma score" || r.nursingchartcelltypevalname !== "GCS Total") return;
  if (r.nursingchartvalue === "" || Number.isNaN(value)) return;
  (gcs.get(r.patientunitstayid) ?? gcs.set(r.patientunitstayid, []).get(r.patientunitstayid)).push(value);
}, candidate);

const raw = new Map(); // stay -> vital -> slot -> value
await rows(folder, "vitalPeriodic", (r) => {
  const slot = Math.round(Number(r.observationoffset) / GRID);
  const s = raw.get(r.patientunitstayid) ?? raw.set(r.patientunitstayid, { heart_rate: new Map(), respiratory_rate: new Map(), spo2: new Map() }).get(r.patientunitstayid);
  for (const v of KEYS) {
    const value = r[COLUMN[v]] === "" ? NaN : Number(r[COLUMN[v]]);
    const [low, high] = CLAMPS[v];
    if (value >= low && value <= high) s[v].set(slot, value);
  }
}, candidate);

const stays = [];
for (const [id, p] of patients) {
  const g = gcs.get(id);
  const s = raw.get(id);
  if (!g || median(g) < 14 || !s || KEYS.some((v) => s[v].size < MIN_SLOTS)) continue;
  const lo = Math.min(...KEYS.map((v) => Math.min(...s[v].keys())));
  const hi = Math.max(...KEYS.map((v) => Math.max(...s[v].keys())));
  const x = {};
  for (const v of KEYS) {
    x[v] = new Float64Array(hi - lo + 1).fill(NaN);
    for (const [slot, value] of s[v]) x[v][slot - lo] = value;
  }
  stays.push({ id, ...p, lo, x });
}

// ---- series tools (dense arrays, NaN for a missing slot) ----

function detrend(x) {
  const out = new Float64Array(x.length).fill(NaN);
  for (let i = 0; i < x.length; i += 1) {
    if (Number.isNaN(x[i])) continue;
    const window = [];
    for (let j = Math.max(0, i - HALF_WINDOW); j <= Math.min(x.length - 1, i + HALF_WINDOW); j += 1) {
      if (!Number.isNaN(x[j])) window.push(x[j]);
    }
    if (window.length >= 12) out[i] = x[i] - median(window);
  }
  return out;
}

function autocov(x, lag) {
  let sum = 0;
  let n = 0;
  for (const value of x) if (!Number.isNaN(value)) (sum += value), (n += 1);
  const mean = sum / n;
  let c = 0;
  let pairs = 0;
  for (let i = 0; i + lag < x.length; i += 1) {
    if (Number.isNaN(x[i]) || Number.isNaN(x[i + lag])) continue;
    c += (x[i] - mean) * (x[i + lag] - mean);
    pairs += 1;
  }
  return pairs < MIN_PAIRS ? NaN : c / pairs;
}

/** Ornstein-Uhlenbeck sd and tau (minutes) from the 5 and 10 minute autocovariances. White noise cancels in the ratio. */
function ouFit(x) {
  const c5 = autocov(x, 1);
  const c10 = autocov(x, 2);
  const phi5 = c10 / c5;
  if (!(c10 > 0) || !(phi5 > 0 && phi5 < 1)) return null;
  return { sd: Math.sqrt((c5 * c5) / c10), tau: -GRID / Math.log(phi5) };
}

function changeSd(x, lag) {
  const d = [];
  for (let i = 0; i + lag < x.length; i += 1) if (!Number.isNaN(x[i]) && !Number.isNaN(x[i + lag])) d.push(x[i + lag] - x[i]);
  if (d.length < MIN_PAIRS) return null;
  const mean = d.reduce((a, b) => a + b) / d.length;
  return Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length);
}

function solve3(a, b) {
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c += 1) {
    const p = m.slice(c).reduce((best, row, i) => (Math.abs(row[c]) > Math.abs(m[best][c]) ? i + c : best), c);
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 3; r += 1) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k += 1) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[3] / m[i][i]);
}

/** value = a + b cos(2 pi clock / 24) + c sin(2 pi clock / 24), clock in hours; needs 24 hours of data. */
function circadianFit(x, lo, admitHour) {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const B = [0, 0, 0];
  let first = Infinity;
  let last = -Infinity;
  x.forEach((value, i) => {
    if (Number.isNaN(value)) return;
    first = Math.min(first, i);
    last = Math.max(last, i);
    const theta = (2 * Math.PI * (admitHour + ((lo + i) * GRID) / 60)) / 24;
    const f = [1, Math.cos(theta), Math.sin(theta)];
    for (let r = 0; r < 3; r += 1) {
      B[r] += f[r] * value;
      for (let c = 0; c < 3; c += 1) A[r][c] += f[r] * f[c];
    }
  });
  if ((last - first) * GRID < 1440) return null;
  const [, b, c] = solve3(A, B);
  return { b, c };
}

/** First principal component of the 3x3 correlation matrix, HR loading made positive. */
function factor(r) {
  const idx = [];
  for (let i = 0; i < r.heart_rate.length; i += 1) if (KEYS.every((v) => !Number.isNaN(r[v][i]))) idx.push(i);
  if (idx.length < MIN_PAIRS) return null;
  const mean = {};
  const sd = {};
  for (const v of KEYS) {
    mean[v] = idx.reduce((a, i) => a + r[v][i], 0) / idx.length;
    sd[v] = Math.sqrt(idx.reduce((a, i) => a + (r[v][i] - mean[v]) ** 2, 0) / idx.length);
    if (!(sd[v] > 0)) return null;
  }
  const z = (v, i) => (r[v][i] - mean[v]) / sd[v];
  const R = KEYS.map((a) => KEYS.map((b) => idx.reduce((s, i) => s + z(a, i) * z(b, i), 0) / idx.length));
  let e = [1, 1, 1];
  for (let k = 0; k < 200; k += 1) {
    const next = R.map((row) => row.reduce((s, x, j) => s + x * e[j], 0));
    const norm = Math.hypot(...next);
    e = next.map((x) => x / norm);
  }
  const lambda = e.reduce((s, x, i) => s + x * R[i].reduce((t, y, j) => t + y * e[j], 0), 0);
  if (e[0] < 0) e = e.map((x) => -x);
  const score = new Float64Array(r.heart_rate.length).fill(NaN);
  for (const i of idx) score[i] = KEYS.reduce((s, v, j) => s + e[j] * z(v, i), 0) / Math.sqrt(lambda);
  return { score, coupling: Object.fromEntries(KEYS.map((v, j) => [v, Math.sqrt(lambda) * e[j] * sd[v]])), mean };
}

// ---- the fit ----

function estimate(stay) {
  const r = Object.fromEntries(KEYS.map((v) => [v, detrend(stay.x[v])]));
  const f = factor(r);
  if (!f) return null;
  const out = { latent: ouFit(f.score), coupling: f.coupling, wander: {}, fast: {} };
  for (const v of KEYS) {
    // White variance the OU fit excludes, on the detrended 5-minute series: C(0) - C(5)^2 / C(10).
    const raw = ouFit(r[v]);
    out.fast[v] = raw ? autocov(r[v], 0) - raw.sd ** 2 : null;
    const e = r[v].map((value, i) => value - f.mean[v] - f.coupling[v] * f.score[i]);
    out.wander[v] = ouFit(e);
  }
  return out;
}

const pooled = (values) => ({ value: median(values), n: values.length });

function analyse(cohort) {
  const fit = cohort.filter((s) => !heldOut(s.hospital));
  const held = cohort.filter((s) => heldOut(s.hospital));
  const est = fit.map(estimate).filter(Boolean);
  const take = (get) => est.map(get).filter((x) => x != null && Number.isFinite(x));
  const circ = Object.fromEntries(KEYS.map((v) => {
    const per = fit.map((s) => circadianFit(s.x[v], s.lo, s.admitHour)).filter(Boolean);
    const b = median(per.map((p) => p.b));
    const c = median(per.map((p) => p.c));
    return [v, { amp: Math.hypot(b, c), peak: ((Math.atan2(c, b) * 12) / Math.PI + 24) % 24, n: per.length }];
  }));
  const band = Object.fromEntries(KEYS.map((v) => {
    const per = held.map((s) => detrend(s.x[v]));
    return [v, LAGS.map((lag) => {
      const sds = per.map((x) => changeSd(x, lag / GRID)).filter((x) => x !== null);
      return { lag, p25: quantile(sds, 0.25), p50: quantile(sds, 0.5), p75: quantile(sds, 0.75), n: sds.length };
    })];
  }));
  return {
    cohort: { stays: cohort.length, fit: fit.length, heldOut: held.length, fitted: est.length },
    latent: pooled(take((e) => e.latent?.tau)),
    vitals: Object.fromEntries(KEYS.map((v) => [v, {
      coupling: pooled(take((e) => e.coupling[v])),
      wanderSd: pooled(take((e) => e.wander[v]?.sd)),
      wanderTau: pooled(take((e) => e.wander[v]?.tau)),
      fastVar: pooled(take((e) => e.fast[v])),
      circadian: circ[v],
    }])),
    band,
  };
}

const primary = analyse(stays);
const cardiac = analyse(stays.filter((s) => CARDIAC.has(s.unit)));

// ---- report ----

const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");
console.log(`Cohort (adult, alive, GCS median >= 14, 12 h+ of HR, RR, SpO2): ${primary.cohort.stays} stays`);
console.log(`  primary: ${JSON.stringify(primary.cohort)}`);
console.log(`  cardiac: ${JSON.stringify(cardiac.cohort)}`);
console.log(`latent tau (min): primary ${f2(primary.latent.value)} (n ${primary.latent.n}), cardiac ${f2(cardiac.latent.value)} (n ${cardiac.latent.n}), old ${OLD.latentTau}`);
for (const v of KEYS) {
  const p = primary.vitals[v];
  const c = cardiac.vitals[v];
  console.log(`${v}`);
  console.log(`  coupling    primary ${f2(p.coupling.value)}  cardiac ${f2(c.coupling.value)}  old ${OLD.coupling[v]}`);
  console.log(`  wander sd   primary ${f2(p.wanderSd.value)}  cardiac ${f2(c.wanderSd.value)}  old ${OLD.wanderSd[v]}`);
  console.log(`  wander tau  primary ${f2(p.wanderTau.value)}  cardiac ${f2(c.wanderTau.value)}  old ${OLD.wanderTau}`);
  console.log(`  fast sd     primary ${f2(Math.sqrt(p.fastVar.value))} (n ${p.fastVar.n})  cardiac ${f2(Math.sqrt(c.fastVar.value))}${v === "heart_rate" ? "  (not written: HR keeps its hand-set noise)" : ""}`);
  console.log(`  circadian   primary amp ${f2(p.circadian.amp)} peak ${f2(p.circadian.peak)} h (n ${p.circadian.n})  cardiac amp ${f2(c.circadian.amp)} peak ${f2(c.circadian.peak)} h (n ${c.circadian.n})  old amp ${OLD.circadianAmp[v]}`);
  for (const [a, b] of primary.band[v].map((x, i) => [x, cardiac.band[v][i]])) {
    console.log(`  change sd ${String(a.lag).padStart(3)} min  held-out p25 ${f2(a.p25)} p50 ${f2(a.p50)} p75 ${f2(a.p75)} (n ${a.n})  cardiac p50 ${f2(b.p50)} (n ${b.n})`);
  }
}

if (primary.cohort.stays < 100) throw new Error(`Cohort of ${primary.cohort.stays} stays is under 100; not writing`);
const taus = [primary.latent.value, ...KEYS.map((v) => primary.vitals[v].wanderTau.value)];
if (!taus.every((t) => t > 0 && Number.isFinite(t))) throw new Error(`Non-positive tau in ${taus}; not writing`);

writeFileSync(
  "src/sim/calibration.json",
  JSON.stringify(
    {
      dataset: "eICU-CRD Demo 2.0.1",
      licence: "ODbL v1.0",
      cohort: primary.cohort,
      latentTau: round(primary.latent.value),
      // RR and SpO2 only: white below the 5-minute resolution is an assumption, not a measurement.
      fastNoise: {
        respiratory_rate: round(Math.sqrt(primary.vitals.respiratory_rate.fastVar.value)),
        spo2: round(Math.sqrt(primary.vitals.spo2.fastVar.value)),
      },
      vitals: Object.fromEntries(KEYS.map((v) => {
        const p = primary.vitals[v];
        return [v, {
          coupling: round(p.coupling.value),
          wanderSd: round(p.wanderSd.value),
          wanderTau: round(p.wanderTau.value),
          circadianAmp: round(p.circadian.amp),
          circadianPeak: round(p.circadian.peak),
        }];
      })),
      changeSd: Object.fromEntries(KEYS.map((v) => [v, primary.band[v].map(({ lag, p25, p50, p75 }) => ({ lag, p25: round(p25), p50: round(p50), p75: round(p75) }))])),
    },
    null,
    2,
  ) + "\n",
);
console.log("wrote src/sim/calibration.json");
