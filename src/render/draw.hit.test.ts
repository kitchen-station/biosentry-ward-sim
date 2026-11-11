import { expect, it } from "vitest";
import { fitCam, zoomAbout } from "../camera";
import { createRenderer, LOGICAL_H, LOGICAL_W } from "./draw";
import { createSim } from "../sim/sim";
import { createSyntheticSource, FIXTURE_SEED } from "../sim/source";

// The renderer needs a canvas; a stub whose 2D context does nothing is enough for hit(), which reads only the camera.
it("hit() finds the same thing under the cursor before and after zooming about that point", () => {
  const ctx = new Proxy({}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 1 }) : () => ({ data: new Uint8ClampedArray(4) })), set: () => true });
  const fake = () => ({ getContext: () => ctx, style: {}, width: 0, height: 0 });
  Object.assign(globalThis, { document: { createElement: fake }, ImageData: class {} });
  const r = createRenderer(fake() as unknown as HTMLCanvasElement);
  r.resize(656, 382, 1);
  const s = createSim(createSyntheticSource(FIXTURE_SEED, true));
  let found: [number, number, string] | null = null;
  for (let y = 0; y < 382 && !found; y += 3) {
    for (let x = 0; x < 656 && !found; x += 3) {
      const id = r.hit(s, x, y);
      if (id) found = [x, y, id];
    }
  }
  expect(found).not.toBeNull();
  const [x, y, id] = found!;
  // Zoom about another point: the thing moves, and hit() must follow the live camera.
  const scale = Math.min(656 / LOGICAL_W, 382 / LOGICAL_H);
  const [qx, qy] = [x < 328 ? 656 : 0, y < 191 ? 382 : 0]; // the far corner
  r.zoomAt(2, qx, qy, true);
  const cam = zoomAbout(fitCam(LOGICAL_W, LOGICAL_H), 2, qx / scale - LOGICAL_W / 2, qy / scale - LOGICAL_H / 2, LOGICAL_W, LOGICAL_H);
  const moved = [((x / scale - cam.x) * 2 + LOGICAL_W / 2) * scale, ((y / scale - cam.y) * 2 + LOGICAL_H / 2) * scale];
  expect(r.hit(s, x, y)).not.toBe(id);
  expect(r.hit(s, moved[0], moved[1])).toBe(id);
  expect(r.canPan()).toBe(true);
  r.fit();
  r.reset();
  expect(r.canPan()).toBe(false);
});
