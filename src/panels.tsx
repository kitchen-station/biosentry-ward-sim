import { useState, type FormEvent } from "react";
import { Sparkline } from "./chart";
import { EcgStrip } from "./ecg";
import { explain } from "./explain";
import { PORTRAIT, STAFF_PALETTES, sprite } from "./render/sprites";
import { CHIP_COLOURS, RISK_LIGHT } from "./render/draw";
import {
  applyPatch,
  detachPatch,
  injectDeterioration,
  startArrhythmia,
  minuteOf,
  recordBp,
  setSpeed,
  staffStatus,
  vitalQuality,
  type Patient,
  type Sim,
  type Speed,
  type Staff,
} from "./sim/sim";
import type { Vital, VitalsSource } from "./sim/source";

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

function RankedList({
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
    <>
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
    </>
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
    <div className="vital" title={source}>
      <div className="vhead">
        <span>{label}</span>
        {quality !== "ok" && <span className="pill">{quality}</span>}
      </div>
      <span className="vnum">
        {value}
        <small>{unit}</small>
      </span>
      <Sparkline data={data} height={22} />
      <div className="prov">{at}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="vital">
      <div className="vhead">{label}</div>
      <span className="vnum">{value}</span>
    </div>
  );
}

/** Only the log lines that name this person. */
function Activity({ s, src, name }: { s: Sim; src: VitalsSource; name: string }) {
  const lines = s.log.filter((line) => line.text.includes(name)).slice(-5).reverse();
  if (lines.length === 0) return null;
  return (
    <>
      <h3>Recent activity</h3>
      <ol className="log">
        {lines.map((line, i) => (
          <li key={i}>
            <span className="mono">{clockText(src, line.minute)}</span> {line.text}
          </li>
        ))}
      </ol>
    </>
  );
}

const RISK_WORDS: Record<string, string> = {
  low: "Low risk",
  low_medium: "Low-medium risk",
  medium: "Medium risk",
  high: "High risk",
};

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

function PatientPanel({ s, src, p }: { s: Sim; src: VitalsSource; p: Patient }) {
  const id = p.id;
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
    <>
      <div className="chead">
        <div>
          <h2>{p.name}</h2>
          <p className="mono">
            Bed {p.bed} · {p.age} {p.sex}
          </p>
          <p className="mono">
            {d.kind === "ranked" ? `${RISK_WORDS[d.news2.risk]} · Rank ${p.rank}` : "Not ranked"}
            {p.trend === "insufficient" ? "" : ` · ${p.trend}`}
          </p>
        </div>
        <div className="big">
          {d.kind === "ranked" ? d.news2.total : "--"}
          <small>NEWS2</small>
        </div>
      </div>
      <div className="explain">
        <p>{explain(p)}</p>
      </div>
      <p className="story">{p.context}. {p.story}.</p>
      <div className="vitals">
        {device("heart_rate", "Heart rate", "/min")}
        {device("respiratory_rate", "Resp. rate", "/min")}
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
      <div className="actions">
        {src.inject && (
          <button disabled={p.injected} onClick={() => injectDeterioration(s, src, id)}>
            {p.injected ? "Deteriorating" : "Start deterioration"}
          </button>
        )}
        {src.startAf && (
          <button disabled={p.irregular} onClick={() => startArrhythmia(s, src, id)}>
            {p.irregular ? "In AF" : "Start AF"}
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
      <Activity s={s} src={src} name={p.name} />
      <details>
        <summary>ECG and score details</summary>
        <div className="vital">
          <div className="vhead">
            <span>ECG, lead II</span>
            <span className="pill">illustrative</span>
          </div>
          {src.synthetic ? (
            <>
              <EcgStrip
                hr={p.patch && vitalQuality(p, "heart_rate", minute) !== "missing" ? p.held.heart_rate : null}
                clockS={s.clockS}
                irregular={p.irregular}
                ectopyPerHour={p.ectopyPerHour}
              />
              <div className="prov">
                Waveform drawn from the heart rate{p.irregular ? ", AF" : ""}; beat timing fitted to real labelled
                ECGs. Nothing here analyses it.
              </div>
            </>
          ) : (
            <div className="prov">The eICU demo has no waveforms, so no strip is drawn.</div>
          )}
        </div>
        <p className="second mono">
          ACVPU {p.consciousness}
          {src.synthetic ? "" : " (from GCS)"} · {p.onOxygen ? "On oxygen" : "Room air"} · Scale {p.spo2Scale} · Signal{" "}
          {Math.round((100 * p.signal.reduce((a, b) => a + b, 0)) / Math.max(1, p.signal.length))}%
        </p>
        {d.kind === "ranked" && (
          <ul className="reasons">
            {d.news2.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        <div className="prov">The summary at the top is a fixed template standing in for the planned explainer agent. It does not rank.</div>
      </details>
    </>
  );
}

export const MACHINE_NAMES: Record<string, string> = {
  gateway: "Ward gateway",
  gate: "Quality gate",
  news2: "NEWS2",
  arbiter: "Escalation arbiter",
  screen: "Ward list",
};

function MachinePanel({
  s,
  src,
  id,
  selected,
  onSelect,
}: {
  s: Sim;
  src: VitalsSource;
  id: string;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { received, rejected, abstained } = s.counts;
  const patched = s.patients.filter((p) => p.patch).length;
  const ranked = s.patients.filter((p) => p.rank !== null).length;
  // Build status as the Kitchen BioSentry page states it.
  const info: Record<string, { status: string; text: string; stats: [string, string | number][] }> = {
    gateway: {
      status: "Planned",
      text: "Receives BLE from each patch and sends it on through IoT Device Access.",
      stats: [["Samples received", received], ["Patches on", `${patched} of ${s.patients.length}`]],
    },
    gate: {
      status: "Demo rule",
      text: src.synthetic
        ? "Stands in for the planned signal-quality model: 15-minute median of 8 or more usable readings."
        : "Stands in for the planned signal-quality model: 2 of 3 readings, temperature holds 8 hours.",
      stats: [["Rejected", rejected], ["Passed", `${Math.round((100 * (received - rejected)) / Math.max(1, received))}%`]],
    },
    news2: {
      status: "Built",
      text: "Runs on the ward edge server. Any missing input abstains. Nothing is imputed.",
      stats: [["Scored", received - rejected - abstained], ["Abstained", abstained]],
    },
    arbiter: {
      status: "Built",
      text: "Runs on the ward edge server. The only step that changes priority.",
      stats: [["Ranked", ranked], ["Not ranked", s.patients.length - ranked]],
    },
    screen: {
      status: "Built",
      text: "One ranked list per clinician. A human decides. Click a row to go to that patient.",
      stats: [["Ranked", ranked], ["Tasks queued", s.tasks.length]],
    },
  };
  const { status, text, stats } = info[id];
  return (
    <>
      <div className="chead">
        <h2>{MACHINE_NAMES[id]}</h2>
        <span className="pill">{status}</span>
      </div>
      <p className="story">{text}</p>
      <div className="vitals">
        {stats.map(([label, value]) => (
          <Stat key={label} label={label} value={value} />
        ))}
      </div>
      {id === "screen" && (
        <>
          <h3>Ranked patients</h3>
          <RankedList s={s} selected={selected} onSelect={onSelect} />
        </>
      )}
    </>
  );
}

const portraits = new Map<string, string>();

function portrait(id: string) {
  if (!portraits.has(id)) portraits.set(id, sprite(PORTRAIT, STAFF_PALETTES[id]).toDataURL());
  return portraits.get(id)!;
}

function StaffPanel({ s, src, m }: { s: Sim; src: VitalsSource; m: Staff }) {
  const { chip, text } = staffStatus(s, m);
  const queued = s.tasks.filter((t) => t.rn === m.id).length;
  return (
    <>
      <div className="chead staff">
        <img src={portrait(m.id)} alt="" />
        <div>
          <h2>{m.name}</h2>
          <p className="mono">{m.title}</p>
          <span className="chip">
            <i style={{ background: CHIP_COLOURS[chip] }} />
            {chip}
          </span>
        </div>
      </div>
      <div className="explain">
        <p>{text}</p>
      </div>
      <div className="vitals">
        <Stat label="Tasks queued" value={queued} />
      </div>
      <Activity s={s} src={src} name={m.name} />
    </>
  );
}

export function Inspector({
  s,
  src,
  selected,
  onSelect,
}: {
  s: Sim;
  src: VitalsSource;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  if (selected === null) {
    return (
      <aside className="panel command">
        <h2 className="ptitle">Click anything on the ward</h2>
        <p className="story">A bed, a person or a machine. It zooms in and its details show here.</p>
        <ul className="key">
          {Object.entries(RISK_WORDS).map(([risk, word]) => (
            <li key={risk}>
              <i style={{ background: RISK_LIGHT[risk] }} /> {word}
            </li>
          ))}
          <li>
            <i style={{ background: "#A899B5" }} /> Not ranked (NR)
          </li>
        </ul>
      </aside>
    );
  }
  const patient = s.patients.find((p) => p.id === selected);
  const staff = s.staff.find((m) => m.id === selected);
  return (
    <aside className="panel command">
      <button onClick={() => onSelect(null)}>Back to full ward</button>
      <div className="scroll">
        {patient ? (
          <PatientPanel s={s} src={src} p={patient} />
        ) : staff ? (
          <StaffPanel s={s} src={src} m={staff} />
        ) : selected in MACHINE_NAMES ? (
          <MachinePanel s={s} src={src} id={selected} selected={selected} onSelect={onSelect} />
        ) : (
          <p className="empty">This patient has left the ward.</p>
        )}
      </div>
    </aside>
  );
}

/** The canvas cannot take focus per item, so keyboard users pick from these. Hidden until focused. */
export function SelectList({ s, onSelect }: { s: Sim; onSelect: (id: string) => void }) {
  const targets: [string, string][] = [
    ...s.patients.map((p): [string, string] => [p.id, `${p.name}, bed ${p.bed}`]),
    ...s.staff.map((m): [string, string] => [m.id, m.name]),
    ...Object.entries(MACHINE_NAMES),
  ];
  return (
    <ul className="sr" aria-label="Select on the ward">
      {targets.map(([id, name]) => (
        <li key={id}>
          <button onClick={() => onSelect(id)}>{name}</button>
        </li>
      ))}
    </ul>
  );
}
