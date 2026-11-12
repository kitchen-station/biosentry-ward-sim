// Isometric ward renderer: one Canvas 2D, sprites nearest-neighbour, text at full resolution.
// Tile (x, y) has its top corner at iso(x, y). Reads the sim, never changes it.

import { clampCam, fitCam, panBy, zoomAbout, type Cam } from "../camera";
import { findPath, nurseStand, BEDS, CORRIDOR, MAP_H, MAP_W, STATIONS, bedByLabel, type Bed, type Tile } from "../sim/map";
import { GROUP_COLOURS, type Cell } from "../building";
import { W4, type FloorSpec, type SpecRoom, type Tint } from "./floors";
import type { Figure } from "./move";
import type { Scene } from "./scene";
import { staffById, staffStatus, type Sim } from "../sim/sim";
import {
  ENVELOPE,
  ENVELOPE_PALETTE,
  NURSE_PALETTES,
  PATIENT_HEAD,
  PERSON,
  PLANT,
  PLANT_PALETTE,
  STAFF_PALETTES,
  figurePalette,
  patientPalette,
  sprite,
} from "./sprites";

const HALF_W = 12;
const HALF_H = 6;
const MARGIN = 4;
const OX = MAP_H * HALF_W + MARGIN;
const OY = 48;
export const LOGICAL_W = (MAP_W + MAP_H) * HALF_W + MARGIN * 2;
export const LOGICAL_H = OY + (MAP_W + MAP_H) * HALF_H + 10;

const INK = "#1A1320";
const CREAM = "#FFF8E7";
const FONT = '8px "VT323", monospace';
const FONT_SMALL = '7px "VT323", monospace';

export const CHIP_COLOURS = {
  idle: "#A899B5",
  thinking: "#4ECDC4",
  working: "#FFD93D",
  waiting: "#6C8EF5",
  success: "#6BCF7F",
};

export const RISK_LIGHT: Record<string, string> = {
  low: "#6BCF7F",
  low_medium: "#FFD93D",
  medium: "#FFA07A",
  high: "#FF6B6B",
};

export const iso = (x: number, y: number): [number, number] => [
  Math.round(OX + (x - y) * HALF_W),
  Math.round(OY + (x + y) * HALF_H),
];

type Ctx = CanvasRenderingContext2D;

/** An isometric box, rasterised in rows and columns so the edges stay hard. */
export function box(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  d: number,
  h: number,
  colours: [string, string, string],
  z = 0,
) {
  const [top, left, right] = colours;
  const T = iso(x, y);
  const R = iso(x + w, y);
  const B = iso(x + w, y + d);
  const L = iso(x, y + d);
  ctx.fillStyle = left;
  for (let px = L[0]; px < B[0]; px += 1) {
    const edge = Math.round(L[1] + (px - L[0]) / 2);
    ctx.fillRect(px, edge - h - z, 1, h);
  }
  ctx.fillStyle = right;
  for (let px = B[0]; px < R[0]; px += 1) {
    const edge = Math.round(B[1] - (px - B[0]) / 2);
    ctx.fillRect(px, edge - h - z, 1, h);
  }
  ctx.fillStyle = top;
  for (let py = T[1]; py < B[1]; py += 1) {
    const from = py <= L[1] ? T[0] - (py - T[1]) * 2 : L[0] + (py - L[1]) * 2;
    const to = py <= R[1] ? T[0] + (py - T[1]) * 2 : R[0] - (py - R[1]) * 2;
    ctx.fillRect(from, py - h - z, to - from, 1);
  }
}

/** Marks on a box's left (south-facing) face: a band `from` to `to` px above the floor. */
export function leftFaceBand(ctx: Ctx, x: number, y: number, w: number, from: number, to: number, colour: string, inset = 0) {
  const L = iso(x, y);
  const B = iso(x + w, y);
  ctx.fillStyle = colour;
  for (let px = L[0] + inset; px < B[0] - inset; px += 1) {
    const edge = Math.round(L[1] + (px - L[0]) / 2);
    ctx.fillRect(px, edge - to, 1, to - from);
  }
}

/** The same, on a box's right (east-facing) face, for a wall running along y. */
export function rightFaceBand(ctx: Ctx, x: number, y: number, d: number, from: number, to: number, colour: string, inset = 0) {
  const B = iso(x, y + d);
  const R = iso(x, y);
  ctx.fillStyle = colour;
  for (let px = B[0] + inset; px < R[0] - inset; px += 1) {
    const edge = Math.round(B[1] - (px - B[0]) / 2);
    ctx.fillRect(px, edge - to, 1, to - from);
  }
}

interface Item {
  depth: number;
  image: HTMLCanvasElement;
  bed?: string;
  empty?: HTMLCanvasElement; // a bed's picture with nobody in it
  body?: HTMLCanvasElement; // and with a body under a sheet, awaiting the morgue
  dx: number;
  dy: number;
}

/** Paints once into a small canvas; bounds cover the given footprint and height. */
function bake(depth: number, x: number, y: number, w: number, d: number, h: number, paint: (ctx: Ctx) => void): Item {
  const left = iso(x, y + d)[0] - 2;
  const right = iso(x + w, y)[0] + 2;
  const top = iso(x, y)[1] - h - 2;
  const bottom = iso(x + w, y + d)[1] + 2;
  const image = document.createElement("canvas");
  image.width = right - left;
  image.height = bottom - top;
  const ctx = image.getContext("2d")!;
  ctx.translate(-left, -top);
  paint(ctx);
  return { depth, image, dx: left, dy: top };
}

const hex = (colour: string): [number, number, number] => [
  parseInt(colour.slice(1, 3), 16),
  parseInt(colour.slice(3, 5), 16),
  parseInt(colour.slice(5, 7), 16),
];

// [grout, light, dark] per room type; each room reads as its own space.
const FLOORS: Record<Tint, [string, string, string]> = {
  bay: ["#97B09F", "#BBD0C1", "#AEC5B6"],
  hdu: ["#93AFC0", "#C3D8E4", "#B5CDDB"],
  side: ["#B8A48F", "#E8D5C2", "#DECAB5"],
  station: ["#C9B98F", "#F4E9C7", "#EADDB5"],
  office: ["#8F6843", "#C79A6B", "#BD9062"],
  utility: ["#B9C2C7", "#EEF1F2", "#E2E7EA"],
  family: ["#B3A7C2", "#DDD3E6", "#D2C7DD"],
  comms: ["#4B566A", "#6B7A8F", "#637286"],
  waiting: ["#C9B98F", "#F4E9C7", "#EADDB5"],
  cold: ["#9AA6AE", "#D5DDE2", "#C9D2D8"],
};

const roomIn = (spec: FloorSpec, x: number, y: number) =>
  spec.rooms.find((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);

function floorColour(spec: FloorSpec, tx: number, ty: number, u: number, v: number): [number, number, number] {
  const grout = u - tx < 0.05 || v - ty < 0.05;
  const checker = (tx + ty) % 2 === 0;
  const ch = spec.map[ty]?.[tx];
  if (ch === "+") return hex(grout ? "#8F8571" : "#B5A98D");
  if (ty >= CORRIDOR.y0 && ty <= CORRIDOR.y1) {
    if (v > 9.4 && v < 9.54) return hex("#4ECDC4"); // wayfinding stripe
    return hex(grout ? "#CBBE9F" : checker ? "#EFE5CB" : "#E6DABC");
  }
  const room = roomIn(spec, tx, ty);
  if (!room) return hex("#B8AE98"); // under the walls
  const [g, light, dark] = FLOORS[room.floor];
  if (room.floor === "office") {
    const plank = Math.floor(v * 3);
    if (Math.floor(v * 3 + 0.08) !== plank) return hex(g);
    return hex(plank % 2 === 0 ? light : dark);
  }
  return hex(grout ? g : checker ? light : dark);
}

function bakeFloor(spec: FloorSpec): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = LOGICAL_W;
  canvas.height = LOGICAL_H;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(LOGICAL_W, LOGICAL_H);
  for (let py = 0; py < LOGICAL_H; py += 1) {
    for (let px = 0; px < LOGICAL_W; px += 1) {
      const a = (px - OX) / HALF_W;
      const b = (py - OY) / HALF_H;
      const u = (a + b) / 2;
      const v = (b - a) / 2;
      if (u < 0.7 || v < 0.7 || u >= MAP_W - 0.7 || v >= MAP_H - 0.7) continue;
      const [r, g, bl] = floorColour(spec, Math.floor(u), Math.floor(v), u, v);
      const i = (py * LOGICAL_W + px) * 4;
      image.data[i] = r;
      image.data[i + 1] = g;
      image.data[i + 2] = bl;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

const WALL: [string, string, string] = ["#FFF8E7", "#C9D6CE", "#A9BAB0"];
const WALL_EDGE: [string, string, string] = ["#E8D9A0", "#B9A98A", "#A3947A"];

const isWall = (map: string[], x: number, y: number) => ["#", "+", "g"].includes(map[y]?.[x] ?? "");
const GLASS: [string, string, string] = ["rgba(216,240,245,.85)", "rgba(168,220,230,.55)", "rgba(143,202,214,.55)"];

/** Walls are drawn thin inside their tile, so rooms read as rooms and the floor stays visible. */
function wallItem(map: string[], x: number, y: number): Item {
  const rimBack = y === 0 || x === 0;
  const rimFront = y === MAP_H - 1 || x === MAP_W - 1;
  const glass = map[y][x] === "g"; // the high-dependency bay is glazed toward the station
  const h = rimFront ? 3 : rimBack ? 20 : glass ? 11 : 8;
  const colours = rimFront ? WALL_EDGE : glass ? GLASS : WALL;
  const T = 0.3;
  const across = isWall(map, x - 1, y) || isWall(map, x + 1, y);
  const along = isWall(map, x, y - 1) || isWall(map, x, y + 1);
  return bake(x + y, x, y, 1, 1, h, (ctx) => {
    if (y === 0) box(ctx, x, 1 - T, 1, T, h, colours);
    else if (x === 0) box(ctx, 1 - T, y, T, 1, h, colours);
    else if (y === MAP_H - 1) box(ctx, x, y, 1, T, h, colours);
    else if (x === MAP_W - 1) box(ctx, x, y, T, 1, h, colours);
    else {
      if (along) box(ctx, x + 0.35, y, T, 1, h, colours);
      if (across) box(ctx, x, y + 0.35, 1, T, h, colours);
    }
    if (y === 0 && x > 0 && x < MAP_W - 1) {
      leftFaceBand(ctx, x, 1, 1, 0, 5, "#8FA99B");
      if (x % 2 === 0 && x < 31) leftFaceBand(ctx, x, 1, 1, 8, 16, "#BFE6F2", 3);
    }
    if (x === 0 && y > 0 && y < MAP_H - 1) rightFaceBand(ctx, 1, y, 1, 0, 5, "#7F978A");
  });
}

const SHEET: [string, string, string] = ["#FFFDF5", "#E3DFD0", "#CFCABA"];

/** body: a sheet over the whole length, head included, and no blanket colour. */
function bedItem(bedX: number, headY: number, footY: number, patient: number | null, body = false): Item {
  const y0 = Math.min(headY, footY);
  const north = headY < footY;
  const frame: [string, string, string] = ["#D9D3C4", "#9F9A8E", "#8A8579"];
  const sheet = SHEET;
  const blanket: [string, string, string] =
    patient === null ? ["#D9E4EC", "#B8C7D2", "#A5B5C1"] : ["#7DA7D9", "#5E89BC", "#4F78A9"];
  return bake(y0 + 1 + bedX, bedX, y0, 1, 2, 16, (ctx) => {
    const x = bedX + 0.12;
    box(ctx, x, y0, 0.76, 2, 4, frame);
    box(ctx, x, y0, 0.76, 2, 2, sheet, 4);
    const blanketY = north ? y0 + 0.75 : y0;
    if (body) box(ctx, x + 0.06, y0 + 0.1, 0.64, 1.8, 4, ["#F2EEE2", "#CFCABA", "#BDB8A8"], 4);
    else box(ctx, x, blanketY, 0.76, 1.25, patient === null ? 2 : 3, blanket, 4);
    if (!body) box(ctx, x + 0.1, north ? y0 + 0.08 : y0 + 1.42, 0.56, 0.5, 2, sheet, 6);
    box(ctx, x, north ? y0 : y0 + 1.92, 0.76, 0.08, 12, ["#E8D9A0", "#C7B583", "#B3A172"]);
    if (patient !== null && !body) {
      const [sx, sy] = iso(bedX + 0.5, north ? y0 + 0.36 : y0 + 1.66);
      ctx.drawImage(sprite(PATIENT_HEAD, patientPalette(patient)), sx - 3, sy - 13);
    }
  });
}

function tileItem(spec: FloorSpec, ch: string, x: number, y: number): Item | null {
  const depth = x + y;
  switch (ch) {
    case "=":
      return bake(depth, x, y, 1, 1, 26, (ctx) => {
        box(ctx, x, y, 1, 1, 6, ["#D8B27C", "#A9835A", "#94714D"]);
        box(ctx, x, y, 1, 1, 1, ["#F4E9C7", "#D9CDA6", "#C7BA92"], 6);
        if (x === STATIONS.screen[0]) {
          box(ctx, x + 0.2, y + 0.35, 0.6, 0.15, 12, ["#3D2E4A", "#1A1320", "#1A1320"], 7);
          leftFaceBand(ctx, x + 0.2, y + 0.5, 0.6, 9, 18, "#4ECDC4", 1);
          leftFaceBand(ctx, x + 0.2, y + 0.5, 0.6, 13, 14, "#FFF8E7", 2);
        } else if ((x + 1) % 2 === 0) {
          box(ctx, x + 0.3, y + 0.4, 0.4, 0.15, 7, ["#3D2E4A", "#1A1320", "#1A1320"], 7);
        }
      });
    case "c":
      return bake(depth, x, y, 1, 1, 10, (ctx) => {
        box(ctx, x + 0.2, y + 0.2, 0.6, 0.6, 4, ["#C79A6B", "#8F6843", "#7A5838"]);
        box(ctx, x + 0.2, y + 0.2, 0.6, 0.12, 9, ["#C79A6B", "#8F6843", "#7A5838"]);
      });
    case "M":
      return bake(depth, x, y, 1, 1, 20, (ctx) => {
        box(ctx, x + 0.05, y + 0.1, 0.9, 0.8, 16, ["#D5DDE2", "#9AA6AE", "#87939B"]);
        [3, 8, 13].forEach((h) => leftFaceBand(ctx, x + 0.05, y + 0.9, 0.9, h, h + 1, "#5E6B75", 3));
      });
    case "V":
      return bake(depth, x, y, 1, 1, 26, (ctx) => {
        box(ctx, x + 0.3, y + 0.3, 0.4, 0.4, 10, ["#D9D3C4", "#9F9A8E", "#8A8579"]);
        box(ctx, x + 0.2, y + 0.35, 0.6, 0.15, 9, ["#3D2E4A", "#1A1320", "#1A1320"], 10);
        leftFaceBand(ctx, x + 0.2, y + 0.5, 0.6, 12, 18, "#4ECDC4", 1);
      });
    case "D":
      return bake(depth, x, y, 1, 1, 20, (ctx) => {
        box(ctx, x, y, 1, 1, 6, ["#8F6843", "#6E4F31", "#5D4229"]);
        box(ctx, x + 0.25, y + 0.3, 0.5, 0.15, 8, ["#3D2E4A", "#1A1320", "#1A1320"], 6);
        leftFaceBand(ctx, x + 0.25, y + 0.45, 0.5, 8, 13, "#A8E6E0", 1);
      });
    case "L":
      // A bookshelf in the doctors' office, a supply cabinet everywhere else.
      if (roomIn(spec, x, y)?.floor === "office") {
        return bake(depth, x, y, 1, 1, 20, (ctx) => {
          box(ctx, x + 0.1, y + 0.1, 0.8, 0.8, 16, ["#8F6843", "#6E4F31", "#5D4229"]);
          ["#FF6B6B", "#FFD93D", "#6C8EF5", "#6BCF7F"].forEach((c, i) =>
            leftFaceBand(ctx, x + 0.15 + i * 0.18, y + 0.9, 0.14, 3, 14, c),
          );
        });
      }
      return bake(depth, x, y, 1, 1, 16, (ctx) => {
        box(ctx, x + 0.1, y + 0.1, 0.8, 0.8, 12, ["#FFFDF5", "#D9D3C4", "#C4BEAF"]);
        leftFaceBand(ctx, x + 0.1, y + 0.9, 0.8, 6, 7, "#A9B4BA", 1);
      });
    case "K":
      return bake(depth, x, y, 1, 1, 24, (ctx) => {
        box(ctx, x + 0.1, y + 0.1, 0.8, 0.8, 20, ["#3D2E4A", "#2A2036", "#1A1320"]);
        [5, 9, 13, 17].forEach((h) => leftFaceBand(ctx, x + 0.1, y + 0.9, 0.8, h, h + 1, "#4ECDC4", 2));
      });
    case "S":
      return bake(depth, x, y, 1, 1, 14, (ctx) => {
        box(ctx, x + 0.15, y + 0.15, 0.7, 0.7, 7, ["#FFFDF5", "#D9D3C4", "#C4BEAF"]);
        box(ctx, x + 0.3, y + 0.3, 0.4, 0.4, 1, ["#A8E6E0", "#A8E6E0", "#A8E6E0"], 7);
      });
    case "W":
      return bake(depth, x, y, 1, 1, 14, (ctx) => {
        box(ctx, x + 0.3, y + 0.25, 0.4, 0.5, 4, ["#FFFDF5", "#D9D3C4", "#C4BEAF"]);
        box(ctx, x + 0.65, y + 0.25, 0.2, 0.5, 9, ["#FFFDF5", "#D9D3C4", "#C4BEAF"]);
      });
    case "T":
      return bake(depth, x, y, 1, 1, 10, (ctx) => {
        box(ctx, x + 0.15, y + 0.15, 0.7, 0.7, 5, ["#C79A6B", "#8F6843", "#7A5838"]);
      });
    case "H":
      return bake(depth, x, y, 1, 1, 12, (ctx) => {
        box(ctx, x + 0.1, y + 0.15, 0.8, 0.7, 4, ["#B197FC", "#8E72E0", "#7459C4"]);
        box(ctx, x + 0.1, y + 0.15, 0.8, 0.2, 8, ["#B197FC", "#8E72E0", "#7459C4"]);
      });
    case "U":
      return bake(depth, x, y, 1, 1, 12, (ctx) => {
        box(ctx, x + 0.05, y + 0.1, 0.9, 0.8, 7, ["#E2E7EA", "#A9B4BA", "#97A3AA"]);
      });
    case "P":
      return bake(depth, x, y, 1, 1, 18, (ctx) => {
        const [sx, sy] = iso(x + 0.5, y + 0.5);
        ctx.drawImage(sprite(PLANT, PLANT_PALETTE), sx - 4, sy - 10);
      });
    case "G":
    case "Q":
    case "N":
    case "R":
      return bake(depth, x, y, 1, 1, 22, (ctx) => {
        box(ctx, x + 0.1, y + 0.1, 0.8, 0.8, 16, ["#4B566A", "#39424F", "#2C343F"]);
        leftFaceBand(ctx, x + 0.1, y + 0.9, 0.8, 6, 13, "#1A1320", 2);
      });
    default:
      return null;
  }
}

function buildItems(spec: FloorSpec): Item[] {
  const items: Item[] = [];
  for (let y = 0; y < MAP_H; y += 1) {
    for (let x = 0; x < MAP_W; x += 1) {
      const ch = spec.map[y][x];
      if (ch === "#" || ch === "g") items.push(wallItem(spec.map, x, y));
      else {
        const item = tileItem(spec, ch, x, y);
        if (item) items.push(item);
      }
    }
  }
  // Both pictures, because patients come and go.
  spec.beds.forEach((bed, i) => {
    const [x, head, foot] = [bed.head[0], bed.head[1], bed.foot[1]];
    items.push({ ...bedItem(x, head, foot, i), bed: bed.label, empty: bedItem(x, head, foot, null).image, body: bedItem(x, head, foot, i, true).image });
  });
  return items.sort((a, b) => a.depth - b.depth);
}

const stationPoint = (tile: Tile, lift = 18): [number, number] => {
  const [x, y] = iso(tile[0] + 0.5, tile[1] + 0.5);
  return [x, y - lift];
};

export const ZOOM = 2.4;
const ENTRY: Tile = [34, 8];
export const TROLLEY_TILES_PER_S = 7;

// id, tile, tag text, tag height above the machine (staggered so neighbours do not overlap)
const MACHINES: [string, Tile, string, number][] = [
  ["gateway", STATIONS.gateway, "GATEWAY", 19],
  ["gate", STATIONS.gate, "GATE", 31],
  ["news2", STATIONS.news2, "NEWS2", 19],
  ["arbiter", STATIONS.arbiter, "ARBITER", 31],
  ["screen", STATIONS.screen, "WARD LIST", 19],
  ["entrance", ENTRY, "ENTRANCE", 10],
];

interface Trolley {
  path: Tile[];
  at: number; // tiles along the path
  bed: string;
  kind: Sim["moves"][number]["kind"];
}

const TROLLEY_TAG: Record<Trolley["kind"], string> = { in: "IN", discharged: "OUT", higher_care: "HIGHER CARE" };

export function bedAnchor(p: { bed: string }): [number, number] {
  const bed = bedByLabel(p.bed);
  const y0 = Math.min(bed.head[1], bed.foot[1]);
  const [x, y] = iso(bed.foot[0] + 0.5, y0 + (bed.north ? 0.9 : 1.1));
  return [x, y - 8];
}

export function tag(ctx: Ctx, text: string, cx: number, bottom: number, dot?: string, inverted = false) {
  ctx.font = FONT;
  const dotW = dot ? 6 : 0;
  const w = Math.ceil(ctx.measureText(text).width) + 5 + dotW;
  const h = 9;
  const x = Math.round(cx - w / 2);
  const y = Math.round(bottom - h - 2);
  ctx.fillStyle = INK;
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillRect(Math.round(cx) - 1, y + h, 3, 2);
  ctx.fillStyle = inverted ? INK : CREAM;
  ctx.fillRect(x, y, w, h);
  if (dot) {
    ctx.fillStyle = dot;
    ctx.fillRect(x + 2, y + 3, 3, 3);
  }
  ctx.fillStyle = inverted ? CREAM : INK;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(text, x + 2 + dotW, y + h / 2 + 0.5);
}

function label(ctx: Ctx, text: string, x: number, y: number, colour: string, font = FONT_SMALL) {
  ctx.font = font;
  ctx.fillStyle = colour;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}


/** Room labels and the floor's name, printed on the floor. */
function floorText(ctx: Ctx, spec: FloorSpec) {
  for (const room of spec.rooms) {
    const [x, y] = iso((room.x0 + room.x1 + 1) / 2, (room.y0 + room.y1 + 1) / 2);
    label(ctx, room.label, x, y, room.floor === "comms" ? "#E8D9A0" : "rgba(26,19,32,.55)");
  }
  const [wx, wy] = iso(3, 8.6);
  label(ctx, spec.name, wx, wy, "rgba(26,19,32,.6)", FONT);
}

export const roomCentre = (room: SpecRoom) => iso((room.x0 + room.x1 + 1) / 2, (room.y0 + room.y1 + 1) / 2);

const unIso = (px: number, py: number): [number, number] => {
  const a = (px - OX) / HALF_W;
  const b = (py - OY) / HALF_H;
  return [(a + b) / 2, (b - a) / 2];
};
/** Whether a logical point falls on a w x d footprint at (tx, ty), or on anything standing up to h px on it. */
function onFootprint(x: number, y: number, tx: number, ty: number, w: number, d: number, h: number) {
  for (let lift = 0; lift <= h; lift += 1) {
    const [u, v] = unIso(x, y + lift);
    if (u >= tx && u < tx + w && v >= ty && v < ty + d) return true;
  }
  return false;
}
function outline(ctx: Ctx, tx: number, ty: number, w: number, d: number, selected: boolean) {
  const [a, right, b, left] = [iso(tx, ty), iso(tx + w, ty), iso(tx + w, ty + d), iso(tx, ty + d)];
  ctx.strokeStyle = selected ? "#FFD93D" : CREAM;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(right[0], right[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.lineTo(left[0], left[1]);
  ctx.closePath();
  ctx.stroke();
}
const tilePoint = (t: Tile, lift: number): [number, number] => {
  const [x, y] = iso(t[0] + 0.5, t[1] + 0.5);
  return [x, y - lift];
};
const bedPoint = (bed: Bed): [number, number] => {
  const y0 = Math.min(bed.head[1], bed.foot[1]);
  const [x, y] = iso(bed.head[0] + 0.5, y0 + (bed.north ? 0.9 : 1.1));
  return [x, y - 8];
};
/** Initials; "XX ICU" for an ICU-indicated person once admitted; a body's tag is inverted and has no dot. */
const cellText = (c: Cell) => (c.icu && !c.dead ? `${c.initials} ICU` : c.initials);
const cellTag = (ctx: Ctx, c: Cell, x: number, bottom: number) => tag(ctx, cellText(c), x, bottom, c.dead ? undefined : GROUP_COLOURS[c.group], c.dead);
const inTag = (x: number, y: number, cx: number, bottom: number, text: string, dot: boolean) =>
  Math.abs(x - cx) <= text.length * 2 + (dot ? 6 : 3) && y >= bottom - 12 && y <= bottom;
const TROLLEY: [string, string, string] = ["#7DA7D9", "#5E89BC", "#4F78A9"];
const COVER: [string, string, string] = ["#F2EEE2", "#CFCABA", "#BDB8A8"];

/** A hospital floor other than W4: baked once; who is where comes from its scene (render/scene.ts) at each paint. */
export function createFloor(spec: FloorSpec) {
  const floor = bakeFloor(spec);
  const items = buildItems(spec);
  const nurses = NURSE_PALETTES.map((p) => sprite(PERSON.front.stand, p));
  const heads = Array.from({ length: 5 }, (_, i) => sprite(PATIENT_HEAD, patientPalette(i)));
  const figures = new Map<string, HTMLCanvasElement>(); // per triage colour and skin
  const figure = (colour: string, n: number) => {
    const key = `${colour}:${n % 5}`;
    if (!figures.has(key)) figures.set(key, sprite(PERSON.front.stand, figurePalette(colour, n)));
    return figures.get(key)!;
  };
  const personN = (id: string) => Number(id.slice(2)) || 0;
  const depthOf = (t: Tile) => t[0] + t[1] + 0.01;

  function drawSpot(ctx: Ctx, tile: Tile, c: Cell, morgue: boolean) {
    const [x, y] = tile;
    const [sx, sy] = iso(x + 0.5, y + 0.5);
    ctx.fillStyle = "rgba(26,19,32,.28)";
    ctx.fillRect(sx - 6, sy - 1, 12, 2);
    if (c.dead || morgue) {
      box(ctx, x + 0.1, y + 0.2, 0.8, 0.6, 2, COVER, 3);
      box(ctx, x + 0.2, y + 0.3, 0.6, 0.4, 2, COVER, 5);
    } else {
      box(ctx, x + 0.1, y + 0.2, 0.8, 0.6, 2, TROLLEY, 3);
      ctx.drawImage(heads[c.slot % 5], sx - 3, sy - 13);
    }
  }

  return {
    paint(ctx: Ctx, scene: Scene, selected: string | null, hovered: string | null, now: number, figures: Figure[] = []) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(floor, 0, 0);
      floorText(ctx, spec);
      const beds = new Map(scene.beds.map((b) => [b.bed.label, b]));
      const actors: { depth: number; draw: () => void }[] = [
        ...scene.spots.map((p) => ({ depth: depthOf(p.tile), draw: () => drawSpot(ctx, p.tile, p.cell, p.unit === "MORGUE") })),
        ...scene.staff.map((m) => ({
          depth: depthOf(m.tile),
          draw: () => {
            const [sx, sy] = iso(m.tile[0] + 0.5, m.tile[1] + 0.5);
            ctx.fillStyle = "rgba(26,19,32,.28)";
            ctx.fillRect(sx - 5, sy - 1, 10, 2);
            ctx.drawImage(nurses[m.i % nurses.length], sx - 6, sy - 20);
          },
        })),
        ...figures.map((f) => ({
          depth: depthOf(f.tile),
          draw: () => {
            if (!f.walk) return drawSpot(ctx, f.tile, f.cell, f.body);
            const [sx, sy] = iso(f.tile[0] + 0.5, f.tile[1] + 0.5);
            ctx.fillStyle = "rgba(26,19,32,.28)";
            ctx.fillRect(sx - 5, sy - 1, 10, 2);
            ctx.drawImage(figure(f.colour, personN(f.id)), sx - 6, sy - 20);
          },
        })),
        ...scene.queue.map((q) => ({
          depth: depthOf(q.tile),
          draw: () => {
            const [sx, sy] = iso(q.tile[0] + 0.5, q.tile[1] + 0.5);
            const img = figure(q.colour, personN(q.id));
            if (q.seated) ctx.drawImage(img, 0, 0, 12, 17, sx - 6, sy - 17, 12, 17); // the 3 leg rows cropped, 3 px lower: sitting
            else ctx.drawImage(img, sx - 6, sy - 20);
          },
        })),
      ].sort((a, b) => a.depth - b.depth);
      let next = 0;
      for (const item of items) {
        while (next < actors.length && actors[next].depth < item.depth) actors[next++].draw();
        if (!item.bed) {
          ctx.drawImage(item.image, item.dx, item.dy);
          continue;
        }
        const b = beds.get(item.bed);
        if (!b) continue; // a bed tile beyond the unit's authorised count
        ctx.drawImage(b.cell === null ? item.empty! : b.cell.dead ? item.body! : item.image, item.dx, item.dy);
      }
      while (next < actors.length) actors[next++].draw();

      for (const d of scene.drawers) {
        if (!d.full) continue;
        const [x, y] = iso(d.tile[0] + 0.5, d.tile[1] + 0.9);
        ctx.fillStyle = INK;
        ctx.fillRect(x - 2, y - 17, 4, 3);
        ctx.fillStyle = Math.floor(now * 2 + d.tile[0]) % 6 === 0 ? CREAM : "#FFD93D";
        ctx.fillRect(x - 1, y - 16, 2, 1);
      }
      const [lx, ly] = iso(MAP_W - 1 + 0.5, CORRIDOR.y0 + 0.5);
      tag(ctx, "LIFT", lx, ly - 10);

      const marked = (...ids: string[]) => (ids.includes(selected ?? "") ? "selected" : ids.includes(hovered ?? "") ? "hovered" : null);
      for (const b of scene.beds) {
        const m = marked(b.id, b.slot);
        if (m) outline(ctx, b.bed.head[0], Math.min(b.bed.head[1], b.bed.foot[1]), 1, 2, m === "selected");
      }
      for (const p of scene.spots) {
        const m = marked(p.id, p.slot);
        if (m) outline(ctx, p.tile[0], p.tile[1], 1, 1, m === "selected");
      }
      for (const d of scene.drawers) {
        const m = d.full ? marked(d.id, d.slot) : marked(d.slot);
        if (m) outline(ctx, d.tile[0], d.tile[1], 1, 1, m === "selected");
      }
      for (const b of scene.beds) {
        if (!b.cell) continue;
        const [x, y] = bedPoint(b.bed);
        cellTag(ctx, b.cell, x, y - 8);
      }
      for (const p of scene.spots) {
        const [x, y] = tilePoint(p.tile, 0);
        cellTag(ctx, p.unit === "MORGUE" ? { ...p.cell, dead: true } : p.cell, x, y - 14); // every body's tag is inverted
      }
      for (const f of figures) {
        const [x, y] = tilePoint(f.tile, 0);
        if (!f.walk) cellTag(ctx, f.body ? { ...f.cell, dead: true } : f.cell, x, y - 14);
        else if (marked(f.id)) tag(ctx, f.cell.initials, x, y - 22, f.colour);
      }
      for (const q of scene.queue) {
        if (!marked(q.id)) continue;
        const [x, y] = tilePoint(q.tile, 0);
        tag(ctx, q.cell.initials, x, y - (q.seated ? 19 : 22), q.colour);
      }
      for (const m of scene.more) {
        const [x, y] = tilePoint(m.tile, 4);
        tag(ctx, m.text, x, y, undefined, marked(m.id) !== null);
      }
      for (const room of spec.rooms) {
        if (!room.sel || !marked(room.sel)) continue;
        const [x, y] = roomCentre(room);
        tag(ctx, room.label, x, y + 5, undefined, true);
      }
    },

    /** The thing at a logical point of this floor: people, tags, beds and drawers, labels. */
    hit(scene: Scene, x: number, y: number, figures: Figure[] = []): string | null {
      const people = [
        ...figures.map((f) => ({ id: f.id, tile: f.tile, h: 20 })),
        ...scene.queue.map((q) => ({ id: q.id, tile: q.tile, h: q.seated ? 17 : 20 })),
        ...scene.staff.map((m) => ({ id: m.id, tile: m.tile, h: 20 })),
      ].sort((a, b) => b.tile[0] + b.tile[1] - (a.tile[0] + a.tile[1]));
      for (const p of people) {
        const [sx, sy] = iso(p.tile[0] + 0.5, p.tile[1] + 0.5);
        if (Math.abs(x - sx) <= 5 && y <= sy && y >= sy - p.h) return p.id;
      }
      for (const b of scene.beds) {
        if (!b.cell) continue;
        const [cx, cy] = bedPoint(b.bed);
        if (inTag(x, y, cx, cy - 8, cellText(b.cell), !b.cell.dead)) return b.id;
      }
      for (const p of scene.spots) {
        const [cx, cy] = tilePoint(p.tile, 0);
        if (inTag(x, y, cx, cy - 14, cellText(p.cell), !p.cell.dead && p.unit !== "MORGUE")) return p.id;
      }
      for (const m of scene.more) {
        const [cx, cy] = tilePoint(m.tile, 4);
        if (inTag(x, y, cx, cy, m.text, false)) return m.id;
      }
      const front = (t: Tile) => -(t[0] + t[1]);
      for (const b of [...scene.beds].sort((p, q) => front(p.bed.head) - front(q.bed.head))) {
        if (onFootprint(x, y, b.bed.head[0], Math.min(b.bed.head[1], b.bed.foot[1]), 1, 2, 14)) return b.id;
      }
      for (const p of [...scene.spots].sort((a, b) => front(a.tile) - front(b.tile))) {
        if (onFootprint(x, y, p.tile[0], p.tile[1], 1, 1, 8)) return p.id;
      }
      for (const d of [...scene.drawers].sort((a, b) => front(a.tile) - front(b.tile))) if (onFootprint(x, y, d.tile[0], d.tile[1], 1, 1, 16)) return d.id;
      for (const room of spec.rooms) {
        const [cx, cy] = roomCentre(room);
        if (room.sel && Math.abs(x - cx) <= room.label.length * 2 + 4 && Math.abs(y - cy) <= 6) return room.sel;
      }
      return null;
    },

    /** Where the camera goes for a selection on this floor; null when it is not drawn here. */
    focusPoint(scene: Scene, id: string, figures: Figure[] = []): [number, number] | null {
      const f = figures.find((x) => x.id === id);
      if (f) return tilePoint(f.tile, f.walk ? 10 : 3);
      const b = scene.beds.find((x) => x.id === id || x.slot === id);
      if (b) return bedPoint(b.bed);
      const p = scene.spots.find((x) => x.id === id || x.slot === id);
      if (p) return tilePoint(p.tile, 3);
      const q = scene.queue.find((x) => x.id === id);
      if (q) return tilePoint(q.tile, 10);
      const d = scene.drawers.find((x) => (x.full && x.id === id) || x.slot === id);
      if (d) return tilePoint(d.tile, 8);
      const room = spec.rooms.find((r) => r.sel === id);
      return room ? roomCentre(room) : null;
    },
  };
}

/** Whether a logical point is on the slab: the floor diamond, its front edge, and the walls and tags above it. */
export function onSlab(x: number, y: number) {
  const [tx, ty] = iso(0, 0);
  const [bx, by] = iso(MAP_W, MAP_H);
  return x >= iso(0, MAP_H)[0] && x <= iso(MAP_W, 0)[0] && y >= ty + Math.abs(x - tx) / 2 - 40 && y <= by - Math.abs(x - bx) / 2 + 4;
}

/** W4 as today, in its own logical pixels, painted onto whichever context it is handed (a stack draws it translated). */
export function createW4() {
  let ctx: Ctx;
  const floor = bakeFloor(W4);
  const items = buildItems(W4);
  const people: Record<string, Record<string, HTMLCanvasElement>> = {};
  for (const [id, palette] of Object.entries(STAFF_PALETTES)) {
    people[id] = {
      front: sprite(PERSON.front.stand, palette),
      back: sprite(PERSON.back.stand, palette),
      frontStepL: sprite(PERSON.front.step, palette),
      frontStepR: sprite(PERSON.front.step, palette, true),
      backStepL: sprite(PERSON.back.step, palette),
      backStepR: sprite(PERSON.back.step, palette, true),
    };
  }
  const envelope = sprite(ENVELOPE, ENVELOPE_PALETTE);
  let trolleys: Trolley[] = [];

  function drawStaff(s: Sim, id: string) {
    const m = staffById(s, id);
    const [sx, sy] = iso(m.x + 0.5, m.y + 0.5);
    ctx.fillStyle = "rgba(26,19,32,.28)";
    ctx.fillRect(sx - 5, sy - 1, 10, 2);
    ctx.fillRect(sx - 3, sy - 2, 6, 4);
    const walking = m.path.length > 0;
    const phase = Math.floor(m.moved * 4) % 4;
    const set = people[id];
    const key = !walking || phase % 2 === 1 ? m.facing : `${m.facing}Step${phase === 0 ? "L" : "R"}`;
    ctx.drawImage(set[key], sx - 6, sy - 20);
  }

  function launchTrolleys(s: Sim) {
    for (const { bed, kind } of s.moves.splice(0)) {
      const stand = nurseStand(bedByLabel(bed));
      const path = kind === "in" ? [ENTRY, ...findPath(ENTRY, stand)] : [stand, ...findPath(stand, ENTRY)];
      trolleys.push({ path, at: 0, bed, kind });
    }
  }

  // shortcut: trolleys draw over walls and furniture, depth-sort them with staff if that ever looks wrong
  function drawTrolleys(dt: number) {
    for (const t of trolleys) t.at += dt * TROLLEY_TILES_PER_S;
    trolleys = trolleys.filter((t) => t.at < t.path.length - 1);
    for (const t of trolleys) {
      const leg = Math.floor(t.at);
      const [ax, ay] = t.path[leg];
      const [bx, by] = t.path[leg + 1];
      const x = ax + (bx - ax) * (t.at - leg);
      const y = ay + (by - ay) * (t.at - leg);
      box(ctx, x + 0.1, y + 0.2, 0.8, 0.6, 2, ["#7DA7D9", "#5E89BC", "#4F78A9"], 3);
      const [sx, sy] = iso(x + 0.5, y + 0.5);
      ctx.drawImage(sprite(PATIENT_HEAD, patientPalette(BEDS.findIndex((b) => b.label === t.bed))), sx - 3, sy - 13);
      tag(ctx, TROLLEY_TAG[t.kind], sx, sy - 14);
    }
  }

  function drawEnvelopes(s: Sim) {
    for (const m of s.staff) {
      if (m.stage !== "message") continue;
      const from =
        m.role === "md" && m.task
          ? (() => {
              const nurse = staffById(s, m.task.rn);
              const [x, y] = iso(nurse.x + 0.5, nurse.y + 0.5);
              return [x, y - 22] as [number, number];
            })()
          : stationPoint(STATIONS.screen, 20);
      const [tx, ty] = iso(m.x + 0.5, m.y + 0.5);
      const t = 1 - Math.max(0, m.timer) / 2;
      const arc = Math.sin(t * Math.PI) * 20;
      ctx.drawImage(
        envelope,
        Math.round(from[0] + (tx - from[0]) * t) - 4,
        Math.round(from[1] + (ty - 22 - from[1]) * t - arc) - 3,
      );
    }
  }

  function drawBedOverlays(s: Sim, selected: string | null, hovered: string | null, now: number) {
    for (const p of s.patients) {
      const bed = bedByLabel(p.bed);
      const [lx, ly] = iso(bed.head[0] + 0.9, bed.head[1] + (bed.north ? 0.15 : 0.85));
      const risk = p.decision.kind === "ranked" ? p.decision.news2.risk : null;
      const blink = risk === "high" && Math.floor(now * 3) % 2 === 0;
      ctx.fillStyle = INK;
      ctx.fillRect(lx - 3, ly - 15, 7, 6);
      ctx.fillStyle = blink ? CREAM : risk ? RISK_LIGHT[risk] : "#A899B5";
      ctx.fillRect(lx - 2, ly - 14, 5, 4);
    }
    for (const bed of BEDS) {
      const ids = [`bed:${bed.label}`, s.patients.find((p) => p.bed === bed.label)?.id];
      const isSelected = ids.includes(selected ?? "");
      if (!isSelected && !ids.includes(hovered ?? "")) continue;
      const y0 = Math.min(bed.head[1], bed.foot[1]);
      const [a, right, b, left] = [iso(bed.head[0], y0), iso(bed.head[0] + 1, y0), iso(bed.head[0] + 1, y0 + 2), iso(bed.head[0], y0 + 2)];
      ctx.strokeStyle = isSelected ? "#FFD93D" : CREAM;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(right[0], right[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineTo(left[0], left[1]);
      ctx.closePath();
      ctx.stroke();
    }
    for (const p of s.patients) {
      const [x, y] = bedAnchor(p);
      tag(ctx, p.rank ? `#${p.rank}` : "NR", x, y - 8, undefined, p.rank === 1);
    }
  }

  function drawStaffTags(s: Sim, selected: string | null, hovered: string | null) {
    for (const m of s.staff) {
      if (m.id !== selected && m.id !== hovered) continue;
      const [sx, sy] = iso(m.x + 0.5, m.y + 0.5);
      const { chip } = staffStatus(s, m);
      tag(ctx, m.name, sx, sy - 22, CHIP_COLOURS[chip]);
    }
  }

  function focusPoint(s: Sim, id: string): [number, number] | null {
    const p = s.patients.find((x) => x.id === id);
    if (p) return bedAnchor(p);
    const m = s.staff.find((x) => x.id === id);
    if (m) {
      const [x, y] = iso(m.x + 0.5, m.y + 0.5);
      return [x, y - 10];
    }
    if (id.startsWith("bed:")) return bedAnchor({ bed: id.slice(4) });
    const stay = s.stays.find((x) => x.id === id);
    if (stay) return bedAnchor(stay);
    const machine = MACHINES.find(([key]) => key === id);
    return machine ? stationPoint(machine[1]) : null;
  }

  return {
    focusPoint,
    reset() {
      trolleys = [];
    },
    paint(target: Ctx, s: Sim, selected: string | null, hovered: string | null, dt: number, now: number) {
      ctx = target;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(floor, 0, 0);

      floorText(ctx, W4);
      const actors = s.staff
        .map((m) => ({ id: m.id, depth: m.x + m.y + 0.01 }))
        .sort((a, b) => a.depth - b.depth);
      let next = 0;
      const arriving = trolleys.filter((t) => t.kind === "in").map((t) => t.bed);
      const taken = new Set([...s.patients.map((p) => p.bed), ...(s.occupied ?? [])].filter((bed) => !arriving.includes(bed)));
      for (const item of items) {
        while (next < actors.length && actors[next].depth < item.depth) {
          drawStaff(s, actors[next].id);
          next += 1;
        }
        ctx.drawImage(item.bed && !taken.has(item.bed) ? item.empty! : item.image, item.dx, item.dy);
      }
      while (next < actors.length) {
        drawStaff(s, actors[next].id);
        next += 1;
      }

      MACHINES.forEach(([id, tile, name, lift], i) => {
        const [x, y] = iso(tile[0] + 0.5, tile[1] + 0.5);
        if (i < 4) {
          ctx.fillStyle = Math.floor(now * 4 + i) % 3 === 0 ? "#FFD93D" : "#4ECDC4";
          ctx.fillRect(x - 6, y - 11, 3, 2);
          ctx.fillStyle = "#6BCF7F";
          ctx.fillRect(x - 1, y - 11, 3, 2);
        }
        tag(ctx, name, x, y - lift, undefined, id === selected || id === hovered);
      });

      if (s.speed > 0) launchTrolleys(s);
      drawTrolleys(s.speed > 0 ? dt : 0);
      drawEnvelopes(s);
      drawBedOverlays(s, selected, hovered, now);
      drawStaffTags(s, selected, hovered);
    },

    /** The patient, empty bed, staff member or machine at a logical point of W4, if any. */
    hit(s: Sim, x: number, y: number): string | null {
      for (const m of s.staff) {
        const [sx, sy] = iso(m.x + 0.5, m.y + 0.5);
        if (Math.hypot(x - sx, y - (sy - 10)) <= 9) return m.id;
      }
      // Tags first: a staggered tag can sit over the machine behind it.
      for (const [id, tile, , lift] of MACHINES) {
        const [mx, my] = iso(tile[0] + 0.5, tile[1] + 0.5);
        if (Math.abs(x - mx) <= 18 && Math.abs(y - (my - lift - 7)) <= 6) return id;
      }
      for (const [id, tile] of MACHINES) {
        const [mx, my] = iso(tile[0] + 0.5, tile[1] + 0.5);
        if (Math.hypot(x - mx, y - (my - 6)) <= 12) return id;
      }
      for (const bed of BEDS) {
        const y0 = Math.min(bed.head[1], bed.foot[1]);
        const left = iso(bed.head[0], y0 + 2)[0];
        const right = iso(bed.head[0] + 1, y0)[0];
        const top = iso(bed.head[0], y0)[1] - 18;
        const bottom = iso(bed.head[0] + 1, y0 + 2)[1];
        if (x >= left && x <= right && y >= top && y <= bottom) {
          return s.patients.find((p) => p.bed === bed.label)?.id ?? `bed:${bed.label}`;
        }
      }
      return null;
    },
  };
}

/** Device pixels per logical pixel: the whole number nearest the CSS scale times the device ratio, at least 1. Nearest,
 * not up: a canvas a little smaller than the screen scaled up costs far fewer pixels than one a lot larger scaled down. */
export const backingFor = (scale: number, ratio: number) => Math.max(1, Math.round(scale * ratio));

export function createRenderer(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d", { alpha: false })!; // every frame fills the whole canvas
  const w4 = createW4();
  const cam: Cam = fitCam(LOGICAL_W, LOGICAL_H); // logical point at the view centre
  const user: Cam = fitCam(LOGICAL_W, LOGICAL_H); // where the camera rests with nothing selected; the default is today's view
  let scale = 1; // CSS pixels per logical pixel
  let backing = 1; // device pixels per logical pixel, always a whole number

  /** Eases the camera toward the selection, or back to the whole ward. Stays inside the map. */
  function moveCamera(s: Sim, selected: string | null, dt: number) {
    const focus = selected ? w4.focusPoint(s, selected) : null;
    const ease = 1 - Math.exp(-dt * 6);
    cam.zoom += ((focus ? ZOOM : user.zoom) - cam.zoom) * ease;
    cam.x += ((focus ? focus[0] : user.x) - cam.x) * ease;
    cam.y += ((focus ? focus[1] : user.y) - cam.y) * ease;
    Object.assign(cam, clampCam(cam, LOGICAL_W, LOGICAL_H));
  }

  const setUser = (c: Cam, instant: boolean) => {
    Object.assign(user, c);
    if (instant) Object.assign(cam, c);
  };

  return {
    /** Draws at a whole-number scale so every art pixel is the same size, then lets CSS fit it. */
    resize(width: number, height: number, ratio: number) {
      scale = Math.min(width / LOGICAL_W, height / LOGICAL_H);
      backing = backingFor(scale, ratio);
      canvas.width = LOGICAL_W * backing;
      canvas.height = LOGICAL_H * backing;
      ctx.fillStyle = "#2A2036"; // an opaque canvas clears to black; until the next frame show the stage, as transparent did
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      canvas.style.width = `${LOGICAL_W * scale}px`;
      canvas.style.height = `${LOGICAL_H * scale}px`;
      canvas.style.left = `${(width - LOGICAL_W * scale) / 2}px`;
      canvas.style.top = `${(height - LOGICAL_H * scale) / 2}px`;
    },

    /** The user's own zoom (1 is the whole ward), for the TopBar. */
    userZoom: () => user.zoom,
    /** At zoom 1 the whole ward is in view and there is nothing to pan. */
    canPan: () => user.zoom > 1,
    /** Zooms to z about a CSS point of the canvas; instant for the wheel, eased for the buttons. */
    zoomAt(z: number, cssX: number, cssY: number, instant: boolean) {
      setUser(zoomAbout(instant ? cam : user, z, cssX / scale - LOGICAL_W / 2, cssY / scale - LOGICAL_H / 2, LOGICAL_W, LOGICAL_H), instant);
    },
    /** Drags the picture by CSS pixels. */
    pan(dx: number, dy: number) {
      setUser(panBy(cam, dx / scale, dy / scale, LOGICAL_W, LOGICAL_H), true);
    },
    fit() {
      setUser(fitCam(LOGICAL_W, LOGICAL_H), false);
    },

    /** Every frame paints here, so there is no kept picture to forget. */
    redraw() {},

    reset() {
      Object.assign(cam, fitCam(LOGICAL_W, LOGICAL_H));
      Object.assign(user, fitCam(LOGICAL_W, LOGICAL_H));
      w4.reset();
    },

    /** Paints the frame; true when it painted (the stack's closed building may skip one that would not change). */
    frame(s: Sim, selected: string | null, hovered: string | null, dt: number, now: number): boolean {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#2A2036";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      moveCamera(s, selected, dt);
      const pixels = backing * cam.zoom;
      ctx.setTransform(pixels, 0, 0, pixels, backing * (LOGICAL_W / 2 - cam.x * cam.zoom), backing * (LOGICAL_H / 2 - cam.y * cam.zoom));
      w4.paint(ctx, s, selected, hovered, dt, now);
      return true;
    },

    /** The patient, empty bed, staff member or machine under a canvas CSS pixel, if any. */
    hit(s: Sim, cssX: number, cssY: number): string | null {
      const x = cam.x + (cssX / scale - LOGICAL_W / 2) / cam.zoom;
      const y = cam.y + (cssY / scale - LOGICAL_H / 2) / cam.zoom;
      return w4.hit(s, x, y);
    },
  };
}

/** `floorOf`: the stack's own answer to which floor a person is on this moment (a mover is still on the floor they leave by). */
export type Renderer = ReturnType<typeof createRenderer> & { floorOf?: (s: Sim, id: string) => number | null; figures?: (floor: number) => Figure[]; clock?: () => number };
