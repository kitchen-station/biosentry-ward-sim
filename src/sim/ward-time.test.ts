import { describe, expect, it } from "vitest";
import { stamp } from "../panels";
import { createSim } from "./sim";
import { createSyntheticSource, FIXTURE_SEED, START_CLOCK_MIN, WARD_START_ISO } from "./source";
import { createSync } from "./sync";

// One calendar for the ward (audit gap 1): the instant the API is sent as a run's origin is the instant the pages print at minute 0.
describe("ward time", () => {
  // Manila is UTC+8 all year. Plain arithmetic, so the check does not depend on the machine's locale data.
  const manila = (ms: number) => {
    const d = new Date(ms + 8 * 3600_000);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hhmm: `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}` };
  };

  it("minute 0 is 3 Sept 2026, 15:00 in Manila, on the page and in the constant", () => {
    const src = createSyntheticSource(FIXTURE_SEED, true);
    const start = Date.parse(WARD_START_ISO);
    expect(new Date(start).toISOString()).toBe(WARD_START_ISO);
    expect(manila(start)).toEqual({ year: 2026, month: 9, day: 3, hhmm: `${String(START_CLOCK_MIN / 60).padStart(2, "0")}:00` });
    // The page prints the same day and time at minute 0, and 26 hours 34 minutes later.
    for (const minute of [0, 1594]) {
      const m = manila(start + minute * 60_000);
      expect(stamp(src, minute).startsWith(`${m.day} `)).toBe(true);
      expect(stamp(src, minute).endsWith(m.hhmm)).toBe(true);
    }
  });

  it("a new run is sent that instant as its origin, not the real clock", async () => {
    const bodies: { origin?: string }[] = [];
    const sync = createSync({
      apiUrl: "http://api.test",
      key: "k",
      clientId: "c",
      fetch: (async (_url: unknown, init?: { body?: string }) => {
        bodies.push(JSON.parse(init?.body ?? "{}"));
        return new Response(JSON.stringify({ run_id: 7 }), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    });
    const src = createSyntheticSource(FIXTURE_SEED, true);
    await sync.start(createSim(src), src);
    expect(bodies[0].origin).toBe(WARD_START_ISO);
    expect(sync.run.origin).toBe(WARD_START_ISO);
  });
});
