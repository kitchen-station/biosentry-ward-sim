// Ward W4 as a tile grid. x runs east along the corridor, y runs south across it.
//   # wall   + door   . floor   = nurse station   A B C bed   G Q N R pipeline stations
//   D office desk   P plant   K server rack   S sink   L shelf

export const MAP = [
  "###############################",
  "#A.B.C#A.B#A.B#A.B#ASB#G.Q.N.R#",
  "#A.B.C#A.B#A.B#A.B#A.B#.......#",
  "#.....#...#...#...#...#K.....K#",
  "###+####+###+###+###+#####+####",
  "#P...........................P#",
  "#..........======.............#",
  "#P...........................P#",
  "###+####+###+###+###+#####+####",
  "#.....#...#...#...#...#L.....L#",
  "#A.B..#A.B#A.B#A.B#A.B#.......#",
  "#A.B.S#A.B#A.B#A.B#A.B#.D...D.#",
  "###############################",
];

export const MAP_W = MAP[0].length;
export const MAP_H = MAP.length;

export type Tile = [number, number];

const WALKABLE = new Set([".", "+"]);
const walkable = (x: number, y: number) => WALKABLE.has(MAP[y]?.[x] ?? "#");

export interface Room {
  label: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export const ROOMS: Room[] = [
  { label: "1", x0: 1, x1: 5, y0: 1, y1: 3 },
  { label: "2", x0: 7, x1: 9, y0: 1, y1: 3 },
  { label: "3", x0: 11, x1: 13, y0: 1, y1: 3 },
  { label: "4", x0: 15, x1: 17, y0: 1, y1: 3 },
  { label: "5", x0: 19, x1: 21, y0: 1, y1: 3 },
  { label: "10", x0: 1, x1: 5, y0: 9, y1: 11 },
  { label: "9", x0: 7, x1: 9, y0: 9, y1: 11 },
  { label: "8", x0: 11, x1: 13, y0: 9, y1: 11 },
  { label: "7", x0: 15, x1: 17, y0: 9, y1: 11 },
  { label: "6", x0: 19, x1: 21, y0: 9, y1: 11 },
];

export const CLOSET: Room = { label: "Edge server", x0: 23, x1: 29, y0: 1, y1: 3 };
export const OFFICE: Room = { label: "Physicians", x0: 23, x1: 29, y0: 9, y1: 11 };

// Beds are a 1x2 footprint. `head` is the pillow tile, `foot` the tile toward the door.
export interface Bed {
  label: string;
  head: Tile;
  foot: Tile;
  north: boolean;
}

function bedsFrom(room: string, xs: number[], letters: string, north: boolean): Bed[] {
  return xs.map((x, i) => ({
    label: `${room}${letters[i]}`,
    head: [x, north ? 1 : 11] as Tile,
    foot: [x, north ? 2 : 10] as Tile,
    north,
  }));
}

export const BEDS: Bed[] = [
  ...bedsFrom("1", [1, 3, 5], "ABC", true),
  ...bedsFrom("2", [7, 9], "AB", true),
  ...bedsFrom("3", [11, 13], "AB", true),
  ...bedsFrom("4", [15, 17], "AB", true),
  ...bedsFrom("5", [19, 21], "AB", true),
  ...bedsFrom("10", [1, 3], "AB", false),
  ...bedsFrom("9", [7, 9], "AB", false),
  ...bedsFrom("8", [11, 13], "AB", false),
  ...bedsFrom("7", [15, 17], "AB", false),
  ...bedsFrom("6", [19, 21], "AB", false),
];

export const bedByLabel = (label: string) => {
  const bed = BEDS.find((b) => b.label === label);
  if (!bed) throw new Error(`No bed ${label}`);
  return bed;
};

/** Where a nurse stands: the tile past the foot of the bed. */
export const nurseStand = (bed: Bed): Tile => [bed.foot[0], bed.north ? 3 : 9];

/** Where a physician stands: beside the bed, on the free side. */
export const physicianStand = (bed: Bed): Tile => {
  const side = bed.label.endsWith("A") ? 1 : -1;
  return [bed.foot[0] + side, bed.foot[1]];
};

export const HOMES: Record<string, Tile> = {
  "rn-delacruz": [13, 7],
  "rn-manalo": [14, 5],
  "md-santos": [24, 10],
  "md-aquino": [28, 10],
};

export const STATIONS = {
  gateway: [23, 1] as Tile,
  gate: [25, 1] as Tile,
  news2: [27, 1] as Tile,
  arbiter: [29, 1] as Tile,
  screen: [14, 6] as Tile,
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
