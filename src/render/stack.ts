// The hospital on the dark stage: closed, one building (facade.ts); open, the stack of W4-style slabs with one floor
// focused and the others ghosted. Three levels: BUILDING (view null, closed), FLOOR (open, one slab live) and THING
// (zoomed onto one thing on it). Picking a floor opens the building upward into the stack; leaving to All closes it.
// Reads the sim, never changes it but for draining W4's trolleys while W4 is inside. Time comes only from frame(dt, now).
import { clampCam, fitCam, panBy, zoomAbout, ZOOM_MIN, type Cam } from "../camera";
import { floorSummary, type FloorSummary } from "../building";
import type { Sim } from "../sim/sim";
import { MAP_H } from "../sim/map";
import { backingFor, createFloor, createW4, iso, LOGICAL_H, LOGICAL_W, onSlab, tag, ZOOM, type Renderer } from "./draw";
import { BUILDING, createFacade, ease, lift, QUEUE_SHOWN, QUEUE_SPOTS, STOREY, storeyAt, storeyLit } from "./facade";
import { FLOORS, W4 } from "./floors";
import { animate, figureOf, newMovers, placesOf, type Mover, type Place } from "./move";
import { EMPTY, floorScene, slabTag, type Scene } from "./scene";

type Ctx = CanvasRenderingContext2D;

export const GAP = 200; // logical px from one floor to the next when open; a slab's diamond is 324 px tall, so the one above hides only a strip of its back wall
export const WORLD_H = LOGICAL_H + (FLOORS.length - 1) * GAP;
const ABOVE = 0.15; // ghost alpha of the floors above the focused one
const BELOW = 0.35; // and below it
const GHOST_BACKING = 2;
export const OPEN_S = 0.6; // the opening (and closing), seconds
export const CAMERA_AT = 0.6; // the camera leaves the building for the floor this far into the opening
const NUDGE = 3; // px a hovered storey of the closed building peeks out
const STAGE = "#2A2036";

const top = FLOORS.length - 1;
export const slabTop = (i: number) => (top - i) * GAP; // floor i's logical y in the world, open
export const slabIndex = (floor: number) => FLOORS.findIndex((f) => f.floor === floor);
const BASE = slabTop(0); // GF's floor stays put; closed, the storeys sit on it
/** Floor i's logical y in the world at opening progress q: 0 the closed block, no gaps; 1 the stack, slabTop(i). */
export const storeyY = (i: number, q: number) => BASE + lift(i) + (slabTop(i) - BASE - lift(i)) * ease(q);
const BOX = BUILDING(FLOORS.length);

export interface Level { view: number | null; selected: string | null }
export type LevelEvent = { slab: number } | { rail: number | null } | { thing: string; floor: number } | "empty" | "outside" | "escape";

/** The three-level table: BUILDING (view null), FLOOR (view, nothing selected), THING (view and a selection). */
export function nextLevel(l: Level, e: LevelEvent): Level {
  if (e === "escape" || e === "outside") return l.selected !== null ? { view: l.view, selected: null } : { view: null, selected: null };
  if (e === "empty") return { view: l.view, selected: null };
  if ("slab" in e) return { view: e.slab, selected: null };
  if ("rail" in e) return { view: e.rail, selected: null };
  return { view: e.floor, selected: e.thing };
}

/** `getView` is App's floor (null for the building). Same surface as createRenderer, so App drives either. */
export function createStackRenderer(canvas: HTMLCanvasElement, getView: () => number | null): Renderer {
  const ctx = canvas.getContext("2d", { alpha: false })!; // every frame fills the whole canvas
  const w4 = createW4();
  const slabs = FLOORS.map((spec) => (spec === W4 ? null : createFloor(spec)));
  const facade = createFacade(FLOORS.map((f) => f.floor));
  // Who is where changes only when the hospital steps a minute: the scenes are worked out once per minute, not per frame.
  let memo: { h: unknown; minute: number; floors: FloorSummary[]; scenes: Scene[] } | null = null;
  function scenes(s: Sim): { floors: FloorSummary[] | null; scenes: Scene[] } {
    const h = s.hospital;
    if (!h) return { floors: null, scenes: FLOORS.map(() => EMPTY) };
    if (memo?.h !== h || memo.minute !== h.lastMinute) {
      const floors = floorSummary(h);
      const next = FLOORS.map((spec) => floorScene(h, spec, floors));
      const now = placesOf(next);
      const still = new Map(h.people.map((p) => [`h:${p.n}`, p]));
      const ok = places && memo?.h === h && open > 0 && h.lastMinute - memo.minute <= 5; // closed, or a skip: nobody is walked
      const fresh = ok ? newMovers(places!, now, clock, (id) => { const p = still.get(id); return !p || p.unit === "W4" || p.where === "awaiting_morgue" || p.where === "morgue"; }, (id) => { const m = movers.find((x) => x.id === id); return m ? figureOf(m, clock) : null; }) : null;
      movers = fresh ? [...movers.filter((m) => !fresh.some((f) => f.id === m.id)), ...fresh] : []; // no new walks: old ones would go to stale places
      places = now;
      memo = { h, minute: h.lastMinute, floors, scenes: next };
    }
    return memo;
  }
  // Display-only motion (move.ts): the clock runs while the hospital does and a floor is open; movers are people on their way.
  let clock = 0;
  let movers: Mover[] = [];
  let places: Map<string, Place> | null = null; // who was drawn where at the last minute
  const figuresOn = (i: number) => movers.flatMap((m) => { const f = figureOf(m, clock); return f && f.floor === i ? [f] : []; });
  const animated = (i: number, scene: Scene) => animate(scene, FLOORS[i].map, new Set(movers.map((m) => m.id)), clock);
  let turn = 0; // the ghost repainted this frame, round-robin
  // Ghosts are pictures of a whole slab, so a translucent floor does not show its own walls through its floor.
  const ghosts = FLOORS.map(() => {
    const c = document.createElement("canvas");
    c.width = LOGICAL_W * GHOST_BACKING;
    c.height = LOGICAL_H * GHOST_BACKING;
    return c;
  });
  // What each ghost was painted from: its scene (a new object each minute) and the drawers' blink, the slab's one use of now.
  // Moving people repaint a ghost four times a second, and only while the hospital runs.
  const blink = (scene: Scene, now: number) => scene.drawers.map((d) => d.full && Math.floor(now * 2 + d.tile[0]) % 6 === 0).join() + (scene.staff.length + movers.length > 0 ? `|${Math.floor(clock * 4)}` : "");
  let ghostOf: ({ scene: Scene; blink: string } | null)[] = FLOORS.map(() => null);
  function paintGhost(i: number, scene: Scene, now: number) {
    const b = blink(scene, now);
    if (ghostOf[i]?.scene === scene && ghostOf[i]!.blink === b) return; // the picture it holds is this one
    ghostOf[i] = { scene, blink: b };
    version[i] += 1;
    const g = ghosts[i].getContext("2d")!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, LOGICAL_W * GHOST_BACKING, LOGICAL_H * GHOST_BACKING);
    g.setTransform(GHOST_BACKING, 0, 0, GHOST_BACKING, 0, 0);
    slabs[i]?.paint(g, animated(i, scene), null, null, now, figuresOn(i));
  }
  const version = FLOORS.map(() => 0); // each ghost's repaints, so a layer knows when one it holds changed
  ghosts.forEach((_, i) => paintGhost(i, EMPTY, 0));
  const w4Ghost = ghosts[slabIndex(W4.floor)].getContext("2d")!;
  // W4 moves its own trolleys by the time since it was last painted, live or into its ghost. Its ghost is repainted once a
  // blink turn (machines at 4 Hz, high-risk badges at 3 Hz), not every frame: w4Phase is the turn it holds, null for none.
  let w4Dt = 0;
  let w4Phase: number | null = null;
  let open = 0; // 0 the closed building, 1 the open stack
  // The closed building at rest changes only with what it is drawn from: the key of the picture on the canvas, or null.
  let painted: unknown[] | null = null;
  const same = (a: unknown[] | null, b: unknown[]) => a?.length === b.length && b.every((v, i) => v === a[i]);
  // Open and settled, the stage with the ghosts below the focused floor (opaque), and the ghosts above it, as two pictures
  // the size of the canvas. Each is recomposed when its key changes: a ghost it holds was repainted (version), the focus,
  // the camera, the canvas; resize, redraw and reset forget both, and so does any frame painted without them.
  const layers = [document.createElement("canvas"), document.createElement("canvas")];
  const layerCtx = [layers[0].getContext("2d", { alpha: false })!, layers[1].getContext("2d")!];
  let layerKey: (unknown[] | null)[] = [null, null];

  const cam: Cam = { zoom: 1, x: 0, y: 0 }; // world coordinates
  let user: Cam = fitCam(LOGICAL_W, LOGICAL_H); // FLOOR's resting camera, in the floor's own coordinates
  let scale = 1; // CSS pixels per logical pixel at zoom 1: one floor fits, as the ward-only view
  let backing = 1;
  let viewW = LOGICAL_W; // the canvas in logical px at zoom 1
  let viewH = LOGICAL_H;
  let shown: number | null | undefined; // the view the camera last served; undefined until the first frame, which snaps
  const buildingZoom = () => Math.min(viewW / (BOX.w * 1.12), viewH / (BOX.h * 1.12));
  const minZoom = () => Math.min(ZOOM_MIN, buildingZoom());
  const local = (view: number): Cam => ({ zoom: cam.zoom, x: cam.x, y: cam.y - slabTop(slabIndex(view)) });

  function focusPoint(s: Sim, view: number, id: string): [number, number] | null {
    const i = slabIndex(view);
    if (FLOORS[i] === W4) return w4.focusPoint(s, id);
    return slabs[i]?.focusPoint(animated(i, scenes(s).scenes[i]), id, figuresOn(i)) ?? null;
  }

  function target(s: Sim, view: number | null, selected: string | null): Cam {
    if (view === null || open < CAMERA_AT) return { zoom: buildingZoom(), x: BOX.x0 + BOX.w / 2, y: BASE + BOX.y0 + BOX.h / 2 };
    const f = selected ? focusPoint(s, view, selected) : null;
    const c = f ? clampCam({ zoom: ZOOM, x: f[0], y: f[1] }, LOGICAL_W, LOGICAL_H, viewW, viewH) : user;
    return { zoom: c.zoom, x: c.x, y: c.y + slabTop(slabIndex(view)) };
  }

  /** World point under a CSS pixel of the canvas. */
  const world = (cssX: number, cssY: number): [number, number] => [
    cam.x + (cssX / scale - viewW / 2) / cam.zoom,
    cam.y + (cssY / scale - viewH / 2) / cam.zoom,
  ];
  /** Stage point of a point of the closed building (GF's floor at 0), `up` world px higher. */
  const screen = ([wx, wy]: [number, number], up = 0): [number, number] => [viewW / 2 + (wx - cam.x) * cam.zoom, viewH / 2 + (wy + BASE - up - cam.y) * cam.zoom];
  // The storeys' signs: one tidy column near the building's front corner, at screen size so they read at the landing zoom.
  const signAnchor = (i: number) => screen(iso(34.5, MAP_H), 8 - lift(i));
  let signFloors: FloorSummary[] | null = null; // the summary the signs last showed, so hit() reads the same text
  const signText = (i: number) => slabTag(FLOORS[i], signFloors);
  const signDot = (i: number) => (FLOORS[i] === W4 ? "#4ECDC4" : undefined); // the monitored ward

  function closed(s: Sim, floors: FloorSummary[] | null, hovered: string | null) {
    const peek = hovered?.startsWith("floor:") ? slabIndex(Number(hovered.slice(6))) : -1;
    ctx.save();
    ctx.translate(0, BASE);
    facade.plate(ctx);
    FLOORS.forEach((spec, i) => facade.drawStorey(ctx, i, storeyLit(spec.floor, floors), lift(i), i === peek ? NUDGE : 0));
    facade.queue(ctx, floors?.find((f) => f.floor === 0));
    if (peek >= 0) facade.outline(ctx, lift(peek), NUDGE, 2 / cam.zoom);
    ctx.restore();
    if (s.speed > 0) s.moves.length = 0; // W4 moves its own trolleys when painted; unseen inside, they are not saved up

    ctx.setTransform(backing, 0, 0, backing, 0, 0);
    FLOORS.forEach((_, i) => {
      ctx.globalAlpha = i === peek ? 1 : 0.85;
      tag(ctx, signText(i), ...signAnchor(i), signDot(i));
    });
    ctx.globalAlpha = 1;
    tag(ctx, "ENTRANCE", ...screen(iso(7.5, MAP_H), 10));
    tag(ctx, "EMERGENCY", ...screen(iso(15.5, MAP_H), 8));
    const gf = floors?.find((f) => f.floor === 0);
    const er = gf?.units.find((u) => u.id === "ER");
    if (er && er.queue.length > QUEUE_SHOWN) tag(ctx, `+${er.queue.length - QUEUE_SHOWN}`, ...screen(iso(QUEUE_SPOTS[QUEUE_SHOWN - 1][0] - 1.2, MAP_H + 2.9)));
    if (gf && gf.boarders > 0) tag(ctx, `${gf.boarders} boarding`, ...screen(iso(11, MAP_H + 2.8)), "#FFA07A");
  }

  return {
    resize(width: number, height: number, ratio: number) {
      scale = Math.min(width / LOGICAL_W, height / LOGICAL_H);
      backing = backingFor(scale, ratio);
      viewW = width / scale;
      viewH = height / scale;
      canvas.width = Math.round(viewW * backing);
      canvas.height = Math.round(viewH * backing);
      ctx.fillStyle = STAGE; // an opaque canvas clears to black; until the next frame show the stage, as transparent did
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      canvas.style.left = "0px";
      canvas.style.top = "0px";
      painted = null;
      layerKey = [null, null];
    },
    /** The picture on the canvas was lost (context restored, fonts loaded, tab shown again): paint the next frame. */
    redraw() {
      painted = null;
      ghostOf = FLOORS.map(() => null);
      w4Phase = null;
      layerKey = [null, null];
    },

    figures: (i: number) => figuresOn(i),
    clock: () => clock,

    /** The floor a person is on now: a mover's current floor, else where they are drawn; null when unseen. */
    floorOf(s: Sim, id: string): number | null {
      scenes(s);
      const f = movers.map((m) => figureOf(m, clock)).find((x) => x?.id === id);
      const i = f ? f.floor : places?.get(id)?.floor;
      return i === undefined ? null : FLOORS[i].floor;
    },

    /** 1 is one floor fitting the stage; the building shows below that. */
    userZoom: () => (getView() === null ? buildingZoom() : user.zoom),
    canPan: () => getView() !== null && user.zoom > 1,
    zoomAt(z: number, cssX: number, cssY: number, instant: boolean) {
      const view = getView();
      if (view === null) return; // the building has one zoom: all of it
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
      turn = 0;
      ghostOf = FLOORS.map(() => null);
      memo = null;
      places = null;
      movers = [];
      clock = 0;
      painted = null;
      layerKey = [null, null];
      w4Dt = 0;
      w4Phase = null;
      w4.reset();
    },

    frame(s: Sim, selected: string | null, hovered: string | null, dt: number, now: number): boolean {
      const view = getView();
      if (view !== shown && shown !== undefined) user = fitCam(LOGICAL_W, LOGICAL_H); // a new floor starts at its fit
      const snap = shown === undefined;
      const want = view === null ? 0 : 1;
      open = snap ? want : open < want ? Math.min(want, open + dt / OPEN_S) : Math.max(want, open - dt / OPEN_S);
      if (open > 0 && s.speed > 0) clock += dt;
      movers = movers.filter((m) => figureOf(m, clock) !== null);
      const t = target(s, view, selected);
      const k = snap ? 1 : 1 - Math.exp(-dt * 6);
      shown = view;
      cam.zoom += (t.zoom - cam.zoom) * k;
      cam.x += (t.x - cam.x) * k;
      cam.y += (t.y - cam.y) * k;
      cam.zoom = Math.max(minZoom(), cam.zoom);

      const live = scenes(s);
      signFloors = live.floors;
      const settled = Math.abs(t.zoom - cam.zoom) < 1e-3 && Math.abs(t.x - cam.x) < 1e-3 && Math.abs(t.y - cam.y) < 1e-3;
      if (open === 0 && settled) {
        // Everything closed() draws: the minute's summary (a new object each minute or world), the hover, the canvas.
        const key = [live.floors, hovered, canvas.width, canvas.height, viewW, viewH, backing, ...[cam.zoom, cam.x, cam.y].map((v) => Math.round(v * 1e3))];
        if (same(painted, key)) {
          if (s.speed > 0) s.moves.length = 0; // as closed(): unseen inside, W4's trolleys are not saved up
          return false;
        }
        painted = key;
      } else if (open === 0) painted = null; // open, the frame's own key is below

      const stage = () => {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = STAGE;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      };
      const pixels = backing * cam.zoom;
      const toWorld = (c: Ctx) => {
        c.setTransform(pixels, 0, 0, pixels, backing * (viewW / 2 - cam.x * cam.zoom), backing * (viewH / 2 - cam.y * cam.zoom));
        c.imageSmoothingEnabled = false;
      };

      if (open === 0) {
        w4Dt = 0; // closed, W4 is not painted and its trolleys hold still, as before
        w4Phase = null;
        layerKey = [null, null];
        stage();
        toWorld(ctx);
        closed(s, live.floors, hovered);
        return true;
      }

      const e = ease(open);
      const walls = Math.round(STOREY * (1 - e)); // the outer walls sink to the slab's own low walls; no ceilings
      const focus = view === null ? -1 : slabIndex(view);
      const alphaOf = (i: number) => (focus < 0 || i === focus ? 1 : 1 + ((i > focus ? ABOVE : BELOW) - 1) * e);
      // Floors other than W4 show from their cached pictures unless focused; one of them is repainted a frame (all on the first).
      const first = turn === 0;
      FLOORS.forEach((spec, i) => {
        if (spec !== W4 && i !== focus && (first || turn % FLOORS.length === i)) paintGhost(i, live.scenes[i], now);
      });
      turn += 1;
      w4Dt += dt;
      const w4i = slabIndex(W4.floor);
      // W4's machines blink at 4 Hz and its high-risk badges at 3 Hz: repaint on either turn, so both stay even.
      const phase = Math.floor(now * 4) * 1e6 + Math.floor(now * 3);
      if (alphaOf(w4i) !== 1 && w4Phase !== phase) {
        w4Ghost.setTransform(1, 0, 0, 1, 0, 0);
        w4Ghost.clearRect(0, 0, LOGICAL_W * GHOST_BACKING, LOGICAL_H * GHOST_BACKING);
        w4Ghost.setTransform(GHOST_BACKING, 0, 0, GHOST_BACKING, 0, 0);
        w4.paint(w4Ghost, s, null, null, w4Dt, now);
        [w4Dt, w4Phase] = [0, phase];
        version[w4i] += 1;
      }
      // Floor i in painter's order onto c (the canvas, or a layer), in the world transform. W4 alone is painted live, or
      // shown from its ghost.
      const slab = (c: Ctx, i: number) => {
        const alpha = alphaOf(i);
        c.save();
        if (alpha !== 1) c.globalAlpha = alpha;
        c.translate(0, storeyY(i, open));
        if (alpha === 1 && FLOORS[i] === W4) {
          w4.paint(c, s, i === focus ? selected : null, i === focus ? hovered : null, w4Dt, now);
          [w4Dt, w4Phase] = [0, null];
        } else if (alpha === 1 && i === focus) slabs[i]!.paint(c, animated(i, live.scenes[i]), selected, hovered, now, figuresOn(i));
        else c.drawImage(ghosts[i], 0, 0, LOGICAL_W, LOGICAL_H); // a ghost; closing, every slab but W4 from its cache
        facade.walls(c, walls);
        if (i === top && e < 1) {
          c.globalAlpha = alpha * (1 - e); // the roof lifts away with the top storey and fades
          facade.roof(c, walls);
        }
        c.restore();
      };

      if (open < 1 || focus < 0 || !settled) {
        // Opening, closing or the camera easing: everything changes every frame, so paint it all here, as before.
        layerKey = [null, null];
        painted = null;
        stage();
        toWorld(ctx);
        if (e < 1) {
          // The pavement and the queue outside fade as the building opens.
          ctx.save();
          ctx.globalAlpha = 1 - e;
          ctx.translate(0, BASE);
          facade.plate(ctx);
          facade.queue(ctx, live.floors?.find((f) => f.floor === 0));
          ctx.restore();
        }
        FLOORS.forEach((_, i) => slab(ctx, i));
        return true;
      }
      // Open and settled: the stage and the ghosts below the focus, then the focus live, then the ghosts above it.
      const base = [focus, canvas.width, canvas.height, viewW, viewH, backing, ...[cam.zoom, cam.x, cam.y].map((v) => Math.round(v * 1e3))];
      const compose = (n: 0 | 1, floors: number[]) => {
        const key = [...base, ...floors.map((i) => version[i])];
        if (same(layerKey[n], key)) return;
        layerKey[n] = key;
        const [l, c] = [layers[n], layerCtx[n]];
        if (l.width !== canvas.width || l.height !== canvas.height) [l.width, l.height] = [canvas.width, canvas.height];
        c.setTransform(1, 0, 0, 1, 0, 0);
        if (n === 0) {
          c.fillStyle = STAGE;
          c.fillRect(0, 0, l.width, l.height);
        } else c.clearRect(0, 0, l.width, l.height);
        toWorld(c);
        for (const i of floors) slab(c, i);
      };
      compose(0, FLOORS.map((_, i) => i).filter((i) => i < focus));
      compose(1, FLOORS.map((_, i) => i).filter((i) => i > focus));
      // Everything the focused floor draws: its scene (a new object each minute), the clock (staff and movers; it stands
      // still only while the hospital is paused or ended), the selection, the hover and its drawers' blink. The layers are
      // new arrays whenever recomposed. W4 is never skipped: its machines and alarms blink from now even when paused.
      const scene = live.scenes[focus];
      const key = [layerKey[0], layerKey[1], scene, clock, selected, hovered, blink(scene, now)];
      if (FLOORS[focus] !== W4 && same(painted, key)) return false;
      painted = key;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(layers[0], 0, 0);
      toWorld(ctx);
      slab(ctx, focus);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(layers[1], 0, 0);
      return true;
    },

    /** BUILDING (closed): `floor:<n>` for a storey or its sign. FLOOR and THING (open): a thing's id on the focused
     * slab, "" for its empty floor, null off it (ghosts take no clicks). "" everywhere while the building opens or
     * closes, so a click then changes nothing. */
    hit(s: Sim, cssX: number, cssY: number): string | null {
      const view = getView();
      const [x, y] = world(cssX, cssY);
      if (view === null && open === 0) {
        const [sx, sy] = [cssX / scale, cssY / scale];
        for (let i = top; i >= 0; i -= 1) {
          const [tx, ty] = signAnchor(i);
          if (Math.abs(sx - tx) <= signText(i).length * 2 + (signDot(i) ? 7 : 4) && sy <= ty && sy >= ty - 12) return `floor:${FLOORS[i].floor}`;
        }
        const i = storeyAt(x, y - BASE, FLOORS.length);
        return i >= 0 ? `floor:${FLOORS[i].floor}` : null;
      }
      if (view === null || open < 1) return "";
      const i = slabIndex(view);
      const ly = y - slabTop(i);
      if (!onSlab(x, ly)) return null;
      return (FLOORS[i] === W4 ? w4.hit(s, x, ly) : slabs[i]!.hit(animated(i, scenes(s).scenes[i]), x, ly, figuresOn(i))) ?? "";
    },
  };
}
