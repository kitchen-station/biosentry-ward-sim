// Ward W4 as a tile grid, laid out like a real ward: bays and side rooms off one corridor, a
// nurse station facing the high-dependency bay, and the staff rooms behind it.
// x runs east along the corridor, y runs south across it.
//   # wall   g glass wall   + door   . floor   b bed   = station counter
//   G Q N R pipeline stations   K server rack   D desk   L shelf or cabinet   S sink
//   U utility counter   W toilet   T table   H sofa   P plant

const row = (...parts: string[]) => parts.join("");

export const MAP = [
  "#".repeat(36),
  row("#", ".b..b..b.", "#", ".b.b.b.b", "#", ".b.", "#", ".b.", "#", ".b.", "#", "G.Q", "#"),
  row("#", ".b..b..b.", "#", ".b.b.b.b", "#", ".b.", "#", ".b.", "#", ".b.", "#", "...", "#"),
  row("#", ".........", "#", "........", "#", "...", "#", "...", "#", "...", "#", "N.R", "#"),
  row("#", "S........", "#", "........", "#", "...", "#", "...", "#", "...", "#", "...", "#"),
  row("#", ".b..b..b.", "#", "S.......", "#", "...", "#", "...", "#", "...", "#", "K.K", "#"),
  row("#", ".b..b..b.", "#", "........", "#", "..W", "#", "..W", "#", "..W", "#", "...", "#"),
  row("#", "########+", "#", "gggg+ggg", "#", "+##", "#", "+##", "#", "+##", "#", "##+", "#"),
  row("#", ".".repeat(34), "+"),
  row("#", "P", ".".repeat(33), "+"),
  row("#", "########+", "#", ".======.", "#", "+####", "#", "+##", "#", "+#", "#", "+#", "#"),
  row("#", ".b..b..b.", "#", "........", "#", ".....", "#", "..W", "#", "..", "#", "..", "#"),
  row("#", ".b..b..b.", "#", "#+####+#", "#", ".D.D.", "#", "...", "#", ".U", "#", "HH", "#"),
  row("#", ".........", "#", "L..L#L.L", "#", ".....", "#", "...", "#", ".U", "#", "..", "#"),
  row("#", "S........", "#", "....#...", "#", "..T..", "#", "...", "#", ".S", "#", "T.", "#"),
  row("#", ".b..b..b.", "#", "U...#...", "#", "H....", "#", ".b.", "#", "..", "#", "..", "#"),
  row("#", ".b..b..b.", "#", "LL..#UUU", "#", "L...L", "#", ".b.", "#", "..", "#", "P.", "#"),
  "#".repeat(36),
];

export const MAP_W = MAP[0].length;
export const MAP_H = MAP.length;

export type Tile = [number, number];

const WALKABLE = new Set([".", "+"]);
const walkable = (x: number, y: number) => WALKABLE.has(MAP[y]?.[x] ?? "#");

export type Floor = "bay" | "hdu" | "side" | "station" | "office" | "utility" | "family" | "comms";

export interface Room {
  label: string;
  floor: Floor;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export const ROOMS: Room[] = [
  { label: "FEMALE BAY", floor: "bay", x0: 1, x1: 9, y0: 1, y1: 6 },
  { label: "HIGH DEPENDENCY", floor: "hdu", x0: 11, x1: 18, y0: 1, y1: 6 },
  { label: "SIDE 1", floor: "side", x0: 20, x1: 22, y0: 1, y1: 6 },
  { label: "SIDE 2", floor: "side", x0: 24, x1: 26, y0: 1, y1: 6 },
  { label: "SIDE 3", floor: "side", x0: 28, x1: 30, y0: 1, y1: 6 },
  { label: "EDGE SERVER", floor: "comms", x0: 32, x1: 34, y0: 1, y1: 6 },
  { label: "MALE BAY", floor: "bay", x0: 1, x1: 9, y0: 11, y1: 16 },
  { label: "NURSE STATION", floor: "station", x0: 11, x1: 18, y0: 10, y1: 11 },
  { label: "MEDS", floor: "utility", x0: 11, x1: 14, y0: 13, y1: 16 },
  { label: "CLEAN UTILITY", floor: "utility", x0: 16, x1: 18, y0: 13, y1: 16 },
  { label: "DOCTORS", floor: "office", x0: 20, x1: 24, y0: 11, y1: 16 },
  { label: "SIDE 4", floor: "side", x0: 26, x1: 28, y0: 11, y1: 16 },
  { label: "SLUICE", floor: "utility", x0: 30, x1: 31, y0: 11, y1: 16 },
  { label: "RELATIVES", floor: "family", x0: 33, x1: 34, y0: 11, y1: 16 },
];

export const CORRIDOR = { y0: 8, y1: 9 };

export const roomAt = (x: number, y: number) =>
  ROOMS.find((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);

// Beds are a 1x2 footprint. `head` is the pillow tile, `foot` the tile toward the aisle.
export interface Bed {
  label: string;
  zone: string; // H, A, B or S: the room, which survives relabelling below
  head: Tile;
  foot: Tile;
  north: boolean; // head on the smaller y
}

function bedsAt(prefix: string, xs: number[], headY: number, footY: number, first = 1): Bed[] {
  return xs.map((x, i) => ({
    label: `${prefix}${first + i}`,
    zone: prefix,
    head: [x, headY] as Tile,
    foot: [x, footY] as Tile,
    north: headY < footY,
  }));
}

export const BEDS: Bed[] = [
  ...bedsAt("H", [12, 14, 16, 18], 1, 2),
  ...bedsAt("A", [2, 5, 8], 1, 2),
  ...bedsAt("A", [2, 5, 8], 6, 5, 4),
  ...bedsAt("B", [2, 5, 8], 11, 12),
  ...bedsAt("B", [2, 5, 8], 16, 15, 4),
  ...bedsAt("S", [21, 25, 29], 1, 2),
  ...bedsAt("S", [27], 16, 15, 4),
];

// The twelve occupied tiles carry the BioSentry dashboard's bed labels; the other eight stay empty.
const DASHBOARD_LABEL: Record<string, string> = {
  H1: "4A", H2: "2B", H3: "1C", H4: "3A", A1: "6A", A2: "7B", A3: "9A",
  B1: "5B", B2: "8A", B3: "10B", S1: "4B", S2: "3B",
};
for (const bed of BEDS) bed.label = DASHBOARD_LABEL[bed.label] ?? bed.label;

export const bedByLabel = (label: string) => {
  const bed = BEDS.find((b) => b.label === label);
  if (!bed) throw new Error(`No bed ${label}`);
  return bed;
};

/** Where a nurse stands: the aisle tile past the foot of the bed. */
export const nurseStand = (bed: Bed): Tile => [bed.foot[0], bed.foot[1] + (bed.north ? 1 : -1)];

/** Where a physician stands: beside the foot of the bed, on whichever side is free. */
export const physicianStand = (bed: Bed): Tile => {
  const [x, y] = bed.foot;
  return walkable(x + 1, y) ? [x + 1, y] : [x - 1, y];
};

export const HOMES: Record<string, Tile> = {
  "rn-delacruz": [12, 11],
  "rn-reyes": [16, 11],
  "rn-manalo": [14, 11],
  "md-santos": [21, 13],
  "md-aquino": [23, 13],
};

export const STATIONS = {
  gateway: [32, 1] as Tile,
  gate: [34, 1] as Tile,
  news2: [32, 3] as Tile,
  arbiter: [34, 3] as Tile,
  screen: [14, 10] as Tile,
};

/** Breadth-first path, excluding the start tile. Empty when already there. */
export function findPath(from: Tile, to: Tile): Tile[] {
  const key = (x: number, y: number) => y * MAP_W + x;
  const cameFrom = new Map<number, number>();
  const start = key(from[0], from[1]);
  const goal = key(to[0], to[1]);
  cameFrom.set(start, -1);
  const queue: Tile[] = [from];
  while (queue.length > 0) {
    const [x, y] = queue.shift()!;
    if (key(x, y) === goal) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (!walkable(nx, ny) || cameFrom.has(key(nx, ny))) continue;
      cameFrom.set(key(nx, ny), key(x, y));
      queue.push([nx, ny]);
    }
  }
  if (!cameFrom.has(goal)) throw new Error(`No path to ${to}`);
  const path: Tile[] = [];
  for (let at = goal; at !== start; at = cameFrom.get(at)!) {
    path.unshift([at % MAP_W, Math.floor(at / MAP_W)]);
  }
  return path;
}
