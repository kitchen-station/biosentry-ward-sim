// Isometric ward renderer: one Canvas 2D, sprites nearest-neighbour, text at full resolution.
// Tile (x, y) has its top corner at iso(x, y). Reads the sim, never changes it.

import { BEDS, CLOSET, MAP, MAP_H, MAP_W, OFFICE, ROOMS, STATIONS, bedByLabel, type Tile } from "../sim/map";
import { minuteOf, patientById, staffById, staffStatus, vitalQuality, type PacketOutcome, type Patient, type Sim } from "../sim/sim";
import { VITALS } from "../sim/source";
import {
  ENVELOPE,
  ENVELOPE_PALETTE,
  PATIENT_HEAD,
  PERSON,
  PLANT,
  PLANT_PALETTE,
  STAFF_PALETTES,
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

const RISK_LIGHT: Record<string, string> = {
  low: "#6BCF7F",
  low_medium: "#FFD93D",
  medium: "#FFA07A",
  high: "#FF6B6B",
};

const PACKET_COLOURS: Record<PacketOutcome, string> = {
  ok: "#4ECDC4",
  rejected: "#FF6B6B",
  abstained: "#A899B5",
};

const iso = (x: number, y: number): [number, number] => [
  Math.round(OX + (x - y) * HALF_W),
  Math.round(OY + (x + y) * HALF_H),
];

type Ctx = CanvasRenderingContext2D;

/** An isometric box, rasterised in rows and columns so the edges stay hard. */
function box(
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
function leftFaceBand(ctx: Ctx, x: number, y: number, w: number, from: number, to: number, colour: string, inset = 0) {
  const L = iso(x, y);
  const B = iso(x + w, y);
  ctx.fillStyle = colour;
  for (let px = L[0] + inset; px < B[0] - inset; px += 1) {
    const edge = Math.round(L[1] + (px - L[0]) / 2);
    ctx.fillRect(px, edge - to, 1, to - from);
  }
}

/** The same, on a box's right (east-facing) face, for a wall running along y. */
function rightFaceBand(ctx: Ctx, x: number, y: number, d: number, from: number, to: number, colour: string, inset = 0) {
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

function inRoom(x: number, y: number, r: { x0: number; x1: number; y0: number; y1: number }) {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

function floorColour(tx: number, ty: number, u: number, v: number): [number, number, number] {
  const fu = u - tx;
  const fv = v - ty;
  const grout = fu < 0.05 || fv < 0.05;
  const checker = (tx + ty) % 2 === 0;
  const ch = MAP[ty]?.[tx];
  if (ch === "+") return hex(grout ? "#8F8571" : "#B5A98D");
  if (inRoom(tx, ty, CLOSET)) return hex(grout ? "#4B566A" : checker ? "#6B7A8F" : "#637286");
  if (inRoom(tx, ty, OFFICE)) {
    const plank = Math.floor(v * 3);
    if (Math.floor(v * 3 + 0.08) !== plank) return hex("#8F6843");
    return hex(plank % 2 === 0 ? "#C79A6B" : "#BD9062");
  }
  if (ty >= 5 && ty <= 7) {
    if (v > 7.72 && v < 7.86) return hex("#4ECDC4"); // wayfinding stripe
    return hex(grout ? "#CBBE9F" : checker ? "#EFE5CB" : "#E6DABC");
  }
  return hex(grout ? "#97B09F" : checker ? "#BBD0C1" : "#AEC5B6");
}

function bakeFloor(): HTMLCanvasElement {
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
      const [r, g, bl] = floorColour(Math.floor(u), Math.floor(v), u, v);
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

const isWall = (x: number, y: number) => MAP[y]?.[x] === "#" || MAP[y]?.[x] === "+";

/** Walls are drawn thin inside their tile, so rooms read as rooms and the floor stays visible. */
function wallItem(x: number, y: number): Item {
  const rimBack = y === 0 || x === 0;
  const rimFront = y === MAP_H - 1 || x === MAP_W - 1;
  const h = rimFront ? 3 : rimBack ? 20 : 8;
  const colours = rimFront ? WALL_EDGE : WALL;
  const T = 0.3;
  const across = isWall(x - 1, y) || isWall(x + 1, y);
  const along = isWall(x, y - 1) || isWall(x, y + 1);
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
      if (x % 2 === 0 && x < 23) leftFaceBand(ctx, x, 1, 1, 8, 16, "#BFE6F2", 3);
    }
    if (x === 0 && y > 0 && y < MAP_H - 1) rightFaceBand(ctx, 1, y, 1, 0, 5, "#7F978A");
  });
}

function bedItem(bedX: number, headY: number, footY: number, patient: number | null): Item {
  const y0 = Math.min(headY, footY);
  const north = headY < footY;
  const frame: [string, string, string] = ["#D9D3C4", "#9F9A8E", "#8A8579"];
  const sheet: [string, string, string] = ["#FFFDF5", "#E3DFD0", "#CFCABA"];
  const blanket: [string, string, string] =
    patient === null ? ["#D9E4EC", "#B8C7D2", "#A5B5C1"] : ["#7DA7D9", "#5E89BC", "#4F78A9"];
  return bake(y0 + 1 + bedX, bedX, y0, 1, 2, 16, (ctx) => {
    const x = bedX + 0.12;
    box(ctx, x, y0, 0.76, 2, 4, frame);
    box(ctx, x, y0, 0.76, 2, 2, sheet, 4);
    const blanketY = north ? y0 + 0.75 : y0;
    box(ctx, x, blanketY, 0.76, 1.25, patient === null ? 2 : 3, blanket, 4);
    box(ctx, x + 0.1, north ? y0 + 0.08 : y0 + 1.42, 0.56, 0.5, 2, sheet, 6);
    box(ctx, x, north ? y0 : y0 + 1.92, 0.76, 0.08, 12, ["#E8D9A0", "#C7B583", "#B3A172"]);
    if (patient !== null) {
      const [sx, sy] = iso(bedX + 0.5, north ? y0 + 0.36 : y0 + 1.66);
      ctx.drawImage(sprite(PATIENT_HEAD, patientPalette(patient)), sx - 3, sy - 13);
    }
  });
}

function tileItem(ch: string, x: number, y: number): Item | null {
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
    case "D":
      return bake(depth, x, y, 1, 1, 20, (ctx) => {
        box(ctx, x, y, 1, 1, 6, ["#8F6843", "#6E4F31", "#5D4229"]);
        box(ctx, x + 0.25, y + 0.3, 0.5, 0.15, 8, ["#3D2E4A", "#1A1320", "#1A1320"], 6);
        leftFaceBand(ctx, x + 0.25, y + 0.45, 0.5, 8, 13, "#A8E6E0", 1);
      });
    case "L":
      return bake(depth, x, y, 1, 1, 24, (ctx) => {
        box(ctx, x, y, 1, 1, 20, ["#8F6843", "#6E4F31", "#5D4229"]);
        ["#FF6B6B", "#FFD93D", "#6C8EF5", "#6BCF7F"].forEach((c, i) =>
          leftFaceBand(ctx, x + 0.1 + i * 0.2, y + 1, 0.16, 3, 17, c),
        );
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

function buildItems(s: Sim): Item[] {
  const items: Item[] = [];
  for (let y = 0; y < MAP_H; y += 1) {
    for (let x = 0; x < MAP_W; x += 1) {
      const ch = MAP[y][x];
      if (ch === "#") items.push(wallItem(x, y));
      else {
        const item = tileItem(ch, x, y);
        if (item) items.push(item);
      }
    }
  }
  for (const bed of BEDS) {
    const index = s.patients.findIndex((p) => p.bed === bed.label);
    items.push(bedItem(bed.head[0], bed.head[1], bed.foot[1], index >= 0 ? index : null));
  }
  return items.sort((a, b) => a.depth - b.depth);
}

interface Flight {
  route: [number, number][];
  leg: number;
  t: number;
  colour: string;
}

const stationPoint = (tile: Tile, lift = 18): [number, number] => {
  const [x, y] = iso(tile[0] + 0.5, tile[1] + 0.5);
  return [x, y - lift];
};

export function bedAnchor(p: Patient): [number, number] {
  const bed = bedByLabel(p.bed);
  const [x, y] = iso(bed.foot[0] + 0.5, bed.north ? 1.9 : 11.1);
  return [x, y - 8];
}

export function createRenderer(canvas: HTMLCanvasElement, firstSim: Sim) {
  const ctx = canvas.getContext("2d")!;
  const floor = bakeFloor();
  const items = buildItems(firstSim);
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
  let flights: Flight[] = [];
  let lastSync = 0;
  let scale = 1; // CSS pixels per logical pixel
  let backing = 1; // device pixels per logical pixel, always a whole number

  function tag(text: string, cx: number, bottom: number, dot?: string, inverted = false) {
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

  function label(text: string, x: number, y: number, colour: string, font = FONT_SMALL) {
    ctx.font = font;
    ctx.fillStyle = colour;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y);
  }

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

  function drawFlights(dt: number) {
    flights = flights.filter((f) => f.leg < f.route.length - 1);
    for (const f of flights) {
      const a = f.route[f.leg];
      const b = f.route[f.leg + 1];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      f.t += (dt * 170) / length;
      if (f.t >= 1) {
        f.leg += 1;
        f.t = 0;
        if (f.leg >= f.route.length - 1) continue;
      }
      const arc = Math.sin(f.t * Math.PI) * Math.min(26, length * 0.16);
      const x = a[0] + (b[0] - a[0]) * f.t;
      const y = a[1] + (b[1] - a[1]) * f.t - arc;
      ctx.fillStyle = INK;
      ctx.fillRect(Math.round(x) - 2, Math.round(y) - 2, 5, 5);
      ctx.fillStyle = f.colour;
      ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, 3, 3);
    }
  }

  function launchPackets(s: Sim) {
    for (const packet of s.packets.splice(0)) {
      if (flights.length > 70) continue;
      const p = patientById(s, packet.patient);
      const route: [number, number][] = [bedAnchor(p), stationPoint(STATIONS.gateway), stationPoint(STATIONS.gate)];
      if (packet.outcome !== "rejected") route.push(stationPoint(STATIONS.news2));
      if (packet.outcome === "ok") {
        route.push(stationPoint(STATIONS.arbiter), stationPoint(STATIONS.screen, 20));
      }
      flights.push({ route, leg: 0, t: 0, colour: PACKET_COLOURS[packet.outcome] });
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
      const [lx, ly] = iso(bed.head[0] + 0.9, bed.north ? 1.15 : 11.85);
      const risk = p.decision.kind === "ranked" ? p.decision.news2.risk : null;
      const blink = risk === "high" && Math.floor(now * 3) % 2 === 0;
      ctx.fillStyle = INK;
      ctx.fillRect(lx - 3, ly - 15, 7, 6);
      ctx.fillStyle = blink ? CREAM : risk ? RISK_LIGHT[risk] : "#A899B5";
      ctx.fillRect(lx - 2, ly - 14, 5, 4);
      if (p.id === selected || p.id === hovered) {
        const [a, b] = [iso(bed.head[0], Math.min(bed.head[1], bed.foot[1])), iso(bed.head[0] + 1, Math.min(bed.head[1], bed.foot[1]) + 2)];
        const left = iso(bed.head[0], Math.min(bed.head[1], bed.foot[1]) + 2);
        const right = iso(bed.head[0] + 1, Math.min(bed.head[1], bed.foot[1]));
        ctx.strokeStyle = p.id === selected ? "#FFD93D" : CREAM;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(right[0], right[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.lineTo(left[0], left[1]);
        ctx.closePath();
        ctx.stroke();
      }
    }
    for (const p of s.patients) {
      const [x, y] = bedAnchor(p);
      tag(p.rank ? `#${p.rank}` : "NR", x, y - 8, undefined, p.rank === 1);
    }
  }

  function drawStaffTags(s: Sim) {
    for (const m of s.staff) {
      const [sx, sy] = iso(m.x + 0.5, m.y + 0.5);
      const { chip } = staffStatus(s, m);
      tag(m.name, sx, sy - 22, CHIP_COLOURS[chip]);
    }
  }

  function drawCard(s: Sim, selected: string) {
    const p = patientById(s, selected);
    const minute = minuteOf(s);
    const value = (v: (typeof VITALS)[number], digits = 0) =>
      vitalQuality(p, v, minute) === "missing" || p.held[v] === null ? "--" : p.held[v]!.toFixed(digits);
    const lines = [
      `HR   ${value("heart_rate")} /min`,
      `RR   ${value("respiratory_rate")} /min`,
      `SpO2 ${value("spo2")} %`,
      `Temp ${value("temperature", 1)} C`,
      `BP   ${p.bp ? `${p.bp.systolic}/${p.bp.diastolic}` : "--"} mmHg`,
    ];
    const score = p.decision.kind === "ranked" ? `NEWS2 ${p.decision.news2.total}` : "NOT RANKED";
    const w = 76;
    const h = 11 + lines.length * 8 + 11;
    const [ax, ay] = bedAnchor(p);
    const x = Math.max(2, Math.min(LOGICAL_W - w - 2, ax + 12));
    const y = Math.max(2, Math.min(LOGICAL_H - h - 2, ay - h / 2));
    ctx.fillStyle = INK;
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    ctx.fillStyle = "#E8D9A0";
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = CREAM;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = INK;
    ctx.fillRect(x, y, w, 10);
    ctx.font = FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = CREAM;
    ctx.fillText(`${p.bed} ${p.name.split(",")[0]}`, x + 3, y + 5.5);
    ctx.fillStyle = INK;
    lines.forEach((line, i) => ctx.fillText(line, x + 3, y + 15 + i * 8));
    ctx.fillText(score, x + 3, y + h - 6);
  }

  return {
    /** Draws at a whole-number scale so every art pixel is the same size, then lets CSS fit it. */
    resize(width: number, height: number, ratio: number) {
      scale = Math.min(width / LOGICAL_W, height / LOGICAL_H);
      backing = Math.max(1, Math.ceil(scale * ratio));
      canvas.width = LOGICAL_W * backing;
      canvas.height = LOGICAL_H * backing;
      canvas.style.width = `${LOGICAL_W * scale}px`;
      canvas.style.height = `${LOGICAL_H * scale}px`;
      canvas.style.left = `${(width - LOGICAL_W * scale) / 2}px`;
      canvas.style.top = `${(height - LOGICAL_H * scale) / 2}px`;
    },

    reset() {
      flights = [];
      lastSync = 0;
    },

    frame(s: Sim, selected: string | null, hovered: string | null, dt: number, now: number) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#2A2036";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(backing, 0, 0, backing, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(floor, 0, 0);

      for (const room of ROOMS) {
        const [x, y] = iso((room.x0 + room.x1 + 1) / 2, room.y0 === 1 ? 3.5 : 9.5);
        label(`ROOM ${room.label}`, x, y, "rgba(26,19,32,.5)");
      }
      const actors = s.staff
        .map((m) => ({ id: m.id, depth: m.x + m.y + 0.01 }))
        .sort((a, b) => a.depth - b.depth);
      let next = 0;
      for (const item of items) {
        while (next < actors.length && actors[next].depth < item.depth) {
          drawStaff(s, actors[next].id);
          next += 1;
        }
        ctx.drawImage(item.image, item.dx, item.dy);
      }
      while (next < actors.length) {
        drawStaff(s, actors[next].id);
        next += 1;
      }

      const lights = [STATIONS.gateway, STATIONS.gate, STATIONS.news2, STATIONS.arbiter];
      const names = ["GATEWAY", "GATE", "NEWS2", "ARBITER"];
      lights.forEach((tile, i) => {
        const [x, y] = iso(tile[0] + 0.5, tile[1] + 0.5);
        ctx.fillStyle = Math.floor(now * 4 + i) % 3 === 0 ? "#FFD93D" : "#4ECDC4";
        ctx.fillRect(x - 6, y - 11, 3, 2);
        ctx.fillStyle = "#6BCF7F";
        ctx.fillRect(x - 1, y - 11, 3, 2);
        tag(names[i], x, y - (i % 2 === 0 ? 19 : 31));
      });
      const [wx, wy] = iso(14.5, 5.3);
      label("WARD W4", wx - 90, wy + 3, "rgba(26,19,32,.55)", FONT);
      const [cx, cy] = iso(26.5, 2.8);
      label("EDGE SERVER", cx, cy, "#E8D9A0");
      const [fx, fy] = iso(26.5, 9.6);
      label("PHYSICIANS", fx, fy, "#3D2E4A");

      if (s.speed > 0) launchPackets(s);
      const [cloudX, cloudY] = [LOGICAL_W - 70, 120]; // the empty sky above the closet
      tag("HUAWEI CLOUD", cloudX, cloudY);
      const minute = minuteOf(s);
      if (minute >= lastSync + 15 && s.speed > 0) {
        lastSync = minute - (minute % 15);
        flights.push({ route: [stationPoint(STATIONS.arbiter), [cloudX, cloudY - 4]], leg: 0, t: 0, colour: "#B197FC" });
      }
      drawFlights(s.speed > 0 ? dt : 0);
      drawEnvelopes(s);
      drawBedOverlays(s, selected, hovered, now);
      drawStaffTags(s);
      if (selected) drawCard(s, selected);
    },

    /** The patient under a canvas CSS pixel, if any. */
    hit(s: Sim, cssX: number, cssY: number): string | null {
      const x = cssX / scale;
      const y = cssY / scale;
      for (const p of s.patients) {
        const bed = bedByLabel(p.bed);
        const y0 = Math.min(bed.head[1], bed.foot[1]);
        const left = iso(bed.head[0], y0 + 2)[0];
        const right = iso(bed.head[0] + 1, y0)[0];
        const top = iso(bed.head[0], y0)[1] - 18;
        const bottom = iso(bed.head[0] + 1, y0 + 2)[1];
        if (x >= left && x <= right && y >= top && y <= bottom) return p.id;
      }
      return null;
    },
  };
}
