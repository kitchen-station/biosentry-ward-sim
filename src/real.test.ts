import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PARAMS, UNITS } from "./sim/hospital/params";
import { ROWS, SYNTHETIC_LINE } from "./real";

const root = new URL("..", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), "utf8");

const PARAMS_FILE = "src/sim/hospital/params.ts";
// "obs.roundMin" walks PARAMS; "UNITS.MED3A.nurses.typical" finds the unit by id. Both end in a Sourced value.
function inCode(path: string): number | number[] {
  const keys = path.split(".");
  let at: unknown = keys[0] === "UNITS" ? UNITS.find((u) => u.id === keys[1]) : PARAMS;
  for (const k of keys.slice(keys[0] === "UNITS" ? 2 : 0)) at = (at as Record<string, unknown>)[k];
  return (at as { value: number | number[] }).value;
}

describe("What is real here", () => {
  it("has a sensible number of rows and the synthetic line", () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(12);
    expect(ROWS.length).toBeLessThanOrEqual(18);
    expect(SYNTHETIC_LINE).toMatch(/synthetic/);
  });

  it.each(ROWS.map((r) => [r.thing, r] as const))("%s: ref file holds the symbol", (_t, r) => {
    const i = r.ref.indexOf(": ");
    const [file, symbol] = [r.ref.slice(0, i), r.ref.slice(i + 2)];
    const text = read(file); // throws when the file is missing
    if (file === PARAMS_FILE) expect(inCode(symbol), r.ref).toBeDefined();
    else expect(text, r.ref).toContain(symbol);
  });

  it.each(ROWS.filter((r) => r.num !== undefined).map((r) => [r.thing, r] as const))("%s: shown number equals the code", (_t, r) => {
    const symbol = r.ref.split(": ")[1];
    const code = inCode(symbol);
    const num = Array.isArray(code) ? code[1] : code;
    expect(r.num).toBe(num);
    expect(r.value).toContain(r.pct ? `${Math.round(num * 1000) / 10}%` : String(num));
  });
});
