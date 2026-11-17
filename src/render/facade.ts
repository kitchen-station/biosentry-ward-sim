// The hospital from outside: the storeys as one calm block on a pavement. Large light panels, one glass ribbon per storey
// and face, one glass stair core, one cross. A storey's floor is its floor map's own logical frame, lifted STOREY px per
// storey; nothing sits between storeys. Pictures are baked per storey and re-baked only when its lit-segment count changes.
// Pure: no clock, no random.
import { themed } from "./theme";
import { TRIAGE_COLOURS, type FloorSummary } from "../building";
import { MAP_H, MAP_W } from "../sim/map";
import { box, iso, leftFaceBand, rightFaceBand } from "./draw";
import { figurePalette, PERSON, sprite } from "./sprites";

type Ctx = CanvasRenderingContext2D;
type Faces = [string, string, string]; // top, south (left on screen), east (right on screen)

export const STOREY = 36; // logical px: about 1.8 people (sprites are 20 px), three tile heights
export const lift = (i: number) => -i * STOREY; // storey i's floor, GF (0) at the bottom
const T = iso(0, 0);
const R = iso(MAP_W, 0);
const B = iso(MAP_W, MAP_H);
const L = iso(0, MAP_H);

const INK = "#C9D0DA"; // the soft grey line along the corners
const CREAM = "#FFFFFF";
const WALLS: Faces = ["#FFFFFF", "#F4F6F9", "#E4E8EE"];
const EDGE = ["#D5DBE3", "#C8CFD9"]; // the slim line at each floor edge, south and east
const PAVE: Faces = ["#E1E7EE", "#CFD6DF", "#C2CAD5"];
const PARAPET: Faces = ["#F4F6F9", "#DDE2E9", "#CDD3DC"];
const LIT = "#D3E2F0"; // glass with people behind it: a touch lighter and bluer than DIM, no more // a ribbon segment with people behind it; low contrast with DIM on purpose
const DIM = "#BFCEDD";
const MULLION = "#E9EEF4";
const CORE = "#BBD7EE"; // the glass stair core
export const PLATE = { x0: -1, y0: -1, x1: MAP_W + 1, y1: MAP_H + 3 };
const DOORS: [number, number][] = [[5.5, 9.5], [13, 18]]; // GF's south face: the entrance, the emergency bay
const RIBBON = { from: 12, to: 25 }; // px above the floor
const SOUTH_RIBBON: [number, number] = [0.5, 30]; // five segments, then the core and a plain panel
const CORE_AT: [number, number] = [30.5, 33.5];
const EAST_RIBBON: [number, number] = [0.5, 14.5]; // three segments; the cross sits past them on the top storey
export const QUEUE_SHOWN = 12;

/** Cubic in-out on [0, 1]: monotone, 0 at 0, 1 at 1. */
export const ease = (p: number) => {
  const t = Math.max(0, Math.min(1, p));
  return t < 0.5 ? 4 * t * t * t : 1 - (2 - 2 * t) ** 3 / 2;
};

/** Whether a point in a storey's own frame (its floor at lift 0) is on that storey's box: its two front faces or its top. */
export function onStorey(x: number, y: number) {
  if (x < L[0] || x > R[0]) return false;
  return y >= T[1] + Math.abs(x - T[0]) / 2 - STOREY && y <= B[1] - Math.abs(x - B[0]) / 2;
}
/** The storey drawn on top at a point of the closed block (GF's floor at 0): higher storeys cover the tops of lower ones. */
export function storeyAt(x: number, y: number, count: number): number {
  for (let i = count - 1; i >= 0; i -= 1) if (onStorey(x, y - lift(i))) return i;
  return -1;
}

/** The closed block, roof and pavement (GF's floor at 0), for the landing camera. */
export const BUILDING = (count: number) => {
  const x0 = iso(PLATE.x0, PLATE.y1)[0];
  const x1 = iso(PLATE.x1, PLATE.y0)[0];
  const y0 = T[1] + lift(count - 1) - STOREY - 6;
  const y1 = iso(PLATE.x1, PLATE.y1)[1] + 3;
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
};

/** One storey's ribbon segments: five on the long south face, three on the short east face, less GF's doors. */
export interface Segment { face: "south" | "east"; from: number; to: number }
export function segments(floor: number): Segment[] {
  const split = (face: Segment["face"], [a, b]: [number, number], n: number) =>
    Array.from({ length: n }, (_, k): Segment => ({ face, from: a + ((b - a) * k) / n, to: a + ((b - a) * (k + 1)) / n }));
  const south = split("south", SOUTH_RIBBON, 5).filter((s) => floor !== 0 || !DOORS.some(([lo, hi]) => s.from < hi && s.to > lo));
  return [...south, ...split("east", EAST_RIBBON, 3)];
}
/** Lit segments from occupancy: occupied / beds of `total`, rounded, never more than all of them. */
export const litCount = (census: number, capacity: number, total: number) =>
  capacity > 0 ? Math.min(total, Math.max(0, Math.round((total * census) / capacity))) : 0;
export const storeyLit = (floor: number, floors: FloorSummary[] | null) => {
  const f = floors?.find((x) => x.floor === floor);
  return f ? litCount(f.census, f.capacity, segments(floor).length) : 0;
};
const LIT_ORDER = [2, 5, 0, 7, 3, 6, 1, 4]; // which segment lights next: spread over both faces, not left to right

interface Baked { image: HTMLCanvasElement; dx: number; dy: number }
function bakeAt(x0: number, y0: number, x1: number, y1: number, paint: (ctx: Ctx) => void): Baked {
  const image = document.createElement("canvas");
  image.width = x1 - x0;
  image.height = y1 - y0;
  const ctx = themed(image.getContext("2d")!);
  ctx.translate(-x0, -y0);
  paint(ctx);
  return { image, dx: x0, dy: y0 };
}

/** The ink outline: the three upright corners and the top edges of both front faces. */
function inkEdges(ctx: Ctx, h: number) {
  ctx.fillStyle = INK;
  for (const p of [L, B, R]) ctx.fillRect(p[0] - (p === R ? 1 : 0), p[1] - h, 1, h);
  leftFaceBand(ctx, 0, MAP_H, MAP_W, h - 1, h, INK);
  rightFaceBand(ctx, MAP_W, 0, MAP_H, h - 1, h, INK);
}

function paintStorey(ctx: Ctx, floor: number, roof: boolean, lit: number) {
  box(ctx, 0, 0, MAP_W, MAP_H, STOREY, WALLS);
  leftFaceBand(ctx, 0, MAP_H, MAP_W, 0, 2, EDGE[0]);
  rightFaceBand(ctx, MAP_W, 0, MAP_H, 0, 2, EDGE[1]);
  const segs = segments(floor);
  const on = new Set(LIT_ORDER.filter((k) => k < segs.length).slice(0, lit));
  segs.forEach((s, k) => {
    if (s.face === "south") {
      leftFaceBand(ctx, s.from, MAP_H, s.to - s.from, RIBBON.from, RIBBON.to, on.has(k) ? LIT : DIM);
      for (let m = s.from; m < s.to; m += 0.75) leftFaceBand(ctx, m, MAP_H, 0.07, RIBBON.from, RIBBON.to, MULLION); // thin mullions
    } else {
      rightFaceBand(ctx, MAP_W, s.from, s.to - s.from, RIBBON.from, RIBBON.to, on.has(k) ? LIT : DIM);
      for (let m = s.from; m < s.to; m += 0.75) rightFaceBand(ctx, MAP_W, m, 0.07, RIBBON.from, RIBBON.to, MULLION);
    }
  });
  leftFaceBand(ctx, CORE_AT[0], MAP_H, CORE_AT[1] - CORE_AT[0], 2, STOREY, CORE); // the stair core, storey to storey
  if (floor === 0) {
    leftFaceBand(ctx, DOORS[0][0], MAP_H, DOORS[0][1] - DOORS[0][0], 0, 22, "#C9E1F5"); // the entrance, under a canopy
    box(ctx, DOORS[0][0] - 0.3, MAP_H, DOORS[0][1] - DOORS[0][0] + 0.6, 0.8, 2, PARAPET, 23);
    leftFaceBand(ctx, DOORS[1][0], MAP_H, DOORS[1][1] - DOORS[1][0], 0, 20, "#A3AEBE"); // the emergency bay and its red band
    leftFaceBand(ctx, DOORS[1][0], MAP_H, DOORS[1][1] - DOORS[1][0], 24, 31, "#E7434A");
  }
  leftFaceBand(ctx, 0, MAP_H, MAP_W, STOREY - 2, STOREY, "#DCE2EA"); // the slab edge above each storey keeps the floors legible
  rightFaceBand(ctx, MAP_W, 0, MAP_H, STOREY - 2, STOREY, "#CED5DF");
  inkEdges(ctx, STOREY);
  if (roof) {
    rightFaceBand(ctx, MAP_W, 15.2, 2, 12, 28, "#E7434A"); // the hospital cross, near the top
    rightFaceBand(ctx, MAP_W, 15.2, 2, 18, 22, CREAM, 3);
    rightFaceBand(ctx, MAP_W, 15.95, 0.5, 14, 26, CREAM);
    paintRoof(ctx);
  }
}

/** The roof: tonal paving, a parapet, two plant rooms, rooftop units, a stair head and a helipad with a clear H. */
function paintRoof(ctx: Ctx) {
  const z = STOREY;
  const GREY: Faces = ["#E6EAF0", "#D3D9E1", "#C4CBD5"];
  const PLANT: Faces = ["#F6F8FA", "#DDE2E9", "#CBD2DB"];
  const FAN: Faces = ["#B7C1CE", "#9EA9B8", "#8D99A9"];
  box(ctx, 0, 0, MAP_W, MAP_H, 0, ["#ECEFF3", "#ECEFF3", "#ECEFF3"], z);
  box(ctx, 1, 1, MAP_W - 2, MAP_H - 2, 0, ["#F4F6F9", "#F4F6F9", "#F4F6F9"], z); // a paler inner deck
  for (const x of [8, 16, 29]) box(ctx, x, 1, 0.25, MAP_H - 2, 0, GREY, z); // expansion joints
  box(ctx, 0, 0, MAP_W, 0.3, 3, PARAPET, z);
  box(ctx, 0, 0, 0.3, MAP_H, 3, PARAPET, z);
  box(ctx, 2, 2.5, 5, 3.5, 7, PLANT, z); // plant room
  box(ctx, 2.6, 6.3, 3.5, 1.2, 3, PLANT, z);
  box(ctx, 9, 2, 3, 2.5, 5, PLANT, z); // a second, lower one
  for (const [x, y] of [[10, 6], [12.2, 6], [10, 8.2], [12.2, 8.2]]) { // rooftop units with a fan each
    box(ctx, x, y, 1.6, 1.6, 3, GREY, z);
    box(ctx, x + 0.4, y + 0.4, 0.8, 0.8, 0, FAN, z + 3);
  }
  box(ctx, 14, 2, 4, 3, 5, PLANT, z); // lift and stair head
  box(ctx, 14.5, 5.5, 3, 0.5, 1, FAN, z);
  box(ctx, 21, 3.5, 10, 10, 1, ["#B8C3D2", "#9DA9BA", "#8E9AAD"], z); // the helipad
  box(ctx, 21.4, 3.9, 9.2, 9.2, 0, ["#C6CFDB", "#C6CFDB", "#C6CFDB"], z + 1);
  for (const [x, y, w, d] of [[21.4, 3.9, 9.2, 0.35], [21.4, 12.75, 9.2, 0.35], [21.4, 3.9, 0.35, 9.2], [30.25, 3.9, 0.35, 9.2]]) box(ctx, x, y, w, d, 0, [CREAM, CREAM, CREAM], z + 1); // the ring
  for (const x of [24.4, 27]) box(ctx, x, 6, 0.8, 5, 0, [CREAM, CREAM, CREAM], z + 1); // the H
  box(ctx, 25.2, 8.1, 1.8, 0.8, 0, [CREAM, CREAM, CREAM], z + 1);
  box(ctx, 0, MAP_H - 0.3, MAP_W, 0.3, 3, PARAPET, z);
  box(ctx, MAP_W - 0.3, 0, 0.3, MAP_H, 3, PARAPET, z);
}

function paintPlate(ctx: Ctx) {
  box(ctx, PLATE.x0, PLATE.y0, PLATE.x1 - PLATE.x0, PLATE.y1 - PLATE.y0, 3, PAVE, -3);
  box(ctx, 14, MAP_H + 1, 3.2, 1.3, 11, ["#FFFFFF", "#E3E8EE", "#D3DAE3"]); // the ambulance
  leftFaceBand(ctx, 14, MAP_H + 2.3, 3.2, 4, 6, "#E7434A");
  for (const x of [14.4, 16.2]) leftFaceBand(ctx, x, MAP_H + 2.3, 0.6, 0, 2, INK);
}

/** Where the waiting figures stand outside the entrance: two rows out from the doors, back row first. */
export const QUEUE_SPOTS: [number, number][] = Array.from({ length: QUEUE_SHOWN }, (_, j) => [8.6 - (j % 6), MAP_H + 1.2 + Math.floor(j / 6)] as [number, number]);
const BOUNDS = [L[0] - 2, T[1] - STOREY - 12, R[0] + 2, B[1] + 2] as const;

export function createFacade(floors: number[]) {
  const roofOf = floors.length - 1;
  const plate = bakeAt(iso(PLATE.x0, PLATE.y1)[0] - 2, iso(PLATE.x0, PLATE.y0)[1] - 2, iso(PLATE.x1, PLATE.y0)[0] + 2, iso(PLATE.x1, PLATE.y1)[1] + 4, paintPlate);
  const roof = bakeAt(...BOUNDS, paintRoof);
  const baked: (Baked & { lit: number })[] = [];
  const figures = new Map<string, HTMLCanvasElement>();
  const figure = (colour: string, n: number) => {
    const key = `${colour}:${n % 5}`;
    if (!figures.has(key)) figures.set(key, sprite(PERSON.front.stand, figurePalette(colour, n)));
    return figures.get(key)!;
  };
  /** Storey i's picture with `lit` segments lit; re-baked only when that count changes. */
  const storey = (i: number, lit: number) => {
    if (baked[i]?.lit !== lit) baked[i] = { ...bakeAt(...BOUNDS, (ctx) => paintStorey(ctx, floors[i], i === roofOf, lit)), lit };
    return baked[i];
  };
  return {
    storey,
    plate(ctx: Ctx) {
      ctx.drawImage(plate.image, plate.dx, plate.dy);
    },
    /** Storey i of the closed block, its floor at y; `nudge` px out toward the viewer (a hovered storey peeks out). */
    drawStorey(ctx: Ctx, i: number, lit: number, y: number, nudge = 0) {
      const b = storey(i, lit);
      ctx.drawImage(b.image, b.dx + nudge * 2, b.dy + y + nudge);
    },
    /** The roof on walls `h` px tall, in the top storey's frame: it lifts away with that storey as the building opens. */
    roof(ctx: Ctx, h: number) {
      ctx.drawImage(roof.image, roof.dx, roof.dy + STOREY - h);
    },
    outline(ctx: Ctx, y: number, nudge: number, width: number) {
      const at = (p: [number, number], up: number) => [p[0] + nudge * 2, p[1] + y + nudge - up];
      const pts = [at(L, STOREY), at(T, STOREY), at(R, STOREY), at(R, 0), at(B, 0), at(L, 0)];
      ctx.strokeStyle = "#3979F9";
      ctx.lineWidth = width;
      ctx.beginPath();
      pts.forEach(([x, py], k) => (k === 0 ? ctx.moveTo(x, py) : ctx.lineTo(x, py)));
      ctx.closePath();
      ctx.stroke();
    },
    /** The ER queue outside the entrance, in seeing order, in triage colours. */
    queue(ctx: Ctx, gf: FloorSummary | undefined) {
      const er = gf?.units.find((u) => u.id === "ER");
      if (!er) return;
      const shown = er.queue.slice(0, QUEUE_SHOWN).map((t, j) => ({ t, j, at: QUEUE_SPOTS[j] }));
      shown.sort((a, b) => a.at[0] + a.at[1] - (b.at[0] + b.at[1]));
      for (const { t, j, at } of shown) {
        const [sx, sy] = iso(at[0] + 0.5, at[1] + 0.5);
        ctx.fillStyle = "rgba(70,84,104,.18)";
        ctx.fillRect(sx - 5, sy - 1, 10, 2);
        ctx.drawImage(figure(TRIAGE_COLOURS[t], j), sx - 6, sy - 20);
      }
    },
    /** A storey's outer walls, `h` px tall, sinking as the building opens; its ceiling is gone. Storey frame. */
    walls(ctx: Ctx, h: number) {
      if (h < 1) return;
      leftFaceBand(ctx, 0, MAP_H, MAP_W, 0, h, WALLS[1]);
      rightFaceBand(ctx, MAP_W, 0, MAP_H, 0, h, WALLS[2]);
      leftFaceBand(ctx, 0, MAP_H, MAP_W, 0, Math.min(2, h), EDGE[0]);
      inkEdges(ctx, h);
    },
  };
}
