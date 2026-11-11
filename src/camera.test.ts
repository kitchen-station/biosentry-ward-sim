import { describe, expect, it } from "vitest";
import { clampCam, clampZoom, fitCam, panBy, stepZoom, wheelZoom, zoomAbout, ZOOM_MAX, ZOOM_MIN } from "./camera";

const W = 656;
const H = 382;

describe("camera", () => {
  it("limits the zoom", () => {
    expect(clampZoom(10)).toBe(ZOOM_MAX);
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(stepZoom(3, 1)).toBe(3);
    expect(stepZoom(0.5, -1)).toBe(0.5);
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.8);
    expect(wheelZoom(2.9, -50)).toBe(3);
    expect(wheelZoom(0.6, 50)).toBe(0.5);
    expect(zoomAbout(fitCam(W, H), 99, 0, 0, W, H).zoom).toBe(3);
    expect(zoomAbout(fitCam(W, H), 0.01, 0, 0, W, H).zoom).toBe(0.5);
    let z = 1;
    for (let i = 0; i < 20; i += 1) z = stepZoom(z, 1);
    expect(z).toBe(3);
    for (let i = 0; i < 20; i += 1) z = stepZoom(z, -1);
    expect(z).toBe(0.5);
    expect([ZOOM_MIN, ZOOM_MAX]).toEqual([0.5, 3]);
  });

  it("leaves the default camera and any zoom of 1 or more exactly as the old clamp did", () => {
    expect(clampCam(fitCam(W, H), W, H)).toEqual({ zoom: 1, x: W / 2, y: H / 2 });
    for (const zoom of [1, 1.7, 2.4, 3]) {
      const hw = W / 2 / zoom;
      const hh = H / 2 / zoom;
      const c = clampCam({ zoom, x: -50, y: 9999 }, W, H);
      expect([c.x, c.y]).toEqual([Math.max(hw, Math.min(W - hw, -50)), Math.max(hh, Math.min(H - hh, 9999))]);
    }
  });

  it("cannot drag the ward off-screen", () => {
    const c = panBy({ zoom: 2, x: W / 2, y: H / 2 }, -100000, 100000, W, H);
    expect(c.x).toBe(W - W / 4);
    expect(c.y).toBe(H / 4);
    expect(clampCam({ zoom: 0.5, x: 0, y: 0 }, W, H)).toEqual({ zoom: 0.5, x: W / 2, y: H / 2 }); // zoomed out: centred
  });

  it("zooms about the cursor: the point under it stays put", () => {
    const c = { zoom: 1.5, x: 300, y: 200 };
    const [px, py] = [100, -40];
    const at = (k: { zoom: number; x: number; y: number }) => [k.x + px / k.zoom, k.y + py / k.zoom];
    const next = zoomAbout(c, 2.25, px, py, W, H);
    expect(next.zoom).toBe(2.25);
    expect(at(next)[0]).toBeCloseTo(at(c)[0]);
    expect(at(next)[1]).toBeCloseTo(at(c)[1]);
  });

  it("Fit resets", () => {
    expect(fitCam(W, H)).toEqual({ zoom: 1, x: W / 2, y: H / 2 });
  });

  it("pans by exact amounts when nothing clamps", () => {
    // zoom 2: a 40 x 20 logical drag moves the centre 20 x 10 the other way
    expect(panBy({ zoom: 2, x: 300, y: 200 }, 40, 20, W, H)).toEqual({ zoom: 2, x: 280, y: 190 });
    expect(panBy({ zoom: 4 > ZOOM_MAX ? 3 : 4, x: 300, y: 200 }, -30, 0, W, H)).toEqual({ zoom: 3, x: 310, y: 200 });
  });

  it("rounds a wheel zoom to two decimals and counts mouse-wheel lines", () => {
    expect(wheelZoom(1, -10)).toBe(1.11); // 1 * e^0.1 = 1.10517
    expect(wheelZoom(1, 10)).toBe(0.9);
    expect(wheelZoom(1, -1, 1)).toBe(wheelZoom(1, -16, 0));
  });

  it("steps from a value between presets", () => {
    expect(stepZoom(1.1, 1)).toBe(1.25);
    expect(stepZoom(1.1, -1)).toBe(1);
    expect(stepZoom(0.9, 1)).toBe(1);
    expect(stepZoom(0.9, -1)).toBe(0.8);
  });

  it("zooming about a cursor past the limit stops at the limit and stays inside the map", () => {
    const next = zoomAbout({ zoom: 2.9, x: 100, y: 60 }, 9, -300, -150, W, H);
    expect(next.zoom).toBe(ZOOM_MAX);
    expect(next.x).toBeGreaterThanOrEqual(W / 2 / ZOOM_MAX);
    expect(next.y).toBeGreaterThanOrEqual(H / 2 / ZOOM_MAX);
  });
});
