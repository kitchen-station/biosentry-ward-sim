// The canvas theme. Light is what the palettes in draw.ts, facade.ts and stack.ts are written in. Dark maps each
// colour the way a dark UI would: pale surfaces and dark ink swap their lightness, vivid colours (risk, selection,
// beds, signals) stay as they are. The draw log snapshot is the light theme, which touches nothing here.
let dark = false;
export const setRenderDark = (on: boolean) => void (dark = on);
export const isRenderDark = () => dark;

export const STAGE_LIGHT = "#EEF2F7";
export const STAGE_DARK = "#161B22";
export const stageColour = () => (dark ? STAGE_DARK : STAGE_LIGHT);

const cache = new Map<string, string>();

function toHsl(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b) / 255;
  const mn = Math.min(r, g, b) / 255;
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const h = mx === rr ? ((gg - bb) / d + 6) % 6 : mx === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  return [h * 60, s, l];
}

function fromHsl(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** One colour string, dark theme: neutrals and pastels flip their lightness, vivid colours stay. */
export function darkColour(colour: string): string {
  if (colour === STAGE_LIGHT) return STAGE_DARK;
  const hit = cache.get(colour);
  if (hit) return hit;
  let r: number, g: number, b: number, a = 1;
  const m = /^#([0-9a-f]{6})$/i.exec(colour);
  const n = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(colour);
  if (m) [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  else if (n) [r, g, b, a] = [+n[1], +n[2], +n[3], n[4] === undefined ? 1 : +n[4]];
  else return colour;
  const [h, s, l] = toHsl(r, g, b);
  let out = colour;
  if (s < 0.55) {
    const [rr, gg, bb] = fromHsl(h, s, 0.1 + (1 - l) * 0.8);
    out = m ? `#${[rr, gg, bb].map((v) => v.toString(16).padStart(2, "0")).join("")}` : `rgba(${rr},${gg},${bb},${a})`;
  }
  cache.set(colour, out);
  return out;
}

export const tone = (colour: string) => (dark ? darkColour(colour) : colour);

const COLOUR_PROPS = new Set(["fillStyle", "strokeStyle", "shadowColor"]);

/** The 2D context for this theme: in light, the context itself; in dark, one that maps every colour string it is given. */
export function themed<T extends CanvasRenderingContext2D>(ctx: T): T {
  if (!dark) return ctx;
  const bound = new Map<string, unknown>();
  return new Proxy(ctx, {
    get(target, key: string) {
      const v = Reflect.get(target, key, target);
      if (typeof v !== "function") return v;
      let f = bound.get(key);
      if (!f) bound.set(key, (f = (v as (...a: unknown[]) => unknown).bind(target)));
      return f;
    },
    set(target, key: string, value) {
      Reflect.set(target, key, COLOUR_PROPS.has(key) && typeof value === "string" ? darkColour(value) : value, target);
      return true;
    },
  });
}
