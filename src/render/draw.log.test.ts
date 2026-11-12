import { beforeEach, expect, it } from "vitest";
import { createRenderer } from "./draw";
import { createStackRenderer, slabIndex, slabTop } from "./stack";
import { createSim, step } from "../sim/sim";
import { createSyntheticSource, FIXTURE_SEED } from "../sim/source";

// A recording 2D context: every call and property set, in order. Images are named by a hash of what was painted
// into them, so the same picture baked twice (or by another renderer) gets the same name.
type Fake = { width: number; height: number; style: Record<string, string>; log: string[]; getContext: () => unknown };

const fnv = (text: string) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16);
};

function fmt(v: unknown): string {
  if (typeof v === "number") return String(Math.round(v * 1e4) / 1e4);
  if (v && typeof v === "object" && "log" in v) {
    const c = v as Fake;
    return `img(${c.width}x${c.height}:${fnv(c.log.join("\n"))})`;
  }
  if (v && typeof v === "object" && "data" in v) {
    const d = (v as { data: Uint8ClampedArray }).data;
    let h = 2166136261;
    for (let i = 0; i < d.length; i += 1) h = Math.imul(h ^ d[i], 16777619) >>> 0;
    return `data(${h.toString(16)})`;
  }
  return JSON.stringify(v);
}

function fakeCanvas(): Fake {
  const log: string[] = [];
  const ctx = new Proxy(
    {},
    {
      get: (_t, k: string) => {
        if (k === "measureText") return (text: string) => ({ width: text.length * 4 });
        if (k === "createImageData") return (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
        return (...args: unknown[]) => void log.push(`${k}(${args.map(fmt).join(",")})`);
      },
      set: (_t, k: string, v) => {
        log.push(`${k}=${fmt(v)}`);
        return true;
      },
    },
  );
  return { width: 0, height: 0, style: {}, log, getContext: () => ctx };
}

function installDom() {
  Object.assign(globalThis, { document: { createElement: fakeCanvas }, ImageData: class {} });
}

function wardAt600() {
  const src = createSyntheticSource(FIXTURE_SEED, true);
  const s = createSim(src);
  for (let i = 0; i < 600; i += 1) step(s, src);
  return s;
}

/** Three frames, as the page draws them; the last one's log. */
function lastFrame(canvas: Fake, frame: (dt: number, now: number) => void) {
  [0.016, 0.017, 0.016].forEach((dt, i) => {
    canvas.log.length = 0;
    frame(dt, 10 + i * 0.0167);
  });
  return [...canvas.log];
}

beforeEach(installDom);

it("the ward-only renderer draws the same frame as before the floors refactor", () => {
  const canvas = fakeCanvas();
  const r = createRenderer(canvas as unknown as HTMLCanvasElement);
  r.resize(656, 382, 1);
  const s = wardAt600();
  const log = lastFrame(canvas, (dt, now) => r.frame(s, null, null, dt, now));
  expect(log.length).toBeGreaterThan(500);
  expect(log).toMatchSnapshot();
});

it("the hospital stack focused on 4F draws W4 exactly as the ward-only renderer does, moved only by the floor's translate", () => {
  const [a, b] = [fakeCanvas(), fakeCanvas()];
  const ward = createRenderer(a as unknown as HTMLCanvasElement);
  const stack = createStackRenderer(b as unknown as HTMLCanvasElement, () => 4);
  ward.resize(656, 382, 1);
  stack.resize(656, 382, 1);
  const [s1, s2] = [wardAt600(), wardAt600()];
  const wardLog = lastFrame(a, (dt, now) => ward.frame(s1, null, null, dt, now));
  const stackLog = lastFrame(b, (dt, now) => stack.frame(s2, null, null, dt, now));

  const last = (log: string[], prefix: string, before = log.length) => log.slice(0, before).findLastIndex((x) => x.startsWith(prefix));
  const wardCam = last(wardLog, "setTransform(");
  const shift = slabTop(slabIndex(4));
  const from = stackLog.indexOf(`translate(0,${shift})`);
  const to = stackLog.indexOf("restore()", from);
  expect(from).toBeGreaterThan(0);
  expect(to - from).toBeGreaterThan(500);
  expect(stackLog.slice(from + 1, to)).toEqual(wardLog.slice(wardCam + 1));

  // The camera, settled on 4F: the stack's transform followed by the floor's translate is the ward-only transform.
  const args = (entry: string) => entry.slice(entry.indexOf("(") + 1, -1).split(",").map(Number);
  const [p, , , , e, f] = args(stackLog[last(stackLog, "setTransform(", from)]);
  const w = args(wardLog[wardCam]);
  [p, 0, 0, p, e, f + p * shift].forEach((v, i) => expect(v).toBeCloseTo(w[i], 9));
});
