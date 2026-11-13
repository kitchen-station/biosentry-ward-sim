// One person across moves (display only): unit bands and small charts over the whole stay. Synthetic data.
// Text only: nothing here sets inner HTML. Ward W4 is not read by the engine, so a W4 span is a break with a link.
import { Sparkline } from "./chart";
import { CAPS, type PersonVitals } from "./sim/hospital/vitals";
import type { UnitId } from "./sim/hospital/params";

export const RECOVERY_NOTE = "Simulated recovery, not modelled.";
export const W4_BREAK = "On W4: see the W4 stay";
export const NOT_READ = "Not read";
export const CAPPED = "Last 200 h";
export const NEWS2_ICU = "NEWS2 is a ward score";

const BIN = 15;

export interface Band { unit: UnitId; kind: "read" | "w4" | "gap"; fromMin: number; endMin: number; w4Id: string | null; recovery: boolean }
export interface Series {
  minutes: number[];
  hr: (number | null)[]; rr: (number | null)[]; spo2: (number | null)[]; temp: (number | null)[]; sbp: (number | null)[]; news2: (number | null)[];
  bands: Band[];
  capped: boolean;
}

/** A 15-minute grid from the first bin to the last. null where there is no bin (W4, a gap) and for NEWS2 in intensive care. */
export function timelineSeries(pv: PersonVitals): Series {
  const out: Series = { minutes: [], hr: [], rr: [], spo2: [], temp: [], sbp: [], news2: [], bands: [], capped: pv.bins.length >= CAPS.bins };
  const first = pv.bins[0]?.m, last = pv.bins.at(-1)?.m;
  if (first === undefined || last === undefined) return out;
  const byMin = new Map(pv.bins.map((b) => [b.m, b]));
  for (let m = first; m <= last; m += BIN) {
    const b = byMin.get(m);
    out.minutes.push(m);
    out.hr.push(b?.hr ?? null); out.rr.push(b?.rr ?? null); out.spo2.push(b?.spo2 ?? null); out.temp.push(b?.temp ?? null); out.sbp.push(b?.sbp ?? null);
    out.news2.push(b && b.unit !== "ICU" ? b.news2 : null);
  }
  pv.spans.forEach((sp, i) => {
    const endMin = pv.spans[i + 1]?.fromMin ?? last + BIN;
    if (endMin <= first) return; // rolled out of the capped bins
    out.bands.push({ unit: sp.unit, kind: sp.gap ? "gap" : sp.unit === "W4" ? "w4" : "read", fromMin: Math.max(sp.fromMin, first), endMin, w4Id: sp.w4Id, recovery: sp.recovery === "not_modelled" });
  });
  return out;
}

const CHARTS: [keyof Pick<Series, "hr" | "rr" | "spo2" | "temp" | "sbp" | "news2">, string][] = [
  ["hr", "Heart rate"], ["rr", "Respiratory rate"], ["spo2", "SpO2"], ["temp", "Temperature"], ["sbp", "Systolic pressure"], ["news2", "NEWS2"],
];

export function PersonTimeline({ pv, onSelect }: { pv: PersonVitals; onSelect: (id: string) => void }) {
  const t = timelineSeries(pv);
  if (t.minutes.length === 0) return <p className="tiny">No readings kept yet.</p>;
  const t0 = t.bands[0]?.fromMin ?? t.minutes[0];
  const span = Math.max(BIN, (t.bands.at(-1)?.endMin ?? t0) - t0);
  return (
    <>
      <h3>Whole stay</h3>
      {t.capped && <p className="tiny">{CAPPED}</p>}
      <div style={{ display: "flex", gap: 1, margin: "2px 0 6px" }}>
        {t.bands.map((b, i) => (
          <div key={i} className="tiny" style={{ flex: `${Math.max(b.endMin - b.fromMin, BIN)} 1 0`, minWidth: 28, overflow: "hidden", border: "1px solid var(--ink-900)", padding: "0 2px" }}>
            {b.kind === "gap" ? NOT_READ : b.kind === "w4" ? (
              <>{W4_BREAK}<br /><button className="linkbtn" onClick={() => onSelect(b.w4Id!)}>Open the W4 stay</button></>
            ) : b.unit}
            {b.recovery && <><br />{RECOVERY_NOTE}</>}
          </div>
        ))}
      </div>
      <p className="tiny">{span >= 120 ? `${Math.round(span / 60)} h` : `${span} min`} in view. Each chart scales to its own data.</p>
      {CHARTS.map(([k, label]) => {
        const vals = t[k].filter((v): v is number => v !== null);
        return (
          <div key={k}>
            <p className="tiny">{label}{vals.length > 0 ? ` · ${Math.min(...vals)} to ${Math.max(...vals)}` : " · none"}{k === "news2" && t.bands.some((b) => b.unit === "ICU") ? ` · blank in intensive care: ${NEWS2_ICU}` : ""}</p>
            <Sparkline data={t[k]} width={300} height={30} />
          </div>
        );
      })}
    </>
  );
}
