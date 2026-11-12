// The hospital's six floors as tile maps, each 36 x 18 like W4, so the renderer's geometry and art stay as they are.
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

const BAYS = [2, 5, 8, 11, 14]; // ER: two rows of five, heads on y1 and y6

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
      spots: [...along(range(2, 30, 2), 8), ...along([...range(2, 16, 2), ...range(20, 30, 2), 31], 9)], // trolleys in the corridor, slot 10 on; none at the triage door
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

// ICU beds four tiles apart (a ward's are three), each with its monitor; the station faces them through the glass.
const ICU_XS = [2, 6, 10, 14, 18];
const ICU: FloorSpec = {
  floor: 2, name: "INTENSIVE CARE", short: "ICU",
  map: [
    WALL,
    "#.bV..bV..bV..bV..bV.#....#....#...#",
    "#.b...b...b...b...b..#....#....#...#",
    "#....................#.U..#.D.D#...#",
    "#S...................#.U..#....#HH.#",
    "#.b...b...b...b...b..#.L..#....#...#",
    "#.bV..bV..bV..bV..bV.#.L..#.L..#.T.#",
    "#ggggggggggg+gggggggg#+####+####+###",
    ...CORRIDOR,
    "#####+#.======.#+####+###+####+#####",
    "#.....#........#....#...#....#.....#",
    "#.....#.UUU..L.#.D..#.W.#.L..#...S.#",
    "#.....#........#....#...#....#.....#",
    "#..T..#........#.L..#...#....#.....#",
    "#.....#.L...U..#....#...#....#.....#",
    "#P..H.#........#....#...#....#...P.#",
    WALL,
  ],
  rooms: [
    { label: "ICU", floor: "hdu", x0: 1, x1: 20, ...north, sel: "unit:ICU" },
    { label: "EQUIPMENT", floor: "utility", x0: 22, x1: 25, ...north, sel: "unit:ICU" },
    { label: "DOCTORS", floor: "office", x0: 27, x1: 30, ...north, sel: "unit:ICU" },
    { label: "RELATIVES", floor: "family", x0: 32, x1: 34, ...north, sel: "unit:ICU" },
    { label: "STAFF", floor: "office", x0: 1, x1: 5, ...south, sel: "unit:ICU" },
    { label: "NURSE STATION", floor: "station", x0: 7, x1: 14, y0: 10, y1: 16, sel: "unit:ICU" },
    { label: "MEDS", floor: "utility", x0: 16, x1: 19, ...south, sel: "unit:ICU" },
    { label: "SLUICE", floor: "utility", x0: 21, x1: 23, ...south, sel: "unit:ICU" },
    { label: "STORE", floor: "utility", x0: 25, x1: 28, ...south, sel: "unit:ICU" },
    { label: "LINEN", floor: "utility", x0: 30, x1: 34, ...south, sel: "unit:ICU" },
  ],
  ...plans({
    unit: "ICU", beds: [...row("ICU", ICU_XS, 1, 2, 0), ...row("ICU", ICU_XS, 6, 5, 5)], spots: [],
    staff: [[9, 11], [12, 11], [8, 13], [11, 13], [13, 14], [10, 16]], more: [16, 4],
  }),
};

// 1F and 3F: one medicine ward each, 30 beds in five bays of six as W4's (beds three tiles apart, a two-tile aisle
// between facing feet), the station and treatment room south, stretchers along the corridor's north wall.
const MED_BAY = [".b..b..b.", ".b..b..b.", ".........", "S........", ".b..b..b.", ".b..b..b."];
const MED_UTILITY = ["U..U", "U...", "....", "S...", "...L", "U..L"]; // clean utility, x31-34
const MED_SOUTH = [
  "#########+#.======.######+######+###",
  "#.b..b..b.#........#.b..b..b.#.....#",
  "#.b..b..b.#........#.b..b..b.#.U.U.#",
  "#.........#.UUU..L.#.........#.....#",
  "#S........#........#S........#..T..#",
  "#.b..b..b.#.L...U..#.b..b..b.#.....#",
  "#.b..b..b.#........#.b..b..b.#S..L.#",
];
const BAY_XS = [[2, 5, 8], [12, 15, 18], [22, 25, 28], [2, 5, 8], [21, 24, 27]];
const STRETCHERS = range(2, 28, 2); // corridor stretcher spots, clear of the doors; more than any shipped scenario's count

function medicine(floor: number, unit: UnitId, name: string): FloorSpec {
  const sel = `unit:${unit}`;
  return {
    floor, name, short: "MEDICINE",
    map: [
      WALL,
      ...MED_BAY.map((r, y) => `#${r}#${r}#${r}#${MED_UTILITY[y]}#`),
      "#########+#########+#########+##+###",
      ...CORRIDOR,
      ...MED_SOUTH,
      WALL,
    ],
    rooms: [
      { label: "BAY 1", floor: "bay", x0: 1, x1: 9, ...north, sel },
      { label: "BAY 2", floor: "bay", x0: 11, x1: 19, ...north, sel },
      { label: "BAY 3", floor: "bay", x0: 21, x1: 29, ...north, sel },
      { label: "CLEAN UTILITY", floor: "utility", x0: 31, x1: 34, ...north, sel },
      { label: "BAY 4", floor: "bay", x0: 1, x1: 9, ...south, sel },
      { label: "NURSE STATION", floor: "station", x0: 11, x1: 18, y0: 10, y1: 16, sel },
      { label: "BAY 5", floor: "bay", x0: 20, x1: 28, ...south, sel },
      { label: "TREATMENT", floor: "side", x0: 30, x1: 34, ...south, sel },
    ],
    ...plans({
      unit,
      beds: BAY_XS.flatMap((xs, k) => (k < 3
        ? [...row(unit, xs, 1, 2, k * 6), ...row(unit, xs, 6, 5, k * 6 + 3)]
        : [...row(unit, xs, 11, 12, k * 6), ...row(unit, xs, 16, 15, k * 6 + 3)])),
      spots: along(STRETCHERS, 8), staff: [[13, 11], [16, 11], [12, 14], [15, 14]], more: [30, 9],
    }),
  };
}
const MED1 = medicine(1, "MED3B", "MEDICINE 1A"); // unit id kept from when it shared 3F
const MED3 = medicine(3, "MED3A", "MEDICINE 3A");

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

/** Bottom up: GF first, as the stack is drawn. */
export const FLOORS: FloorSpec[] = [GF, MED1, ICU, MED3, W4, SURG];
