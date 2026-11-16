// The public page when the server runs a whole hospital: the open answers of every unit, drawn as the building.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { floorSummary } from "./building";
import { FLOORS } from "./render/floors";
import { slabTag } from "./render/scene";
import { bedSel, inOrder, openBedOf, openHospital, openRisk, OPEN_FIRST_MS, OPEN_RETRY_MS, OPEN_UNITS, startUnitsPoll, type OpenViews } from "./open-hospital";
import { OpenHospitalPanel } from "./open-panels";
import { OPEN_POLL_MS, type OpenBed, type OpenWard } from "./open-view";

const ward = (id: string, beds: OpenBed[]): OpenWard => ({ ward: id, synthetic: true, can_control: false, sim: { clockS: 600, speed: 10, ended: false, staff: [], moves: [] }, beds });
const ranked = (bed: string, rank: number, risk: OpenBed["risk"]): OpenBed => ({ bed, state: "ranked", rank, risk });
const plain = (bed: string): OpenBed => ({ bed, state: "not_ranked", rank: null, risk: null });
const VIEWS: OpenViews = {
  W4: ward("W4", [ranked("4A", 1, "high"), plain("2B")]),
  MED3A: ward("MED3A", [ranked("MED3A-12", 2, "low"), plain("MED3A-7"), ranked("MED3A-30", 1, "medium")]),
  ER: ward("ER", [plain("ER-5"), plain("ER-41")]),
  ICU: ward("ICU", [plain("ICU-9")]),
};
const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

afterEach(() => vi.useRealTimers());

describe("the hospital made from the open answers", () => {
  const h = openHospital(VIEWS, 10);

  it("has every unit but the morgue, no nurses, and one nameless person per bed in use", () => {
    expect(h.units.map((u) => u.id).sort()).toEqual(["ER", "ICU", "MED3A", "MED3B", "SURG5A", "W4"]);
    expect(h.units.every((u) => u.nurses === 0)).toBe(true); // the open answer holds no staffing: none is drawn
    expect(h.people).toHaveLength(8);
    expect(h.people.every((p) => p.name === "" && p.age === 0 && p.group === "minor" && p.complaint === "")).toBe(true);
    expect(h.lastMinute).toBe(10);
  });

  it("fills a unit's drawn beds in the list's order, ranked first, and leaves W4's people to the ward's own stubs", () => {
    expect(inOrder(VIEWS.MED3A.beds).map((b) => b.bed)).toEqual(["MED3A-30", "MED3A-12", "MED3A-7"]);
    const med = h.people.filter((p) => p.unit === "MED3A");
    expect(med.map((p) => [p.id, p.slot])).toEqual([["open:MED3A:MED3A-30", 0], ["open:MED3A:MED3A-12", 1], ["open:MED3A:MED3A-7", 2]]);
    expect(h.people.filter((p) => p.unit === "W4").map((p) => [p.w4Id, p.slot])).toEqual([["open-bed:4A", null], ["open-bed:2B", null]]);
  });

  it("gives the building a band where the unit is ranked, grey where it is shown, and nothing in intensive care", () => {
    const risk = openRisk(VIEWS);
    const floors = floorSummary(h, risk);
    const cells = (unit: string) => floors.flatMap((f) => f.units).find((u) => u.id === unit)!.beds.filter((c) => c !== null);
    expect(cells("MED3A").map((c) => c.risk)).toEqual(["medium", "low", null]);
    expect(cells("ER").map((c) => c.risk)).toEqual([null, null]);
    expect(cells("ICU").map((c) => c.risk)).toEqual([undefined]); // never scored: no NEWS2 colour at all
    expect(cells("MED3B")).toEqual([]); // no answer for it: drawn empty
    expect(new Set(h.people.map((p) => p.n)).size).toBe(h.people.length); // one number per bed
  });

  it("puts nothing of the placeholder person on the drawing: a bed's tag has no initials, and a sign counts beds in use only", () => {
    const floors = floorSummary(h, openRisk(VIEWS));
    const cells = floors.flatMap((f) => f.units).flatMap((u) => [...u.beds, ...u.stretchers, ...u.over]).filter((c) => c !== null);
    expect(cells).toHaveLength(8);
    expect(cells.every((c) => c.initials === "")).toBe(true); // no name was given, so none can show
    const spec = (floor: number) => FLOORS.find((s) => s.floor === floor)!;
    expect(slabTag(spec(0), floors, true)).toBe("GF ER 2"); // not "0 waiting": the open answer has no queue
    expect(slabTag(spec(3), floors, true)).toMatch(/^3F \S+ 3$/); // not "3/30": the open answer has no capacity
    expect(slabTag(spec(4), floors, true)).toMatch(/ 2$/);
    expect(slabTag(spec(0), floors)).toMatch(/waiting$/); // the standalone page's own sign is unchanged
    const er = floors.find((f) => f.floor === 0)!.units.find((u) => u.id === "ER")!;
    expect([er.queue.length, floors.find((f) => f.floor === 0)!.boarders]).toEqual([0, 0]); // so no "+N" and no "N boarding" tag is drawn
  });

  it("finds the unit and bed a click or a row means, and nothing for anything else", () => {
    expect(openBedOf(VIEWS, bedSel("MED3A", "MED3A-7"))).toMatchObject({ unit: { id: "MED3A" }, bed: { bed: "MED3A-7" } });
    expect(openBedOf(VIEWS, "open-bed:4A")).toMatchObject({ unit: { id: "W4" }, bed: { bed: "4A" } });
    expect(openBedOf(VIEWS, "bed:2B")).toMatchObject({ unit: { id: "W4" }, bed: { bed: "2B" } });
    for (const other of [null, "h:1", "hbed:MED3A:9", "unit:ER", "entrance", "open-3"]) expect(openBedOf(VIEWS, other)).toBeNull();
  });
});

describe("asking the other units", () => {
  const ok = (id: string) => new Response(JSON.stringify(ward(id, [])), { status: 200 });

  it("asks one unit at a time in turn, quickly on the first round and then once per poll", async () => {
    vi.useFakeTimers();
    const urls: string[] = [];
    const f = vi.fn(async (url: string) => { urls.push(url.replace("http://api/wards/", "").replace("/open-view", "")); return ok(urls.at(-1)!); });
    const got: [string, boolean][] = [];
    const stop = startUnitsPoll({ fetch: f as unknown as typeof fetch, base: "http://api", units: ["ER", "ICU", "MED3A"], onUnit: (u, b) => got.push([u, b !== null]) });
    await vi.advanceTimersByTimeAsync(2 * OPEN_FIRST_MS + 50);
    expect(urls).toEqual(["ER", "ICU", "MED3A"]);
    await vi.advanceTimersByTimeAsync(OPEN_POLL_MS - 100);
    expect(urls).toHaveLength(3); // the first round is over: back to the poll's own pace
    await vi.advanceTimersByTimeAsync(3 * OPEN_POLL_MS);
    expect(urls.slice(3)).toEqual(["ER", "ICU", "MED3A"]);
    expect(got.every(([, has]) => has)).toBe(true);
    stop();
    const n = f.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * OPEN_POLL_MS);
    expect(f).toHaveBeenCalledTimes(n);
  });

  it("drops a unit the server does not hold and asks it again only after a minute; a unit that is down keeps its answer", async () => {
    vi.useFakeTimers();
    const urls: string[] = [];
    const f = vi.fn(async (url: string) => {
      const id = url.replace("http://api/wards/", "").replace("/open-view", "");
      urls.push(id);
      return id === "ER" ? new Response(null, { status: 404 }) : id === "ICU" ? new Response(null, { status: 503 }) : ok(id);
    });
    const got: [string, boolean][] = [];
    const stop = startUnitsPoll({ fetch: f as unknown as typeof fetch, base: "http://api", units: ["ER", "ICU", "MED3A"], onUnit: (u, b) => got.push([u, b !== null]) });
    await vi.advanceTimersByTimeAsync(OPEN_RETRY_MS - 1000);
    expect(urls.filter((u) => u === "ER")).toHaveLength(1);
    expect(urls.filter((u) => u === "ICU").length).toBeGreaterThan(5);
    expect(got.filter(([u]) => u === "ER")).toEqual([["ER", false]]);
    expect(got.some(([u]) => u === "ICU")).toBe(false); // down: nothing said, the last answer stays
    await vi.advanceTimersByTimeAsync(3 * OPEN_POLL_MS + 1000);
    expect(urls.filter((u) => u === "ER")).toHaveLength(2);
    stop();
  });
});

describe("the side panel", () => {
  const panel = (view: number | null, selected: string | null) => renderToStaticMarkup(<OpenHospitalPanel views={VIEWS} view={view} selected={selected} speed={10} onView={noop} onSelect={noop} />);

  it("first says what this is in one sentence, with the speed in words, and lists the floors from the top", () => {
    const html = panel(null, null);
    expect(text(html)).toContain("This is a simulated hospital, running at 10x: 1 minute here is 10 hospital minutes. Every patient is synthetic. Pick a floor, then a bed. Read-only. Sign in to control.");
    const rows = [...html.matchAll(/<li><button>([^<]+)<\/button><\/li>/g)].map((m) => m[1]);
    expect(rows).toEqual([
      "5F Surgery 5A · no answer yet",
      "4F Ward W4 · 2 beds in use",
      "3F Medicine 3A · 3 beds in use",
      "2F Intensive Care · 1 bed in use",
      "1F Medicine 1A · no answer yet",
      "GF Emergency Room · 2 beds in use",
    ]);
    expect(html).toContain('<b aria-current="page">Hospital</b>');
    expect(html).toContain("Escape goes up one level.");
  });

  it("on a floor lists the unit's beds, ranked first, under a breadcrumb back to the hospital", () => {
    const html = panel(3, null);
    expect(html).toMatch(/<nav class="crumbs" aria-label="Where you are"><button>Hospital<\/button> › <b aria-current="page">3F Medicine 3A<\/b><\/nav>/);
    expect([...html.matchAll(/<\/i> ([^<]+)<\/button>/g)].map((m) => m[1])).toEqual(["Bed MED3A-30 · Rank 1 · Medium risk", "Bed MED3A-12 · Rank 2 · Low risk", "Bed MED3A-7 · Not ranked"]);
    expect(text(panel(0, null))).toContain("Shown, not ranked: NEWS2 is a ward score.");
    expect(text(panel(2, null))).toContain("Not scored: NEWS2 is a ward score, not an intensive care score.");
    expect(text(panel(1, null))).toContain("No answer from the server yet.");
  });

  it("a bed's card holds the band, the rank and where it is, and nothing about the person", () => {
    const html = panel(3, bedSel("MED3A", "MED3A-30"));
    expect(html).toMatch(/<button>Hospital<\/button> › <button>3F Medicine 3A<\/button> › <b aria-current="page">Bed MED3A-30<\/b>/);
    expect(text(html)).toContain("Bed MED3A-30 Medium risk Medicine 3A, 3F. Rank 1 in this unit. Read-only. Sign in to see this patient's vitals.");
    expect(html).not.toMatch(/NEWS2 \d|bpm|SpO2|years|heart/i);
    expect(text(panel(2, bedSel("ICU", "ICU-9")))).toContain("Not ranked Intensive Care, 2F. Not scored");
    // a pick wins over the open floor: the card is the bed's own unit
    expect(panel(5, "open-bed:4A")).toContain("4F Ward W4");
  });

  it("never says demo, and names no single ward as the whole page", () => {
    const all = [panel(null, null), panel(3, null), panel(4, null), panel(3, bedSel("MED3A", "MED3A-30"))].join(" ");
    expect(all).not.toMatch(/demo/i);
    expect(all).not.toMatch(/Watching W4|This is ward W4/);
    for (const file of ["src/open-panels.tsx", "src/open-hospital.ts"]) expect(readFileSync(file, "utf8")).not.toMatch(/demo/i);
  });
});

describe("the page's wiring", () => {
  const app = readFileSync("src/App.tsx", "utf8");

  it("draws the building only when another unit has answered, and takes clicks only on floors and beds", () => {
    expect(app).toContain("const hosp = HOSPITAL || (!!watch && Object.keys(others).length > 0);");
    expect(app).toContain("serverHospital={!!watch && hosp}");
    expect(app).toContain('const id = watch && hit && !hit.startsWith("floor:") && !openBedOf(views, hit) ? "" : hit;');
    expect(app).toContain("units: OPEN_UNITS.map((u) => u.id).filter((id) => id !== OPEN_WARD),");
    expect(OPEN_UNITS[0].id).toBe("W4");
  });
});
