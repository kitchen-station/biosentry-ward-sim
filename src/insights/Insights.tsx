// The Analytics page: charts first, short labels. It draws only the summary and the patients it is given.
// Every string from data is React text. Nothing from data goes in a link, a style or a class name.
import { useState } from "react";
import { RISK_LIGHT } from "../render/draw";
import type { Patient } from "../sim/sim";
import type { WardSummary } from "../sim/ward-stats";
import { LineChart, StackedBars, Strip, type Slot } from "./charts";

export type Person = Pick<Patient, "id" | "name" | "bed" | "stay" | "history">;
/** hospital: the standalone hospital world. ward: a standalone W4 only. viewer: the runner's ward, whose totals this page does not have. */
export type Mode = "hospital" | "ward" | "viewer";

const NO_DATA = "No data yet";
const NOT_YET = "Not available from the runner yet";
const LEVELS = ["low", "low_medium", "medium", "high", "not_ranked"] as const;
const LEVEL_NAME: Record<(typeof LEVELS)[number], string> = { low: "low", low_medium: "low-medium", medium: "medium", high: "high", not_ranked: "not ranked" };
const LEVEL_COLOR = [RISK_LIGHT.low, RISK_LIGHT.low_medium, RISK_LIGHT.medium, RISK_LIGHT.high, "var(--ink-300)"];
const FLOW_NAME = ["admitted", "discharged", "transferred in", "transferred out"] as const;
const FLOW_COLOR = ["var(--ink-700)", "var(--ink-300)", "var(--cream-300)", "var(--lemon)"];
const OUTCOME_COLOR = { discharged: "var(--ink-500)", higher_care: "var(--lemon)" };
const VITAL_NAME = { heart_rate: "Heart rate", respiratory_rate: "Resp. rate", spo2: "SpO2", temperature: "Temperature" } as const;

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

function Hospital({ mode, sum }: { mode: Mode; sum: WardSummary | null }) {
  if (mode === "ward") return <p>This page simulates ward W4 only.</p>;
  const h = mode === "viewer" ? null : sum?.hospital;
  const note = mode === "viewer" ? NOT_YET : !h || h.hours.length === 0 ? NO_DATA : undefined;
  const byFloor = new Map<number, NonNullable<WardSummary["hospital"]>["units"]>();
  for (const u of h?.units ?? []) byFloor.set(u.floor, [...(byFloor.get(u.floor) ?? []), u]);
  const hours = (id: string) => (h?.hours ?? []).filter((r) => r.unit === id).sort((a, b) => a.hour - b.hour);
  return (
    <>
      <Fig name="Beds in use" caption="Per unit, per hour. Dashed line: beds." note={note}>
        {[...byFloor].sort((a, b) => a[0] - b[0]).map(([floor, units]) => (
          <div key={floor} className="floorrow">
            <h5>Floor {floor}</h5>
            {units.map((u) => {
              const rows = hours(u.id);
              return (
                <div key={u.id} className="unit">
                  <span>
                    {u.name}: {last(rows)?.census ?? "none"} of {u.beds}
                  </span>
                  <LineChart values={withGaps(rows, (r) => r.hour, 1).map((r) => (r === "skip" || r === null ? r : r.census))} refLine={u.beds} label={`${u.name} beds in use`} height={46} />
                </div>
              );
            })}
          </div>
        ))}
      </Fig>
      <Fig name="In and out" caption="Counts from the simulator. Per unit, per day." note={note}>
        {h?.units.map((u) => {
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
  const longest = Math.max(1, ...lens);
  return (
    <>
      <Fig
        name="NEWS2 levels"
        caption={now ? `Last hour: ${LEVELS.map((k) => `${LEVEL_NAME[k]} ${now[k]}`).join(", ")}.` : NO_DATA}
        note={empty(rows.length)}
      >
        <Legend names={LEVELS.map((k) => LEVEL_NAME[k])} colors={LEVEL_COLOR} />
        <StackedBars bars={hourly.map((r) => (r === "skip" || r === null ? r : { parts: LEVELS.map((k) => r[k]), title: `${LEVELS.map((k) => `${LEVEL_NAME[k]} ${r[k]}`).join(", ")}` }))} colors={LEVEL_COLOR} label="NEWS2 levels per hour" scale={Math.max(1, ...rows.map((r) => r.beds))} />
      </Fig>
      <Fig
        name="Alerts per patient per shift"
        caption={lastShift ? `Alert = NEWS2 5 or more (demo line). Last shift: ${lastShift.alerts} alerts, ${lastShift.patientMin} patient-min${lastShift.partial ? ", part shift" : ""}.` : NO_DATA}
        note={empty(shifts.length)}
      >
        <StackedBars
          bars={shifts.map((x) => ({ parts: [rate(x)], title: `${x.alerts} alerts, ${x.patientMin} patient-min${x.partial ? ", part shift" : ""}` }))}
          colors={["var(--ink-700)"]}
          label="Alerts per patient per shift"
          faded={shifts.flatMap((x, i) => (x.partial ? [i] : []))}
        />
      </Fig>
      <Fig name="Beds in use" caption={now ? `Last hour: ${now.beds} beds in use.` : NO_DATA} note={empty(rows.length)}>
        <LineChart values={hourly.map((r) => (r === "skip" || r === null ? r : r.beds))} label="Beds in use per hour" />
      </Fig>
      <Fig name="Length of stay" caption={stays.length === 0 ? NO_DATA : "Finished stays, left shorter, right longer. Coloured by outcome."} note={empty(stays.length)}>
        <Legend names={["discharged", "higher care"]} colors={[OUTCOME_COLOR.discharged, OUTCOME_COLOR.higher_care]} />
        <Strip
          dots={stays.map((x, i) => ({ at: lens[i] / longest, row: i, color: OUTCOME_COLOR[x.outcome], title: `${x.outcome === "discharged" ? "discharged" : "higher care"}, in ${x.inMin}, out ${x.outMin}` }))}
          label="Length of stay"
        />
      </Fig>
    </>
  );
}

function PersonSection({ patients, label }: { patients: Person[]; label: (minute: number) => string }) {
  const [picked, setPicked] = useState("");
  const p = patients.find((x) => x.id === picked) ?? patients[0];
  if (!p) {
    return (
      <>
        {["NEWS2 by hour", "What happened", "Vitals, last 3 h"].map((n) => (
          <Fig key={n} name={n} caption={NO_DATA} note={NO_DATA} />
        ))}
      </>
    );
  }
  const scores = p.stay.scores;
  const have = scores.filter((v): v is number => v !== null);
  const events = p.stay.events.slice(-30);
  const first = events[0]?.minute ?? 0;
  const span = Math.max(1, (last(events)?.minute ?? 0) - first);
  return (
    <>
      <label>
        Person{" "}
        <select value={p.id} onChange={(e) => setPicked(e.target.value)}>
          {patients.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}, bed {x.bed}
            </option>
          ))}
        </select>
      </label>
      <Fig name="NEWS2 by hour" caption={have.length ? `Last score: ${last(have)}. Dashed line: 5.` : NO_DATA} note={have.length ? undefined : NO_DATA}>
        <LineChart values={scores} refLine={5} label="NEWS2 by hour" />
      </Fig>
      <Fig name="What happened" caption={events.length ? `Last: ${label(last(events).minute)}, ${last(events).text}` : NO_DATA} note={events.length ? undefined : NO_DATA}>
        <svg viewBox={`0 0 300 ${events.length * 14 + 8}`} role="img" aria-label="What happened" className="chart">
          {events.map((e, i) => (
            <g key={i}>
              <circle cx={6 + ((e.minute - first) / span) * 60} cy={11 + i * 14} r={2.5} fill="var(--ink-900)" />
              <text x={74} y={14 + i * 14} fontSize={9} fill="var(--ink-900)">
                {label(e.minute)} {e.text.slice(0, 70)}
              </text>
            </g>
          ))}
        </svg>
      </Fig>
      <Fig
        name="Vitals, last 3 h"
        caption={`Last: ${(Object.keys(VITAL_NAME) as (keyof typeof VITAL_NAME)[]).map((v) => `${VITAL_NAME[v]} ${last(p.history[v]) ?? "no reading"}`).join(", ")}.`}
        note={(Object.keys(VITAL_NAME) as (keyof typeof VITAL_NAME)[]).every((v) => p.history[v].every((x) => x === null)) ? NO_DATA : undefined}
      >
        {(Object.keys(VITAL_NAME) as (keyof typeof VITAL_NAME)[]).map((v) => (
          <div key={v} className="unit">
            <span>{VITAL_NAME[v]}</span>
            <LineChart values={p.history[v]} label={VITAL_NAME[v]} height={40} />
          </div>
        ))}
      </Fig>
    </>
  );
}

export default function Insights({ mode, summary, patients, label }: { mode: Mode; summary: WardSummary | null; patients: Person[]; label: (minute: number) => string }) {
  return (
    <section className="insights" aria-label="Analytics">
      <h2>Analytics</h2>
      <p>Synthetic hospital. Simulated patients. No outcome claim.</p>
      <h3>Hospital</h3>
      <Hospital mode={mode} sum={summary} />
      <h3>Ward W4</h3>
      <p>NEWS2 exists on W4 only</p>
      <Ward mode={mode} sum={summary} />
      <h3>Person</h3>
      <PersonSection patients={patients} label={label} />
    </section>
  );
}
