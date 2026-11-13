import { useEffect, useRef, useState, type FormEvent } from "react";
import { Flip } from "./flip";
import { Sparkline } from "./chart";
import { EcgStrip } from "./ecg";
import { explain } from "./explain";
import { floorSummary, type FloorSummary } from "./building";
import { HospitalPanel, isHospitalId, W4HospitalSections } from "./hospital-panels";
import { PORTRAIT, STAFF_PALETTES, sprite } from "./render/sprites";
import { CHIP_COLOURS, RISK_LIGHT } from "./render/draw";
import type { CommandBody } from "./sim/commands";
import { PageNav } from "./nav";
import { BEDS } from "./sim/map";
import {
  applyPatch,
  detachPatch,
  flowStats,
  injectDeterioration,
  startArrhythmia,
  minuteOf,
  recordBp,
  setSpeed,
  skipDay,
  staffStatus,
  vitalQuality,
  type Patient,
  type Sim,
  type Speed,
  type Staff,
  type Stay,
  type StayOutcome,
} from "./sim/sim";
import type { Vital, VitalsSource } from "./sim/source";

/** The build draws the headless runner's ward from this API and changes nothing on it. */
export const VIEW_API: string | undefined = import.meta.env.VITE_VIEW_API_URL;

const SPEEDS: Speed[] = [0, 1, 10, 60];
const SYSTOLIC_BOUNDS = { min: 20, max: 300 };
const DIASTOLIC_BOUNDS = { min: 10, max: 200 };

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** Synthetic runs from 15:00 in Manila. A de-identified dataset has no dates, so it shows elapsed time. */
export function clockText(src: VitalsSource, minute: number) {
  if (src.synthetic) return hhmm((15 * 60 + minute) % (24 * 60));
  return `${minute < 0 ? "-" : "+"}${hhmm(Math.abs(minute))}`;
}

const dateText = (minute: number) =>
  new Date(Date.UTC(2026, 8, 3, 15, minute)).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

const stamp = (src: VitalsSource, minute: number) =>
  src.synthetic ? `${dateText(minute)}, ${clockText(src, minute)}` : clockText(src, minute);

/** Exported for the test: 5d 3h, 3h 5m or 12m. */
export function duration(minutes: number) {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

const stayLength = (stay: Stay, minute: number) =>
  `${stay.inMin === 0 ? "at least " : ""}${duration((stay.outMin ?? minute) - stay.inMin)}`;

const OUTCOME: Record<StayOutcome, string> = { discharged: "Discharged", higher_care: "Moved to higher care" };

function vitalText(p: Patient, v: Vital, minute: number, digits = 0) {
  const held = p.held[v];
  return held === null || vitalQuality(p, v, minute) === "missing" ? "--" : held.toFixed(digits);
}

const bpText = (p: Patient) => (p.bp ? `${p.bp.systolic}/${p.bp.diastolic}` : "--");

/** Sets the whole second each frame. Only this component re-renders. Seconds never flip; the date and hour do.
 *  The minute flips only at 10x or slower: at 60x it changes every second. */
function Clock({ src, read, speed }: { src: VitalsSource; read: () => number; speed: number }) {
  const readRef = useRef(read);
  readRef.current = read;
  const [sec, setSec] = useState(() => Math.floor(read()));
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setSec(Math.floor(readRef.current()));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const minute = Math.floor(sec / 60);
  const [hour, min] = clockText(src, minute).split(":");
  const ss = String(((sec % 60) + 60) % 60).padStart(2, "0");
  return (
    <span className="clock">
      {src.synthetic && (
        <>
          <Flip value={`${dateText(minute)} 2026`} />,{" "}
        </>
      )}
      <Flip value={hour} />:{speed > 10 ? min : <Flip value={min} />}:{ss}
      {src.synthetic && " Manila"}
    </span>
  );
}

export function TopBar({
  s,
  src,
  notice,
  onSignIn,
  onReset,
  onSpeed,
  hospital,
  readClock,
}: {
  s: Sim;
  src: VitalsSource;
  /** Viewer mode: the clock runs on between reads (see clock.ts). Left out, the clock reads the sim itself. */
  readClock?: () => number;
  notice: string | null;
  /** Watching with no token: a pill and a button that opens the sign-in form. */
  onSignIn?: () => void;
  /** Left out in viewer mode unless the clinician may control the runner's ward, which has no clock of its own here. */
  onReset?: () => void;
  /** Viewer mode: the speed is asked of the runner, not set here. */
  onSpeed?: (speed: Speed) => void;
  /** Hospital world only: the scenario picker and +1 day. Floor choice and zoom live on the stage. */
  hospital?: { skipping: boolean; onSkip: () => void; scenario: string; scenarios: string[]; onScenario: (name: string) => void };
}) {
  return (
    <header className="topbar">
      <h1>BioSentry ward sim</h1>
      <PageNav page="simulation" />
      <span className="pill">{hospital ? "Hospital" : "W4"}</span>
      <Clock src={src} speed={s.speed} read={readClock ?? (() => s.clockS)} />
      <span className="pill" title="Simulation speed">
        {s.speed === 0 ? "Paused" : `${s.speed}x`}
      </span>
      {notice && (
        <span className="pill solid" role="status">
          {notice}
        </span>
      )}
      {s.ended && <span className="pill solid">Run ended</span>}
      {onSignIn && (
        <>
          <span className="pill">Watching, read-only</span>
          <button onClick={onSignIn}>Sign in to control</button>
        </>
      )}
      {hospital && (
        <>
          <select aria-label="Scenario" value={hospital.scenario} onChange={(e) => hospital.onScenario(e.target.value)}>
            {hospital.scenarios.map((n) => <option key={n}>{n}</option>)}
          </select>
          <button disabled={hospital.skipping || s.ended} onClick={hospital.onSkip}>{hospital.skipping ? "skipping…" : "+1 day"}</button>
        </>
      )}
      {onReset && (
        <div className="speeds right" role="group" aria-label="Simulation speed">
          {SPEEDS.map((speed) => (
            <button
              key={speed}
              className={s.speed === speed ? "on" : ""}
              aria-pressed={s.speed === speed}
              disabled={hospital?.skipping}
              onClick={() => (onSpeed ? onSpeed(speed) : setSpeed(s, speed))}
            >
              {speed === 0 ? "Pause" : `${speed}x`}
            </button>
          ))}
          <button onClick={onReset}>Reset</button>
        </div>
      )}
    </header>
  );
}

/** The view's own zoom, on the stage. Display only: it never reaches the sim. */
export function ZoomBar({ pct, onZoom, disabled }: { pct: number; onZoom: (action: "in" | "out" | "fit") => void; disabled?: boolean }) {
  return (
    <div className="stagebar zoombar" role="group" aria-label="Zoom">
      <button aria-label="Zoom out" title="Zoom out (-)" disabled={disabled} onClick={() => onZoom("out")}>-</button>
      <span className="zoompct">{pct}%</span>
      <button aria-label="Zoom in" title="Zoom in (+)" disabled={disabled} onClick={() => onZoom("in")}>+</button>
      <button title="Fit: back to 100% (0)" disabled={disabled} onClick={() => onZoom("fit")}>Fit</button>
    </div>
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
        <span className="rank"><Flip value={p.rank ?? ""} /></span>
        <span className="who">
          <b>{p.name}</b> <span className="mono">{p.bed}</span>
        </span>
        <span className="score">
          <Flip value={d.news2.total} />
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

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="vital">
      <div className="vhead">{label}</div>
      <span className="vnum"><Flip value={value} /></span>
    </div>
  );
}

function Activity({ src, lines }: { src: VitalsSource; lines: { minute: number; text: string }[] }) {
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

function StayScores({ stay }: { stay: Stay }) {
  if (stay.scores.length < 2) return null;
  return (
    <div className="vital">
      <div className="vhead">
        <span>NEWS2 across the stay</span>
        <span>peak {stay.peak ?? "--"}</span>
      </div>
      <Sparkline data={stay.scores} width={290} height={30} />
    </div>
  );
}

function StayRows({
  s,
  src,
  stays,
  onSelect,
}: {
  s: Sim;
  src: VitalsSource;
  stays: Stay[];
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="list">
      {stays.map((stay) => (
        <li key={stay.id}>
          <button className="row" onClick={() => onSelect(stay.id)}>
            <span className="rank small">{stay.peak ?? "--"}</span>
            <span className="who">
              <b>{stay.name}</b>
            </span>
            <span className="why">
              {stamp(src, stay.outMin ?? stay.inMin)} · {stayLength(stay, minuteOf(s))}
              {stay.outcome ? ` · ${OUTCOME[stay.outcome]}` : " · on the ward"}
            </span>
          </button>
        </li>
      ))}
    </ul>
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

function PatientPanel({ s, src, p, send }: { s: Sim; src: VitalsSource; p: Patient; send?: (body: CommandBody) => void }) {
  const id = p.id;
  const minute = minuteOf(s);
  const d = p.decision;
  const origin = src.synthetic ? "synthetic" : "dataset";
  const when = (at: number | null) => (at === null ? "no reading" : clockText(src, at));
  const device = (v: Vital, label: string, unit: string, digits = 0) => (
    <VitalCard
      label={label}
      value={vitalText(p, v, minute, digits)}
      unit={unit}
      source={`${src.rules.charted.includes(v) ? "charted" : "device"} · ${origin}`}
      at={when(p.heldAt[v])}
      quality={vitalQuality(p, v, minute)}
      data={p.history[v]}
    />
  );
  const patchRequested = s.tasks.some((t) => t.patient === id && t.kind === "apply_patch") ||
    s.staff.some((m) => m.task?.patient === id && m.task.kind === "apply_patch");
  // Viewer mode with control: each button asks the runner and shows the ward as it publishes it.
  const ask = (kind: CommandBody["kind"], local: () => void) => () => (send ? send({ kind, patient_id: id, speed: null }) : local());
  return (
    <>
      <div className="chead">
        <div>
          <h2>{p.name}</h2>
          <p className="mono">
            Bed {p.bed} · {p.age} {p.sex}
          </p>
          <p className="mono">
            <Flip value={`${d.kind === "ranked" ? `${RISK_WORDS[d.news2.risk]} · Rank ${p.rank}` : "Not ranked"}${p.trend === "insufficient" ? "" : ` · ${p.trend}`}`} />
          </p>
          <p className="mono">In for {stayLength(p.stay, minute)}</p>
        </div>
        <div className="big">
          <Flip value={d.kind === "ranked" ? d.news2.total : "--"} />
          <small>NEWS2</small>
        </div>
      </div>
      <div className="explain">
        <p>{explain(p)}</p>
      </div>
      <p className="story">{p.context}. {p.story}.</p>
      <StayScores stay={p.stay} />
      <div className="vitals">
        {device("heart_rate", "Heart rate", "/min")}
        {device("respiratory_rate", "Resp. rate", "/min")}
        {device("spo2", "SpO2", "%")}
        {device("temperature", "Temperature", "°C", 1)}
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
      <div className="actions">
        {(src.inject || send) && (
          <button disabled={p.injected} onClick={ask("inject_deterioration", () => injectDeterioration(s, src, id))}>
            {p.injected ? "Deteriorating" : "Start deterioration"}
          </button>
        )}
        {(src.startAf || send) && (
          <button disabled={p.irregular} onClick={ask("start_arrhythmia", () => startArrhythmia(s, src, id))}>
            {p.irregular ? "In AF" : "Start AF"}
          </button>
        )}
        {VIEW_API && !send ? null : p.patch ? (
          <button onClick={ask("detach_patch", () => detachPatch(s, id))}>Detach patch</button>
        ) : (
          <button disabled={patchRequested} onClick={ask("apply_patch", () => applyPatch(s, id))}>
            {patchRequested ? "Nurse on the way" : "Apply patch"}
          </button>
        )}
      </div>
      {!VIEW_API && p.bp === null && <BpForm key={id} s={s} src={src} p={p} />}
      <Activity src={src} lines={p.stay.events.slice(-5).reverse()} />
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
            <div className="prov">This source has no waveforms, so no strip is drawn.</div>
          )}
        </div>
        <p className="second mono">
          ACVPU {p.consciousness} · {p.onOxygen ? "On oxygen" : "Room air"} · Scale {p.spo2Scale} · Signal{" "}
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
  entrance: "Entrance",
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

function StayPanel({ s, src, stay }: { s: Sim; src: VitalsSource; stay: Stay }) {
  return (
    <>
      <div className="chead">
        <div>
          <h2>{stay.name}</h2>
          <p className="mono">Bed {stay.bed}</p>
        </div>
        {stay.outcome && <span className="pill">Left the ward</span>}
      </div>
      <div className="explain">
        <p>{stay.outcome ? OUTCOME[stay.outcome] : "On the ward"}</p>
      </div>
      {stay.context && <p className="story">{stay.context}.</p>}
      <div className="vitals">
        <Stat label="Arrived" value={stay.inMin === 0 ? "Before sim" : stamp(src, stay.inMin)} />
        <Stat label="Left" value={stay.outMin === null ? "--" : stamp(src, stay.outMin)} />
        <Stat label="Length of stay" value={stayLength(stay, minuteOf(s))} />
        <Stat label="Peak NEWS2" value={stay.peak ?? "--"} />
      </div>
      <StayScores stay={stay} />
      <Activity src={src} lines={[...stay.events].reverse().slice(0, 10)} />
    </>
  );
}

function EmptyBedPanel({
  s,
  src,
  bed,
  onSelect,
}: {
  s: Sim;
  src: VitalsSource;
  bed: string;
  onSelect: (id: string) => void;
}) {
  const past = s.stays.filter((x) => x.bed === bed && x.outMin !== null).reverse();
  return (
    <>
      <div className="chead">
        <h2>Bed {bed}</h2>
        <span className="pill">Empty</span>
      </div>
      <div className="vitals">
        <Stat label="Empty for" value={past.length ? duration(minuteOf(s) - past[0].outMin!) : "Since start"} />
        <Stat label="Past stays" value={past.length} />
      </div>
      {past.length > 0 && (
        <>
          <h3>Who was here</h3>
          <StayRows s={s} src={src} stays={past.slice(0, 10)} onSelect={onSelect} />
        </>
      )}
    </>
  );
}

function EntrancePanel({
  s,
  src,
  onSelect,
  onTimeline,
}: {
  s: Sim;
  src: VitalsSource;
  onSelect: (id: string) => void;
  onTimeline: () => void;
}) {
  const stats = flowStats(s);
  // A stay shows once, at its latest move.
  const recent = s.stays
    .filter((x) => x.inMin > 0 || x.outMin !== null)
    .sort((a, b) => (b.outMin ?? b.inMin) - (a.outMin ?? a.inMin))
    .slice(0, 12);
  return (
    <>
      <div className="chead">
        <h2>Entrance</h2>
      </div>
      <p className="story">Everyone who comes onto or leaves the ward passes through here.</p>
      <div className="vitals">
        <Stat label="In, last 24 h" value={stats.in24h} />
        <Stat label="Out, last 24 h" value={stats.out24h} />
        <Stat label="Beds in use" value={`${stats.occupied} of ${stats.beds}`} />
        <Stat label="Average stay" value={stats.averageStayMin === null ? "--" : duration(stats.averageStayMin)} />
      </div>
      <div className="actions">
        <button onClick={onTimeline}>Bed timeline</button>
        {/* A day at once would overflow the queue to the database. */}
        {src.admit && !s.outbox && <button onClick={() => skipDay(s, src)}>Skip 1 day</button>}
      </div>
      <h3>Who came and went</h3>
      {recent.length === 0 ? (
        <p className="empty">Nobody yet.{VIEW_API ? "" : " Stays last days: try Skip 1 day."}</p>
      ) : (
        <StayRows s={s} src={src} stays={recent} onSelect={onSelect} />
      )}
    </>
  );
}

const TIMELINE_MIN_DAYS = 3;
const TIMELINE_MAX_DAYS = 14;

/** One row per bed, one bar per stay, over the last days of the run. */
export function BedTimeline({
  s,
  src,
  onSelect,
  onClose,
}: {
  s: Sim;
  src: VitalsSource;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const minute = minuteOf(s);
  const span = Math.max(TIMELINE_MIN_DAYS, Math.min(TIMELINE_MAX_DAYS, Math.ceil(minute / 1440))) * 1440;
  const from = Math.max(0, minute - span);
  const pct = (m: number) => `${((m - from) / span) * 100}%`;
  const ticks: number[] = [];
  // Midnight in sim time: minute 0 is 15:00.
  for (let t = 540; t <= from + span; t += 1440) if (t >= from) ticks.push(t);
  return (
    <div className="timeline">
      <div className="chead">
        <h2>Bed timeline</h2>
        <button onClick={onClose}>Back to ward</button>
      </div>
      <div className="trow ticks">
        <span />
        <div className="track">
          {ticks.map((t) => (
            <span key={t} style={{ left: pct(t) }}>
              {src.synthetic ? dateText(t) : clockText(src, t)}
            </span>
          ))}
        </div>
      </div>
      <div className="trows">
        {BEDS.map((bed) => (
          <div className="trow" key={bed.label}>
            <span className="mono">{bed.label}</span>
            <div className="track">
              {s.stays
                .filter((x) => x.bed === bed.label && (x.outMin ?? minute) > from)
                .map((x) => {
                  const start = Math.max(x.inMin, from);
                  const text = `${x.name}, ${stayLength(x, minute)}, ${x.outcome ? OUTCOME[x.outcome] : "on the ward"}`;
                  return (
                    <button
                      key={x.id}
                      className={`bar${x.outcome === null ? " open" : ""}${x.outcome === "higher_care" ? " care" : ""}`}
                      style={{
                        left: pct(start),
                        width: pct(from + (x.outMin ?? minute) - start),
                        background: x.peakRisk ? RISK_LIGHT[x.peakRisk] : "#A899B5",
                      }}
                      title={text}
                      aria-label={text}
                      onClick={() => onSelect(x.id)}
                    >
                      {x.name.split(",")[0]}
                    </button>
                  );
                })}
            </div>
          </div>
        ))}
      </div>
      <p className="prov">Colour is the worst risk in that stay. Dashed edge: still on the ward. Thick border: moved to higher care.</p>
    </div>
  );
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
            <Flip value={chip} />
          </span>
        </div>
      </div>
      <div className="explain">
        <p>{text}</p>
      </div>
      <div className="vitals">
        <Stat label="Tasks queued" value={queued} />
      </div>
      <Activity src={src} lines={s.log.filter((line) => line.text.includes(m.name)).slice(-5).reverse()} />
    </>
  );
}

export function Inspector({
  s,
  src,
  selected,
  onSelect,
  onTimeline,
  floors,
  building = false,
  send,
  watching = false,
}: {
  s: Sim;
  src: VitalsSource;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onTimeline: () => void;
  floors?: FloorSummary[];
  building?: boolean; // the hospital seen from outside: no floor is out yet
  send?: (body: CommandBody) => void; // viewer mode with control: a patient's buttons ask the runner
  watching?: boolean; // no token: the legend only
}) {
  if (selected === null) {
    return (
      <aside className="panel command">
        {watching ? (
          <>
            <h2 className="ptitle">Watching W4</h2>
            <p className="story">Read-only. Sign in to control.</p>
          </>
        ) : building ? (
          <>
            <h2 className="ptitle">Pick a floor of the hospital</h2>
            <p className="story">Click a storey of the building, its sign or a floor button. The building opens up so you can see inside.</p>
          </>
        ) : (
          <>
            <h2 className="ptitle">Click anything on the ward</h2>
            <p className="story">A bed, a person or a machine. It zooms in and its details show here. Click ENTRANCE to see who came and went.</p>
          </>
        )}
        <ul className="key">
          {Object.entries(RISK_WORDS).map(([risk, word]) => (
            <li key={risk}>
              <i style={{ background: RISK_LIGHT[risk] }} /> {word}
            </li>
          ))}
          {!watching && (
            <li>
              <i style={{ background: "#A899B5" }} /> Not ranked (NR)
            </li>
          )}
        </ul>
      </aside>
    );
  }
  const bed = selected.startsWith("bed:") ? selected.slice(4) : null;
  // An empty bed that has since filled shows its new patient.
  const patient = s.patients.find((p) => p.id === selected || p.bed === bed);
  const stay = s.stays.find((x) => x.id === selected);
  const staff = s.staff.find((m) => m.id === selected);
  return (
    <aside className="panel command">
      <button onClick={() => onSelect(null)}>{s.hospital ? "Back to floor" : "Back to full ward"}</button>
      <div className="scroll">
        {s.hospital && isHospitalId(selected) ? (
          <HospitalPanel h={s.hospital} id={selected} onSelect={onSelect} floors={floors ?? floorSummary(s.hospital)} />
        ) : patient ? (
          <>
            <PatientPanel s={s} src={src} p={patient} send={send} />
            <W4HospitalSections s={s} p={patient} onSelect={onSelect} />
          </>
        ) : staff ? (
          <StaffPanel s={s} src={src} m={staff} />
        ) : stay ? (
          <StayPanel s={s} src={src} stay={stay} />
        ) : bed && s.occupied?.includes(bed) ? (
          <>
            <div className="chead">
              <h2>Bed {bed}</h2>
              <span className="pill">Occupied</span>
            </div>
            <p className="story">Occupied. Not on your list.</p>
          </>
        ) : bed ? (
          <EmptyBedPanel s={s} src={src} bed={bed} onSelect={onSelect} />
        ) : selected === "entrance" ? (
          <EntrancePanel s={s} src={src} onSelect={onSelect} onTimeline={onTimeline} />
        ) : selected in MACHINE_NAMES ? (
          <MachinePanel s={s} src={src} id={selected} selected={selected} onSelect={onSelect} />
        ) : (
          <p className="empty">This stay is too old to be on record.</p>
        )}
      </div>
    </aside>
  );
}

/** The canvas cannot take focus per item, so keyboard users pick from these. Hidden until focused. */
export const selectTargets = (s: Sim): [string, string][] => [
  ...s.patients.map((p): [string, string] => [p.id, `${p.name}, bed ${p.bed}`]),
  ...BEDS.filter((b) => !s.patients.some((p) => p.bed === b.label)).map((b): [string, string] => [`bed:${b.label}`, `${s.occupied?.includes(b.label) ? "Occupied" : "Empty"} bed ${b.label}`]),
  ...s.staff.map((m): [string, string] => [m.id, m.name]),
  ...Object.entries(MACHINE_NAMES),
];

export function SelectList({ s, onSelect }: { s: Sim; onSelect: (id: string) => void }) {
  const targets = selectTargets(s);
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
