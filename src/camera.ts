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

/** Keeps the view inside the w x h map; an axis the whole map fits on stays centred. The view is viewW x viewH logical px
 * at zoom 1 (the map's own size unless the canvas is wider or taller); `min` lets a stack zoom out below ZOOM_MIN. */
export function clampCam(c: Cam, w: number, h: number, viewW = w, viewH = h, min = ZOOM_MIN): Cam {
  const zoom = Math.max(min, Math.min(ZOOM_MAX, c.zoom));
  const axis = (p: number, size: number, view: number) => {
    const half = view / 2 / zoom;
    return half * 2 >= size ? size / 2 : Math.max(half, Math.min(size - half, p));
  };
  return { zoom, x: axis(c.x, w, viewW), y: axis(c.y, h, viewH) };
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
