import { useState, type FormEvent } from "react";
import { Sparkline } from "./chart";
import { PORTRAIT, STAFF_PALETTES, sprite } from "./render/sprites";
import { CHIP_COLOURS } from "./render/draw";
import {
  applyPatch,
  detachPatch,
  injectDeterioration,
  minuteOf,
  patientById,
  recordBp,
  setSpeed,
  staffStatus,
  vitalQuality,
  type Patient,
  type Sim,
  type Speed,
} from "./sim/sim";
import type { Vital, VitalsSource } from "./sim/source";

export type Tab = "ranked" | "chart" | "pipeline" | "log";

const SPEEDS: Speed[] = [0, 1, 10, 60];
const SYSTOLIC_BOUNDS = { min: 20, max: 300 };
const DIASTOLIC_BOUNDS = { min: 10, max: 200 };

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** Synthetic runs from 15:00 in Manila. Replay dates are de-identified, so it shows elapsed time. */
export function clockText(src: VitalsSource, minute: number) {
  if (src.synthetic) return hhmm((15 * 60 + minute) % (24 * 60));
  return `${minute < 0 ? "-" : "+"}${hhmm(Math.abs(minute))}`;
}

const dayOf = (minute: number) => 3 + Math.floor((15 * 60 + minute) / (24 * 60));

function vitalText(p: Patient, v: Vital, minute: number, digits = 0) {
  const held = p.held[v];
  return held === null || vitalQuality(p, v, minute) === "missing" ? "--" : held.toFixed(digits);
}

const bpText = (p: Patient) => (p.bp ? `${p.bp.systolic}/${p.bp.diastolic}` : "--");

export function TopBar({
  s,
  src,
  replayReady,
  onSource,
  onReset,
}: {
  s: Sim;
  src: VitalsSource;
  replayReady: boolean;
  onSource: (replay: boolean) => void;
  onReset: () => void;
}) {
  const minute = minuteOf(s);
  return (
    <header className="topbar">
      <h1>BioSentry ward sim</h1>
      <span className="pill">W4</span>
      <span className="clock">
        {src.synthetic
          ? `${dayOf(minute)} Sep 2026, ${clockText(src, minute)} Manila`
          : `Replay ${clockText(src, minute)} of 24:00`}
      </span>
      <div className="speeds" role="group" aria-label="Data source">
        <button className={src.synthetic ? "on" : ""} aria-pressed={src.synthetic} onClick={() => onSource(false)}>
          Synthetic
        </button>
        <button
          className={src.synthetic ? "" : "on"}
          aria-pressed={!src.synthetic}
          disabled={!replayReady}
          title={replayReady ? undefined : "Run npm run extract first. See the README."}
          onClick={() => onSource(true)}
        >
          eICU replay
        </button>
      </div>
      {s.ended && <span className="pill solid">Replay ended</span>}
      <div className="speeds right" role="group" aria-label="Simulation speed">
        {SPEEDS.map((speed) => (
          <button
            key={speed}
            className={s.speed === speed ? "on" : ""}
            aria-pressed={s.speed === speed}
            onClick={() => setSpeed(s, speed)}
          >
            {speed === 0 ? "Pause" : `${speed}x`}
          </button>
        ))}
        <button onClick={onReset}>Reset</button>
      </div>
    </header>
  );
}

function RankedRow({
  p,
  minute,
  onSelect,
  selected,
}: {
  p: Patient;
  minute: number;
  onSelect: (id: string) => void;
  selected: boolean;
}) {
  const d = p.decision;
  if (d.kind !== "ranked") return null;
  return (
    <li>
      <button className={`row${selected ? " sel" : ""}`} onClick={() => onSelect(p.id)}>
        <span className="rank">{p.rank}</span>
        <span className="who">
          <b>{p.name}</b> <span className="mono">{p.bed}</span>
        </span>
        <span className="score">
          {d.news2.total}
          <small>{p.trend === "insufficient" ? "" : p.trend}</small>
        </span>
        <span className="mini">
          HR {vitalText(p, "heart_rate", minute)} RR {vitalText(p, "respiratory_rate", minute)} SpO2{" "}
          {vitalText(p, "spo2", minute)} T {vitalText(p, "temperature", minute, 1)} BP {bpText(p)}
        </span>
        {d.reasons.length > 0 && <span className="why">{d.reasons.join(". ")}</span>}
      </button>
    </li>
  );
}

function RankedTab({
  s,
  selected,
  onSelect,
}: {
  s: Sim;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const minute = minuteOf(s);
  const ranked = s.patients
    .filter((p) => p.rank !== null)
    .sort((a, b) => a.rank! - b.rank!);
  const notRanked = s.patients.filter((p) => p.rank === null);
  return (
    <div className="scroll">
      <ol className="list">
        {ranked.map((p) => (
          <RankedRow key={p.id} p={p} minute={minute} onSelect={onSelect} selected={p.id === selected} />
        ))}
      </ol>
      {notRanked.length > 0 && <h3>Not ranked</h3>}
      <ul className="list">
        {notRanked.map((p) => (
          <li key={p.id}>
            <button className={`row${p.id === selected ? " sel" : ""}`} onClick={() => onSelect(p.id)}>
              <span className="rank">--</span>
              <span className="who">
                <b>{p.name}</b> <span className="mono">{p.bed}</span>
              </span>
              {p.decision.kind === "not_ranked" && (
                <span className="why">
                  {p.decision.reason}. {p.decision.instruction}.
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function VitalCard({
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
    <div className="vital">
      <div className="vhead">
        <span>{label}</span>
        {quality !== "ok" && <span className="pill">{quality}</span>}
      </div>
      <div className="vbody">
        <span className="vnum">
          {value}
          <small>{unit}</small>
        </span>
        <Sparkline data={data} />
      </div>
      <div className="prov">
        {source} · {at}
      </div>
    </div>
  );
}

function BpForm({ s, src, p }: { s: Sim; src: VitalsSource; p: Patient }) {
  const cuff = src.cuff(p.id, minuteOf(s));
  const [systolic, setSystolic] = useState(String(cuff?.systolic ?? ""));
  const [diastolic, setDiastolic] = useState(String(cuff?.diastolic ?? ""));
  const [error, setError] = useState("");
  const pending = s.tasks.some((t) => t.patient === p.id && t.kind === "record_bp");

  function submit(event: FormEvent) {
    event.preventDefault();
    const sys = Number(systolic);
    const dia = Number(diastolic);
    if (
      !Number.isInteger(sys) || !Number.isInteger(dia) ||
      sys < SYSTOLIC_BOUNDS.min || sys > SYSTOLIC_BOUNDS.max ||
      dia < DIASTOLIC_BOUNDS.min || dia > DIASTOLIC_BOUNDS.max || dia >= sys
    ) {
      setError("Rejected, never adjusted. Systolic 20-300, diastolic 10-200 and below systolic.");
      return;
    }
    setError("");
    recordBp(s, p.id, { systolic: sys, diastolic: dia });
  }

  return (
    <form className="bp" onSubmit={submit}>
      <label>
        Systolic
        <input inputMode="numeric" value={systolic} onChange={(e) => setSystolic(e.target.value)} />
      </label>
      <label>
        Diastolic
        <input inputMode="numeric" value={diastolic} onChange={(e) => setDiastolic(e.target.value)} />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? "Nurse on the way" : "Record BP"}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function ChartTab({ s, src, id }: { s: Sim; src: VitalsSource; id: string | null }) {
  if (!id) return <p className="empty">Click a bed or a ranked row to open a chart.</p>;
  const p = patientById(s, id);
  const minute = minuteOf(s);
  const d = p.decision;
  const origin = src.synthetic ? "synthetic" : "eICU";
  const when = (at: number | null) => (at === null ? "no reading" : clockText(src, at));
  const device = (v: Vital, label: string, unit: string, digits = 0) => (
    <VitalCard
      label={label}
      value={vitalText(p, v, minute, digits)}
      unit={unit}
      source={`${src.rules.charted.includes(v) ? "charted" : src.synthetic ? "device" : "monitor"} · ${origin}`}
      at={when(p.heldAt[v])}
      quality={vitalQuality(p, v, minute)}
      data={p.history[v]}
    />
  );
  const patchRequested = s.tasks.some((t) => t.patient === id && t.kind === "apply_patch") ||
    s.staff.some((m) => m.task?.patient === id && m.task.kind === "apply_patch");
  return (
    <div className="scroll">
      <div className="chead">
        <div>
          <h2>{p.name}</h2>
          <p className="mono">
            Bed {p.bed} · {p.age} {p.sex} · {p.rank ? `Rank ${p.rank}` : "NOT RANKED"}
          </p>
        </div>
        <div className="big">
          {d.kind === "ranked" ? d.news2.total : "--"}
          <small>NEWS2</small>
        </div>
      </div>
      <p className="story">{p.context}. {p.story}.</p>
      <div className="vitals">
        {device("heart_rate", "Heart rate", "/min")}
        {device("respiratory_rate", "Respiratory rate", "/min")}
        {device("spo2", "SpO2", "%")}
        {device("temperature", "Temperature", "°C", 1)}
        <VitalCard
          label="Blood pressure"
          value={bpText(p)}
          unit="mmHg"
          source={`${src.synthetic ? "nurse" : "cuff"} · ${origin}`}
          at={when(p.bpAt)}
          quality={p.bp ? "ok" : "missing"}
          data={p.bpHistory}
        />
      </div>
      <p className="second mono">
        ACVPU {p.consciousness}
        {src.synthetic ? "" : " (from GCS)"} · {p.onOxygen ? "On oxygen" : "Room air"} · Scale {p.spo2Scale} · Signal{" "}
        {Math.round((100 * p.signal.reduce((a, b) => a + b, 0)) / Math.max(1, p.signal.length))}%
      </p>
      {d.kind === "ranked" ? (
        <ul className="reasons">
          {d.news2.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : (
        <p className="story">
          {d.reason}. {d.instruction}.
        </p>
      )}
      <div className="actions">
        {src.inject && (
          <button disabled={p.injected} onClick={() => injectDeterioration(s, src, id)}>
            {p.injected ? "Deteriorating" : "Start deterioration"}
          </button>
        )}
        {p.patch ? (
          <button onClick={() => detachPatch(s, id)}>Detach patch</button>
        ) : (
          <button disabled={patchRequested} onClick={() => applyPatch(s, id)}>
            {patchRequested ? "Nurse on the way" : "Apply patch"}
          </button>
        )}
      </div>
      {p.bp === null && <BpForm key={id} s={s} src={src} p={p} />}
    </div>
  );
}

function PipelineTab({ s, src }: { s: Sim; src: VitalsSource }) {
  const patched = s.patients.filter((p) => p.patch).length;
  const ranked = s.patients.filter((p) => p.rank !== null).length;
  const stages: [string, string, string][] = [
    [
      src.synthetic ? "Chest patch" : "Bedside monitor",
      src.synthetic
        ? "HR, RR, SpO2 and temperature. One sample a minute here."
        : "Stands in for the patch. HR, RR and SpO2 every 5 minutes. Temperature is charted.",
      `${patched} of ${s.patients.length} on`,
    ],
    ["Ward gateway", "BLE from the patch, then the edge server.", `${s.counts.received} received`],
    [
      "Quality gate",
      src.synthetic
        ? "Demo rule: 15-minute median of 8 or more usable readings."
        : "Demo rule: 15-minute median of 2 of 3 readings. Temperature holds 8 hours.",
      `${s.counts.rejected} rejected`,
    ],
    ["NEWS2", "Tier A. Any missing input abstains. Nothing is imputed.", `${s.counts.abstained} abstained`],
    ["Arbiter", "The only stage that changes priority.", `${ranked} ranked, ${s.patients.length - ranked} not`],
    ["Ward list", "Ranks and displays. A human decides.", `${s.tasks.length} queued`],
  ];
  return (
    <div className="scroll">
      <ol className="stages">
        {stages.map(([name, text, count], i) => (
          <li key={name}>
            <span className="rank">{i + 1}</span>
            <div>
              <b>{name}</b>
              <p>{text}</p>
            </div>
            <span className="mono">{count}</span>
          </li>
        ))}
      </ol>
      <p className="story">
        The patch, gateway and edge server are the described design. None of that hardware is built
        yet. NEWS2 and the arbiter here are ported from BioSentry.
      </p>
      <ul className="key">
        <li><i style={{ background: "#4ECDC4" }} /> Sample scored and ranked</li>
        <li><i style={{ background: "#FF6B6B" }} /> Sample rejected at the gate</li>
        <li><i style={{ background: "#A899B5" }} /> NEWS2 abstained</li>
      </ul>
    </div>
  );
}

function LogTab({ s, src }: { s: Sim; src: VitalsSource }) {
  return (
    <div className="scroll">
      {s.log.length === 0 && <p className="empty">Nothing yet.</p>}
      <ol className="log">
        {[...s.log].reverse().map((line, i) => (
          <li key={s.log.length - i}>
            <span className="mono">{clockText(src, line.minute)}</span> {line.text}
          </li>
        ))}
      </ol>
    </div>
  );
}

const TABS: [Tab, string][] = [
  ["ranked", "Ranked"],
  ["chart", "Chart"],
  ["pipeline", "Pipeline"],
  ["log", "Log"],
];

export function CommandCenter({
  s,
  src,
  tab,
  setTab,
  selected,
  onSelect,
}: {
  s: Sim;
  src: VitalsSource;
  tab: Tab;
  setTab: (tab: Tab) => void;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="panel command">
      <h2 className="ptitle">Command center</h2>
      <div className="tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "on" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "ranked" && <RankedTab s={s} selected={selected} onSelect={onSelect} />}
      {tab === "chart" && <ChartTab s={s} src={src} id={selected} />}
      {tab === "pipeline" && <PipelineTab s={s} src={src} />}
      {tab === "log" && <LogTab s={s} src={src} />}
    </aside>
  );
}

const portraits = new Map<string, string>();

function portrait(id: string) {
  if (!portraits.has(id)) portraits.set(id, sprite(PORTRAIT, STAFF_PALETTES[id]).toDataURL());
  return portraits.get(id)!;
}

export function StaffStrip({ s }: { s: Sim }) {
  return (
    <section className="strip" aria-label="Staff">
      {s.staff.map((m) => {
        const { chip, text } = staffStatus(s, m);
        const queued = s.tasks.filter((t) => t.rn === m.id).length;
        return (
          <article key={m.id} className="card">
            <img src={portrait(m.id)} alt="" />
            <div>
              <div className="cname">
                <b>{m.name}</b>
                <span className="chip">
                  <i style={{ background: CHIP_COLOURS[chip] }} />
                  {chip}
                </span>
              </div>
              <p className="mono">
                {m.title}
                {queued > 0 ? ` · ${queued} queued` : ""}
              </p>
              <p className="task">{text}</p>
            </div>
          </article>
        );
      })}
    </section>
  );
}
