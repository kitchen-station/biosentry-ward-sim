// Runs only where the local extract exists. See the README for npm run extract.
import { describe, expect, it } from "vitest";
import { createReplaySource, type ReplayFile } from "./replay";
import { createSim, minuteOf, step, type Patient } from "./sim";

const found = import.meta.glob<ReplayFile>("/public/replay/eicu-12.json", {
  eager: true,
  import: "default",
});
const file = Object.values(found)[0];

const total = (p: Patient) => (p.decision.kind === "ranked" ? p.decision.news2.total : null);

describe.skipIf(!file)("the real 12-stay extract", () => {
  it("ranks all twelve at the start", () => {
    const s = createSim(createReplaySource(file));
    expect(s.patients.map((p) => [p.id, p.decision.kind === "ranked" ? "ok" : p.decision.reason])).toEqual(
      s.patients.map((p) => [p.id, "ok"]),
    );
  });

  it("stays rankable through the 24 hours and reaches the end", () => {
    const src = createReplaySource(file);
    const s = createSim(src);
    const slots: Record<string, (number | null)[]> = {};
    let previous = s.patients.map(total);
    let changes = 0;
    let last = 0;
    while (!s.ended) {
      step(s, src);
      const minute = minuteOf(s);
      if (minute !== last && minute % 15 === 0) {
        last = minute;
        const now = s.patients.map(total);
        s.patients.forEach((p, i) => (slots[p.id] ??= []).push(now[i]));
        changes += now.filter((v, i) => v !== previous[i]).length;
        previous = now;
      }
    }
    const rows = Object.entries(slots).map(([id, values]) => {
      const ok = values.filter((v) => v !== null);
      return { id, rankable: Math.round((100 * ok.length) / values.length), first: ok[0], last: ok.at(-1), max: Math.max(...ok) };
    });
    console.table(rows);
    console.log("ward score changes per hour", (changes / 24).toFixed(1), JSON.stringify(s.counts));
    for (const row of rows) expect(row.rankable, row.id).toBeGreaterThanOrEqual(80);
  });
});
