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
      if (ch === "." || palette[ch] === "none") return; // "none": a cell left clear, so figures carry no outline
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

const INK = "#5B6678"; // a soft slate outline, not black

const staffPalette = (skin: string, hair: string, top: string, shade: string, trim: string, legs: string): Palette => ({
  k: "none",
  e: INK,
  s: skin,
  h: hair,
  c: top,
  d: shade,
  w: trim,
  p: legs,
  b: "#5B6678",
});

export const STAFF_PALETTES: Record<string, Palette> = {
  "rn-delacruz": staffPalette("#C98F63", "#2A1D1A", "#4DB5AC", "#3A9C93", "#FFFFFF", "#3A9C93"),
  "rn-reyes": staffPalette("#E0AD7F", "#4A2F22", "#E79A68", "#D0834F", "#FFFFFF", "#D0834F"),
  "rn-manalo": staffPalette("#B97F55", "#1A1320", "#9A8DE0", "#8174CC", "#FCC800", "#8174CC"),
  "md-santos": staffPalette("#D9A273", "#2F2430", "#FFFFFF", "#E4E8EE", "#E7434A", "#5B6678"),
  "md-aquino": staffPalette("#C48A5B", "#8D8496", "#FFFFFF", "#E4E8EE", "#63D5A8", "#5B6678"),
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

// Outside W4: generic nurses in ward blue scrubs, and the waiting room's people, whose top is their triage colour.
export const NURSE_PALETTES: Palette[] = SKINS.slice(0, 3).map((skin, i) =>
  staffPalette(skin, HAIRS[i * 2 % HAIRS.length], "#7FA3EA", "#6890D8", "#FFFFFF", "#6890D8"),
);
export const figurePalette = (top: string, i: number): Palette =>
  staffPalette(SKINS[i % SKINS.length], HAIRS[(i * 2 + 1) % HAIRS.length], top, top, top, "#7A869A");

export const ENVELOPE = [
  "kkkkkkkkk",
  "kwwwwwwwk",
  "kkwwwwwkk",
  "kwkwwwkwk",
  "kwwkkkwwk",
  "kwwwwwwwk",
  "kkkkkkkkk",
];
export const ENVELOPE_PALETTE: Palette = { k: "#9AA6B8", w: "#FFFFFF" };

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
export const PLANT_PALETTE: Palette = { g: "#5FB08A", G: "#8AD3AE", k: "none", t: "#D9B9A0" };
