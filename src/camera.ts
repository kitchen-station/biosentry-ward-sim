// Pure zoom and pan arithmetic, shared by the canvas camera (render/draw.ts) and the DOM zoom (App.tsx).
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
const STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];

export interface Cam { zoom: number; x: number; y: number } // x, y: the logical point at the view centre

export const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

/** The next preset zoom above (dir 1) or below (dir -1) z. */
export function stepZoom(z: number, dir: 1 | -1): number {
  const next = dir > 0 ? STEPS.find((x) => x > z + 1e-9) : [...STEPS].reverse().find((x) => x < z - 1e-9);
  return next ?? clampZoom(z);
}

/** A ctrl+wheel (or pinch) tick: smooth, two decimals so the label stays tidy. */
export const wheelZoom = (z: number, deltaY: number, deltaMode = 0) =>
  clampZoom(Math.round(z * Math.exp(-(deltaMode === 1 ? deltaY * 16 : deltaY) * 0.01) * 100) / 100); // deltaMode 1: a mouse wheel counts lines

/** Keeps the view inside the w x h map. Zoomed out past 1 the whole map fits, so it stays centred. */
export function clampCam(c: Cam, w: number, h: number): Cam {
  const zoom = clampZoom(c.zoom);
  if (zoom <= 1) return { zoom, x: w / 2, y: h / 2 };
  const hw = w / 2 / zoom;
  const hh = h / 2 / zoom;
  return { zoom, x: Math.max(hw, Math.min(w - hw, c.x)), y: Math.max(hh, Math.min(h - hh, c.y)) };
}

/** New zoom z2 with the logical point under the cursor unchanged. (px, py): the cursor's logical offset from the view centre. */
export function zoomAbout(c: Cam, z2: number, px: number, py: number, w: number, h: number): Cam {
  const zoom = clampZoom(z2);
  return clampCam({ zoom, x: c.x + px / c.zoom - px / zoom, y: c.y + py / c.zoom - py / zoom }, w, h);
}

/** Dragging the content by (dx, dy) logical pixels moves the camera the other way. */
export const panBy = (c: Cam, dx: number, dy: number, w: number, h: number): Cam =>
  clampCam({ zoom: c.zoom, x: c.x - dx / c.zoom, y: c.y - dy / c.zoom }, w, h);

/** Fit: the whole map, centred. */
export const fitCam = (w: number, h: number): Cam => ({ zoom: 1, x: w / 2, y: h / 2 });
