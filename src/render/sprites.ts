// All art in this project is drawn here, in code: pixel grids and procedural boxes.
// A grid is rows of palette characters; "." is transparent.

export type Palette = Record<string, string>;

export function sprite(rows: string[], palette: Palette, flip = false): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = rows[0].length;
  canvas.height = rows.length;
  const ctx = canvas.getContext("2d")!;
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === ".") return;
      ctx.fillStyle = palette[ch];
      ctx.fillRect(flip ? canvas.width - 1 - x : x, y, 1, 1);
    });
  });
  return canvas;
}

const BODY = [
  "..kccwwcck..",
  ".kcccwwccck.",
  ".kcccccccck.",
  ".kckcccckck.",
  ".ksddddddsk.",
  "..kddddddk..",
  "..kppppppk..",
];
const LEGS_STAND = [
  "..kppkkppk..",
  "..kppkkppk..",
  "..kppkkppk..",
  "..kbbkkbbk..",
  "..kkk..kkk..",
];
const LEGS_STEP = [
  "..kppkkppk..",
  "..kppkkppk..",
  "..kbbkkppk..",
  "..kkk.kppk..",
  "......kbbk..",
];
const HEAD_FRONT = [
  "....kkkk....",
  "...khhhhk...",
  "..khhhhhhk..",
  "..khhhhhhk..",
  "..khsssshk..",
  "..ksessesk..",
  "..kssssssk..",
  "...kssssk...",
];
const HEAD_BACK = [
  "....kkkk....",
  "...khhhhk...",
  "..khhhhhhk..",
  "..khhhhhhk..",
  "..khhhhhhk..",
  "..khhhhhhk..",
  "..khhhhhhk..",
  "...kssssk...",
];

export const PERSON = {
  front: { stand: [...HEAD_FRONT, ...BODY, ...LEGS_STAND], step: [...HEAD_FRONT, ...BODY, ...LEGS_STEP] },
  back: { stand: [...HEAD_BACK, ...BODY, ...LEGS_STAND], step: [...HEAD_BACK, ...BODY, ...LEGS_STEP] },
};

export const PORTRAIT = [...HEAD_FRONT, ...BODY.slice(0, 4)];

const INK = "#1A1320";

const staffPalette = (skin: string, hair: string, top: string, shade: string, trim: string, legs: string): Palette => ({
  k: INK,
  e: INK,
  s: skin,
  h: hair,
  c: top,
  d: shade,
  w: trim,
  p: legs,
  b: "#3D2E4A",
});

export const STAFF_PALETTES: Record<string, Palette> = {
  "rn-delacruz": staffPalette("#C98F63", "#2A1D1A", "#3AA89F", "#2F8C84", "#FFF8E7", "#2F8C84"),
  "rn-manalo": staffPalette("#B97F55", "#1A1320", "#8E72E0", "#7459C4", "#FFD93D", "#7459C4"),
  "md-santos": staffPalette("#D9A273", "#2F2430", "#FCFAF0", "#E4DCC6", "#FF6B6B", "#3D2E4A"),
  "md-aquino": staffPalette("#C48A5B", "#8D8496", "#FCFAF0", "#E4DCC6", "#4ECDC4", "#3D2E4A"),
};

export const PATIENT_HEAD = [
  ".hhhhh.",
  "hhhhhhh",
  "hsssssh",
  "sesssse",
  "sssssss",
  ".sssss.",
];

const SKINS = ["#C98F63", "#E0AD7F", "#B97F55", "#D9A273", "#C48A5B"];
const HAIRS = ["#2A1D1A", "#4A2F22", "#8D8496", "#1A1320", "#D9CFE0"];

export const patientPalette = (i: number): Palette => ({
  s: SKINS[i % SKINS.length],
  h: HAIRS[(i * 2 + 1) % HAIRS.length],
  e: INK,
});

export const ENVELOPE = [
  "kkkkkkkkk",
  "kwwwwwwwk",
  "kkwwwwwkk",
  "kwkwwwkwk",
  "kwwkkkwwk",
  "kwwwwwwwk",
  "kkkkkkkkk",
];
export const ENVELOPE_PALETTE: Palette = { k: INK, w: "#FFF8E7" };

export const PLANT = [
  "...g.g...",
  ".g.gGg.g.",
  "..gGgGg..",
  ".gGgGgGg.",
  "..gGgGg..",
  "...gGg...",
  "...kkk...",
  "..kttt k.".replace(" ", "t"),
  "..kttttk.",
  "...kkkk..",
];
export const PLANT_PALETTE: Palette = { g: "#4E9A5B", G: "#6BCF7F", k: INK, t: "#C96F4A" };
