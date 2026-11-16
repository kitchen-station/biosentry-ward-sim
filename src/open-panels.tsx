// The side panel of the public page when the server runs a whole hospital: where you are, what is on this level, and one
// bed's card. Everything shown comes from the open answers (beds only). No name, vitals or score is ever here.
import { bedSel, inOrder, openBedOf, OPEN_UNITS, type OpenViews } from "./open-hospital";
import type { OpenBed } from "./open-view";
import { RISK_LIGHT } from "./render/draw";
import type { RunUnit } from "./sim/hospital/units";
import { RISK_WORDS } from "./vital-cards";

const GREY = "#A899B5";
const floorLabel = (floor: number) => (floor === 0 ? "GF" : `${floor}F`);
/** Why a unit's beds carry no NEWS2 colour, in the unit's own words. */
const KIND_NOTE: Record<RunUnit["kind"], string | null> = {
  ranked: null,
  shown: "Shown, not ranked: NEWS2 is a ward score.",
  unranked: "Not scored: NEWS2 is a ward score, not an intensive care score.",
};
const bedWord = (b: OpenBed) => (b.risk !== null ? RISK_WORDS[b.risk] : "Not ranked");

/** Units from the top floor down, as the building stands. */
const byFloor = () => [...OPEN_UNITS].sort((a, b) => b.floor - a.floor);

function Crumbs({ unit, bed, onUp }: { unit: RunUnit | null; bed: string | null; onUp: (to: "hospital" | "floor") => void }) {
  return (
    <nav className="crumbs" aria-label="Where you are">
      {unit ? <button onClick={() => onUp("hospital")}>Hospital</button> : <b aria-current="page">Hospital</b>}
      {unit && " › "}
      {unit && (bed ? <button onClick={() => onUp("floor")}>{floorLabel(unit.floor)} {unit.name}</button> : <b aria-current="page">{floorLabel(unit.floor)} {unit.name}</b>)}
      {bed && " › "}
      {bed && <b aria-current="page">Bed {bed}</b>}
    </nav>
  );
}

function Beds({ unit, beds, onSelect }: { unit: RunUnit; beds: OpenBed[]; onSelect: (id: string) => void }) {
  if (beds.length === 0) return <p className="tiny">No bed in use.</p>;
  return (
    <ul className="beds" aria-label={`${unit.name}: beds${unit.kind === "ranked" ? ", highest rank first" : ""}`}>
      {inOrder(beds).map((b) => (
        <li key={b.bed}>
          <button onClick={() => onSelect(bedSel(unit.id, b.bed))}>
            <i style={{ background: b.risk !== null ? RISK_LIGHT[b.risk] : GREY }} /> Bed {b.bed}
            {b.rank !== null ? ` · Rank ${b.rank}` : ""} · {bedWord(b)}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * `view`: the floor that is open, null for the whole building. `selected`: a bed, or anything else clicked on the drawing.
 * `onView` opens a floor or goes back to the building; `onSelect` picks a bed or clears the pick.
 */
export function OpenHospitalPanel({ views, view, selected, speed, onView, onSelect }: {
  views: OpenViews; view: number | null; selected: string | null; speed: number;
  onView: (floor: number | null) => void; onSelect: (id: string | null) => void;
}) {
  const picked = openBedOf(views, selected);
  const here = picked ? [picked.unit] : view === null ? [] : OPEN_UNITS.filter((u) => u.floor === view);
  const unit = here[0] ?? null;
  const up = (to: "hospital" | "floor") => {
    onSelect(null);
    if (to === "hospital") onView(null);
  };
  const legend = (
    <ul className="key">
      {Object.entries(RISK_WORDS).map(([risk, word]) => (
        <li key={risk}>
          <i style={{ background: RISK_LIGHT[risk] }} /> {word}
        </li>
      ))}
      <li>
        <i style={{ background: GREY }} /> Not ranked
      </li>
    </ul>
  );

  if (picked) {
    const { bed } = picked;
    return (
      <aside className="panel command">
        <Crumbs unit={picked.unit} bed={bed.bed} onUp={up} />
        <div className="chead">
          <h2>Bed {bed.bed}</h2>
          <span className="pill">{bedWord(bed)}</span>
        </div>
        <p className="story">{picked.unit.name}, {floorLabel(picked.unit.floor)}.</p>
        {bed.rank !== null && <p className="story">Rank {bed.rank} in this unit.</p>}
        {KIND_NOTE[picked.unit.kind] && <p className="story">{KIND_NOTE[picked.unit.kind]}</p>}
        <p className="story">Read-only. Sign in to see this patient's vitals.</p>
        <button onClick={() => up("floor")}>Back to {picked.unit.name}</button>
      </aside>
    );
  }

  if (unit) {
    return (
      <aside className="panel command">
        <Crumbs unit={unit} bed={null} onUp={up} />
        <div className="scroll">
          {here.map((u) => (
            <section key={u.id}>
              <h2 className="ptitle">{u.name}</h2>
              {KIND_NOTE[u.kind] && <p className="tiny">{KIND_NOTE[u.kind]}</p>}
              {views[u.id] ? <Beds unit={u} beds={views[u.id].beds} onSelect={onSelect} /> : <p className="tiny">No answer from the server yet.</p>}
            </section>
          ))}
        </div>
        {legend}
        <button onClick={() => up("hospital")}>Back to the hospital</button>
      </aside>
    );
  }

  return (
    <aside className="panel command">
      <Crumbs unit={null} bed={null} onUp={up} />
      <h2 className="ptitle">One hospital, running on the team server</h2>
      <p className="story">
        This is a simulated hospital{speed > 0 ? `, running at ${speed}x: 1 minute here is ${speed} hospital minute${speed === 1 ? "" : "s"}` : ""}. Every patient is synthetic. Pick a floor, then a bed. Read-only. Sign in to control.
      </p>
      <ul className="beds" aria-label="Floors, top floor first">
        {byFloor().map((u) => (
          <li key={u.id}>
            <button onClick={() => onView(u.floor)}>
              {floorLabel(u.floor)} {u.name} · {views[u.id] ? `${views[u.id].beds.length} bed${views[u.id].beds.length === 1 ? "" : "s"} in use` : "no answer yet"}
            </button>
          </li>
        ))}
      </ul>
      {legend}
      <p className="tiny">Escape goes up one level. Staff on ward W4 walk a set loop; it is not a product feature.</p>
      <p className="tiny">
        The clinicians' view of a sample ward: <a href="https://biosentry-dashboard.pages.dev" target="_blank" rel="noopener noreferrer">open the dashboard</a>.
      </p>
    </aside>
  );
}
