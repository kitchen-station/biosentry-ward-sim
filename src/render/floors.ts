// The hospital's floors as tile maps, each 36 x 18 like W4, so the renderer's geometry and art stay as they are.
// 4F is W4's own map. Rows 0 and 17 are rim walls; rows 8-9 are W4's corridor on every floor; the east doors are the lift.
//   new tiles: c waiting chair   M morgue drawer   V bedside monitor (the rest as in sim/map.ts)
import { BEDS, MAP, ROOMS, type Bed, type Floor, type Room, type Tile } from "../sim/map";
import type { UnitId } from "../sim/hospital/params";

export type Tint = Floor | "waiting" | "cold";
export type SpecRoom = Omit<Room, "floor"> & { floor: Tint; sel?: string }; // sel: what a click on the room's label selects

/** Where one unit's things go. Slot i < beds is beds[i] (MORGUE: drawers[i]); slot beds + j is spots[j]; beyond is "+N" at `more`. */
export interface UnitPlan { unit: UnitId; beds: Bed[]; drawers?: Tile[]; spots: Tile[]; staff: Tile[]; more: Tile }

export interface FloorSpec {
  floor: number; // as the hospital numbers it: 0 is GF
  name: string; // printed on the corridor floor
  short: string; // the slab tag's name
  map: string[];
  rooms: SpecRoom[];
  beds: Bed[]; // every bed tile, baked once; a hospital bed's label is `${unit}:${slot}`
  units?: UnitPlan[];
  queue?: { chairs: Tile[]; standing: Tile[]; more: Tile }; // GF: the waiting room, in seeing order
}

/** One row of beds: slot numbers from `first`, head on headY, foot on footY. */
const row = (unit: UnitId, xs: number[], headY: number, footY: number, first: number): Bed[] =>
  xs.map((x, i) => ({ label: `${unit}:${first + i}`, zone: unit, head: [x, headY], foot: [x, footY], north: headY < footY }));
const range = (from: number, to: number, step = 1) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);
const along = (xs: number[], y: number): Tile[] => xs.map((x) => [x, y]);
const plans = (...us: UnitPlan[]) => ({ units: us, beds: us.flatMap((u) => u.beds) });

const WALL = "#".repeat(36);
const CORRIDOR = [`#${".".repeat(34)}+`, `#P${".".repeat(33)}+`];
const north = { y0: 1, y1: 6 };
const south = { y0: 11, y1: 16 };

export const W4: FloorSpec = { floor: 4, name: "WARD W4 · CARDIOLOGY", short: "W4", map: MAP, rooms: ROOMS, beds: BEDS };

const BAYS = [2, 5, 8, 11, 14]; // ER and ICU: two rows of five, heads on y1 and y6

const GF: FloorSpec = {
  floor: 0, name: "EMERGENCY AND MORGUE", short: "ER",
  map: [
    WALL,
    "#.b..b..b..b..b...#.......#MMMMMM..#",
    "#.b..b..b..b..b...#.......#........#",
    "#.................#.U.U.U.#........#",
    "#S................#.......#........#",
    "#.b..b..b..b..b...#.......#S.......#",
    "#.b..b..b..b..b...#....L..#..T.....#",
    "#gggggg+ggggggggg##+#######+########",
    ...CORRIDOR,
    "#######+##########+####+###+####+###",
    "#c.c.c.c.c.c.c.#.....#...#....#....#",
    "#..............#.===.#.D.#.U..#.W..#",
    "#c.c.c.c.c.c.c.#.....#...#....#....#",
    "#..............#.....#...#.L..#.W..#",
    "#c.c.c.c.c.c.c.#.....#.D.#....#....#",
    "#P.............#..S..#...#.L..#.S..#",
    WALL,
  ],
  rooms: [
    { label: "ER BAYS", floor: "hdu", x0: 1, x1: 17, ...north, sel: "unit:ER" },
    { label: "ER STORE", floor: "utility", x0: 19, x1: 25, ...north, sel: "unit:ER" },
    { label: "MORGUE", floor: "cold", x0: 27, x1: 34, ...north, sel: "morgue" },
    { label: "WAITING", floor: "waiting", x0: 1, x1: 14, ...south, sel: "queue:ER" },
    { label: "TRIAGE", floor: "station", x0: 16, x1: 20, ...south, sel: "unit:ER" },
    { label: "DOCTORS", floor: "office", x0: 22, x1: 24, ...south, sel: "unit:ER" },
    { label: "SUPPLY", floor: "utility", x0: 26, x1: 29, ...south, sel: "unit:ER" },
    { label: "TOILETS", floor: "utility", x0: 31, x1: 34, ...south, sel: "unit:ER" },
  ],
  ...plans(
    {
      unit: "ER", beds: [...row("ER", BAYS, 1, 2, 0), ...row("ER", BAYS, 6, 5, 5)],
      spots: [...along(range(2, 30, 2), 8), ...along(range(2, 30, 2), 9)], // trolleys in the corridor, slot 10 on
      staff: [[17, 11], [19, 11], [16, 13], [18, 13], [20, 13], [17, 15], [19, 15], [16, 14]], more: [32, 9],
    },
    {
      unit: "MORGUE", beds: [], drawers: along(range(27, 32), 1),
      spots: [...along([28, 30, 32], 3), ...along([29, 31, 33], 4), ...along([30, 32, 34], 5)], // overflow: covered trolleys
      staff: [], more: [33, 6],
    },
  ),
  queue: {
    chairs: [11, 13, 15].flatMap((y) => along(range(1, 13, 2), y)),
    standing: [...along(range(1, 14), 12), ...along(range(1, 14), 14), ...along(range(2, 14), 16)],
    more: [12, 15],
  },
};

const ICU: FloorSpec = {
  floor: 2, name: "INTENSIVE CARE", short: "ICU",
  map: [
    WALL,
    "#.bV.bV.bV.bV.bV..#....#.....#.....#",
    "#.b..b..b..b..b...#....#.....#.....#",
    "#.................#.U..#.D.D.#.....#",
    "#S................#.U..#.....#.H.H.#",
    "#.b..b..b..b..b...#.L..#.....#.....#",
    "#.bV.bV.bV.bV.bV..#.L..#..L..#..T..#",
    "#gggggg+ggggggggg##+####+#####+#####",
    ...CORRIDOR,
    "#####+#####.======.###+####+#####+##",
    "#.........#........#....#...#..#...#",
    "#.........#.UUU..L.#.D..#.W.#..#.S.#",
    "#.........#........#....#...#..#...#",
    "#..T..T...#........#.L..#...#..#...#",
    "#.........#.L...U..#....#...#..#...#",
    "#P...H....#........#....#...#..#..P#",
    WALL,
  ],
  rooms: [
    { label: "ICU", floor: "hdu", x0: 1, x1: 17, ...north, sel: "unit:ICU" },
    { label: "EQUIPMENT", floor: "utility", x0: 19, x1: 22, ...north, sel: "unit:ICU" },
    { label: "DOCTORS", floor: "office", x0: 24, x1: 28, ...north, sel: "unit:ICU" },
    { label: "RELATIVES", floor: "family", x0: 30, x1: 34, ...north, sel: "unit:ICU" },
    { label: "STAFF", floor: "office", x0: 1, x1: 9, ...south, sel: "unit:ICU" },
    { label: "NURSE STATION", floor: "station", x0: 11, x1: 18, y0: 10, y1: 16, sel: "unit:ICU" },
    { label: "MEDS", floor: "utility", x0: 20, x1: 23, ...south, sel: "unit:ICU" },
    { label: "SLUICE", floor: "utility", x0: 25, x1: 27, ...south, sel: "unit:ICU" },
    { label: "STORE", floor: "utility", x0: 29, x1: 30, ...south, sel: "unit:ICU" },
    { label: "LINEN", floor: "utility", x0: 32, x1: 34, ...south, sel: "unit:ICU" },
  ],
  ...plans({
    unit: "ICU", beds: [...row("ICU", BAYS, 1, 2, 0), ...row("ICU", BAYS, 6, 5, 5)], spots: [],
    staff: [[13, 11], [16, 11], [12, 13], [15, 13], [17, 14], [14, 16]], more: [16, 4],
  }),
};

// 3F: 3A north and 3B south, the south half the north one mirrored.
const MED_NORTH = [
  "#.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.#..#",
  "#.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.#..#",
  "#...............................#=.#",
  "#...............................#..#",
  "#.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.#..#",
  "#.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.#S.#",
  "#######+#######+#######+#######+##+#",
];
const MED_XS = range(2, 30, 2);
const STRETCHERS = range(3, 29, 2); // corridor stretcher spots, more than any shipped scenario's count

const MED: FloorSpec = {
  floor: 3, name: "MEDICINE", short: "MEDICINE",
  map: [WALL, ...MED_NORTH, ...CORRIDOR, ...[...MED_NORTH].reverse(), WALL],
  rooms: [
    { label: "STATION 3A", floor: "station", x0: 33, x1: 34, ...north, sel: "unit:MED3A" },
    { label: "STATION 3B", floor: "station", x0: 33, x1: 34, ...south, sel: "unit:MED3B" },
    // Each ward's rect runs under the station so its label sits mid-aisle; the station is listed first, so it keeps its tint.
    { label: "MEDICINE 3A", floor: "bay", x0: 1, x1: 34, y0: 1, y1: 7, sel: "unit:MED3A" },
    { label: "MEDICINE 3B", floor: "bay", x0: 1, x1: 34, y0: 10, y1: 16, sel: "unit:MED3B" },
  ],
  ...plans(
    {
      unit: "MED3A", beds: [...row("MED3A", MED_XS, 1, 2, 0), ...row("MED3A", MED_XS, 6, 5, 15)],
      spots: along(STRETCHERS, 8), staff: [[33, 4], [34, 2], [34, 5], [33, 1]], more: [31, 8],
    },
    {
      unit: "MED3B", beds: [...row("MED3B", MED_XS, 11, 12, 0), ...row("MED3B", MED_XS, 16, 15, 15)],
      spots: along(STRETCHERS, 9), staff: [[33, 13], [34, 15], [34, 12], [33, 16]], more: [31, 9],
    },
  ),
};

const SURG: FloorSpec = {
  floor: 5, name: "SURGERY", short: "SURGERY",
  map: [
    WALL,
    "#.b..b..b.#.b..b..b.#.....#...#....#",
    "#.b..b..b.#.b..b..b.#.D.D.#...#....#",
    "#.........#.........#.....#...#....#",
    "#S........#S........#.....#.W.#.U..#",
    "#.b..b..b.#.b..b..b.#.....#...#.U..#",
    "#.b..b..b.#.b..b..b.#..L..#...#.L..#",
    "#########+#########+####+###+####+##",
    ...CORRIDOR,
    "#########+#.======.######+######+###",
    "#.b..b..b.#........#.b..b..b.#.....#",
    "#.b..b..b.#........#.b..b..b.#.D.D.#",
    "#.........#.UUU..L.#.........#.....#",
    "#S........#........#S........#.....#",
    "#.b..b..b.#.L...U..#.b..b..b.#..T..#",
    "#.b..b..b.#........#.b..b..b.#H..P.#",
    WALL,
  ],
  rooms: [
    { label: "BAY A", floor: "bay", x0: 1, x1: 9, ...north, sel: "unit:SURG5A" },
    { label: "BAY B", floor: "bay", x0: 11, x1: 19, ...north, sel: "unit:SURG5A" },
    { label: "DOCTORS", floor: "office", x0: 21, x1: 25, ...north, sel: "unit:SURG5A" },
    { label: "SLUICE", floor: "utility", x0: 27, x1: 29, ...north, sel: "unit:SURG5A" },
    { label: "STORE", floor: "utility", x0: 31, x1: 34, ...north, sel: "unit:SURG5A" },
    { label: "BAY C", floor: "bay", x0: 1, x1: 9, ...south, sel: "unit:SURG5A" },
    { label: "NURSE STATION", floor: "station", x0: 11, x1: 18, y0: 10, y1: 16, sel: "unit:SURG5A" },
    { label: "BAY D", floor: "bay", x0: 20, x1: 28, ...south, sel: "unit:SURG5A" },
    { label: "RELATIVES", floor: "family", x0: 30, x1: 34, ...south, sel: "unit:SURG5A" },
  ],
  ...plans({
    unit: "SURG5A",
    beds: [
      ...row("SURG5A", [2, 5, 8], 1, 2, 0), ...row("SURG5A", [2, 5, 8], 6, 5, 3),
      ...row("SURG5A", [12, 15, 18], 1, 2, 6), ...row("SURG5A", [12, 15, 18], 6, 5, 9),
      ...row("SURG5A", [2, 5, 8], 11, 12, 12), ...row("SURG5A", [2, 5, 8], 16, 15, 15),
      ...row("SURG5A", [21, 24, 27], 11, 12, 18), ...row("SURG5A", [21, 24, 27], 16, 15, 21),
    ],
    spots: along(STRETCHERS, 9), staff: [[13, 11], [16, 11], [12, 14], [15, 14]], more: [31, 9],
  }),
};

/** Bottom up: GF first, as the stack is drawn. There is no 1F unit, so no 1F slab. */
export const FLOORS: FloorSpec[] = [GF, ICU, MED, W4, SURG];
