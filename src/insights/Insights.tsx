// The Analytics page: charts first, short labels. It draws only the summary and the patients it is given.
// Every string from data is React text. Nothing from data goes in a link, a style or a class name.
import { useState } from "react";
import { VITAL_CARD } from "../panels";
import { RISK_LIGHT } from "../render/draw";
import type { Patient } from "../sim/sim";
import type { WardSummary } from "../sim/ward-stats";
import { LineChart, StackedBars, Strip, type Slot } from "./charts";

export type Person = Pick<Patient, "id" | "name" | "bed" | "stay" | "history">;
/** hospital: the standalone hospital world. ward: a standalone W4 only. viewer: the runner's ward, whose totals this page does not have. */
export type Mode = "hospital" | "ward" | "viewer";

const NO_DATA = "No data yet";
const NO_STAY = "No finished stay yet (stays that began before the run are not counted)";
const NOT_YET = "Not available from the runner yet";
const LEVELS = ["low", "low_medium", "medium", "high", "not_ranked"] as const;
const LEVEL_NAME: Record<(typeof LEVELS)[number], string> = { low: "low", low_medium: "low-medium", medium: "medium", high: "high", not_ranked: "not ranked" };
const LEVEL_COLOR = [RISK_LIGHT.low, RISK_LIGHT.low_medium, RISK_LIGHT.medium, RISK_LIGHT.high, "var(--ink-300)"];
const FLOW_NAME = ["admitted", "discharged", "transferred in", "transferred out"] as const;
const FLOW_COLOR = ["var(--ink-700)", "var(--ink-300)", "var(--cream-300)", "var(--lemon)"];
const OUTCOME_COLOR = { discharged: "var(--ink-500)", higher_care: "var(--lemon)" };
const VITALS = Object.keys(VITAL_CARD) as (keyof typeof VITAL_CARD)[];
const arr = <T,>(x: T[] | undefined | null): T[] => (Array.isArray(x) ? x : []);
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** A number as text; one that is not finite is not printed. */
const n = (v: unknown) => (fin(v) ? String(v) : "no reading");
/** A vital as the ward's vital cards print it: the same digits and unit. */
const vital = (k: keyof typeof VITAL_CARD, v: number | null | undefined) => (fin(v) ? `${v.toFixed(VITAL_CARD[k].digits)} ${VITAL_CARD[k].unit}` : "no reading");

function Legend({ names, colors }: { names: readonly string[]; colors: string[] }) {
  return (
    <ul className="legend">
      {names.map((n, i) => (
        <li key={n}>
          <svg width={10} height={10} aria-hidden="true">
            <rect width={10} height={10} fill={colors[i]} stroke="var(--ink-900)" />
          </svg>{" "}
          {n}
        </li>
      ))}
    </ul>
  );
}

/** A chart: its name, the picture, one line of text. `empty` or `note` replace the picture. */
function Fig({ name, caption, note, children }: { name: string; caption: string; note?: string; children?: React.ReactNode }) {
  return (
    <figure className="fig">
      <h4>{name}</h4>
      {note === undefined ? children : null}
      <figcaption>{note ?? caption}</figcaption>
    </figure>
  );
}

/** Rows in order, with "skip" where a step is missing between two of them. */
function withGaps<T>(rows: T[], at: (r: T) => number, step: number): Slot<T>[] {
  const out: Slot<T>[] = [];
  rows.forEach((r, i) => {
    if (i > 0 && at(r) - at(rows[i - 1]) > step) out.push("skip");
    out.push(r);
  });
  return out;
}

const last = <T,>(xs: T[]) => xs[xs.length - 1];
const placeWord = (id: string) => (id === "MORGUE" ? "places" : "beds"); // the morgue holds drawers, not beds

function Hospital({ mode, sum }: { mode: Mode; sum: WardSummary | null }) {
  if (mode === "ward") return <p>This page simulates ward W4 only.</p>;
  if (mode === "viewer") return <p>The runner runs ward W4 only.</p>;
  const h = sum?.hospital;
  const units = arr(h?.units);
  const note = arr(h?.hours).length === 0 || units.length === 0 ? NO_DATA : undefined;
  const byFloor = new Map<number, NonNullable<WardSummary["hospital"]>["units"]>();
  for (const u of units) byFloor.set(u.floor, [...(byFloor.get(u.floor) ?? []), u]);
  const hours = (id: string) => arr(h?.hours).filter((r) => r.unit === id).sort((a, b) => a.hour - b.hour);
  return (
    <>
      <Fig name="Beds in use" caption="Per unit, per hour. Dashed line: beds. The morgue counts places." note={note}>
        {[...byFloor].sort((a, b) => a[0] - b[0]).map(([floor, units]) => (
          <div key={floor} className="floorrow">
            <h5>Floor {n(floor)}</h5>
            {units.map((u) => {
              const rows = hours(u.id);
              return (
                <div key={u.id} className="unit">
                  <span>
                    {u.name}: {n(last(rows)?.census)} of {n(u.beds)}
                    {u.id === "MORGUE" ? " places" : ""}
                  </span>
                  <LineChart values={withGaps(rows, (r) => r.hour, 1).map((r) => (r === "skip" || r === null ? r : r.census))} refLine={u.beds} label={`${u.name} ${placeWord(u.id)} in use`} height={46} />
                </div>
              );
            })}
          </div>
        ))}
      </Fig>
      <Fig name="In and out" caption="Counts from the simulator. Per unit, per day." note={note}>
        {units.map((u) => {
          const days = new Map<number, number[]>();
          for (const r of hours(u.id)) {
            const d = days.get(Math.floor(r.hour / 24)) ?? [0, 0, 0, 0, 0];
            [r.admitted_in, r.discharged, r.transferred_in, r.transferred_out, r.arrivals].forEach((v, i) => (d[i] += v));
            days.set(Math.floor(r.hour / 24), d);
          }
          const er = u.id === "ER";
          const keys = [...days.keys()].sort((a, b) => a - b);
          const bars = withGaps(keys.map((k) => ({ k, parts: days.get(k)! })), (r) => r.k, 1).map((r) => (r === "skip" || r === null ? r : { parts: er ? r.parts : r.parts.slice(0, 4) }));
          return (
            <div key={u.id} className="unit">
              <span>{u.name}</span>
              <Legend names={er ? [...FLOW_NAME, "arrivals"] : FLOW_NAME} colors={er ? [...FLOW_COLOR, "var(--ink-900)"] : FLOW_COLOR} />
              <StackedBars bars={bars} colors={er ? [...FLOW_COLOR, "var(--ink-900)"] : FLOW_COLOR} label={`${u.name} in and out`} height={50} />
            </div>
          );
        })}
      </Fig>
    </>
  );
}

function Ward({ mode, sum }: { mode: Mode; sum: WardSummary | null }) {
  const note = mode === "viewer" ? NOT_YET : undefined;
  const empty = (n: number) => (note ?? (n === 0 ? NO_DATA : undefined));
  const levels = sum?.levels ?? [];
  const hourly = withGaps(levels.filter((r) => r.m % 60 === 0), (r) => r.m, 60);
  const rows = hourly.filter((r) => r !== "skip" && r !== null);
  const now = last(rows);
  const shifts = sum?.shifts ?? [];
  const lastShift = last(shifts);
  const rate = (x: { alerts: number; patientMin: number }) => (x.patientMin === 0 ? 0 : (x.alerts * 720) / x.patientMin);
  const stays = sum?.stays ?? [];
  const lens = stays.map((x) => x.outMin - x.inMin);
  const longest = Math.max(1, ...lens.filter(fin));
  return (
    <>
      <Fig
        name="NEWS2 levels"
        caption={now ? `Last hour: ${LEVELS.map((k) => `${LEVEL_NAME[k]} ${n(now[k])}`).join(", ")}.` : NO_DATA}
        note={empty(rows.length)}
      >
        <Legend names={LEVELS.map((k) => LEVEL_NAME[k])} colors={LEVEL_COLOR} />
        <StackedBars bars={hourly.map((r) => (r === "skip" || r === null ? r : { parts: LEVELS.map((k) => r[k]), title: LEVELS.map((k) => `${LEVEL_NAME[k]} ${n(r[k])}`).join(", ") }))} colors={LEVEL_COLOR} label="NEWS2 levels per hour" scale={Math.max(1, ...rows.map((r) => r.beds))} />
      </Fig>
      <Fig
        name="Alerts per patient per shift"
        caption={lastShift ? `Alert = NEWS2 5 or more (demo line). Last shift: ${n(lastShift.alerts)} alerts, ${n(lastShift.patientMin)} patient-min${lastShift.partial ? ", part shift" : ""}.` : NO_DATA}
        note={empty(shifts.length)}
      >
        <StackedBars
          bars={shifts.map((x) => ({ parts: [rate(x)], title: `${n(x.alerts)} alerts, ${n(x.patientMin)} patient-min${x.partial ? ", part shift" : ""}` }))}
          colors={["var(--ink-700)"]}
          label="Alerts per patient per shift"
          faded={shifts.flatMap((x, i) => (x.partial ? [i] : []))}
        />
      </Fig>
      <Fig name="Beds in use" caption={now ? `Last hour: ${n(now.beds)} beds in use.` : NO_DATA} note={empty(rows.length)}>
        <LineChart values={hourly.map((r) => (r === "skip" || r === null ? r : r.beds))} label="Beds in use per hour" />
      </Fig>
      <Fig name="Length of stay" caption="Finished stays, left shorter, right longer. Coloured by how the stay ended." note={note ?? (stays.length === 0 ? NO_STAY : undefined)}>
        <Legend names={["discharged", "higher care"]} colors={[OUTCOME_COLOR.discharged, OUTCOME_COLOR.higher_care]} />
        <Strip
          dots={stays.map((x, i) => ({ at: lens[i] / longest, row: i, color: OUTCOME_COLOR[x.outcome], title: `${x.outcome === "discharged" ? "discharged" : "higher care"}, in ${n(x.inMin)}, out ${n(x.outMin)}` }))}
          label="Length of stay"
        />
      </Fig>
    </>
  );
}

function PersonSection({ patients, label }: { patients: Person[]; label: (minute: number) => string }) {
  const [picked, setPicked] = useState("");
  const list = arr(patients);
  const p = list.find((x) => x.id === picked) ?? list[0];
  if (!p) {
    return (
      <div className="figs">
        {["NEWS2 by hour", "What happened", "Vitals, last 3 h"].map((name) => (
          <Fig key={name} name={name} caption={NO_DATA} note={NO_DATA} />
        ))}
      </div>
    );
  }
  const scores = arr(p.stay?.scores);
  const have = scores.filter(fin);
  const events = arr(p.stay?.events).slice(-30);
  const hist = (k: keyof typeof VITAL_CARD) => arr(p.history?.[k]);
  const mins = events.map((e) => e.minute).filter(fin);
  const first = mins.length ? Math.min(...mins) : 0;
  const span = Math.max(1, (mins.length ? Math.max(...mins) : 0) - first);
  const spot = (m: number) => {
    const r = (m - first) / span;
    return fin(r) ? Math.min(1, Math.max(0, r)) : 0;
  };
  const noVitals = VITALS.every((k) => hist(k).every((x) => !fin(x)));
  return (
    <>
      <label>
        Person{" "}
        <select value={p.id} onChange={(e) => setPicked(e.target.value)}>
          {list.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}, bed {x.bed}
            </option>
          ))}
        </select>
      </label>
      <div className="figs">
        <Fig name="NEWS2 by hour" caption={have.length ? `Last score: ${n(last(have))}. Dashed line: 5.` : NO_DATA} note={have.length ? undefined : NO_DATA}>
          <LineChart values={scores} refLine={5} label="NEWS2 by hour" />
        </Fig>
        <Fig name="What happened" caption={events.length ? `Last: ${label(last(events).minute)}, ${last(events).text}` : NO_DATA} note={events.length ? undefined : NO_DATA}>
          <div className="scroll">
            <svg viewBox={`0 0 300 ${events.length * 14 + 8}`} role="img" aria-label="What happened" className="chart">
              {events.map((e, i) => (
                <g key={i}>
                  <circle cx={(6 + spot(e.minute) * 60).toFixed(1)} cy={11 + i * 14} r={2.5} fill="var(--ink-900)" />
                  <text x={74} y={14 + i * 14} fontSize={9} fill="var(--ink-900)">
                    {label(e.minute)} {String(e.text).slice(0, 70)}
                  </text>
                </g>
              ))}
            </svg>
          </div>
        </Fig>
        <Fig name="Vitals, last 3 h" caption={`Last: ${VITALS.map((k) => `${VITAL_CARD[k].label} ${vital(k, last(hist(k)))}`).join(", ")}.`} note={noVitals ? NO_DATA : undefined}>
          {VITALS.map((k) => (
            <div key={k} className="unit">
              <span>{VITAL_CARD[k].label}</span>
              <LineChart values={hist(k)} label={VITAL_CARD[k].label} height={40} fit />
            </div>
          ))}
        </Fig>
      </div>
    </>
  );
}

export default function Insights({ mode, summary, patients, label }: { mode: Mode; summary: WardSummary | null; patients: Person[]; label: (minute: number) => string }) {
  return (
    <section className="insights" aria-label="Analytics">
      <h2>Analytics</h2>
      <p>Synthetic hospital. Simulated patients. No outcome claim.</p>
      <h3>Hospital</h3>
      <div className="figs">
        <Hospital mode={mode} sum={summary} />
      </div>
      <h3>Ward W4</h3>
      <p>NEWS2 exists on W4 only</p>
      <div className="figs">
        <Ward mode={mode} sum={summary} />
      </div>
      <h3>Person</h3>
      <PersonSection patients={patients} label={label} />
    </section>
  );
}
