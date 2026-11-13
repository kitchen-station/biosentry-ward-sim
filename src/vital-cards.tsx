// The vital cards and the ranked rows, shared by ward W4's panels and the hospital panels. They live here so
// hospital-panels.tsx can use them without importing panels.tsx (which imports hospital-panels).
import { Sparkline } from "./chart";
import { Flip } from "./flip";
import { vitalQuality, type Patient } from "./sim/sim";
import type { Vital } from "./sim/source";

/** How the vital cards name and print each vital; the Analytics page prints them the same way. */
export const VITAL_CARD = {
  heart_rate: { label: "Heart rate", unit: "/min", digits: 0 },
  respiratory_rate: { label: "Resp. rate", unit: "/min", digits: 0 },
  spo2: { label: "SpO2", unit: "%", digits: 0 },
  temperature: { label: "Temperature", unit: "°C", digits: 1 },
} as const;

export const RISK_WORDS: Record<string, string> = {
  low: "Low risk",
  low_medium: "Low-medium risk",
  medium: "Medium risk",
  high: "High risk",
};

export function vitalText(p: Patient, v: Vital, minute: number, digits = 0) {
  const held = p.held[v];
  return held === null || vitalQuality(p, v, minute) === "missing" ? "--" : held.toFixed(digits);
}

export const bpText = (p: Patient) => (p.bp ? `${p.bp.systolic}/${p.bp.diastolic}` : "--");

const miniLine = (p: Patient, minute: number) =>
  `HR ${vitalText(p, "heart_rate", minute)} RR ${vitalText(p, "respiratory_rate", minute)} SpO2 ${vitalText(p, "spo2", minute)} T ${vitalText(p, "temperature", minute, 1)} BP ${bpText(p)}`;

/** `sel`, `name`, `place` and `rank` default to the ward patient's own; the hospital lists pass their own. */
export function RankedRow({
  p,
  minute,
  onSelect,
  selected,
  sel = p.id,
  name = p.name,
  place = p.bed,
  rank = p.rank ?? "",
}: {
  p: Patient;
  minute: number;
  onSelect: (id: string) => void;
  selected: boolean;
  sel?: string;
  name?: string;
  place?: string;
  rank?: number | string;
}) {
  const d = p.decision;
  if (d.kind !== "ranked") return null;
  return (
    <li>
      <button className={`row${selected ? " sel" : ""}`} onClick={() => onSelect(sel)}>
        <span className="rank"><Flip value={rank} /></span>
        <span className="who">
          <b>{name}</b> <span className="mono">{place}</span>
        </span>
        <span className="score">
          <Flip value={d.news2.total} />
          <small>{p.trend === "insufficient" ? "" : p.trend}</small>
        </span>
        <span className="mini">{miniLine(p, minute)}</span>
        {d.reasons.length > 0 && <span className="why">{d.reasons.join(". ")}</span>}
      </button>
    </li>
  );
}

/** A row with no rank. `minute` adds the vitals line (intensive care shows vitals with no rank). */
export function NotRankedRow({
  p,
  onSelect,
  selected,
  sel = p.id,
  name = p.name,
  place = p.bed,
  minute,
}: {
  p: Patient;
  onSelect: (id: string) => void;
  selected: boolean;
  sel?: string;
  name?: string;
  place?: string;
  minute?: number;
}) {
  return (
    <li>
      <button className={`row${selected ? " sel" : ""}`} onClick={() => onSelect(sel)}>
        <span className="rank">--</span>
        <span className="who">
          <b>{name}</b> <span className="mono">{place}</span>
        </span>
        {minute !== undefined && <span className="mini">{miniLine(p, minute)}</span>}
        {p.decision.kind === "not_ranked" && (
          <span className="why">
            {p.decision.reason}. {p.decision.instruction}.
          </span>
        )}
      </button>
    </li>
  );
}

export function VitalCard({
  label,
  value,
  unit,
  source,
  at,
  quality,
  data,
}: {
  label: string;
  value: string;
  unit: string;
  source: string;
  at: string;
  quality: string;
  data: (number | null)[];
}) {
  return (
    <div className="vital" title={source}>
      <div className="vhead">
        <span>{label}</span>
        {quality !== "ok" && <span className="pill"><Flip value={quality} /></span>}
      </div>
      <span className="vnum">
        <Flip value={value} />
        <small>{unit}</small>
      </span>
      <Sparkline data={data} height={22} />
      <div className="prov">{at}</div>
    </div>
  );
}

/** The five cards. `when` prints a reading's minute; `charted` are the vitals a nurse charts, the rest are device readings. */
export function VitalCards({ p, minute, charted, origin, when }: { p: Patient; minute: number; charted: readonly Vital[]; origin: string; when: (at: number | null) => string }) {
  const device = (v: keyof typeof VITAL_CARD) => (
    <VitalCard
      label={VITAL_CARD[v].label}
      value={vitalText(p, v, minute, VITAL_CARD[v].digits)}
      unit={VITAL_CARD[v].unit}
      source={`${charted.includes(v) ? "charted" : "device"} · ${origin}`}
      at={when(p.heldAt[v])}
      quality={vitalQuality(p, v, minute)}
      data={p.history[v]}
    />
  );
  return (
    <div className="vitals">
      {device("heart_rate")}
      {device("respiratory_rate")}
      {device("spo2")}
      {device("temperature")}
      <VitalCard
        label="Blood pressure"
        value={bpText(p)}
        unit="mmHg"
        source={`nurse · ${origin}`}
        at={when(p.bpAt)}
        quality={p.bp ? "ok" : "missing"}
        data={p.bpHistory}
      />
    </div>
  );
}
