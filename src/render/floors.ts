// The hospital's floors as tile maps, each 36 x 18 like W4, so the renderer's geometry and art stay as they are.
// 4F is W4's own map. The others are, for now, rim walls, W4's corridor and tinted rooms with their labels.
import { BEDS, MAP, MAP_W, ROOMS, type Bed, type Room } from "../sim/map";

export interface FloorSpec {
  floor: number; // as the hospital numbers it: 0 is GF
  name: string; // printed on the corridor floor
  map: string[];
  rooms: (Room & { sel?: string })[]; // sel: what a click on the room's label selects
  beds: Bed[];
}

const wall = "#".repeat(MAP_W);
const room = `#${".".repeat(MAP_W - 2)}#`;
// Rows 8-9 are W4's corridor on every floor; the east doors are the lift.
const SHELL = [wall, ...Array(7).fill(room), `#${".".repeat(MAP_W - 2)}+`, `#P${".".repeat(MAP_W - 3)}+`, ...Array(7).fill(room), wall];
const north = { y0: 1, y1: 7 };
const south = { y0: 10, y1: 16 };

export const W4: FloorSpec = { floor: 4, name: "WARD W4 · CARDIOLOGY", map: MAP, rooms: ROOMS, beds: BEDS };

/** Bottom up: GF first, as the stack is drawn. There is no 1F unit, so no 1F slab. */
export const FLOORS: FloorSpec[] = [
  {
    floor: 0, name: "EMERGENCY AND MORGUE", map: SHELL, beds: [],
    rooms: [
      { label: "EMERGENCY ROOM", floor: "hdu", x0: 1, x1: 25, ...north, sel: "unit:ER" },
      { label: "MORGUE", floor: "utility", x0: 26, x1: 34, ...north, sel: "morgue" },
      { label: "WAITING", floor: "station", x0: 1, x1: 34, ...south, sel: "queue:ER" },
    ],
  },
  {
    floor: 2, name: "INTENSIVE CARE", map: SHELL, beds: [],
    rooms: [
      { label: "INTENSIVE CARE", floor: "hdu", x0: 1, x1: 34, ...north, sel: "unit:ICU" },
      { label: "NURSE STATION", floor: "station", x0: 1, x1: 34, ...south },
    ],
  },
  {
    floor: 3, name: "MEDICINE", map: SHELL, beds: [],
    rooms: [
      { label: "MEDICINE 3A", floor: "bay", x0: 1, x1: 34, ...north, sel: "unit:MED3A" },
      { label: "MEDICINE 3B", floor: "bay", x0: 1, x1: 34, ...south, sel: "unit:MED3B" },
    ],
  },
  W4,
  {
    floor: 5, name: "SURGERY", map: SHELL, beds: [],
    rooms: [
      { label: "SURGERY 5A", floor: "bay", x0: 1, x1: 34, ...north, sel: "unit:SURG5A" },
      { label: "NURSE STATION", floor: "station", x0: 1, x1: 34, ...south },
    ],
  },
];
