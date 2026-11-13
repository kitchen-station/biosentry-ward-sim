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
const xAt = (i: number, n: number) => PAD + (n <= 1 ? (W - 2 * PAD) / 2 : (i * (W - 2 * PAD)) / (n - 1));
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
 * One line over equal steps. `refLine` is a dashed horizontal line (a fixed level, or a bed count).
 * The y axis starts at 0, or with `fit` runs over the data's own range with a little padding, as Sparkline does.
 */
export function LineChart({ values, refLine, label, height = 70, color = ink, fit = false }: { values: Slot<number>[]; refLine?: number; label: string; height?: number; color?: string; fit?: boolean }) {
  const id = useHatch();
  const vs = values.map((v) => (v === "skip" ? v : num(v)));
  const nums = vs.filter((v): v is number => typeof v === "number");
  const ref = num(refLine);
  const fitted = fit && nums.length > 0;
  const lo = fitted ? Math.min(...nums) : 0;
  const range = fitted ? Math.max(...nums) - lo || 1 : Math.max(1, ...nums, ref ?? 0);
  const pad = fitted ? 8 : PAD;
  const y = (v: number) => clamp(height - pad - ((v - lo) / range) * (height - 2 * pad), 0, height);
  const n = vs.length;
  const runs: [number, number][][] = [[]];
  vs.forEach((v, i) => {
    if (typeof v === "number") runs[runs.length - 1].push([xAt(i, n), y(v)]);
    else if (runs[runs.length - 1].length) runs.push([]);
  });
  return (
    <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={label} className="chart">
      <Hatch id={id} />
      {vs.map((v, i) => (v === "skip" ? <Skipped key={i} id={id} x={xAt(i, n) - slotW(n) / 2} w={slotW(n)} h={height} /> : null))}
      <line x1={PAD} x2={W - PAD} y1={height - PAD} y2={height - PAD} stroke={ink} strokeWidth={1} />
      {ref !== null && (!fitted || (ref >= lo && ref <= lo + range)) && <line x1={PAD} x2={W - PAD} y1={f(y(ref))} y2={f(y(ref))} stroke={ink} strokeWidth={1} strokeDasharray="3 3" />}
      {runs.map((r, i) => (r.length === 1 ? <circle key={i} cx={f(r[0][0])} cy={f(r[0][1])} r={2} fill={color} /> : r.length > 1 ? <polyline key={i} points={r.map(([x, yy]) => `${f(x)},${f(yy)}`).join(" ")} fill="none" stroke={color} strokeWidth={2} /> : null))}
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
