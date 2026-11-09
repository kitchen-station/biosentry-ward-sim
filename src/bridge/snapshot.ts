// The bridge to the BioSentry dashboard: the sim's ward, in the dashboard's API shapes
// (ScoreRow, PatientDetail, AbstainedRow). Pure, so it runs headless in tests.
// Labs, Tier B and Tier C are not simulated, so they are null: missing is missing (I1).

import { type Patient, type Sim, minuteOf, vitalQuality } from "../sim/sim";
import { roundHalfUp } from "../sim/news2";
import type { Vital } from "../sim/source";

const WARD = "W4";
const TREND_POINTS = 12; // 3 hours of 15-minute medians, the fixture's length
const TIER_STATUS = [{ tier: "A", label: "NEWS2", live: true }];
const LAB_KEYS = [
  "blood_glucose", "bnp", "bun", "calcium", "chloride", "ck_mb", "creatinine", "hematocrit",
  "hemoglobin", "inr", "lactate", "magnesium", "nt_probnp", "platelet_count", "potassium", "pt",
  "sgot", "sgpt", "sodium", "troponin", "wbc",
] as const;
const NO_LABS = { ...Object.fromEntries(LAB_KEYS.map((k) => [k, null])), freshness_hours: null };
const UNIT: Partial<Record<string, string>> = { heart_rate: "bpm", respiratory_rate: "/min", spo2: "%", temperature: "°C" };
const SHORT: Partial<Record<string, string>> = {
  heart_rate: "HR", respiratory_rate: "RR", spo2: "SpO2", temperature: "Temp",
  systolic_bp: "SBP", consciousness: "ACVPU", supplemental_o2: "O2",
};

export interface PatientEntry {
  id: string;
  rn: string; // assigned staff nurse: the server scopes by these (I7)
  md: string | null; // the physician whose list holds this patient; null when none does
  ranked: Record<string, unknown> | null; // a PatientDetail: a ScoreRow plus history and breakdown
  abstained: Record<string, unknown> | null; // an AbstainedRow
}

export interface WardSnapshot {
  ward: string;
  synthetic: boolean;
  receiving_data: boolean;
  sent_at: string;
  staff: { id: string; role: "rn" | "charge_rn" | "md" }[];
  patients: PatientEntry[];
}

/** Sim minutes are mapped onto the wall clock so the dashboard's ages read true: sim "now" is now. */
function clock(s: Sim, nowMs: number) {
  const minute = minuteOf(s);
  return (atMinute: number) => new Date(nowMs - (minute - atMinute) * 60_000).toISOString();
}

// The precision NEWS2 scores at, so a displayed value always agrees with its points.
const rounded = <T extends number | null>(v: Vital, value: T) =>
  (value === null ? null : roundHalfUp(value, v === "temperature" ? 1 : 0)) as T;

function provenance(observedAt: string, source: string, quality: string, synthetic: boolean) {
  return { computed_at: null, model_id: null, observed_at: observedAt, quality, source, synthetic, tier: null };
}

function deviceVital(p: Patient, v: Vital, minute: number, at: (m: number) => string, synthetic: boolean) {
  const quality = vitalQuality(p, v, minute);
  const heldAt = p.heldAt[v];
  const observed = at(heldAt ?? minute);
  if (quality === "missing" || p.held[v] === null) {
    const reason = heldAt === null ? "No usable reading yet" : `No usable reading for ${minute - heldAt} min`;
    return { data: { present: false, reason }, provenance: provenance(observed, "device", "missing", synthetic) };
  }
  return { data: { present: true, value: rounded(v, p.held[v]) }, provenance: provenance(observed, "device", quality, synthetic) };
}

function nurseValue<T>(value: T | null, at: string, synthetic: boolean, reason: string) {
  return value === null
    ? { data: { present: false, reason }, provenance: provenance(at, "nurse", "missing", synthetic) }
    : { data: { present: true, value }, provenance: provenance(at, "nurse", "ok", synthetic) };
}

const ageOf = (age: number | string) => (typeof age === "number" ? age : null);

function scoreRow(s: Sim, p: Patient, synthetic: boolean, nowMs: number) {
  if (p.decision.kind !== "ranked" || p.rank === null) return null;
  const minute = minuteOf(s);
  const at = clock(s, nowMs);
  const nurseAt = at(p.nurseAt);
  const news2 = p.decision.news2;
  const freshest = Math.max(...Object.values(p.heldAt).map((m) => m ?? -Infinity));
  const usable = p.signal.length ? p.signal.reduce((a, b) => a + b, 0) / p.signal.length : 0;
  const trendOf = (v: Vital) => p.history[v].slice(-TREND_POINTS).map((value) => rounded(v, value));
  const historyOf = (v: Vital) => {
    const h = p.history[v];
    return h.map((value, i) => ({ time: at(minute - (h.length - 1 - i) * 15), value: rounded(v, value) }));
  };
  return {
    id: p.id,
    name: p.name,
    age: ageOf(p.age),
    sex: p.sex,
    bed: p.bed,
    admitting_context: p.context,
    rank: p.rank,
    score: news2.total,
    sort_tier: "A",
    trend: p.trend,
    escalation_reasons: p.decision.reasons.map((text) => ({ rule: "tier_a_threshold", pathway: null, text })),
    supporting: news2.parameters
      .filter((x) => x.score > 0)
      .map((x) => `${SHORT[x.parameter] ?? x.parameter} ${x.value}${UNIT[x.parameter] ? " " + UNIT[x.parameter] : ""}`)
      .join(", "),
    mechanism: "Sorted on NEWS2 (Tier A). Live from the ward simulation.",
    signal_quality: Math.round(usable * 100),
    last_update_s: Number.isFinite(freshest) ? Math.max(0, (minute - freshest) * 60) : 0,
    synthetic,
    vitals: {
      heart_rate: deviceVital(p, "heart_rate", minute, at, synthetic),
      respiratory_rate: deviceVital(p, "respiratory_rate", minute, at, synthetic),
      spo2: deviceVital(p, "spo2", minute, at, synthetic),
      temperature: deviceVital(p, "temperature", minute, at, synthetic),
      blood_pressure: nurseValue(p.bp, at(p.bpAt ?? p.nurseAt), synthetic, "No blood pressure recorded"),
      consciousness: nurseValue(p.consciousness, nurseAt, synthetic, "Not recorded"),
      supplemental_o2: nurseValue(p.onOxygen, nurseAt, synthetic, "Not recorded"),
      spo2_scale: nurseValue(p.spo2Scale, nurseAt, synthetic, "Not recorded"),
    },
    vital_trends: {
      heart_rate: trendOf("heart_rate"),
      respiratory_rate: trendOf("respiratory_rate"),
      spo2: trendOf("spo2"),
      temperature: trendOf("temperature"),
    },
    labs: NO_LABS,
    tier_b: null,
    tier_c: null,
    tier_status: TIER_STATUS,
    // PatientDetail only; the server strips these from ward rows.
    vital_history: {
      heart_rate: historyOf("heart_rate"),
      respiratory_rate: historyOf("respiratory_rate"),
      spo2: historyOf("spo2"),
    },
    tier_breakdown: { tier_a: { label: "NEWS2", score: news2.total }, tier_b: null, tier_c: null },
  };
}

/** The whole ward as the dashboard's API would serve it, before clinician scoping. */
export function wardSnapshot(s: Sim, synthetic: boolean, nowMs = Date.now()): WardSnapshot {
  return {
    ward: WARD,
    synthetic,
    receiving_data: !s.ended,
    sent_at: new Date(nowMs).toISOString(),
    staff: s.staff.map(({ id, role }) => ({ id, role })),
    patients: s.patients.map((p) => ({
      id: p.id,
      rn: p.rn,
      md: p.listMd,
      ranked: scoreRow(s, p, synthetic, nowMs),
      abstained:
        p.decision.kind === "not_ranked"
          ? {
              id: p.id,
              name: p.name,
              age: ageOf(p.age),
              sex: p.sex,
              bed: p.bed,
              admitting_context: p.context,
              reason: p.decision.reason,
              instruction: p.decision.instruction,
              synthetic,
            }
          : null,
    })),
  };
}
