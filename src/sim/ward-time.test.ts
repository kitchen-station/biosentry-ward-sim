import { describe, expect, it } from "vitest";
import { stamp } from "../panels";
import { createSim, type Sim } from "./sim";
import { createSyntheticSource, FIXTURE_SEED, START_CLOCK_MIN, WARD_START_ISO } from "./source";
import { createSync } from "./sync";
import { finishedStays, servedNowMs } from "./view";

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

  it("the viewer takes the API's own now when it serves one, else the real clock", () => {
    expect(servedNowMs({ now: "2026-09-05T09:34:00Z" }, 5)).toBe(Date.UTC(2026, 8, 5, 9, 34));
    for (const now of [undefined, null, 17, "", "soon", {}]) expect(servedNowMs({ now }, 5)).toBe(5);
  });

  it("the stay list counts back from the served now, so a calendar time far from today still gives the right minute", () => {
    const start = Date.parse(WARD_START_ISO);
    const iso = (minute: number) => new Date(start + minute * 60_000).toISOString();
    const s = { clockS: 3000 * 60 } as unknown as Sim; // the ward is at minute 3000
    const rows = [{ id: "n-0001", name: "A", bed: "1C", admitted_at: iso(2000), left_at: iso(2900), outcome: "discharged" as const }];
    const [stay] = finishedStays(rows, s, servedNowMs({ now: iso(3000) }, Date.now()));
    expect([stay.inMin, stay.outMin]).toEqual([2000, 2900]);
    // With the real clock as now, the same rows would land at minute 0: months before today.
    const [wrong] = finishedStays(rows, s, Date.UTC(2026, 10, 14));
    expect([wrong.inMin, wrong.outMin]).toEqual([0, 0]);
  });
});
