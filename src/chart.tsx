// Sparkline geometry from BioSentry. A null is a gap: the line breaks, nothing is bridged.

interface Pt {
  x: number;
  y: number;
}

function runs(points: (Pt | null)[]): Pt[][] {
  const out: Pt[][] = [];
  let current: Pt[] = [];
  for (const p of points) {
    if (p === null) {
      if (current.length > 0) out.push(current);
      current = [];
    } else {
      current.push(p);
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

export function Sparkline({
  data,
  width = 120,
  height = 30,
}: {
  data: (number | null)[];
  width?: number;
  height?: number;
}) {
  const values = data.filter((v): v is number => v !== null);
  if (values.length === 0) return <svg width={width} height={height} aria-hidden="true" />;
  const min = Math.min(...values);
  const range = Math.max(...values) - min || 1;
  const pad = 3;
  const points = data.map((v, i) =>
    v === null
      ? null
      : {
          x: pad + (i / Math.max(1, data.length - 1)) * (width - pad * 2),
          y: height - pad - ((v - min) / range) * (height - pad * 2),
        },
  );
  const lines = runs(points).filter((r) => r.length >= 2);
  const dots = runs(points).filter((r) => r.length === 1);
  const latest = points.at(-1);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {lines.map((r) => (
        <polyline
          key={`${r[0].x}`}
          points={r.map((p) => `${p.x},${p.y}`).join(" ")}
          fill="none"
          stroke="var(--ink-900)"
          strokeWidth={2}
          shapeRendering="crispEdges"
        />
      ))}
      {dots.map(([p]) => (
        <rect key={p.x} x={p.x - 1} y={p.y - 1} width={3} height={3} fill="var(--ink-900)" />
      ))}
      {latest && <rect x={latest.x - 2} y={latest.y - 2} width={4} height={4} fill="var(--ink-900)" />}
    </svg>
  );
}
