// The hospital as a stack of W4-style slabs floating on the dark stage, drawn with draw.ts's own art.
// Three levels: STACK (every slab), FLOOR (one slab live, the others ghosted) and THING (zoomed onto one thing on it).
// Reads the sim, never changes it. Time comes only from frame(dt, now).
import { clampCam, fitCam, panBy, zoomAbout, ZOOM_MIN, type Cam } from "../camera";
import type { Sim } from "../sim/sim";
import { createSlab, createW4, iso, LOGICAL_H, LOGICAL_W, onSlab, roomCentre, tag, ZOOM, type Renderer } from "./draw";
import { FLOORS, W4, type FloorSpec } from "./floors";

export const GAP = 200; // logical px from one floor to the next; a slab's diamond is 324 px tall, so the one above hides only a strip of its back wall
export const WORLD_H = LOGICAL_H + (FLOORS.length - 1) * GAP;
const ABOVE = 0.15; // ghost alpha of the floors above the focused one
const BELOW = 0.35; // and below it; also the floors above a hovered slab in STACK (peek)
const GHOST_BACKING = 2;

const top = FLOORS.length - 1;
export const slabTop = (i: number) => (top - i) * GAP; // floor i's logical y in the world
export const slabIndex = (floor: number) => FLOORS.findIndex((f) => f.floor === floor);
export const floorLabel = (floor: number) => (floor === 0 ? "GF" : `${floor}F`);

export interface Level { view: number | null; selected: string | null }
export type LevelEvent = { slab: number } | { rail: number | null } | { thing: string; floor: number } | "empty" | "outside" | "escape";

/** The three-level table: STACK (view null), FLOOR (view, nothing selected), THING (view and a selection). */
export function nextLevel(l: Level, e: LevelEvent): Level {
  if (e === "escape" || e === "outside") return l.selected !== null ? { view: l.view, selected: null } : { view: null, selected: null };
  if (e === "empty") return { view: l.view, selected: null };
  if ("slab" in e) return { view: e.slab, selected: null };
  if ("rail" in e) return { view: e.rail, selected: null };
  return { view: e.floor, selected: e.thing };
}

/** A label's own click box on a floor that has no live things yet: the text, roughly. */
function labelAt(spec: FloorSpec, x: number, y: number): string | null {
  for (const room of spec.rooms) {
    const [cx, cy] = roomCentre(room);
    if (room.sel && Math.abs(x - cx) <= room.label.length * 2 + 4 && Math.abs(y - cy) <= 6) return room.sel;
  }
  return null;
}

/** `getView` is App's floor (null for the whole stack). Same surface as createRenderer, so App drives either. */
export function createStackRenderer(canvas: HTMLCanvasElement, getView: () => number | null): Renderer {
  const ctx = canvas.getContext("2d")!;
  const w4 = createW4();
  const slabs = FLOORS.map((spec) => (spec === W4 ? null : createSlab(spec)));
  // Ghosts are pictures of a whole slab, so a translucent floor does not show its own walls through its floor.
  const ghosts = FLOORS.map(() => {
    const c = document.createElement("canvas");
    c.width = LOGICAL_W * GHOST_BACKING;
    c.height = LOGICAL_H * GHOST_BACKING;
    return c;
  });
  ghosts.forEach((c, i) => {
    const g = c.getContext("2d")!;
    g.setTransform(GHOST_BACKING, 0, 0, GHOST_BACKING, 0, 0);
    slabs[i]?.(g);
  });
  const w4Ghost = ghosts[slabIndex(W4.floor)].getContext("2d")!;

  const cam: Cam = { zoom: 1, x: LOGICAL_W / 2, y: WORLD_H / 2 }; // world coordinates
  let user: Cam = fitCam(LOGICAL_W, LOGICAL_H); // FLOOR's resting camera, in the floor's own coordinates
  let scale = 1; // CSS pixels per logical pixel at zoom 1: one floor fits, as the ward-only view
  let backing = 1;
  let viewW = LOGICAL_W; // the canvas in logical px at zoom 1
  let viewH = LOGICAL_H;
  let shown: number | null | undefined; // the view the camera last served; undefined until the first frame, which snaps
  const stackZoom = () => Math.min(viewW / LOGICAL_W, viewH / WORLD_H);
  const minZoom = () => Math.min(ZOOM_MIN, stackZoom());
  const local = (view: number): Cam => ({ zoom: cam.zoom, x: cam.x, y: cam.y - slabTop(slabIndex(view)) });

  function focusPoint(s: Sim, view: number, id: string): [number, number] | null {
    const spec = FLOORS[slabIndex(view)];
    if (spec === W4) return w4.focusPoint(s, id);
    const room = spec?.rooms.find((r) => r.sel === id);
    return room ? roomCentre(room) : null;
  }

  function target(s: Sim, view: number | null, selected: string | null): Cam {
    if (view === null) return { zoom: stackZoom(), x: LOGICAL_W / 2, y: WORLD_H / 2 };
    const f = selected ? focusPoint(s, view, selected) : null;
    const c = f ? clampCam({ zoom: ZOOM, x: f[0], y: f[1] }, LOGICAL_W, LOGICAL_H, viewW, viewH) : user;
    return { zoom: c.zoom, x: c.x, y: c.y + slabTop(slabIndex(view)) };
  }

  /** World point under a CSS pixel of the canvas. */
  const world = (cssX: number, cssY: number): [number, number] => [
    cam.x + (cssX / scale - viewW / 2) / cam.zoom,
    cam.y + (cssY / scale - viewH / 2) / cam.zoom,
  ];
  // Each slab's tag in the stack: drawn at screen size, so it reads at any zoom. Anchored on the slab's west corner.
  const tagAnchor = (i: number): [number, number] => {
    const [x, y] = iso(0, 13);
    return [viewW / 2 + (x - cam.x) * cam.zoom, viewH / 2 + (y + slabTop(i) - cam.y) * cam.zoom];
  };
  const tagText = (spec: FloorSpec) => `${floorLabel(spec.floor)} ${spec.name}`;

  return {
    resize(width: number, height: number, ratio: number) {
      scale = Math.min(width / LOGICAL_W, height / LOGICAL_H);
      backing = Math.max(1, Math.ceil(scale * ratio));
      viewW = width / scale;
      viewH = height / scale;
      canvas.width = Math.round(viewW * backing);
      canvas.height = Math.round(viewH * backing);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      canvas.style.left = "0px";
      canvas.style.top = "0px";
    },

    /** 1 is one floor fitting the stage; the stack shows below that. */
    userZoom: () => (getView() === null ? stackZoom() : user.zoom),
    canPan: () => getView() !== null && user.zoom > 1,
    zoomAt(z: number, cssX: number, cssY: number, instant: boolean) {
      const view = getView();
      if (view === null) return; // the stack has one zoom: the whole hospital
      const base = instant ? local(view) : user;
      user = clampCam(zoomAbout(base, z, cssX / scale - viewW / 2, cssY / scale - viewH / 2, LOGICAL_W, LOGICAL_H), LOGICAL_W, LOGICAL_H, viewW, viewH);
      if (instant) Object.assign(cam, { ...user, y: user.y + slabTop(slabIndex(view)) });
    },
    pan(dx: number, dy: number) {
      const view = getView();
      if (view === null) return;
      user = clampCam(panBy(local(view), dx / scale, dy / scale, LOGICAL_W, LOGICAL_H), LOGICAL_W, LOGICAL_H, viewW, viewH);
      Object.assign(cam, { ...user, y: user.y + slabTop(slabIndex(view)) });
    },
    fit() {
      user = fitCam(LOGICAL_W, LOGICAL_H);
    },
    reset() {
      user = fitCam(LOGICAL_W, LOGICAL_H);
      shown = undefined;
      w4.reset();
    },

    frame(s: Sim, selected: string | null, hovered: string | null, dt: number, now: number) {
      const view = getView();
      if (view !== shown && shown !== undefined) user = fitCam(LOGICAL_W, LOGICAL_H); // a new floor starts at its fit
      const t = target(s, view, selected);
      const ease = shown === undefined ? 1 : 1 - Math.exp(-dt * 6);
      shown = view;
      cam.zoom += (t.zoom - cam.zoom) * ease;
      cam.x += (t.x - cam.x) * ease;
      cam.y += (t.y - cam.y) * ease;
      cam.zoom = Math.max(minZoom(), cam.zoom);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#2A2036";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const pixels = backing * cam.zoom;
      ctx.setTransform(pixels, 0, 0, pixels, backing * (viewW / 2 - cam.x * cam.zoom), backing * (viewH / 2 - cam.y * cam.zoom));
      ctx.imageSmoothingEnabled = false;

      const focus = view === null ? -1 : slabIndex(view);
      const peek = view === null && hovered?.startsWith("floor:") ? slabIndex(Number(hovered.slice(6))) : -1;
      // Painter's order, GF first. W4 is painted exactly once a frame (it moves its own trolleys): live, or into its ghost.
      FLOORS.forEach((spec, i) => {
        const alpha = focus < 0 ? (peek >= 0 && i > peek ? BELOW : 1) : i === focus ? 1 : i > focus ? ABOVE : BELOW;
        if (alpha === 1) {
          ctx.save();
          ctx.translate(0, slabTop(i));
          if (spec === W4) w4.paint(ctx, s, i === focus ? selected : null, i === focus ? hovered : null, dt, now);
          else slabs[i]!(ctx);
          ctx.restore();
          return;
        }
        if (spec === W4) {
          w4Ghost.setTransform(1, 0, 0, 1, 0, 0);
          w4Ghost.clearRect(0, 0, LOGICAL_W * GHOST_BACKING, LOGICAL_H * GHOST_BACKING);
          w4Ghost.setTransform(GHOST_BACKING, 0, 0, GHOST_BACKING, 0, 0);
          w4.paint(w4Ghost, s, null, null, dt, now);
        }
        ctx.globalAlpha = alpha;
        ctx.drawImage(ghosts[i], 0, slabTop(i), LOGICAL_W, LOGICAL_H);
        ctx.globalAlpha = 1;
      });

      if (view !== null) return;
      if (peek >= 0) {
        // The hovered slab's rim in cream.
        const [a, b, c, d] = [iso(0, 0), iso(36, 0), iso(36, 18), iso(0, 18)].map(([x, y]) => [x, y + slabTop(peek)]);
        ctx.strokeStyle = "#FFF8E7";
        ctx.lineWidth = 2 / cam.zoom;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.lineTo(c[0], c[1]);
        ctx.lineTo(d[0], d[1]);
        ctx.closePath();
        ctx.stroke();
      }
      ctx.setTransform(backing, 0, 0, backing, 0, 0);
      FLOORS.forEach((spec, i) => {
        const [x, y] = tagAnchor(i);
        tag(ctx, tagText(spec), x, y, undefined, i === peek);
      });
    },

    /** STACK: `floor:<n>` for a slab or its tag. FLOOR and THING: a thing's id on the focused slab, "" for the slab's
     * empty floor, null off it (ghosts take no clicks). */
    hit(s: Sim, cssX: number, cssY: number): string | null {
      const view = getView();
      const [x, y] = world(cssX, cssY);
      if (view === null) {
        const [sx, sy] = [cssX / scale, cssY / scale];
        for (let i = top; i >= 0; i -= 1) {
          const [tx, ty] = tagAnchor(i);
          if (Math.abs(sx - tx) <= tagText(FLOORS[i]).length * 2 + 4 && sy <= ty && sy >= ty - 12) return `floor:${FLOORS[i].floor}`;
        }
        for (let i = top; i >= 0; i -= 1) if (onSlab(x, y - slabTop(i))) return `floor:${FLOORS[i].floor}`;
        return null;
      }
      const i = slabIndex(view);
      const ly = y - slabTop(i);
      if (!onSlab(x, ly)) return null;
      return (FLOORS[i] === W4 ? w4.hit(s, x, ly) : labelAt(FLOORS[i], x, ly)) ?? "";
    },
  };
}
