// Small SVG pieces for the Analytics page: a line over time, stacked bars, a strip. No dependency.
// They draw numbers they are given and print no number of their own. Colours are passed in by the caller.
// A slot is a value, null (no reading) or "skip" (a span the page was not fed, drawn as a hatched gap labelled "skipped").
// A number that is not finite is dropped, and every position is kept inside the chart.
import { useId } from "react";

export type Slot<T> = T | null | "skip";

const W = 300;
const PAD = 4;
const BIG = 1e12; // a value past this is clamped, so sums and differences stay finite
const ink = "var(--ink-900)";
const soft = "var(--ink-300)";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? clamp(v, -BIG, BIG) : null);
const slotW = (n: number) => (W - 2 * PAD) / Math.max(1, n);
const f = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "0.0");

function Skipped({ x, w, h, id }: { x: number; w: number; h: number; id: string }) {
  return (
    <g>
      <rect x={f(x)} y={0} width={f(Math.max(w, 2))} height={h} fill={`url(#${id})`} />
      <text x={f(x)} y={h - 2} fontSize={8} fill={ink}>
        skipped
      </text>
    </g>
  );
}

const Hatch = ({ id }: { id: string }) => (
  <defs>
    <pattern id={id} width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width={2} height={4} fill={soft} />
    </pattern>
  </defs>
);

const useHatch = () => `skip${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

/**
 * One count over equal steps (beds in use, people read). The y axis starts at 0 and is numbered: 0, the top, and `refLine`
 * (a dashed level such as the bed count) when there is one. `unit` names what is counted. The last value is printed.
 */
export function LineChart({ values, refLine, label, height = 70, color = ink, unit }: { values: Slot<number>[]; refLine?: number; label: string; height?: number; color?: string; unit?: string }) {
  const id = useHatch();
  const L = 22; // room for the axis numbers
  const T = 10;
  const vs = values.map((v) => (v === "skip" ? v : num(v)));
  const nums = vs.filter((v): v is number => typeof v === "number");
  const ref = num(refLine);
  const top = Math.max(1, ...nums, ref ?? 0);
  const y = (v: number) => clamp(height - PAD - (v / top) * (height - PAD - T), 0, height);
  const n = vs.length;
  const x = (i: number) => L + (n <= 1 ? (W - L - PAD) / 2 : (i * (W - L - PAD)) / (n - 1));
  const w = (W - L - PAD) / Math.max(1, n);
  const runs: [number, number][][] = [[]];
  vs.forEach((v, i) => {
    if (typeof v === "number") runs[runs.length - 1].push([x(i), y(v)]);
    else if (runs[runs.length - 1].length) runs.push([]);
  });
  const lastValue = nums.length ? nums[nums.length - 1] : null;
  const marks = [...new Set([0, top, ...(ref !== null ? [ref] : [])])];
  return (
    <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={label} className="chart">
      <Hatch id={id} />
      {vs.map((v, i) => (v === "skip" ? <Skipped key={i} id={id} x={x(i) - w / 2} w={w} h={height} /> : null))}
      <line x1={L} x2={L} y1={T} y2={height - PAD} stroke={ink} strokeWidth={1} />
      <line x1={L} x2={W - PAD} y1={height - PAD} y2={height - PAD} stroke={ink} strokeWidth={1} />
      {marks.map((m) => (
        <text key={m} x={L - 3} y={f(Math.min(height - 1, y(m) + 3))} fontSize={8} textAnchor="end" fill={ink}>{String(m)}</text>
      ))}
      {ref !== null && <line x1={L} x2={W - PAD} y1={f(y(ref))} y2={f(y(ref))} stroke={ink} strokeWidth={1} strokeDasharray="3 3" />}
      {runs.map((r, i) => (r.length === 1 ? <circle key={i} cx={f(r[0][0])} cy={f(r[0][1])} r={2} fill={color} /> : r.length > 1 ? <polyline key={i} points={r.map(([px, py]) => `${f(px)},${f(py)}`).join(" ")} fill="none" stroke={color} strokeWidth={2} /> : null))}
      {unit && <text x={L + 2} y={8} fontSize={8} fill={ink}>{unit}</text>}
      {lastValue !== null && <text x={W - PAD} y={8} fontSize={8} textAnchor="end" fontWeight="bold" fill={ink}>last {String(lastValue)}</text>}
    </svg>
  );
}

/**
 * One vital as an observation chart draws it: the NEWS2 score bands shaded behind (src/obs-bands.ts), a fixed axis with its
 * unit and the band limits as ticks, time left to right, a dot at every reading and a line only between readings that follow
 * each other (a missing reading is a gap, never bridged), and the last value printed. A value off the axis is drawn on its edge.
 * `bands`: the spans to shade, bottom up. `ticks`: axis numbers. `times`: labels under the left end, the middle and the right end.
 */
export function ObsChart({ values, lo, hi, bands, ticks, unit, digits = 0, times, label, height = 96 }: {
  values: Slot<number>[]; lo: number; hi: number; bands: { from: number; to: number; colour: string | null }[]; ticks: number[];
  unit: string; digits?: number; times?: [string, string, string]; label: string; height?: number;
}) {
  const id = useHatch();
  const [L, R, T, B] = [30, 6, 12, 14]; // room for the axis numbers, the last value and the times
  const vs = values.map((v) => (v === "skip" ? v : num(v)));
  const n = vs.length;
  const x = (i: number) => L + (n <= 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
  const y = (v: number) => T + (1 - (clamp(v, lo, hi) - lo) / Math.max(hi - lo, 1e-9)) * (height - T - B);
  const pts = vs.map((v, i) => (typeof v === "number" ? { x: x(i), y: y(v), off: v < lo || v > hi } : null));
  const runs: { x: number; y: number }[][] = [[]];
  pts.forEach((p) => {
    if (p) runs[runs.length - 1].push(p);
    else if (runs[runs.length - 1].length) runs.push([]);
  });
  const nums = vs.filter((v): v is number => typeof v === "number");
  const lastValue = nums.length ? nums[nums.length - 1] : null;
  // Every band limit gets a mark; a number is printed only where it has room (8 px), so close limits do not overprint.
  let room = Infinity;
  const numbered = ticks.map((t) => {
    const ok = Math.abs(room - y(t)) >= 8;
    if (ok) room = y(t);
    return ok;
  });
  const said = lastValue === null ? `${label}: no reading` : `${label}: last ${lastValue.toFixed(digits)} ${unit}, ${nums.length} reading${nums.length === 1 ? "" : "s"}`;
  return (
    <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={said} className="chart obs">
      <Hatch id={id} />
      {bands.map((b, i) => (b.colour ? <rect key={i} x={L} y={f(y(b.to))} width={W - L - R} height={f(Math.max(0, y(b.from) - y(b.to)))} fill={b.colour} opacity={0.55} /> : null))}
      {vs.map((v, i) => (v === "skip" ? <Skipped key={i} id={id} x={x(i) - (W - L - R) / Math.max(1, n) / 2} w={(W - L - R) / Math.max(1, n)} h={height - B} /> : null))}
      <line x1={L} x2={L} y1={T} y2={height - B} stroke={ink} strokeWidth={1} />
      <line x1={L} x2={W - R} y1={height - B} y2={height - B} stroke={ink} strokeWidth={1} />
      {ticks.map((t, i) => (
        <g key={t}>
          <line x1={L - 3} x2={L} y1={f(y(t))} y2={f(y(t))} stroke={ink} strokeWidth={1} />
          {numbered[i] && <text x={L - 5} y={f(y(t) + 3)} fontSize={8} textAnchor="end" fill={ink}>{t.toFixed(digits)}</text>}
        </g>
      ))}
      {runs.map((r, i) => (r.length > 1 ? <polyline key={i} points={r.map((p) => `${f(p.x)},${f(p.y)}`).join(" ")} fill="none" stroke={ink} strokeWidth={1.5} /> : null))}
      {pts.map((p, i) => (p ? <circle key={i} cx={f(p.x)} cy={f(p.y)} r={p.off ? 2.5 : 2} fill={p.off ? "none" : ink} stroke={ink} strokeWidth={1} /> : null))}
      <text x={L} y={9} fontSize={8} fill={ink}>{unit}</text>
      <text x={W - R} y={9} fontSize={9} textAnchor="end" fontWeight="bold" fill={ink}>{lastValue === null ? "no reading" : `last ${lastValue.toFixed(digits)}`}</text>
      {times && (
        <>
          <text x={L} y={height - 3} fontSize={8} fill={ink}>{times[0]}</text>
          <text x={(L + W - R) / 2} y={height - 3} fontSize={8} textAnchor="middle" fill={ink}>{times[1]}</text>
          <text x={W - R} y={height - 3} fontSize={8} textAnchor="end" fill={ink}>{times[2]}</text>
        </>
      )}
    </svg>
  );
}

/** Bars of stacked parts (bottom first). `scale` is the full height: the tallest bar if left out. Each bar may carry a title. */
export function StackedBars({ bars, colors, label, height = 90, scale, faded = [] }: { bars: Slot<{ parts: number[]; title?: string }>[]; colors: string[]; label: string; height?: number; scale?: number; faded?: number[] }) {
  const id = useHatch();
  const n = bars.length;
  const clean = bars.map((b) => (b && b !== "skip" ? { ...b, parts: b.parts.map((p) => clamp(num(p) ?? 0, 0, BIG)) } : b));
  const sums = clean.map((b) => (b && b !== "skip" ? b.parts.reduce((a, x) => a + x, 0) : 0));
  const top = num(scale) ?? Math.max(1, ...sums);
  const w = slotW(n);
  return (
    <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={label} className="chart">
      <Hatch id={id} />
      <line x1={PAD} x2={W - PAD} y1={height - PAD} y2={height - PAD} stroke={ink} strokeWidth={1} />
      {clean.map((b, i) => {
        const x = PAD + i * w;
        if (b === "skip") return <Skipped key={i} id={id} x={x} w={w} h={height} />;
        if (b === null) return null;
        let base = height - PAD;
        return (
          <g key={i} opacity={faded.includes(i) ? 0.5 : 1}>
            {b.title && <title>{b.title}</title>}
            {b.parts.map((p, k) => {
              const h = clamp((p / Math.max(top, 1e-9)) * (height - 2 * PAD), 0, height - 2 * PAD);
              base = Math.max(0, base - h);
              return h > 0 ? <rect key={k} x={f(x + w * 0.1)} y={f(base)} width={f(Math.max(w * 0.8, 1))} height={f(h)} fill={colors[k]} /> : null;
            })}
          </g>
        );
      })}
    </svg>
  );
}

/** Dots on one axis, left to right by `at` (0 to 1) and in `rows` rows, so close ones do not hide each other. */
export function Strip({ dots, rows = 4, label, height = 60 }: { dots: { at: number; row: number; color: string; title: string }[]; rows?: number; label: string; height?: number }) {
  const step = (height - 2 * PAD - 8) / Math.max(1, rows - 1);
  return (
    <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={label} className="chart">
      <line x1={PAD} x2={W - PAD} y1={height - PAD} y2={height - PAD} stroke={ink} strokeWidth={1} />
      {dots.map((d, i) => (
        <circle key={i} cx={f(PAD + 4 + clamp(num(d.at) ?? 0, 0, 1) * (W - 2 * PAD - 8))} cy={f(PAD + 4 + (Math.abs(d.row) % rows) * step)} r={3} fill={d.color} stroke={ink} strokeWidth={0.5}>
          <title>{d.title}</title>
        </circle>
      ))}
    </svg>
  );
}
