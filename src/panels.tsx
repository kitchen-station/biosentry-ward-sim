import { Settings } from "./settings";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Flip } from "./flip";
import { Sparkline } from "./chart";
import { NotRankedRow, RankedRow, RISK_WORDS, VITAL_CARD, VitalCards } from "./vital-cards";
import { EcgStrip } from "./ecg";
import { explain } from "./explain";
import { floorSummary, type FloorSummary } from "./building";
import type { HospitalVitals } from "./sim/hospital/vitals";
import { HospitalPanel, isHospitalId, W4HospitalSections } from "./hospital-panels";
import { PORTRAIT, STAFF_PALETTES, sprite } from "./render/sprites";
import { CHIP_COLOURS, RISK_LIGHT } from "./render/draw";
import { SKIPS, type CommandBody } from "./sim/commands";
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
import type { VitalsSource } from "./sim/source";

export { VITAL_CARD }; // the Analytics page prints the vitals the same way

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

export const stamp = (src: VitalsSource, minute: number) =>
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

/** Sets the whole second each frame. Only this component re-renders. Seconds never flip; the date and hour do.
 *  The minute flips only at 10x or slower: at 60x it changes every second. */
const ICON = (name: string) => <i className={`hw-icon fa-solid ${name}`} aria-hidden="true" />;

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

/** "last 4 · low 1 · high 7 · 12 hourly scores", or that there is none yet. Hours with no score are not counted. */
export function stayNumbers(scores: (number | null)[]): string {
  const v = scores.filter((x): x is number => x !== null);
  return v.length === 0 ? "no score yet" : `last ${v[v.length - 1]} · low ${Math.min(...v)} · high ${Math.max(...v)} · ${v.length} hourly score${v.length === 1 ? "" : "s"}`;
}

type BarProps = {
  s: Sim;
  src: VitalsSource;
  /** Signed in with the admin role: the bar says so, and that the view is read-only. */
  admin?: boolean;
  /** Watching the server's run and it is a whole hospital: the bar names the hospital, not ward W4. */
  serverHospital?: boolean;
  /** Viewer mode: the clock runs on between reads (see clock.ts). Left out, the clock reads the sim itself. */
  readClock?: () => number;
  notice: string | null;
  /** Watching with no token: a button that opens the sign-in form. */
  onSignIn?: () => void;
  /** Viewer mode, signed in: drops the token and asks the open route again. */
  onSignOut?: () => void;
  /** Left out in viewer mode unless the clinician may control the runner's ward, which has no clock of its own here. */
  onReset?: () => void;
  /** Viewer mode: the speed is asked of the runner, not set here. */
  onSpeed?: (speed: Speed) => void;
  /** Viewer mode, for a clinician who may control the runner: asks the server to skip ahead. Nothing is stepped in this page. */
  onSkipAhead?: (minutes: number) => void;
  /** Hospital world only: the scenario picker and +1 day. Floor choice and zoom live on the stage. */
  hospital?: { skipping: boolean; onSkip: () => void; scenario: string; scenarios: { id: string; label: string; sentence: string }[]; onScenario: (id: string) => void; seedText: string; onShuffle?: () => void };
};

/** The app bar: what this page is, whether it runs, the clock, and the account. Run controls live on the stage (RunBar). */
export function TopBar({ s, src, notice, onSignIn, onSignOut, hospital, serverHospital = false, admin = false, readClock }: BarProps) {
  const running = s.speed > 0 && !s.ended;
  const mode = admin ? "Hospital admin, read-only" : onSignIn ? "Watching, read-only" : hospital ? "Local simulation" : null;
  const modeTitle = hospital && !admin && !onSignIn ? "This hospital is made up and runs in this page. It is not the server's run." : undefined;
  return (
    <header className="topbar">
      <div className="topinfo">
        <h1>{hospital || serverHospital ? "Hospital" : "Ward W4"}</h1>
        <span className={`hw-tag ${running ? "hw-tag--success" : ""} status`} title={s.speed === 0 ? undefined : `1 minute here is ${s.speed} ${serverHospital ? "hospital" : "ward"} minute${s.speed === 1 ? "" : "s"}`}>
          <span className="dot" data-off={running ? undefined : ""} aria-hidden="true" />
          {s.ended ? "Run ended" : running ? `Running ${s.speed}x` : "Paused"}
        </span>
        <span className="topclock hw-text-muted">
          {serverHospital && <span className="hw-visually-hidden">Server clock </span>}
          <Clock src={src} speed={s.speed} read={readClock ?? (() => s.clockS)} />
        </span>
        {notice && (
          <span className="hw-tag hw-tag--info" role="status">
            {notice}
          </span>
        )}
      </div>
      <div className="topact">
        {mode && <span className="hw-tag" title={modeTitle}>{mode}</span>}
        {onSignIn && <button className="hw-button hw-button--primary hw-button--sm" onClick={onSignIn}>{ICON("fa-right-to-bracket")}Sign in</button>}
        {onSignOut && <button className="hw-button hw-button--sm" onClick={onSignOut}>{ICON("fa-right-from-bracket")}Sign out</button>}
        <Settings />
      </div>
    </header>
  );
}

/** One dock button: icon only, its name in a tooltip on hover and focus (kit tooltip), and as its accessible name. */
function DockButton({ icon, label, pressed, disabled, onClick, children }: { icon?: string; label: string; pressed?: boolean; disabled?: boolean; onClick: () => void; children?: ReactNode }) {
  return (
    <button type="button" className={`hw-button hw-button--sm dock__item${children ? "" : " hw-button--icon"}${pressed ? " hw-button--accent" : ""}`} aria-label={label} aria-pressed={pressed} data-hw-tooltip={label} disabled={disabled} onClick={onClick}>
      {icon && ICON(icon)}
      {children}
    </button>
  );
}

/**
 * The dock: one floating bar at the foot of the stage, like the macOS dock. Scenario and seed (local hospital), speed,
 * skip, reset and the view's zoom. Icon buttons grow a little on hover and name themselves in a tooltip.
 */
export function RunBar({ s, onReset, onSpeed, onSkipAhead, hospital, zoom }: BarProps & { zoom?: { pct: number; onZoom: (action: "in" | "out" | "fit") => void; disabled?: boolean } }) {
  const sep = <span className="dock__sep" aria-hidden="true" />;
  return (
    <div className="dock" role="toolbar" aria-label="Run and view controls">
      {hospital && (
        <>
          <select className="hw-native-select hw-native-select--sm" aria-label="Scenario" data-hw-tooltip={hospital.scenarios.find((n) => n.id === hospital.scenario)?.sentence ?? "Scenario"} value={hospital.scenario} onChange={(e) => hospital.onScenario(e.target.value)}>
            {hospital.scenarios.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
          </select>
          {hospital.onShuffle && <DockButton icon="fa-shuffle" label={`Shuffle: new seed and restart (now ${hospital.seedText})`} disabled={hospital.skipping} onClick={hospital.onShuffle} />}
          <DockButton icon="fa-calendar-plus" label={hospital.skipping ? "Skipping a day" : "Skip one day"} disabled={hospital.skipping || s.ended} onClick={hospital.onSkip} />
          {sep}
        </>
      )}
      {onReset && (
        <>
          <div className="dock__group" role="group" aria-label="Simulation speed">
            {SPEEDS.map((speed) => (
              <DockButton key={speed} icon={speed === 0 ? "fa-pause" : undefined} label={speed === 0 ? "Pause" : `Speed ${speed}x`} pressed={s.speed === speed} disabled={hospital?.skipping} onClick={() => (onSpeed ? onSpeed(speed) : setSpeed(s, speed))}>
                {speed === 0 ? null : `${speed}x`}
              </DockButton>
            ))}
          </div>
          {onSkipAhead && (
            <details className="skipmenu">
              <summary className="hw-button hw-button--sm hw-button--icon dock__item" aria-label="Skip ahead" data-hw-tooltip="Skip ahead: the server moves the whole run">{ICON("fa-forward")}</summary>
              <div role="group" aria-label="Skip ahead">
                {SKIPS.map(([minutes, word]) => (
                  <button className="hw-button hw-button--sm" key={minutes} onClick={(e) => { e.currentTarget.closest("details")!.open = false; onSkipAhead(minutes); }}>{word}</button>
                ))}
              </div>
            </details>
          )}
          <DockButton icon="fa-rotate-left" label="Reset the run" onClick={onReset} />
          {zoom && sep}
        </>
      )}
      {zoom && (
        <div className="dock__group" role="group" aria-label="Zoom">
          <DockButton icon="fa-minus" label="Zoom out (-)" disabled={zoom.disabled} onClick={() => zoom.onZoom("out")} />
          <span className="zoompct">{zoom.pct}%</span>
          <DockButton icon="fa-plus" label="Zoom in (+)" disabled={zoom.disabled} onClick={() => zoom.onZoom("in")} />
          <DockButton icon="fa-expand" label="Fit: back to 100% (0)" disabled={zoom.disabled} onClick={() => zoom.onZoom("fit")} />
        </div>
      )}
    </div>
  );
}

/** The view's own zoom, on the stage. Display only: it never reaches the sim. */
export function ZoomBar({ pct, onZoom, disabled }: { pct: number; onZoom: (action: "in" | "out" | "fit") => void; disabled?: boolean }) {
  return (
    <div className="stagebar zoombar" role="group" aria-label="Zoom">
      <button className="hw-button hw-button--sm" aria-label="Zoom out" title="Zoom out (-)" disabled={disabled} onClick={() => onZoom("out")}>{ICON("fa-minus")}</button>
      <span className="zoompct">{pct}%</span>
      <button className="hw-button hw-button--sm" aria-label="Zoom in" title="Zoom in (+)" disabled={disabled} onClick={() => onZoom("in")}>{ICON("fa-plus")}</button>
      <button className="hw-button hw-button--sm" aria-label="Fit" title="Fit: back to 100% (0)" disabled={disabled} onClick={() => onZoom("fit")}>{ICON("fa-expand")}</button>
    </div>
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
          <NotRankedRow key={p.id} p={p} onSelect={onSelect} selected={p.id === selected} />
        ))}
      </ul>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="vital hw-card hw-card--outlined">
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
      <ol className="hw-timeline evlist">
        {lines.map((line, i) => (
          <li key={i} className="hw-timeline__item">
            <time className="hw-timeline__time">{clockText(src, line.minute)}</time>
            <span className="hw-timeline__text">{line.text}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

function StayScores({ stay }: { stay: Stay }) {
  if (stay.scores.length < 2) return null;
  return (
    <div className="vital hw-card hw-card--outlined">
      <div className="vhead">
        <span>NEWS2 across the stay</span>
        <b>peak {stay.peak ?? "--"}</b>
      </div>
      <div className="spark"><Sparkline data={stay.scores} width={290} height={30} /></div>
      {/* The numbers behind the line, as the unit census prints them: a line with no number says little. */}
      <p className="tiny">{stayNumbers(stay.scores)}</p>
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
          <button className="row hw-card hw-card--interactive" onClick={() => onSelect(stay.id)}>
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
      <div className="hw-field">
        <label className="hw-field__label" htmlFor={`sys-${p.id}`}>Systolic</label>
        <div className="hw-input hw-input--sm"><input className="hw-input__control" id={`sys-${p.id}`} inputMode="numeric" value={systolic} aria-invalid={error ? "true" : "false"} onChange={(e) => setSystolic(e.target.value)} /></div>
      </div>
      <div className="hw-field">
        <label className="hw-field__label" htmlFor={`dia-${p.id}`}>Diastolic</label>
        <div className="hw-input hw-input--sm"><input className="hw-input__control" id={`dia-${p.id}`} inputMode="numeric" value={diastolic} aria-invalid={error ? "true" : "false"} onChange={(e) => setDiastolic(e.target.value)} /></div>
      </div>
      <button className="hw-button hw-button--primary hw-button--sm" type="submit" disabled={pending}>
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
      <VitalCards p={p} minute={minute} charted={src.rules.charted} origin={origin} when={when} />
      <div className="actions">
        {(src.inject || send) && (
          <button className="hw-button hw-button--sm" disabled={p.injected} onClick={ask("inject_deterioration", () => injectDeterioration(s, src, id))}>
            {p.injected ? "Deteriorating" : "Start deterioration"}
          </button>
        )}
        {(src.startAf || send) && (
          <button className="hw-button hw-button--sm" disabled={p.irregular} onClick={ask("start_arrhythmia", () => startArrhythmia(s, src, id))}>
            {p.irregular ? "In AF" : "Start AF"}
          </button>
        )}
        {VIEW_API && !send ? null : p.patch ? (
          <button className="hw-button hw-button--sm" onClick={ask("detach_patch", () => detachPatch(s, id))}>Detach patch</button>
        ) : (
          <button className="hw-button hw-button--sm" disabled={patchRequested} onClick={ask("apply_patch", () => applyPatch(s, id))}>
            {patchRequested ? "Nurse on the way" : "Apply patch"}
          </button>
        )}
      </div>
      {!VIEW_API && p.bp === null && <BpForm key={id} s={s} src={src} p={p} />}
      <Activity src={src} lines={p.stay.events.slice(-5).reverse()} />
      <details>
        <summary>ECG and score details</summary>
        <div className="vital hw-card hw-card--outlined">
          <div className="vhead">
            <span>ECG, lead II</span>
            <span className="hw-tag">illustrative</span>
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
      status: "Stand-in rule",
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
        <span className="hw-tag">{status}</span>
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
        {stay.outcome && <span className="hw-tag">Left the ward</span>}
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
        <span className="hw-tag">Empty</span>
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
        <button className="hw-button hw-button--sm" onClick={onTimeline}>Bed timeline</button>
        {/* A day at once would overflow the queue to the database. */}
        {/* A hospital world is fed after every step, and skipDay steps with no feed: the top bar's +1 day does it. */}
        {src.admit && !s.outbox && !s.hospital && <button className="hw-button hw-button--sm" onClick={() => skipDay(s, src)}>Skip 1 day</button>}
      </div>
      <h3>Who came and went</h3>
      {recent.length === 0 ? (
        <p className="empty">Nobody yet.{VIEW_API || s.hospital ? "" : " Stays last days: try Skip 1 day."}</p>
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
        <button className="hw-button hw-button--sm" onClick={onClose}>Back to ward</button>
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
          {/* Every figure the ward simulates is W4's own staff: the card says the role and the unit. */}
          <p className="mono">{m.title} · Ward W4</p>
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
      <p className="tiny">Staff loop: set by the simulation, not a product feature.</p>
    </>
  );
}

/** The product mark: our own, in every logo slot. */
export function Brand() {
  return (
    <span className="brand">
      <span className="mark" aria-hidden="true"><i className="hw-icon fa-solid fa-heart-pulse" /></span>
      BioSentry
    </span>
  );
}

const VIEW_LINKS = [
  { id: "simulation", label: "Simulation", icon: "fa-hospital" },
  { id: "analytics", label: "Analytics", icon: "fa-chart-line" },
] as const;

/** The view switch: the two pages, as the side nav on a wide screen. The links change the URL hash and nothing else. */
export function ViewNav({ page, brand = true }: { page: "simulation" | "analytics"; brand?: boolean }) {
  return (
    <nav className="hw-sidenav" aria-label="View">
      {brand && <Brand />}
      <p className="hw-sidenav__group">Ward</p>
      {VIEW_LINKS.map((l) => (
        <a key={l.id} className="hw-sidenav__link" href={`#${l.id}`} aria-current={page === l.id ? "page" : undefined}>
          <i className={`hw-icon fa-solid ${l.icon}`} aria-hidden="true" />
          <span className="hw-sidenav__label">{l.label}</span>
        </a>
      ))}
    </nav>
  );
}

/** The same two pages on a phone: an app bar with a menu drawer, and a bottom bar. */
export function PhoneNav({ page }: { page: "simulation" | "analytics" }) {
  const drawer = useRef<HTMLDialogElement>(null);
  return (
    <>
      <header className="hw-appbar hw-only-compact">
        <button className="hw-appbar__action" aria-label="Open menu" onClick={() => drawer.current?.showModal?.()}>
          <i className="hw-icon fa-solid fa-bars" aria-hidden="true" />
        </button>
        <p className="hw-appbar__title">BioSentry</p>
      </header>
      <nav className="hw-bottomnav hw-only-compact" aria-label="Primary">
        {VIEW_LINKS.map((l) => (
          <a key={l.id} className="hw-bottomnav__item" href={`#${l.id}`} aria-current={page === l.id ? "page" : undefined}>
            <span className="hw-bottomnav__icon" aria-hidden="true"><i className={`hw-icon fa-solid ${l.icon}`} /></span>
            {l.label}
          </a>
        ))}
      </nav>
      <dialog className="hw-dialog hw-dialog--nav" ref={drawer} aria-label="Main menu" onClick={(e) => e.target === drawer.current && drawer.current.close()}>
        <ViewNav page={page} />
      </dialog>
    </>
  );
}

/** Top centre of the stage: the place in spaced capitals, and how many people are in it. */
export function StageTitle({ title, count, noun }: { title: string; count: number; noun: string }) {
  return (
    <div className="stagetitle">
      <h2>{title}</h2>
      <span className="hw-tag" role="status">{count} {noun}</span>
    </div>
  );
}

const occupancyTone = (pct: number | null) => (pct === null ? "" : pct >= 90 ? " hw-tag--danger" : pct >= 75 ? " hw-tag--warning" : " hw-tag--success");

/** The building's floors, in the side column. Prev and Next step through them; the open one is marked. */
export function Directory({ floors, view, onView, ward }: { floors: FloorSummary[]; view: number | null; onView: (floor: number | null) => void; ward?: { name: string; count: number; noun: string } }) {
  if (floors.length === 0) {
    return (
      <section className="dir" aria-label="Floors">
        <div className="dirhead"><div><span className="hw-eyebrow">Ward</span><h2>Floors</h2></div></div>
        <div className="dirlist">
          <div className="dirrow" aria-current="true">
            <span className="eyebrow">Ward</span>
            <b>{ward?.name ?? "W4"}</b>
            <span className="hw-tag">{ward?.count ?? 0} {ward?.noun ?? "patients"}</span>
            <span className="sub">single ward | no building</span>
          </div>
        </div>
      </section>
    );
  }
  const items = [
    { floor: null as number | null, eyebrow: "Building", title: "All floors", name: "All floors", tag: String(floors.reduce((n, f) => n + f.census, 0)), tone: "", sub: `${floors.length} floors | roster ${floors.reduce((n, f) => n + f.nurses, 0)}` },
    ...floors.map((f) => ({
      floor: f.floor as number | null, eyebrow: `Floor ${f.label}`, title: f.name, name: `${f.name}: ${f.units.map((u) => u.name).join(" and ")}`,
      tag: f.occupancyPct === null ? `${f.census}` : `${f.occupancyPct}%`, tone: occupancyTone(f.occupancyPct), sub: `roster ${f.nurses} | ${f.census} of ${f.capacity} beds`,
    })),
  ];
  const at = Math.max(0, items.findIndex((i) => i.floor === view));
  const step = (d: number) => onView(items[(at + d + items.length) % items.length].floor);
  return (
    <section className="dir" aria-label="Floors">
      <div className="dirhead">
        <div><span className="hw-eyebrow">Building</span><h2>Floors</h2></div>
        <div className="dirnav">
          <button className="hw-button hw-button--sm" aria-label="Previous floor" onClick={() => step(-1)}>{ICON("fa-chevron-up")}</button>
          <button className="hw-button hw-button--sm" aria-label="Next floor" onClick={() => step(1)}>{ICON("fa-chevron-down")}</button>
        </div>
      </div>
      <div className="dirlist" role="group" aria-label="Floors">
        {items.map((f) => (
          <button key={f.eyebrow} className="dirrow" aria-pressed={view === f.floor} aria-label={f.name} title={f.name} onClick={() => onView(f.floor)}>
            <span className="eyebrow">{f.eyebrow}</span>
            <b>{f.title}</b>
            <span className={`hw-tag${f.tone}`}>{f.tag}</span>
            <span className="sub">{f.sub}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** Under the floor list: the open floor, or the building, or ward W4, in numbers. */
export function CurrentFloor({ floors, view, ward }: { floors: FloorSummary[]; view: number | null; ward: { name: string; rows: [string, string | number][] } }) {
  const f = view === null ? null : floors.find((x) => x.floor === view) ?? null;
  const rows: [string, string | number][] =
    floors.length === 0 ? ward.rows
    : f ? [["Units", f.units.map((u) => u.name).join(", ")], ["Beds in use", `${f.census} of ${f.capacity}`], ["Occupancy", f.occupancyPct === null ? "--" : `${f.occupancyPct}%`], ["Nurses", f.nurses]]
    : [["Floors", floors.length], ["People", floors.reduce((n, x) => n + x.census, 0)], ["Beds", floors.reduce((n, x) => n + x.capacity, 0)], ["Nurses", floors.reduce((n, x) => n + x.nurses, 0)]];
  return (
    <section className="curfloor" aria-label="Current floor">
      <span className="hw-eyebrow">Current floor</span>
      <h2>{floors.length === 0 ? ward.name : f ? f.name : "Whole building"}</h2>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
    </section>
  );
}

const eventLine = (src: VitalsSource, l: { minute: number; text: string }) => `${clockText(src, l.minute)} ${l.text}`;

/** The log under the stage: the run's latest events. Copy, Download and Expand act on this page only. */
export function EventConsole({ s, src }: { s: Sim; src: VitalsSource }) {
  const [open, setOpen] = useState(false);
  const lines = s.log;
  const shown = lines.slice(open ? -20 : -3).reverse();
  const text = () => lines.map((l) => eventLine(src, l)).join("\n");
  const download = () => {
    const url = URL.createObjectURL(new Blob([text()], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "biosentry-events.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section className="events" aria-label="Event log" data-open={open}>
      <div className="evhead">
        <span className="hw-eyebrow">Event log</span>
        <button className="hw-button hw-button--sm hw-button--icon dock__item" aria-label="Copy the log" data-hw-tooltip="Copy the log" disabled={lines.length === 0} onClick={() => void navigator.clipboard?.writeText(text())}>{ICON("fa-copy")}</button>
        <button className="hw-button hw-button--sm hw-button--icon dock__item" aria-label="Download the log" data-hw-tooltip="Download the log" disabled={lines.length === 0} onClick={download}>{ICON("fa-download")}</button>
        <button className="hw-button hw-button--sm hw-button--icon dock__item" aria-expanded={open} aria-label={open ? "Show fewer events" : "Show more events"} data-hw-tooltip={open ? "Show fewer events" : "Show more events"} onClick={() => setOpen(!open)}>{ICON(open ? "fa-compress" : "fa-expand")}</button>
      </div>
      {shown.length === 0 ? (
        <p className="tiny">No events yet.</p>
      ) : (
        <ol className="hw-timeline evlist">
          {shown.map((l, i) => (
            <li key={i} className="hw-timeline__item">
              <time className="hw-timeline__time">{clockText(src, l.minute)}</time>
              <span className="hw-timeline__text">{l.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const SIDE_KEY = "biosentry.sidePanel";

/** The side panel can fold to a narrow tab. The choice is kept in localStorage; without it the panel is open. */
export function SidePanel({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(SIDE_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(SIDE_KEY, open ? "closed" : "open");
    } catch {
      /* the page works without storage */
    }
  };
  return (
    <div className={open ? "side" : "side shut"}>
      <button type="button" className="sidetab hw-button hw-button--sm" aria-expanded={open} aria-controls="side-body" onClick={toggle}>
        <i className={`hw-icon fa-solid ${open ? "fa-angles-right" : "fa-angles-left"}`} aria-hidden="true" />
        {open ? "Hide panel" : "Show panel"}
      </button>
      {open && (
        <div id="side-body" className="sidebody">
          {children}
        </div>
      )}
    </div>
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
  vitals = null,
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
  vitals?: HospitalVitals | null; // hospital world: the vitals engine, beside the world
}) {
  if (selected === null) {
    return (
      <aside className="hw-card hw-card--outlined command">
        {watching ? (
          <>
            <h2 className="ptitle">Watching W4</h2>
            <p className="story">
              This is ward W4, running live on the team server{s.speed > 0 ? ` at ${s.speed}x: 1 minute here is ${s.speed} ward minute${s.speed === 1 ? "" : "s"}` : ""}. Pick a bed in the list. The public dashboard runs alone on a sample ward:{" "}
              <a href="https://biosentry-dashboard.pages.dev" target="_blank" rel="noopener noreferrer">open the dashboard</a>. Read-only. Sign in to control.
            </p>
            <BedList s={s} onSelect={onSelect} />
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
        {watching && <p className="tiny">Staff (nurse, charge nurse, physician) walk a set loop. It is not a product feature.</p>}
        {s.hospital && <p className="tiny">ICU: no NEWS2 colour. Waiting room: triage colour.</p>}
      </aside>
    );
  }
  if (watching) {
    // No token: the bed's colour and rank from the open answer, and nothing else. No name, no vitals.
    const bed = selected.startsWith("bed:") ? selected.slice(4) : null;
    const p = s.patients.find((x) => x.bed === bed);
    const d = p?.decision;
    return (
      <aside className="hw-card hw-card--outlined command">
        <button className="hw-button hw-button--sm" onClick={() => onSelect(null)}>{ICON("fa-arrow-left")}Back to the list</button>
        <div className="chead">
          <h2>Bed {bed}</h2>
          <span className="hw-tag">{d?.kind === "ranked" ? RISK_WORDS[d.news2.risk] : "Not ranked"}</span>
        </div>
        {p?.rank != null && <p className="story">Rank {p.rank} on the ward.</p>}
        <p className="story">Sign in to see this patient's vitals.</p>
      </aside>
    );
  }
  const bed = selected.startsWith("bed:") ? selected.slice(4) : null;
  // An empty bed that has since filled shows its new patient.
  const patient = s.patients.find((p) => p.id === selected || p.bed === bed);
  const stay = s.stays.find((x) => x.id === selected);
  const staff = s.staff.find((m) => m.id === selected);
  return (
    <aside className="hw-card hw-card--outlined command">
      <button className="hw-button hw-button--sm" onClick={() => onSelect(null)}>{ICON("fa-arrow-left")}{s.hospital ? "Back to floor" : "Back to full ward"}</button>
      <div className="scroll">
        {s.hospital && isHospitalId(selected) ? (
          <HospitalPanel h={s.hospital} id={selected} onSelect={onSelect} floors={floors ?? floorSummary(s.hospital)} vitals={vitals} />
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
              <span className="hw-tag">Occupied</span>
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

/** Watching with no token: the beds as the open answer gives them, highest rank first. Colour, rank and the risk word only. */
function BedList({ s, onSelect }: { s: Sim; onSelect: (id: string) => void }) {
  const rows = s.patients
    .map((p) => ({ bed: p.bed, rank: p.rank, d: p.decision }))
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.bed.localeCompare(b.bed));
  if (rows.length === 0) return null;
  return (
    <ul className="beds" aria-label="Beds, highest rank first">
      {rows.map((r) => (
        <li key={r.bed}>
          <button className="hw-button hw-button--sm" onClick={() => onSelect(`bed:${r.bed}`)}>
            <i style={{ background: r.d.kind === "ranked" ? RISK_LIGHT[r.d.news2.risk] : "#A899B5" }} /> Bed {r.bed}
            {r.rank !== null && r.d.kind === "ranked" ? ` · Rank ${r.rank}` : ""} · {r.d.kind === "ranked" ? RISK_WORDS[r.d.news2.risk] : "Not ranked"}
          </button>
        </li>
      ))}
    </ul>
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
          <button className="hw-button hw-button--sm" onClick={() => onSelect(id)}>{name}</button>
        </li>
      ))}
    </ul>
  );
}
