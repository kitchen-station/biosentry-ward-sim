import { useState, type FormEvent } from "react";
import { Sparkline } from "./chart";
import { EcgStrip } from "./ecg";
import { explain } from "./explain";
import { PORTRAIT, STAFF_PALETTES, sprite } from "./render/sprites";
import { CHIP_COLOURS, RISK_LIGHT } from "./render/draw";
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
          ? `${dateText(minute)} 2026, ${clockText(src, minute)} Manila`
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
          <p className="mono">In for {stayLength(p.stay, minute)}</p>
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
      <p className="story">{stay.context}.</p>
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
        {src.admit && <button onClick={() => skipDay(s, src)}>Skip 1 day</button>}
      </div>
      <h3>Who came and went</h3>
      {recent.length === 0 ? (
        <p className="empty">Nobody yet. Stays last days: try Skip 1 day.</p>
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
}: {
  s: Sim;
  src: VitalsSource;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onTimeline: () => void;
}) {
  if (selected === null) {
    return (
      <aside className="panel command">
        <h2 className="ptitle">Click anything on the ward</h2>
        <p className="story">A bed, a person or a machine. It zooms in and its details show here. Click ENTRANCE to see who came and went.</p>
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
  const bed = selected.startsWith("bed:") ? selected.slice(4) : null;
  // An empty bed that has since filled shows its new patient.
  const patient = s.patients.find((p) => p.id === selected || p.bed === bed);
  const stay = s.stays.find((x) => x.id === selected);
  const staff = s.staff.find((m) => m.id === selected);
  return (
    <aside className="panel command">
      <button onClick={() => onSelect(null)}>Back to full ward</button>
      <div className="scroll">
        {patient ? (
          <PatientPanel s={s} src={src} p={patient} />
        ) : staff ? (
          <StaffPanel s={s} src={src} m={staff} />
        ) : stay ? (
          <StayPanel s={s} src={src} stay={stay} />
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
export function SelectList({ s, onSelect }: { s: Sim; onSelect: (id: string) => void }) {
  const targets: [string, string][] = [
    ...s.patients.map((p): [string, string] => [p.id, `${p.name}, bed ${p.bed}`]),
    ...BEDS.filter((b) => !s.patients.some((p) => p.bed === b.label)).map((b): [string, string] => [`bed:${b.label}`, `Empty bed ${b.label}`]),
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
