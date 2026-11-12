import { expect, it } from "vitest";

// A grep, as scenario.test.ts does for src/sim: what the renderer draws depends on the sim and frame(dt, now) only.
const files = import.meta.glob(["/src/render/**/*.ts", "!/src/render/**/*.test.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const BANNED: [string, RegExp][] = [
  ["Math.random", /Math\s*\.\s*random/],
  ["Date.now", /Date\s*\.\s*now/],
  ["new Date", /new\s+Date\b/],
  ["Date()", /(?<![\w.$])Date\s*\(/],
  ["crypto.getRandomValues", /crypto\s*\.\s*getRandomValues/],
  ["crypto.randomUUID", /crypto\s*\.\s*randomUUID/],
  ["performance.now", /performance\s*\.\s*now/],
];

it("render code reads no clock and draws no random numbers", () => {
  expect(Object.keys(files)).toEqual(expect.arrayContaining(["/src/render/draw.ts", "/src/render/stack.ts", "/src/render/floors.ts", "/src/render/sprites.ts", "/src/render/facade.ts"]));
  const hits = Object.entries(files).flatMap(([file, text]) =>
    text.split("\n").flatMap((line, n) => BANNED.filter(([, re]) => re.test(line)).map(([name]) => `${file}:${n + 1}: ${name}`)),
  );
  expect(hits).toEqual([]);
});
