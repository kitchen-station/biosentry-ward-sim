// Builds public/replay/eicu-12.json from the eICU-CRD Demo. The output stays out of git.
// Usage: npm run extract -- <folder holding the four .csv.gz files>

import { mkdirSync, writeFileSync } from "node:fs";
import { rows as readRows } from "./eicu-csv.mjs";

// Cardiac, awake, unventilated stays, discharged alive, picked for a spread of NEWS2 paths. One
// stay per bed on the twelve-bed ward.
const STAYS = [
  "967281", "1695183", "1724218", "1076979", "1176675", "2511125",
  "1728151", "2316703", "1626712", "1794908", "2325386", "263850",
];
const GRID = 5;
const WARMUP = 480;
const LENGTH = 1440;
const ROOM_AIR = new Set(["ra", "room air", "r/a"]);

const folder = process.argv[2];
if (!folder) throw new Error("Usage: npm run extract -- <folder>");

const rows = (name, visit) => readRows(folder, name, visit, (row) => STAYS.includes(row.patientunitstayid));

const number = (text) => (text === "" || text === undefined || Number.isNaN(Number(text)) ? null : Number(text));

const raw = Object.fromEntries(
  STAYS.map((id) => [id, { hr: [], rr: [], spo2: [], temp: [], bp: [], o2: [], gcs: [] }]),
);
const info = {};

await rows("patient", (r) => {
  info[r.patientunitstayid] = r;
});
await rows("vitalPeriodic", (r) => {
  const s = raw[r.patientunitstayid];
  const offset = Number(r.observationoffset);
  for (const [column, key] of [["heartrate", "hr"], ["respiration", "rr"], ["sao2", "spo2"], ["temperature", "temp"]]) {
    const value = number(r[column]);
    if (value !== null) s[key].push([offset, value]);
  }
});
await rows("vitalAperiodic", (r) => {
  const systolic = number(r.noninvasivesystolic);
  const diastolic = number(r.noninvasivediastolic);
  if (systolic !== null && diastolic !== null) {
    raw[r.patientunitstayid].bp.push([Number(r.observationoffset), systolic, diastolic]);
  }
});

const pendingBp = Object.fromEntries(STAYS.map((id) => [id, {}]));
await rows("nurseCharting", (r) => {
  const s = raw[r.patientunitstayid];
  const offset = Number(r.nursingchartoffset);
  const label = r.nursingchartcelltypevallabel;
  const name = r.nursingchartcelltypevalname;
  const text = r.nursingchartvalue.trim();
  const value = number(text);
  if (label === "Temperature" && name === "Temperature (C)" && value !== null) s.temp.push([offset, value]);
  else if (label === "O2 Admin Device") s.o2.push([offset, ROOM_AIR.has(text.toLowerCase()) ? 0 : 1]);
  else if (label === "O2 L/%" && value !== null) s.o2.push([offset, value === 0 || value === 21 ? 0 : 1]);
  else if (label === "Glasgow coma score" && name === "GCS Total" && value !== null) s.gcs.push([offset, value]);
  else if (label === "Non-Invasive BP" && value !== null) {
    const pair = (pendingBp[r.patientunitstayid][offset] ??= {});
    if (name === "Non-Invasive BP Systolic") pair.systolic = value;
    if (name === "Non-Invasive BP Diastolic") pair.diastolic = value;
  }
});
for (const id of STAYS) {
  for (const [offset, pair] of Object.entries(pendingBp[id])) {
    if (pair.systolic && pair.diastolic) raw[id].bp.push([Number(offset), pair.systolic, pair.diastolic]);
  }
}

/** Onto the 5-minute grid, relative to the start. The last entry in a slot wins. */
function binned(series, start, end) {
  const slots = new Map();
  for (const [offset, ...values] of [...series].sort((a, b) => a[0] - b[0])) {
    const minute = Math.ceil((offset - start) / GRID) * GRID + 0;
    if (minute >= -WARMUP && minute <= end - start) slots.set(minute, values);
  }
  return [...slots].map(([minute, values]) => [minute, ...values]);
}

const stays = STAYS.map((id) => {
  const s = raw[id];
  const p = info[id];
  const first = Object.values(s).map((series) => Math.min(...series.map((point) => point[0])));
  const start = Math.max(...first, 0) + 15;
  const end = Math.min(start + LENGTH, Number(p.unitdischargeoffset));
  const out = {
    id,
    dx: p.apacheadmissiondx.split(",")[0],
    age: p.age,
    sex: p.gender[0],
    unit: p.unittype,
    to: p.unitdischargelocation,
    durationMin: Math.floor((end - start) / GRID) * GRID,
  };
  for (const key of Object.keys(s)) out[key] = binned(s[key], start, end);
  return out;
});

mkdirSync("public/replay", { recursive: true });
writeFileSync(
  "public/replay/eicu-12.json",
  JSON.stringify({ dataset: "eICU-CRD Demo 2.0.1", licence: "ODbL v1.0", stays }),
);
console.log(stays.map((s) => `${s.id}: ${s.hr.length} HR, ${s.temp.length} temp, ${s.bp.length} BP, ${s.durationMin} min`).join("\n"));
