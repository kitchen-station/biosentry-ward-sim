import { expect, it } from "vitest";
import { parseOpenWard, toLive } from "./open-view";
import { createRenderer } from "./render/draw";
import { createReader } from "./sim/view";

// A fake canvas that logs fillText and draws nothing.
const log: string[] = [];
const ctx = new Proxy({}, {
  get: (_t, k: string) => {
    if (k === "measureText") return (t: string) => ({ width: t.length * 4 });
    if (k === "createImageData") return (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
    return (...a: unknown[]) => void (k === "fillText" && log.push(String(a[0])));
  },
  set: () => true,
});
const fake = () => ({ width: 0, height: 0, style: {}, getContext: () => ctx });
Object.assign(globalThis, { document: { createElement: fake }, ImageData: class {} });

it("paints a watcher ward with role-coloured figures, grey and coloured beds, no name, no throw", () => {
  const body = {
    ward: "W4", synthetic: true, can_control: false,
    sim: {
      clockS: 5, speed: 1, ended: false,
      staff: [0, 1, 2, 3, 4].map((key) => ({ key, role: ["rn", "charge_rn", "md"][key % 3], x: 4 + key, y: 8, facing: "back", walking: key % 2 === 0, moved: 2.2, stage: "message", timer: 1 })),
      moves: [{ seq: 1, bed: "4A", kind: "in" }],
    },
    beds: [
      { bed: "4A", state: "ranked", rank: 1, risk: "high" },
      { bed: "2B", state: "ranked", rank: 2, risk: null },
      { bed: "1C", state: "not_ranked", rank: null, risk: null },
    ],
  };
  const sim = createReader()(toLive(parseOpenWard(JSON.stringify(body))!));
  const r = createRenderer(fake() as unknown as HTMLCanvasElement);
  r.resize(656, 382, 1);
  for (const [dt, now] of [[0.016, 1], [0.017, 1.02], [0.016, 1.04]]) r.frame(sim, null, null, dt, now);
  expect(log).toContain("#1");
  expect(log).not.toContain("#2"); // risk null: no tag
  expect(log).not.toContain("NR"); // rank null on an open bed: no tag
  for (const name of ["Santos", "Reyes", "Dela Cruz", "Manalo", "Aquino"]) expect(log.join("|")).not.toContain(name);
});
