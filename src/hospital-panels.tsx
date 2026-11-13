// Inspector panels for the hospital layer (H6). Synthetic people: names show only here, never in a log, a URL or storage.
// The helpers are pure and read the hospital's capped event and hourly buffers without draining them.
import { useMemo } from "react";
import { Sparkline } from "./chart";
import { icuFlag, seeingOrder, slotName, type FloorSummary, type UnitSummary } from "./building";

export { seeingOrder };
import { PARAMS, type UnitId } from "./sim/hospital/params";
import { noticedLateMin, overdueRounds } from "./sim/hospital/step";
import type { EventKind, Hospital, Person } from "./sim/hospital/types";
import type { Patient, Sim } from "./sim/sim";
import { Flip } from "./flip";
import { NotRankedRow, RankedRow, RISK_WORDS, VitalCards } from "./vital-cards";
import { unitRank, vitalsOf, type HospitalVitals, type PersonVitals } from "./sim/hospital/vitals";
import { SYNTHETIC_RULES } from "./sim/source";

const START = PARAMS.clock.startMinuteOfDay.value;
const DAY = 1440;
const dayOf = (m: number) => Math.floor((m + START) / DAY);
const now = (h: Hospital) => Math.max(0, h.lastMinute);
const unitName = (h: Hospital, id: UnitId) => h.units.find((u) => u.id === id)?.name ?? id;
const isBody = (p: Person) => p.where === "awaiting_morgue" || p.where === "morgue";

export function clock(minute: number): string {
  const t = (((minute + START) % DAY) + DAY) % DAY;
  return `day ${dayOf(minute) + 1}, ${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}
export const dur = (min: number): string => {
  const m = Math.max(0, Math.round(min));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
};
const median = (xs: number[]): number | null => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// ---- pure helpers (tested) ----

export interface PathLine { minute: number; unit: UnitId; kind: EventKind; text: string }
const EVENT_TEXT: Record<EventKind, (h: Hospital, unit: UnitId, d: string) => string> = {
  arrive: (_h, _u, d) => `Arrived: ${d}`,
  triage: (_h, _u, d) => `Triage: ${d.replace("_", "-")}`,
  consult: () => "Seen by a doctor",
  decide_home: () => "Decided: home",
  decide_admit: (_h, _u, d) => `Decided: admit (${d})`,
  board: (_h, _u, d) => `Boarding in the ER, waiting for ${d}`,
  place: (h, u, d) => `Placed in ${unitName(h, u)}${d.includes("corridor stretcher") ? ", on a corridor stretcher" : ""}${d.includes("ICU-indicated") ? " (ICU-indicated, not in the ICU)" : ""}`,
  transfer: (h, u, d) => `Moved to ${unitName(h, u)} (${d})`,
  discharge: () => "Discharged",
  lwbs: (_h, _u, d) => `Left without being seen (${d})`,
  transfer_out: (_h, _u, d) => `Transferred to another hospital (${d})`,
  died: (h, u) => `Died in ${unitName(h, u)}`,
  to_morgue: () => "Moved to the morgue",
  released: () => "Released from the morgue",
  turned_away: (_h, _u, d) => `Turned away (${d})`,
  deteriorate: () => "Began to deteriorate (not yet known to the staff)",
  noticed: (_h, _u, d) => `Deterioration noticed (${d.replace("delay ", "")} after onset)`,
  unnoticed: (_h, _u, d) => `Left with a deterioration nobody noticed (${d})`,
  return: (_h, _u, d) => `Came back to the emergency room (${d})`,
  return_scheduled: () => "", // the sim's own foreknowledge: never shown (FUTURE below)
  return_dropped: () => "",
};
const FUTURE: EventKind[] = ["return_scheduled", "return_dropped"]; // what the sim knows ahead; nobody in the house does

/** A person's events in time order, and why the list may be short. `note` is null only when the path starts at the arrival. */
export function personPath(h: Hospital, p: Person): { lines: PathLine[]; note: string | null } {
  const mine = h.events.filter((e) => e.person === p.id && !FUTURE.includes(e.kind));
  const lines = mine.map((e) => ({ minute: e.minute, unit: e.unit, kind: e.kind, text: EVENT_TEXT[e.kind](h, e.unit, e.detail) }));
  lines.sort((a, b) => a.minute - b.minute); // stable: same-minute events keep their order
  if (p.arrivedMin <= 0) return { lines, note: "In the house when the run began; no earlier events exist." };
  if (!mine.some((e) => e.kind === "arrive")) return { lines, note: "Earlier events not kept (the event buffer is capped)." };
  return { lines, note: null };
}

/** Median minutes from arrival to a doctor over people first seen in the last 24 h that arrived during the run; null when none. Reads the people still on record. */
export const doorToDoctorMedian24h = (h: Hospital): number | null => doorToDoctor24h(h).median;

/** The median with the n behind it, and `partial` whenever any gone person was dropped from the record (their leaving time is not kept, so no narrower test is safe). */
export function doorToDoctor24h(h: Hospital): { median: number | null; n: number; partial: boolean } {
  const from = now(h) - DAY;
  const xs = [...h.people, ...h.gone].filter((p) => p.seenMin !== null && p.arrivedMin > 0 && p.seenMin > from).map((p) => p.seenMin! - p.arrivedMin);
  return { median: median(xs), n: xs.length, partial: h.goneCount > h.gone.length };
}

/** Census per hourly row for one unit, oldest first, at most the last `hours` rows. */
export const censusSeries = (h: Hospital, unit: UnitId, hours = 72): number[] => h.hourly.filter((r) => r.unit === unit).slice(-hours).map((r) => r.census);

/** Today's in (admitted and moved in), out (discharged and moved out), deaths and ER left-without-being-seen: whole hourly rows of today plus the hour in progress. */
export function todayCounts(h: Hospital, unit: UnitId): { in: number; out: number; died: number; lwbs: number } {
  const today = dayOf(now(h));
  const rows = h.hourly.filter((r) => r.unit === unit && dayOf(r.hour * 60) === today);
  const a = h.acc.by[unit];
  return {
    in: rows.reduce((n, r) => n + r.admitted_in + r.transferred_in, 0) + a.admittedIn + a.transferredIn,
    out: rows.reduce((n, r) => n + r.discharged + r.transferred_out, 0) + a.discharged + a.transferredOut,
    died: rows.reduce((n, r) => n + r.died, 0) + a.died,
    lwbs: unit === "ER" ? rows.reduce((n, r) => n + (r.er_lwbs ?? 0), 0) + h.acc.lwbs : 0,
  };
}

/** ER doctors on shift now, busy and free. */
export function doctorsNow(h: Hospital): { onShift: number; busy: number; free: number } {
  const hour = Math.floor(((now(h) + START) % DAY) / 60);
  const onShift = hour >= 7 && hour < 19 ? h.scenario.er.doctorsDay : h.scenario.er.doctorsNight;
  const busy = h.doctorsFreeAt.slice(0, onShift).filter((t) => t > now(h)).length;
  return { onShift, busy, free: onShift - busy };
}

/** Bodies released from the morgue in the last 24 h, from the event buffer. */
export const releasedLast24h = (h: Hospital): number => h.events.filter((e) => e.kind === "released" && e.minute > now(h) - DAY).length;
/** True when the event buffer is full and its oldest event is newer than 24 h: older releases may have rolled out. */
export const releasedPartial = (h: Hospital): boolean => h.events.length >= PARAMS.bufferCap.events.value && h.events[0].minute > now(h) - DAY;

/** Plain lines for what is wrong with this person's care right now. Nothing pre-drawn that has not happened yet. */
export function complications(h: Hospital, p: Person): string[] {
  const out: string[] = [];
  const er = h.units.find((u) => u.id === "ER")!;
  if (isBody(p)) return out;
  if (icuFlag(p)) out.push("ICU-indicated, no ICU bed was free");
  if (p.where === "stretcher") out.push("on a corridor stretcher");
  if (p.unit === "ER" && p.slot !== null && p.slot >= er.beds && p.where !== "waiting") out.push("on an ER trolley or chair, no bay free");
  const boarded = p.boardedMin + (p.where === "boarding" ? now(h) - p.sinceMin : 0);
  if (boarded >= 60) out.push(`boarded ${Math.round((boarded / 60) * 10) / 10} h`);
  return out;
}

/** "Rounds overdue: 9 of 28 patients. Longest wait: 7 h 20 min.", or null where rounds are not modelled (ICU, W4, morgue). */
export function overdueLine(h: Hospital, id: UnitId, census: number): string | null {
  const o = overdueRounds(h, id, now(h));
  return o ? (o.count === 0 ? `Rounds overdue: none of ${census} patients.` : `Rounds overdue: ${o.count} of ${census} patients. Longest wait: ${dur(o.longestMin)}.`) : null;
}
export const ROUNDS_CAPTION = "These figures are a model output that rests on judgement numbers, not evidence about real wards.";

/** One line once a deterioration was noticed late; null while it is unnoticed, so the panel cannot tell what nobody knows. */
export function noticedLateLine(p: Person): string | null {
  const d = noticedLateMin(p);
  return d === null ? null : `Deterioration noticed ${dur(d)} after it began, ${p.unit === "ICU" ? "on arrival in the ICU" : "at the next observation round"}.`;
}

const findPerson = (h: Hospital, n: number) => h.people.find((p) => p.n === n) ?? h.gone.find((p) => p.n === n);

function whereNow(h: Hospital, p: Person): string {
  const u = h.units.find((x) => x.id === p.unit)!;
  const slot = p.slot === null ? "" : `, ${slotName(p.unit, u.beds, u.stretchers, p.slot).toLowerCase()}`;
  const since = `since ${clock(p.sinceMin)} (${dur(now(h) - p.sinceMin)})`;
  if (!h.people.includes(p)) return "no longer in the hospital";
  switch (p.where) {
    case "waiting": return `ER waiting room ${since}`;
    case "consult": return `ER, with a doctor${slot} ${since}`;
    case "workup": return `ER, work-up${slot} ${since}`;
    case "boarding": return `ER, boarding for ${p.wants ? unitName(h, p.wants) : "a bed"}${slot} ${since}`;
    case "awaiting_morgue": return `${u.name}, awaiting transfer to the morgue ${since}`;
    case "morgue": return `Morgue${slot} ${since}`;
    default: return `${u.name}${p.w4Id ? ` (${p.w4Id})` : slot} ${since}`;
  }
}

// ---- vitals (display only: nothing here reaches care, a move or a task) ----

/** The plan's labels, by unit. W4 is listed for the docs and the tests; the page keeps W4's own panels as they were. */
export const UNIT_LABEL: Partial<Record<UnitId, string>> = {
  W4: "Synthetic. Generator fitted to ICU data at ward-like baselines.",
  MED3A: "Synthetic. Same generator as W4.",
  MED3B: "Synthetic. Same generator as W4.",
  SURG5A: "Synthetic. Adult generator, not fitted to surgical patients.",
  ER: "Synthetic. Not ER data: ward generator.",
  ICU: "Synthetic. ICU vitals are not modelled: ward generator values.",
};
export const ICU_NOT_RANKED = "Not ranked: NEWS2 is a ward score.";
export const DISPLAY_ONLY = "Display only. Care in the model does not read this score.";
export const FIRST_DAY = "First day: everyone starts as a new admission, so scores run high.";
export const RECOVERY_NOTE = "Simulated recovery, not modelled.";

/** Where a person is, in the unit's own words. */
function placeOf(h: Hospital, q: Person): string {
  if (q.where === "waiting") return "Waiting room";
  if (q.where === "boarding" && q.slot === null) return "Boarding";
  if (q.slot === null) return "";
  const u = h.units.find((x) => x.id === q.unit)!;
  return slotName(q.unit, u.beds, u.stretchers, q.slot);
}

/** The label, the ranked list in the ward's own order, and who is not ranked. Intensive care: vitals, no rank. */
function UnitVitals({ h, id, vitals, onSelect }: { h: Hospital; id: UnitId; vitals: HospitalVitals | null; onSelect: (id: string) => void }) {
  const label = UNIT_LABEL[id];
  if (!vitals || !label || id === "W4" || id === "MORGUE") return null;
  const minute = now(h);
  const byId = new Map(h.people.map((q) => [q.id, q]));
  const row = (pv: PersonVitals) => { const q = byId.get(pv.id)!; return { p: pv.p, key: pv.id, sel: `h:${q.n}`, name: q.name, place: placeOf(h, q) }; };
  const rows = (xs: PersonVitals[]) => xs.map(row);
  if (id === "ICU") {
    const here = h.people.flatMap((q) => { const pv = q.unit === "ICU" ? vitals.live.get(q.id) : undefined; return pv && pv.visit === q.visit ? [pv] : []; });
    return (
      <>
        <h3>Vital signs</h3>
        <p className="story">{label}</p>
        <p className="story">{ICU_NOT_RANKED}</p>
        <p className="tiny">{DISPLAY_ONLY}</p>
        {minute < DAY && <p className="tiny">{FIRST_DAY}</p>}
        {here.length === 0 ? <p className="story">Nobody here.</p> : (
          <ul className="list">{rows(here).map((r) => <NotRankedRow key={r.key} p={r.p} sel={r.sel} name={r.name} place={r.place} minute={minute} onSelect={onSelect} selected={false} />)}</ul>
        )}
      </>
    );
  }
  const ur = unitRank(vitals, h, id);
  if (!ur) return null;
  return (
    <>
      <h3>Vital signs</h3>
      <p className="story">{label}</p>
      <p className="tiny">{DISPLAY_ONLY}</p>
      {minute < DAY && <p className="tiny">{FIRST_DAY}</p>}
      {ur.ranked.length === 0 ? <p className="story">Nobody ranked.</p> : (
        <ol className="list">
          {rows(ur.ranked).map((r, i) => <RankedRow key={r.key} p={r.p} rank={i + 1} sel={r.sel} name={r.name} place={r.place} minute={minute} onSelect={onSelect} selected={false} />)}
        </ol>
      )}
      {ur.notRanked.length > 0 && <h3>Not ranked</h3>}
      <ul className="list">
        {rows(ur.notRanked).map((r) => <NotRankedRow key={r.key} p={r.p} sel={r.sel} name={r.name} place={r.place} onSelect={onSelect} selected={false} />)}
      </ul>
    </>
  );
}

/** One person outside W4: the label, the score (or why none), five cards and the stated inputs. */
function PersonVitalsView({ h, p, pv }: { h: Hospital; p: Person; pv: PersonVitals }) {
  const d = pv.p.decision;
  const icu = p.unit === "ICU";
  return (
    <>
      <h3>Vital signs</h3>
      <p className="story">{UNIT_LABEL[p.unit]}</p>
      <p className="mono">{icu ? ICU_NOT_RANKED : d.kind === "ranked" ? `NEWS2 ${d.news2.total} · ${RISK_WORDS[d.news2.risk]}` : `Not ranked: ${d.reason}.`}</p>
      <VitalCards p={pv.p} minute={now(h)} charted={SYNTHETIC_RULES.charted} origin="synthetic" when={(at) => (at === null ? "no reading" : clock(at))} />
      <p className="tiny">Consciousness: alert (not modelled). Oxygen: generator&apos;s draw. BP: {icu ? "at arrival only, no rounds here" : "at arrival and each round"}.</p>
      <p className="tiny">{DISPLAY_ONLY}</p>
      {now(h) < DAY && <p className="tiny">{FIRST_DAY}</p>}
      {pv.spans.some((x) => x.recovery === "not_modelled") && <p className="tiny">{RECOVERY_NOTE}</p>}
    </>
  );
}

// ---- small views ----

function Stat({ label, value }: { label: string; value: string | number }) {
  return <div className="vital"><div className="vhead">{label}</div><span className="vnum"><Flip value={value} /></span></div>;
}
const PersonLink = ({ p, onSelect, children }: { p: Person; onSelect: (id: string) => void; children?: string }) => (
  <button className="linkbtn" onClick={() => onSelect(`h:${p.n}`)}>{children ?? p.name}</button>
);

function Path({ h, p }: { h: Hospital; p: Person }) {
  const { lines, note } = personPath(h, p);
  return (
    <>
      <h3>Path</h3>
      {note && <p className="story">{note}</p>}
      {lines.length === 0 ? <p className="story">No events kept.</p> : (
        <ul className="plist mono">{lines.map((l, i) => <li key={i}>{clock(l.minute)} · {l.text}</li>)}</ul>
      )}
    </>
  );
}

/** The pill and the one status line: a body, released or not, is a person who died; a leaver is "Left" with the outcome if seen. */
export function personStatus(h: Hospital, p: Person): { pill: string; line: string | null } {
  const alive = h.people.includes(p);
  const lines = personPath(h, p).lines;
  if (isBody(p)) {
    const died = lines.find((l) => l.kind === "died");
    return { pill: "Died", line: `Died ${clock(p.dieMin ?? p.sinceMin)}${died ? ` in ${unitName(h, died.unit)}` : " (place not kept)"}.` };
  }
  if (alive) return { pill: "In hospital", line: null };
  const unseen = lines.some((l) => l.kind === "lwbs" || l.kind === "transfer_out");
  return { pill: "Left", line: unseen ? "Outcome not observed: left the record before any stay ended." : lines.at(-1)?.text ?? "Left the record." };
}

function PersonPanel({ h, p, onSelect, vitals }: { h: Hospital; p: Person; onSelect: (id: string) => void; vitals: HospitalVitals | null }) {
  const alive = h.people.includes(p);
  const pv = vitals && alive && p.unit !== "W4" && !isBody(p) ? vitalsOf(vitals, p.id, p.visit) : null;
  const status = personStatus(h, p);
  const comps = complications(h, p);
  const late = noticedLateLine(p);
  const d2d = p.arrivedMin <= 0 ? "not recorded" : p.seenMin !== null ? dur(p.seenMin - p.arrivedMin) : alive && (p.where === "waiting") ? `not seen yet (${dur(now(h) - p.arrivedMin)} so far)` : "not seen";
  const boarded = p.boardedMin + (alive && p.where === "boarding" ? now(h) - p.sinceMin : 0);
  return (
    <>
      <div className="chead">
        <div>
          <h2>{p.name}</h2>
          <p className="mono">{p.age} {p.sex} · {p.id}</p>
          <p className="mono">Synthetic person, hospital record{p.visit > 1 ? ` · visit ${p.visit}, a returning patient` : ""}</p>
        </div>
        <span className="pill"><Flip value={status.pill} /></span>
      </div>
      <h3>Came in for</h3>
      <p className="story">{p.complaint} ({p.group}). Triage: {p.triage.replace("_", "-")}.</p>
      <div className="vitals">
        <Stat label="Arrived" value={p.arrivedMin <= 0 ? "before the run" : clock(p.arrivedMin)} />
        <Stat label="Door to doctor" value={d2d} />
        <Stat label="Boarded" value={boarded > 0 ? `${Math.round((boarded / 60) * 10) / 10} h` : "no"} />
      </div>
      <h3>Where now</h3>
      <p className="story">{whereNow(h, p)}.</p>
      {status.line && <p className="story">{status.line}</p>}
      {pv && <PersonVitalsView h={h} p={p} pv={pv} />}
      {late && <p className="story">{late}</p>}
      <h3>Complications</h3>
      {comps.length === 0 ? <p className="story">None recorded.</p> : <ul className="plist">{comps.map((c) => <li key={c}>{c}</li>)}</ul>}
      <Path h={h} p={p} />
      {p.w4Id !== null && alive && <p className="story">On ward W4: <button className="linkbtn" onClick={() => onSelect(p.w4Id!)}>open the ward panel</button>.</p>}
    </>
  );
}

function BedPanel({ h, unit, slot, onSelect }: { h: Hospital; unit: UnitId; slot: number; onSelect: (id: string) => void }) {
  const u = h.units.find((x) => x.id === unit);
  if (!u || !Number.isSafeInteger(slot) || slot < 0) return <p className="empty">Unknown bed.</p>;
  // W4's cells are numbered by order on the ward; every other unit by slot.
  const who = unit === "W4" ? h.people.filter((p) => p.unit === "W4")[slot] : h.people.find((p) => p.unit === unit && p.slot === slot);
  return (
    <>
      <div className="chead"><h2>{slotName(unit, u.beds, u.stretchers, slot)}</h2><span className="pill"><Flip value={who ? "Occupied" : "Empty"} /></span></div>
      <p className="mono">{u.name}</p>
      {who ? <p className="story">Occupant: <PersonLink p={who} onSelect={onSelect} /> ({who.age} {who.sex}, {who.group}).</p> : <p className="story">Empty.</p>}
    </>
  );
}

function UnitPanel({ h, id, floors, vitals, onSelect }: { h: Hospital; id: UnitId; floors: FloorSummary[]; vitals: HospitalVitals | null; onSelect: (id: string) => void }) {
  const u = h.units.find((x) => x.id === id);
  const sum: UnitSummary | undefined = floors.flatMap((f) => f.units).find((x) => x.id === id);
  // Scans every person: once per sim minute, not per render.
  const minute = now(h);
  const census = sum?.census ?? 0;
  const rounds = useMemo(() => overdueLine(h, id, census), [h, id, minute, census]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!u || !sum) return <p className="empty">Unknown unit.</p>;
  const t = todayCounts(h, id);
  const series = censusSeries(h, id);
  const used = sum.stretchers.filter(Boolean).length + sum.over.length;
  const display = id === "W4" ? "" : " (display)";
  return (
    <>
      <div className="chead"><h2>{u.name}</h2><span className="pill">Floor {u.floor === 0 ? "GF" : u.floor}</span></div>
      <div className="vitals">
        <Stat label="Beds" value={u.beds} />
        <Stat label="Stretchers" value={`${used} used of ${u.stretchers}`} />
        <Stat label="Census" value={sum.census} />
        <Stat label="Occupied" value={sum.occupancyPct === null ? "–" : `${sum.occupancyPct}%`} />
        <Stat label={`Nurses on shift${display}`} value={u.nurses} />
        <Stat label={`Patients per nurse${display}`} value={sum.ratio === null ? "–" : `1:${sum.ratio}`} />
        <Stat label="Residents" value={u.residents} />
        <Stat label="Today in / out / died" value={`${t.in} / ${t.out} / ${t.died}`} />
      </div>
      <h3>Census, last {series.length} h</h3>
      <p className="tiny">Hourly rows; last point is the last full hour; includes bodies awaiting the morgue.</p>
      {series.length === 0 ? <p className="story">No hourly rows yet.</p> : (
        <>
          <Sparkline data={series} width={300} height={40} />
          <p className="mono">now {series.at(-1)} · low {Math.min(...series)} · high {Math.max(...series)}</p>
        </>
      )}
      {rounds && <><p className="story">{rounds}</p><p className="tiny">{ROUNDS_CAPTION}</p></>}
      {sum.bodies > 0 && <p className="story">{sum.bodies} awaiting transfer to the morgue (hold a bed, not counted).</p>}
      <UnitVitals h={h} id={id} vitals={vitals} onSelect={onSelect} />
      <p className="story">Hospital layer: synthetic.{display && " Staffing outside W4 drives observation rounds only; care there is not modelled."}</p>
    </>
  );
}

function QueuePanel({ h, onSelect, vitals }: { h: Hospital; onSelect: (id: string) => void; vitals: HospitalVitals | null }) {
  const waiting = seeingOrder(h);
  const er = h.people.filter((p) => p.unit === "ER");
  const boarders = er.filter((p) => p.where === "boarding");
  const dr = doctorsNow(h);
  const d2d = doorToDoctor24h(h);
  const t = todayCounts(h, "ER");
  return (
    <>
      <div className="chead"><h2>ER queue</h2><span className="pill"><Flip value={`${waiting.length} waiting`} /></span></div>
      <div className="vitals">
        <Stat label="In consult" value={er.filter((p) => p.where === "consult").length} />
        <Stat label="In work-up" value={er.filter((p) => p.where === "workup").length} />
        <Stat label="Doctors busy / free" value={`${dr.busy} / ${dr.free}`} />
        <Stat label={`Door to doctor, 24 h median${d2d.partial ? " (partial)" : ""}`} value={d2d.median === null ? "–" : `${dur(d2d.median)} (n=${d2d.n})`} />
        <Stat label="Left unseen today" value={t.lwbs} />
        <Stat label="Boarders" value={boarders.length} />
      </div>
      <p className="tiny">Median excludes {waiting.length} still waiting and people who left unseen.{d2d.partial ? " Partial: older people were dropped from the record." : ""}</p>
      <h3>Waiting, in seeing order</h3>
      {waiting.length === 0 ? <p className="story">Nobody waiting.</p> : (
        <ol className="plist">
          {waiting.map((p) => <li key={p.n}><PersonLink p={p} onSelect={onSelect}>{`${p.name}, ${p.triage.replace("_", "-")}`}</PersonLink> · waited {dur(now(h) - p.arrivedMin)}</li>)}
        </ol>
      )}
      <h3>Boarding</h3>
      {boarders.length === 0 ? <p className="story">Nobody boarding.</p> : (
        <ul className="plist">
          {boarders.map((p) => <li key={p.n}><PersonLink p={p} onSelect={onSelect} /> · for {p.wants ? unitName(h, p.wants) : "?"} · {Math.floor((now(h) - p.sinceMin) / 60)} h</li>)}
        </ul>
      )}
      <UnitVitals h={h} id="ER" vitals={vitals} onSelect={onSelect} />
    </>
  );
}

function MorguePanel({ h, onSelect }: { h: Hospital; onSelect: (id: string) => void }) {
  const u = h.units.find((x) => x.id === "MORGUE")!;
  const bodies = h.people.filter(isBody).sort((a, b) => (a.dieMin ?? 0) - (b.dieMin ?? 0));
  const drawers = bodies.filter((p) => p.where === "morgue" && p.slot !== null && p.slot < u.beds).length;
  return (
    <>
      <div className="chead"><h2>Morgue</h2><span className="pill"><Flip value={`${bodies.length} bodies`} /></span></div>
      <div className="vitals">
        <Stat label="Drawers used" value={`${drawers} of ${u.beds}`} />
        <Stat label={`Released, 24 h${releasedPartial(h) ? " (partial)" : ""}`} value={releasedLast24h(h)} />
      </div>
      <h3>Bodies</h3>
      {bodies.length === 0 ? <p className="story">None.</p> : (
        <ul className="plist">
          {bodies.map((p) => {
            const died = h.events.find((e) => e.person === p.id && e.kind === "died");
            return (
              <li key={p.n}>
                <PersonLink p={p} onSelect={onSelect} /> · {p.age} · {p.group} · died {clock(p.dieMin ?? p.sinceMin)}{died ? ` in ${unitName(h, died.unit)}` : ""}{p.where === "awaiting_morgue" ? " · awaiting transfer" : ""}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/** Whether Inspector should hand this selection to HospitalPanel. */
export const isHospitalId = (id: string) => /^(h:\d+|hbed:[A-Z0-9]+:\d+|unit:[A-Z0-9]+|queue:ER|morgue)$/.test(id);

/** The floor a selection lives on: W4's own ids are on 4F; null when the record is gone or the unit unknown. */
export function floorOf(h: Hospital, id: string): number | null {
  if (!isHospitalId(id)) return h.units.find((u) => u.id === "W4")?.floor ?? null;
  const [kind, a] = id.split(":");
  const unit = kind === "h" ? findPerson(h, Number(a))?.unit : kind === "queue" ? "ER" : kind === "morgue" ? "MORGUE" : a;
  return h.units.find((u) => u.id === unit)?.floor ?? null;
}

export function HospitalPanel({ h, id, onSelect, floors, vitals = null }: { h: Hospital; id: string; onSelect: (id: string) => void; floors: FloorSummary[]; vitals?: HospitalVitals | null }) {
  const known = (x: string) => h.units.some((u) => u.id === x);
  const [kind, a, b] = id.split(":");
  if (kind === "h") {
    const p = findPerson(h, Number(a));
    return p ? <PersonPanel h={h} p={p} onSelect={onSelect} vitals={vitals} /> : <p className="empty">This person is too old to be on record.</p>;
  }
  if (kind === "hbed" && known(a)) return <BedPanel h={h} unit={a as UnitId} slot={Number(b)} onSelect={onSelect} />;
  if (kind === "queue" || (kind === "unit" && a === "ER")) return <QueuePanel h={h} onSelect={onSelect} vitals={vitals} />;
  if (kind === "morgue" || (kind === "unit" && a === "MORGUE")) return <MorguePanel h={h} onSelect={onSelect} />;
  if (kind === "unit" && known(a)) return <UnitPanel h={h} id={a as UnitId} floors={floors} vitals={vitals} onSelect={onSelect} />;
  return <p className="empty">Nothing here.</p>;
}

/** Two sections below a W4 patient's own panel. Only what the page already has: the sim exposes no AF origin and no episode kind or start. */
export function W4HospitalSections({ s, p, onSelect }: { s: Sim; p: Patient; onSelect: (id: string) => void }) {
  const h = s.hospital;
  const hp = h?.people.find((x) => x.w4Id === p.id);
  if (!h || !hp) return null;
  const started = hp.arrivedMin > 0;
  const boarded = hp.boardedMin / 60;
  return (
    <>
      <h3>Hospital path</h3>
      <ul className="plist mono">
        <li>ER arrival: {started ? clock(hp.arrivedMin) : "before the run began"}</li>
        <li>Triage: {started ? hp.triage.replace("_", "-") : "not recorded"}</li>
        <li>Door to doctor: {started && hp.seenMin !== null ? dur(hp.seenMin - hp.arrivedMin) : "not recorded"}</li>
        <li>Boarding: {boarded > 0 ? `${Math.round(boarded * 10) / 10} h` : "none"}</li>
      </ul>
      <p className="story"><button className="linkbtn" onClick={() => onSelect(`h:${hp.n}`)}>Open the hospital record</button></p>
      <h3>Complications</h3>
      <div className="truth">
        <b>Simulator ground truth (not seen by the risk model)</b>
        <p className="mono">Never shown to a clinician.</p>
        <ul className="plist mono">
          <li>Rhythm: {p.irregular ? "in AF now" : "not in AF now"}</li>
          <li>Deterioration injected by demo control: {p.injected ? "yes" : "no"}</li>
        </ul>
      </div>
    </>
  );
}
