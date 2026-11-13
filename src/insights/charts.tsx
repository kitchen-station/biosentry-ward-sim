// Small SVG pieces for the Analytics page: a line over time, stacked bars, a strip. No dependency.
// They draw numbers they are given and print no number of their own. Colours are passed in by the caller.
// A slot is a value, null (no reading) or "skip" (a span the page was not fed, drawn as a hatched gap labelled "skipped").
export type Slot<T> = T | null | "skip";

const W = 300;
const PAD = 4;
const ink = "var(--ink-900)";
const soft = "var(--ink-300)";

const xAt = (i: number, n: number) => PAD + (n <= 1 ? (W - 2 * PAD) / 2 : (i * (W - 2 * PAD)) / (n - 1));
const slotW = (n: number) => (W - 2 * PAD) / Math.max(1, n);
const f = (v: number) => v.toFixed(1);

function Skipped({ x, w, h }: { x: number; w: number; h: number }) {
  return (
    <g>
      <rect x={f(x)} y={0} width={f(Math.max(w, 2))} height={h} fill="url(#skip)" />
      <text x={f(x)} y={h - 2} fontSize={8} fill={ink}>
        skipped
      </text>
    </g>
  );
}

const Hatch = () => (
  <defs>
    <pattern id="skip" width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width={2} height={4} fill={soft} />
    </pattern>
  </defs>
);

/** One line over equal steps. `refLine` is a dashed horizontal line (a fixed level, or a bed count). The y axis starts at 0. */
export function LineChart({ values, refLine, label, height = 70, color = ink }: { values: Slot<number>[]; refLine?: number; label: string; height?: number; color?: string }) {
  const nums = values.filter((v): v is number => typeof v === "number");
  const top = Math.max(1, ...nums, refLine ?? 0);
  const y = (v: number) => height - PAD - (v / top) * (height - 2 * PAD);
  const n = values.length;
  const runs: string[][] = [[]];
  values.forEach((v, i) => {
    if (typeof v === "number") runs[runs.length - 1].push(`${f(xAt(i, n))},${f(y(v))}`);
    else if (runs[runs.length - 1].length) runs.push([]);
  });
  return (
    <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={label} className="chart">
      <Hatch />
      {values.map((v, i) => (v === "skip" ? <Skipped key={i} x={xAt(i, n) - slotW(n) / 2} w={slotW(n)} h={height} /> : null))}
      <line x1={PAD} x2={W - PAD} y1={height - PAD} y2={height - PAD} stroke={ink} strokeWidth={1} />
      {refLine !== undefined && <line x1={PAD} x2={W - PAD} y1={f(y(refLine))} y2={f(y(refLine))} stroke={ink} strokeWidth={1} strokeDasharray="3 3" />}
      {runs.map((r, i) => (r.length === 1 ? <circle key={i} cx={r[0].split(",")[0]} cy={r[0].split(",")[1]} r={2} fill={color} /> : r.length > 1 ? <polyline key={i} points={r.join(" ")} fill="none" stroke={color} strokeWidth={2} /> : null))}
    </svg>
  );
}

/** Bars of stacked parts (bottom first). `scale` is the full height: the tallest bar if left out. Each bar may carry a title. */
export function StackedBars({ bars, colors, label, height = 90, scale, faded = [] }: { bars: Slot<{ parts: number[]; title?: string }>[]; colors: string[]; label: string; height?: number; scale?: number; faded?: number[] }) {
  const n = bars.length;
  const sums = bars.map((b) => (b && b !== "skip" ? b.parts.reduce((a, x) => a + x, 0) : 0));
  const top = scale ?? Math.max(1, ...sums);
  const w = slotW(n);
  return (
    <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={label} className="chart">
      <Hatch />
      <line x1={PAD} x2={W - PAD} y1={height - PAD} y2={height - PAD} stroke={ink} strokeWidth={1} />
      {bars.map((b, i) => {
        const x = PAD + i * w;
        if (b === "skip") return <Skipped key={i} x={x} w={w} h={height} />;
        if (b === null) return null;
        let base = height - PAD;
        return (
          <g key={i} opacity={faded.includes(i) ? 0.5 : 1}>
            {b.title && <title>{b.title}</title>}
            {b.parts.map((p, k) => {
              const h = (p / top) * (height - 2 * PAD);
              base -= h;
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
        <circle key={i} cx={f(PAD + 4 + d.at * (W - 2 * PAD - 8))} cy={f(PAD + 4 + (d.row % rows) * step)} r={3} fill={d.color} stroke={ink} strokeWidth={0.5}>
          <title>{d.title}</title>
        </circle>
      ))}
    </svg>
  );
}
