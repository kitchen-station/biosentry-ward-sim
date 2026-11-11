// The hospital around W4 as a DOM screen: BuildingView (one strip per floor) and UnitBoard (one floor, larger cells).
// floorSummary is the only place the numbers are computed, so the strips, the boards and the button names agree.
import { RISK_LIGHT } from "./render/draw";
import { PARAMS, type Group, type Triage, type UnitId } from "./sim/hospital/params";
import type { Hospital, Person } from "./sim/hospital/types";

export const GROUP_COLOURS: Record<Group, string> = {
  cardiac: "#FF6B6B", stroke: "#6C8EF5", hypertensive: "#FFA07A", respiratory: "#4ECDC4",
  infection: "#6BCF7F", trauma: "#FFD93D", minor: "#A899B5",
};
export const TRIAGE_COLOURS: Record<Triage, string> = { emergent: "#FF6B6B", urgent: "#FFD93D", non_urgent: "#6BCF7F" };
const NOT_RANKED = "#A899B5";
const QUEUE_DRAWN = 40;
const CHIPS_DRAWN = 12;
const TRIAGE_RANK: Record<Triage, number> = { emergent: 0, urgent: 1, non_urgent: 2 };

export interface Cell { group: Group; initials: string; risk?: string | null; dead?: boolean; icu?: boolean } // risk: W4 only, null = not ranked
export interface UnitSummary {
  id: UnitId; name: string; beds: (Cell | null)[]; stretchers: (Cell | null)[]; over: Cell[]; // over: ER trolleys, morgue overflow
  census: number; bodies: number; nurses: number; occupancyPct: number | null; ratio: number | null;
  queue: Triage[]; consult: number; workup: number; boarders: { to: string; hours: number }[]; // ER only
}
export interface FloorSummary {
  floor: number; label: string; name: string; units: UnitSummary[];
  census: number; capacity: number; occupancyPct: number | null; nurses: number; ratio: number | null;
  baysUsed: number; erCount: number; // GF: people holding a bay, and everyone in the ER including the waiting room
  boarders: number;            // GF: everyone boarding in the ER; upper floors: boarding people who want a bed here
  deathsToday: number | null;  // GF only (house-wide): a body's own floor is not kept once it reaches the morgue
  awaitingMorgue: number;
}

const initialsOf = (name: string) => name.split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
const cellOf = (p: Person, risk: Record<string, string | null>): Cell => {
  const c: Cell = { group: p.group, initials: initialsOf(p.name) };
  if (p.w4Id !== null) c.risk = Object.hasOwn(risk, p.w4Id) ? risk[p.w4Id] : null;
  if (p.where === "awaiting_morgue") c.dead = true; // still holds its bed until the body leaves
  else if (p.icuIndicated && p.unit !== "ICU") c.icu = true;
  return c;
};
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : null);
const ratioOf = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10) / 10 : null);
const FLOOR_NAMES: Record<number, string> = { 0: "Ground floor" };

/** Every number the strips and boards show. `w4Risk`: W4 patient id to NEWS2 risk, null when not ranked. */
export function floorSummary(h: Hospital, w4Risk: Record<string, string | null> = {}): FloorSummary[] {
  const START = PARAMS.clock.startMinuteOfDay.value;
  const day = (m: number) => Math.floor((m + START) / 1440);
  const today = day(Math.max(0, h.lastMinute));
  const bodies = (p: Person) => p.where === "awaiting_morgue" || p.where === "morgue";
  // gone holds released bodies (the morgue frees drawers), so a death earlier today may live only there.
  const deaths = [...h.people, ...h.gone].filter((p) => bodies(p) && p.dieMin !== null && day(p.dieMin) === today).length;
  const inEr = (p: Person) => p.where === "waiting" || p.where === "consult" || p.where === "workup" || p.where === "boarding";

  const units = h.units.map((u): UnitSummary => {
    const here = h.people.filter((p) => p.unit === u.id);
    const placed = here.filter((p) => p.slot !== null).sort((a, b) => a.slot! - b.slot!);
    const stay = u.id === "ER" ? here.filter(inEr) : u.id === "MORGUE" ? here.filter((p) => p.where === "morgue") : here.filter((p) => (p.slot !== null || p.w4Id !== null) && p.where !== "awaiting_morgue"); // bodies are not patients
    const slots = (lo: number, hi: number) => Array.from({ length: hi - lo }, (_, i) => { const p = placed.find((x) => x.slot === lo + i); return p ? cellOf(p, w4Risk) : null; });
    const w4 = u.id === "W4" ? here.map((p) => cellOf(p, w4Risk)) : null;
    const er = u.id === "ER";
    const waiting = er ? here.filter((p) => p.where === "waiting").sort((a, b) => TRIAGE_RANK[a.triage] - TRIAGE_RANK[b.triage] || a.arrivedMin - b.arrivedMin) : [];
    const lastMin = Math.max(0, h.lastMinute);
    return {
      id: u.id, name: u.name,
      beds: w4 ? Array.from({ length: u.beds }, (_, i) => w4[i] ?? null) : slots(0, u.beds), // W4's own bed labels are not in the hospital's slots
      stretchers: slots(u.beds, u.beds + u.stretchers),
      over: placed.filter((p) => p.slot! >= u.beds + u.stretchers).map((p) => cellOf(p, w4Risk)),
      census: stay.length, bodies: here.filter((p) => p.where === "awaiting_morgue").length, nurses: u.nurses,
      occupancyPct: pct(stay.length, u.beds), ratio: ratioOf(stay.length, u.nurses),
      queue: waiting.map((p) => p.triage),
      consult: here.filter((p) => p.where === "consult").length, workup: here.filter((p) => p.where === "workup").length,
      boarders: here.filter((p) => p.where === "boarding").map((p) => ({ to: p.wants ?? "?", hours: Math.floor((lastMin - p.sinceMin) / 60) })),
    };
  });

  const floors = [...new Set(h.units.map((u) => u.floor))].sort((a, b) => b - a);
  return floors.map((floor): FloorSummary => {
    const us = units.filter((u) => h.units.find((x) => x.id === u.id)!.floor === floor);
    const care = us.filter((u) => u.id !== "MORGUE"); // the morgue has no nurses and no beds to fill
    const er = us.find((u) => u.id === "ER");
    const census = care.reduce((n, u) => n + u.census, 0);
    const capacity = care.reduce((n, u) => n + u.beds.length, 0);
    const nurses = care.reduce((n, u) => n + u.nurses, 0);
    const wanted = new Set<string>(us.map((u) => u.id));
    const boarders = floor === 0
      ? us.find((u) => u.id === "ER")?.boarders.length ?? 0
      : h.people.filter((p) => p.where === "boarding" && p.wants !== null && wanted.has(p.wants)).length;
    return {
      floor, label: floor === 0 ? "GF" : `${floor}F`, name: FLOOR_NAMES[floor] ?? `Floor ${floor}`, units: us,
      census, capacity, occupancyPct: pct(census, capacity), nurses, ratio: ratioOf(census, nurses),
      boarders, deathsToday: floor === 0 ? deaths : null,
      baysUsed: er ? er.beds.filter(Boolean).length : 0, erCount: er ? er.census : 0,
      awaitingMorgue: h.people.filter((p) => p.where === "awaiting_morgue" && (floor === 0 || us.some((u) => u.id === p.unit))).length, // GF: house-wide
    };
  });
}

/** The strip button's spoken name: starts with the visible label. */
export function floorName(f: FloorSummary): string {
  if (f.floor === 0) {
    const er = f.units.find((u) => u.id === "ER")!;
    return `${f.label}: ${er.name}, ${er.queue.length} waiting, ${f.boarders} boarding`;
  }
  return `${f.label}: ${f.units.map((u) => u.name).join(" and ")}, ${f.census} patients, ${f.occupancyPct ?? 0}% of beds occupied, ${f.boarders} boarding in ER for here`;
}

const cellColour = (c: Cell, monitored: boolean) => (c.dead ? "#3D2E4A" : monitored ? (c.risk ? RISK_LIGHT[c.risk] ?? NOT_RANKED : NOT_RANKED) : GROUP_COLOURS[c.group]);
const cellTitle = (c: Cell, monitored: boolean) => (c.dead ? "died, awaiting transfer to the morgue" : c.icu ? `${c.initials}, ${c.group}: ICU-indicated, no ICU bed was free` : monitored ? `${c.initials}, ${c.risk ? `NEWS2 risk ${c.risk}` : "not ranked"}` : `${c.initials}, ${c.group}`);

function Cells({ cells, kind, monitored }: { cells: (Cell | null)[]; kind: "bed" | "str"; monitored: boolean }) {
  return cells.map((c, i) => (
    <i key={i} className={`cell ${kind}${c ? " full" : ""}`} style={c ? { background: cellColour(c, monitored) } : undefined} title={c ? cellTitle(c, monitored) : undefined}>{c?.dead ? "×" : c?.icu ? "!" : ""}</i>
  ));
}

function Strip({ f, onPick }: { f: FloorSummary; onPick: () => void }) {
  return (
    <li>
      <button className="strip" aria-label={floorName(f)} onClick={onPick}>
        <span className="sleft"><b>{f.label}</b></span>
        <span className="smid" aria-hidden="true">
          {f.units.map((u) => (
            <span className="urow" key={u.id}>
              <span className="uname">{u.name}{u.id === "W4" && <em className="badge">monitored</em>}</span>
              {u.id === "ER" ? <ErLine u={u} /> : (
                <span className="cells">
                  <Cells cells={u.beds} kind="bed" monitored={u.id === "W4"} />
                  {u.stretchers.length + u.over.length > 0 && <span className="gap" />}
                  <Cells cells={[...u.stretchers, ...u.over]} kind="str" monitored={false} />
                </span>
              )}
              {u.id === "MORGUE" && f.awaitingMorgue > 0 && <span className="tiny"> +{f.awaitingMorgue} awaiting</span>}
              {u.bodies > 0 && u.id !== "MORGUE" && <span className="tiny"> {u.bodies} awaiting morgue</span>}
            </span>
          ))}
        </span>
        <span className="sright" aria-hidden="true">
          {f.floor === 0 ? <span>bays {f.baysUsed}/{f.units[0].beds.length}</span> : <span>{f.occupancyPct === null ? "–" : `${f.occupancyPct}%`} beds occupied</span>}
          {f.floor === 0 && <span>{f.erCount} in ER</span>}
          <span>{f.ratio === null ? "–" : `1:${f.ratio}`} nurse{f.floor !== 4 && " (display)"}</span>
          <span>{f.floor === 0 ? `${f.boarders} boarders` : `${f.boarders} boarding in ER for here`}</span>
          {f.deathsToday !== null && <span>{f.deathsToday} deaths today</span>}
        </span>
      </button>
    </li>
  );
}

const queueText = (q: Triage[]) =>
  `${q.length} waiting: emergent ${q.filter((x) => x === "emergent").length}, urgent ${q.filter((x) => x === "urgent").length}, non-urgent ${q.filter((x) => x === "non_urgent").length}`;

function ErLine({ u }: { u: UnitSummary }) {
  const drawn = u.queue.slice(0, QUEUE_DRAWN);
  return (
    <span className="erline">
      <span className="cells">
        {drawn.map((t, i) => <i key={i} className="fig" style={{ background: TRIAGE_COLOURS[t] }} />)}
        {u.queue.length > drawn.length && <span className="tiny">+{u.queue.length - drawn.length}</span>}
        <span className="tiny"> {queueText(u.queue)}</span>
      </span>
      <span className="cells">
        <Cells cells={u.beds} kind="bed" monitored={false} />
        {u.over.length > 0 && <span className="gap" />}
        <Cells cells={u.over} kind="str" monitored={false} />
      </span>
      <Chips u={u} />
    </span>
  );
}

function Chips({ u }: { u: UnitSummary }) {
  if (u.boarders.length === 0) return null;
  return (
    <span className="cells">
      {u.boarders.slice(0, CHIPS_DRAWN).map((b, i) => <span key={i} className="chip">{b.to} {b.hours}h</span>)}
      {u.boarders.length > CHIPS_DRAWN && <span className="tiny">+{u.boarders.length - CHIPS_DRAWN}</span>}
    </span>
  );
}

export function Legend() {
  return (
    <p className="legend">
      {(Object.keys(GROUP_COLOURS) as Group[]).map((g) => <span key={g}><i className="cell full" style={{ background: GROUP_COLOURS[g] }} /> {g}</span>)}
      <span><i className="cell str" /> dashed: corridor stretcher</span>
      <span>Waiting queue: <i className="fig" style={{ background: TRIAGE_COLOURS.emergent }} /> emergent <i className="fig" style={{ background: TRIAGE_COLOURS.urgent }} /> urgent <i className="fig" style={{ background: TRIAGE_COLOURS.non_urgent }} /> non-urgent</span>
      <span>4F bed colour is NEWS2 risk; grey is not ranked.</span>
      <span><i className="cell full" style={{ background: "#3D2E4A" }}>×</i> died, awaiting transfer to the morgue (holds the bed, not counted as a patient)</span>
      <span><i className="cell full">!</i> ICU-indicated, no ICU bed was free</span>
      <span>Nurse ratios outside 4F are display, not modelled.</span>
    </p>
  );
}

/** Five strips, top floor first. A click opens that floor. */
export function BuildingView({ floors, onPick }: { floors: FloorSummary[]; onPick: (floor: number) => void }) {
  return (
    <section className="building" aria-label="Hospital building, schematic, not to scale">
      <ul className="strips">{floors.map((f) => <Strip key={f.floor} f={f} onPick={() => onPick(f.floor)} />)}</ul>
      <Legend />
      <p className="legend">Schematic, not to scale.</p>
    </section>
  );
}

/** One floor, larger cells: rows of beds, a corridor row of stretchers. Initials and a group stripe per occupied cell. */
export function UnitBoard({ f, onBack }: { f: FloorSummary; onBack: () => void }) {
  return (
    <section className="building" aria-label={`${f.label} board, schematic, not to scale`}>
      <p className="boardhead">
        <button onClick={onBack}>Building</button>
        <b>{f.label}</b>
        <span>{f.floor === 0 ? `${f.erCount} in ER, bays ${f.baysUsed}/${f.units[0].beds.length}` : `${f.census} patients, ${f.occupancyPct ?? "–"}% of beds occupied`}, {f.nurses} nurses{f.ratio === null ? "" : ` (1:${f.ratio}${f.floor === 4 ? "" : ", display"})`}, {f.floor === 0 ? `${f.boarders} boarders` : `${f.boarders} boarding in ER for here`}</span>
        {f.deathsToday !== null && <span>{f.deathsToday} deaths today</span>}
      </p>
      {f.units.map((u) => (
        <div className="board" key={u.id}>
          <h2>{u.name} <small>{u.census} {u.id === "ER" || u.id === "MORGUE" ? "here" : "occupied"}, {u.beds.length} {u.id === "ER" ? "bays" : u.id === "MORGUE" ? "drawers" : "beds"}, {u.nurses} nurses</small></h2>
          {u.id === "ER" && (
            <>
              <p className="erline"><span className="cells">{u.queue.slice(0, QUEUE_DRAWN).map((t, i) => <i key={i} className="fig big" style={{ background: TRIAGE_COLOURS[t] }} />)}{u.queue.length > QUEUE_DRAWN && <span className="tiny">+{u.queue.length - QUEUE_DRAWN}</span>}</span></p>
              <p className="tiny">{queueText(u.queue)}; {u.consult} in consult, {u.workup} in work-up. Triage desk at the door.</p>
            </>
          )}
          <div className="bedrows">
            {u.beds.map((c, i) => <Big key={i} c={c} label={`${i + 1}`} monitored={u.id === "W4"} />)}
          </div>
          {u.stretchers.length + u.over.length > 0 && (
            <div className="bedrows corridor" aria-label="Corridor">
              {[...u.stretchers, ...u.over].map((c, i) => <Big key={i} c={c} label="" monitored={false} str />)}
            </div>
          )}
          {u.id === "ER" && <Chips u={u} />}
          {u.id === "MORGUE" && f.awaitingMorgue > 0 && <p className="tiny">{f.awaitingMorgue} awaiting transfer to the morgue</p>}
        </div>
      ))}
      <Legend />
      <p className="legend">Schematic, not to scale. Station: nurses and relatives gather here (not drawn).</p>
    </section>
  );
}

function Big({ c, label, monitored, str }: { c: Cell | null; label: string; monitored: boolean; str?: boolean }) {
  return (
    <span className={`bcell${str ? " str" : ""}${c ? " full" : ""}`} title={c ? cellTitle(c, monitored) : "empty"}>
      <small>{label}</small>
      {c && <b>{c.dead ? "×" : c.initials}{c.icu && "!"}</b>}
      {c && <i className="stripe" style={{ background: cellColour(c, monitored) }} />}
    </span>
  );
}
