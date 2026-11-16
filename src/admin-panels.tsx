// The side panel of a signed-in hospital admin: every unit, its patients with names, NEWS2 and vitals, the unit's history
// and one patient. Read-only: there is no control here. Everything shown came from a signed-in route; a value the server
// did not send is said to be missing, never filled in.
import { ADMIN_VITALS, type AdminPatient, type AdminRow, type AdminRows, type AdminStay, type AdminUnit, type AdminValue } from "./admin-view";
import { ago } from "./open-panels";
import { UNITS } from "./sim/hospital/params";
import { RISK_WORDS, VITAL_CARD } from "./vital-cards";

/** What the page knows of one answer: not asked yet, on its way, refused, failed, or the answer. */
export type Load<T> = T | "loading" | "denied" | "failed" | null;
const ready = <T,>(v: Load<T>): v is T => v !== null && typeof v !== "string";

const floorLabel = (floor: number | null) => (floor === null ? "" : floor === 0 ? "GF" : `${floor}F`);
/** The unit's floor as the server gives it; the page's own floor when the server says "not known". */
export const adminFloor = (u: AdminUnit): number | null => u.floor ?? UNITS.find((x) => x.id === u.id)?.floor ?? null;
const TREND: Record<string, string> = { rising: "rising", falling: "falling", stable: "stable", insufficient: "not enough readings yet" };
const OUTCOME: Record<string, string> = { discharged: "discharged", higher_care: "moved to higher care", transferred: "moved", died: "died" };
const KIND_NOTE: Record<AdminUnit["kind"], string | null> = { ranked: null, shown: "Shown, not ranked: NEWS2 is a ward score.", unranked: "Not scored: NEWS2 is a ward score, not an intensive care score." };
const NOT_SERVED = "Vitals not served yet.";

const state = (v: "loading" | "denied" | "failed" | null) =>
  v === "denied" ? "The server refused this for your sign-in." : v === "failed" ? "No answer from the server. It is asked again shortly." : "Loading…";

const short = (v: AdminValue, digits: number) => (v.value === null ? "none" : v.value.toFixed(digits));
/** One line of a row's vitals: values only. */
function vitalsLine(r: AdminRow): string {
  const v = r.vitals;
  if (!v) return NOT_SERVED;
  const bp = v.blood_pressure.systolic === null ? "none" : `${v.blood_pressure.systolic}/${v.blood_pressure.diastolic}`;
  return `HR ${short(v.heart_rate, 0)} · RR ${short(v.respiratory_rate, 0)} · SpO2 ${short(v.spo2, 0)} · T ${short(v.temperature, 1)} · BP ${bp}`;
}
const headline = (r: AdminRow) => (r.ranked ? `NEWS2 ${r.ranked.score} · Rank ${r.ranked.rank} · ${TREND[r.ranked.trend]}` : `Not ranked${r.risk ? ` · ${RISK_WORDS[r.risk]}` : ""}`);
const when = (ms: number | null, nowMs: number) => (ms === null ? "time not known" : ago(ms, nowMs));

function Crumbs({ unit, patient, onUp }: { unit: AdminUnit | null; patient: string | null; onUp: (to: "hospital" | "unit") => void }) {
  const here = unit ? `${floorLabel(adminFloor(unit))} ${unit.name}`.trim() : "";
  return (
    <nav className="crumbs" aria-label="Where you are">
      {unit ? <button onClick={() => onUp("hospital")}>Hospital</button> : <b aria-current="page">Hospital</b>}
      {unit && " › "}
      {unit && (patient ? <button onClick={() => onUp("unit")}>{here}</button> : <b aria-current="page">{here}</b>)}
      {patient && " › "}
      {patient && <b aria-current="page">{patient}</b>}
    </nav>
  );
}

function PatientCard({ p }: { p: AdminPatient }) {
  const { row: r, nowMs } = p;
  const v = r.vitals;
  return (
    <>
      <div className="chead">
        <h2>{r.name}</h2>
        <span className="pill">{r.ranked ? `NEWS2 ${r.ranked.score}` : "Not ranked"}</span>
      </div>
      <p className="tiny">Synthetic data</p>
      <p className="story">
        Bed {r.bed}.{r.age !== null ? ` Age ${r.age}.` : ""}{r.sex ? ` ${r.sex}.` : ""} {r.context}
      </p>
      <p className="story">{r.ranked ? `Rank ${r.ranked.rank} in this unit. Trend: ${TREND[r.ranked.trend]}.` : `${r.reason ?? ""}${r.risk ? ` NEWS2 band: ${RISK_WORDS[r.risk]}.` : ""}`}</p>
      {v ? (
        <ul className="plist" aria-label="Latest vitals">
          {ADMIN_VITALS.map((code) => (
            <li key={code}>
              {VITAL_CARD[code].label}: {v[code].value === null ? "none stored" : <><b>{v[code].value!.toFixed(VITAL_CARD[code].digits)}</b> {VITAL_CARD[code].unit}</>} · {v[code].source ?? "source not known"} · {when(v[code].atMs, nowMs)}
            </li>
          ))}
          <li>
            Blood pressure: {v.blood_pressure.systolic === null ? "none stored" : <><b>{v.blood_pressure.systolic}/{v.blood_pressure.diastolic}</b> mmHg</>} · {v.blood_pressure.source ?? "source not known"} · {when(v.blood_pressure.atMs, nowMs)}
          </li>
        </ul>
      ) : (
        <p className="story">{NOT_SERVED}</p>
      )}
    </>
  );
}

export function AdminPanel({ units, view, rows, stays, patient, picked, onView, onPatient }: {
  units: Load<AdminUnit[]>; view: number | null;
  /** The open unit's rows and history. */
  rows: Load<AdminRows>; stays: Load<AdminStay[]>;
  /** The row picked in the open unit (by a row or by a bed on the drawing), and its page once it has come. */
  picked: AdminRow | null; patient: Load<AdminPatient>;
  onView: (floor: number | null) => void; onPatient: (row: AdminRow | null) => void;
}) {
  const list = ready(units) ? units : [];
  const unit = view === null ? null : list.find((u) => adminFloor(u) === view) ?? null;
  const up = (to: "hospital" | "unit") => {
    onPatient(null);
    if (to === "hospital") onView(null);
  };

  if (unit && picked) {
    return (
      <aside className="panel command">
        <Crumbs unit={unit} patient={picked.name} onUp={up} />
        <div className="scroll">
          {ready(patient) && patient.row.id === picked.id ? <PatientCard p={patient} /> : <p className="story">{picked.name}, bed {picked.bed}. {state(ready(patient) ? "loading" : patient)}</p>}
        </div>
        <button onClick={() => up("unit")}>Back to {unit.name}</button>
      </aside>
    );
  }

  if (unit) {
    const ended = ready(stays) ? stays.filter((s) => s.outMs !== null).sort((a, b) => b.outMs! - a.outMs!).slice(0, 20) : [];
    return (
      <aside className="panel command">
        <Crumbs unit={unit} patient={null} onUp={up} />
        <div className="scroll">
          <h2 className="ptitle">{unit.name}</h2>
          {KIND_NOTE[unit.kind] && <p className="tiny">{KIND_NOTE[unit.kind]}</p>}
          {!ready(rows) || rows.unit !== unit.id ? (
            <p className="tiny">{state(ready(rows) ? "loading" : rows)}</p>
          ) : rows.rows.length === 0 ? (
            <p className="tiny">No patient here now.</p>
          ) : (
            <ul className="beds admin" aria-label={`${unit.name}: patients${unit.kind === "ranked" ? ", highest rank first" : ""}`}>
              {rows.rows.map((r) => (
                <li key={r.id}>
                  <button onClick={() => onPatient(r)}>
                    <b>{r.name}</b> · Bed {r.bed} · {headline(r)}
                    <span className="tiny">{vitalsLine(r)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <h2 className="ptitle">Unit history</h2>
          {!ready(stays) ? (
            <p className="tiny">{state(stays)}</p>
          ) : ended.length === 0 ? (
            <p className="tiny">No stay has ended here yet.</p>
          ) : (
            <ul className="plist" aria-label={`${unit.name}: stays that ended, newest first`}>
              {ended.map((s) => (
                <li key={s.id}>
                  {s.name}, bed {s.bed}: {s.outcome ? OUTCOME[s.outcome] : "left"}{s.toUnit ? ` to ${s.toUnit}` : ""}, {ready(rows) ? ago(s.outMs!, rows.nowMs) : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
        <button onClick={() => up("hospital")}>Back to the hospital</button>
      </aside>
    );
  }

  return (
    <aside className="panel command">
      <Crumbs unit={null} patient={null} onUp={up} />
      <h2 className="ptitle">Hospital admin</h2>
      <p className="story">You are signed in as the hospital admin. Every unit and every patient is shown. Read-only: nothing here changes the hospital. Every patient is synthetic.</p>
      {!ready(units) ? (
        <p className="tiny">{state(units)}</p>
      ) : (
        <ul className="beds" aria-label="Units, top floor first">
          {[...units].sort((a, b) => (adminFloor(b) ?? -99) - (adminFloor(a) ?? -99)).map((u) => (
            <li key={u.id}>
              <button disabled={adminFloor(u) === null} onClick={() => onView(adminFloor(u))}>
                {floorLabel(adminFloor(u))} {u.name} · {u.patients} patient{u.patients === 1 ? "" : "s"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="tiny">Pick a unit, then a patient. Escape goes up one level.</p>
    </aside>
  );
}
