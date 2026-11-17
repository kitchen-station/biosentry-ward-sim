// The public page when the server runs a whole hospital: the open answers of every unit, drawn as the building.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { floorSummary } from "./building";
import { FLOORS } from "./render/floors";
import { slabTag } from "./render/scene";
import { bedSel, drawnUnits, inOrder, openBedOf, openHospital, openRisk, OPEN_FIRST_MS, OPEN_RETRY_MS, startUnitsList, startUnitsPoll, type OpenViews } from "./open-hospital";
import { ago, OpenHospitalPanel, type CardState } from "./open-panels";
import { fetchOpenCard, fetchOpenUnits, OPEN_POLL_MS, parseOpenCard, parseOpenUnits, type OpenBed, type OpenCard, type OpenWard } from "./open-view";

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
// The server's list (GET /open-view), W4 first as the runner sends it.
const LIST = {
  synthetic: true,
  units: [
    { id: "W4", name: "Ward W4", floor: 4, kind: "ranked" }, { id: "ER", name: "Emergency Room", floor: 0, kind: "shown" },
    { id: "ICU", name: "Intensive Care", floor: 2, kind: "unranked" }, { id: "MED3A", name: "Medicine 3A", floor: 3, kind: "ranked" },
    { id: "MED3B", name: "Medicine 3B", floor: 1, kind: "ranked" }, { id: "SURG5A", name: "Surgery 5A", floor: 5, kind: "ranked" },
  ],
};
const UNITS = drawnUnits(parseOpenUnits(JSON.stringify(LIST))!);
const NOW = Date.parse("2026-09-03T09:00:00.000Z");
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const CARD = {
  unit: "MED3A", floor: 3, kind: "ranked", bed: "MED3A-30", synthetic: true, state: "ranked", score: 6, risk: "medium", reason: null, trend: "rising",
  vitals: {
    heart_rate: { value: 96, observed_at: at(1), source: "device" }, respiratory_rate: { value: 21, observed_at: at(0), source: "device" },
    spo2: { value: 94, observed_at: at(2), source: "device" }, temperature: { value: 37.84, observed_at: at(12), source: "device" },
    blood_pressure: { systolic: 104, diastolic: 62, observed_at: at(95), source: "nurse" },
  },
};
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
    const risk = openRisk(VIEWS, UNITS);
    const floors = floorSummary(h, risk);
    const cells = (unit: string) => floors.flatMap((f) => f.units).find((u) => u.id === unit)!.beds.filter((c) => c !== null);
    expect(cells("MED3A").map((c) => c.risk)).toEqual(["medium", "low", null]);
    expect(cells("ER").map((c) => c.risk)).toEqual([null, null]);
    expect(cells("ICU").map((c) => c.risk)).toEqual([undefined]); // never scored: no NEWS2 colour at all
    expect(cells("MED3B")).toEqual([]); // no answer for it: drawn empty
    expect(new Set(h.people.map((p) => p.n)).size).toBe(h.people.length); // one number per bed
  });

  it("puts nothing of the placeholder person on the drawing: a bed's tag has no initials, and a sign counts beds in use only", () => {
    const floors = floorSummary(h, openRisk(VIEWS, UNITS));
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
    expect(openBedOf(VIEWS, bedSel("MED3A", "MED3A-7"), UNITS)).toMatchObject({ unit: { id: "MED3A" }, bed: { bed: "MED3A-7" } });
    expect(openBedOf(VIEWS, "open-bed:4A", UNITS)).toMatchObject({ unit: { id: "W4" }, bed: { bed: "4A" } });
    expect(openBedOf(VIEWS, "bed:2B", UNITS)).toMatchObject({ unit: { id: "W4" }, bed: { bed: "2B" } });
    for (const other of [null, "h:1", "hbed:MED3A:9", "unit:ER", "entrance", "open-3"]) expect(openBedOf(VIEWS, other, UNITS)).toBeNull();
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
  const panel = (view: number | null, selected: string | null, data: CardState["data"] = "loading") =>
    renderToStaticMarkup(<OpenHospitalPanel units={UNITS} views={VIEWS} view={view} selected={selected} speed={10} card={selected ? { sel: selected, data } : null} nowMs={NOW} onView={noop} onSelect={noop} />);
  const sel = bedSel("MED3A", "MED3A-30");
  const card = parseOpenCard(JSON.stringify(CARD), "MED3A", "MED3A-30")!;

  it("first says what this is in one sentence, with the speed in words, and lists the floors from the top", () => {
    const html = panel(null, null);
    expect(text(html)).toContain("This is a simulated hospital, running at 10x: 1 minute here is 10 hospital minutes. Every patient is synthetic. Pick a floor, then a bed. Read-only. Sign in to control.");
    const rows = [...html.matchAll(/<li><button[^>]*>([^<]+)<\/button><\/li>/g)].map((m) => m[1]);
    expect(rows).toEqual([
      "5F Surgery 5A · no answer yet",
      "4F Ward W4 · 2 beds in use",
      "3F Medicine 3A · 3 beds in use",
      "2F Intensive Care · 1 bed in use",
      "1F Medicine 3B · no answer yet",
      "GF Emergency Room · 2 beds in use",
    ]);
    expect(html).toContain('<b aria-current="page">Hospital</b>');
    expect(html).toContain("Escape goes up one level.");
  });

  it("on a floor lists the unit's beds, ranked first, under a breadcrumb back to the hospital", () => {
    const html = panel(3, null);
    expect(html).toMatch(/<nav class="crumbs" aria-label="Where you are"><button[^>]*>Hospital<\/button> › <b aria-current="page">3F Medicine 3A<\/b><\/nav>/);
    expect([...html.matchAll(/<\/i> ([^<]+)<\/button>/g)].map((m) => m[1])).toEqual(["Bed MED3A-30 · Rank 1 · Medium risk", "Bed MED3A-12 · Rank 2 · Low risk", "Bed MED3A-7 · Not ranked"]);
    expect(text(panel(0, null))).toContain("Shown, not ranked: NEWS2 is a ward score.");
    expect(text(panel(2, null))).toContain("Not scored: NEWS2 is a ward score, not an intensive care score.");
    expect(text(panel(1, null))).toContain("No answer from the server yet.");
  });

  it("a ranked bed's card shows what the bed route returned: score, band, trend and five vitals each with source and age", () => {
    const html = panel(3, sel, card);
    expect(html).toMatch(/<button[^>]*>Hospital<\/button> › <button[^>]*>3F Medicine 3A<\/button> › <b aria-current="page">Bed MED3A-30<\/b>/);
    expect(text(html)).toContain("Bed MED3A-30 Medium risk Synthetic data Medicine 3A, 3F. Rank 1 in this unit. NEWS2 6: Medium risk. Trend: rising.");
    expect([...html.matchAll(/<li>(.*?)<\/li>/g)].map((m) => text(m[1]).trim())).toEqual([
      "Heart rate: 96 /min · device · 1 min ago",
      "Resp. rate: 21 /min · device · just now",
      "SpO2: 94 % · device · 2 min ago",
      "Temperature: 37.8 °C · device · 12 min ago",
      "Blood pressure: 104/62 mmHg · nurse · 1 h 35 min ago",
    ]);
    expect(html).not.toMatch(/Sign in to see this patient/);
  });

  it("a bed that is not ranked shows its state and the reason only; an empty bed and a failed request say so; every card says synthetic", () => {
    const er = parseOpenCard(JSON.stringify({ unit: "ER", floor: 0, kind: "shown", bed: "ER-5", synthetic: true, state: "not_ranked", score: null, risk: null, vitals: null, trend: null, reason: "Emergency Room is shown, not ranked: NEWS2 is a ward score." }), "ER", "ER-5")!;
    const erHtml = panel(0, bedSel("ER", "ER-5"), er);
    expect(text(erHtml)).toContain("Bed ER-5 Not ranked Synthetic data Emergency Room, GF. Not ranked. Emergency Room is shown, not ranked: NEWS2 is a ward score. Back to Emergency Room");
    expect(erHtml).not.toMatch(/<li>|NEWS2 \d|Sign in to see/);
    expect(text(panel(3, sel, "empty"))).toContain("This bed is empty now.");
    expect(text(panel(3, sel, "failed"))).toContain("No answer from the server. Pick the bed again to ask once more.");
    expect(text(panel(3, sel, "loading"))).toContain("Loading this bed");
    for (const data of [card, er, "empty", "failed", "loading"] as const) expect(text(panel(3, sel, data))).toContain("Synthetic data");
    // a card for another pick is not shown under this one
    expect(text(renderToStaticMarkup(<OpenHospitalPanel units={UNITS} views={VIEWS} view={3} selected={sel} speed={10} card={{ sel: "h:1", data: card }} nowMs={NOW} onView={noop} onSelect={noop} />))).toContain("Loading this bed");
    // a pick wins over the open floor: the card is the bed's own unit
    expect(panel(5, "open-bed:4A")).toContain("4F Ward W4");
  });

  it("says how long ago in ward time", () => {
    expect([0, 59_000, 60_000, 59 * 60_000, 95 * 60_000, 50 * 3600_000].map((d) => ago(NOW - d, NOW))).toEqual(["just now", "just now", "1 min ago", "59 min ago", "1 h 35 min ago", "2 days ago"]);
    expect(ago(NOW + 5000, NOW)).toBe("just now"); // a time ahead of the ward's clock
  });

  it("never says demo, and names no single ward as the whole page", () => {
    const all = [panel(null, null), panel(3, null), panel(4, null), panel(3, sel, card), panel(3, sel, "empty")].join(" ");
    expect(all).not.toMatch(/demo/i);
    expect(all).not.toMatch(/Watching W4|This is ward W4/);
    for (const file of ["src/open-panels.tsx", "src/open-hospital.ts"]) expect(readFileSync(file, "utf8")).not.toMatch(/demo/i);
  });
});

describe("the run's units, from the server", () => {
  it("takes the server's list strictly, keeps only units the building draws, and uses its own floor when the server knows none", () => {
    expect(UNITS.map((u) => u.id)).toEqual(["W4", "ER", "ICU", "MED3A", "MED3B", "SURG5A"]);
    const odd = parseOpenUnits(JSON.stringify({ synthetic: true, units: [{ id: "W4", name: "Ward W4", floor: null, kind: "ranked" }, { id: "NICU", name: "Newborn care", floor: 6, kind: "unranked" }, { id: "MORGUE", name: "Morgue", floor: 0, kind: "unranked" }] }))!;
    expect(drawnUnits(odd)).toEqual([{ id: "W4", name: "Ward W4", floor: 4, kind: "ranked" }]);
    const bad = (change: object) => parseOpenUnits(JSON.stringify({ ...LIST, ...change }));
    expect(bad({ synthetic: false })).toBeNull();
    expect(bad({ units: [] })).toBeNull();
    expect(bad({ units: [...LIST.units, LIST.units[0]] })).toBeNull(); // an id twice
    expect(bad({ units: [{ ...LIST.units[0], kind: "secret" }] })).toBeNull();
    expect(bad({ units: [{ ...LIST.units[0], id: "<b>" }] })).toBeNull();
    expect(bad({ units: [{ ...LIST.units[0], name: "" }] })).toBeNull();
    expect(bad({ units: [{ ...LIST.units[0], floor: 1.5 }] })).toBeNull();
    expect(parseOpenUnits(JSON.stringify({ ...LIST, units: [{ ...LIST.units[0], patients: 9, clinicians: ["x"] }] }))).toEqual([LIST.units[0]]); // extra keys are never kept
  });

  it("asks for the list at once and then once a minute; a 404 says there is no list; a server that is down says nothing", async () => {
    vi.useFakeTimers();
    let status = 200;
    const urls: string[] = [];
    const f = vi.fn(async (url: string, init: RequestInit) => {
      urls.push(url);
      expect(init).toMatchObject({ credentials: "omit", cache: "no-store", redirect: "error" });
      expect("headers" in init).toBe(false);
      return status === 200 ? new Response(JSON.stringify(LIST), { status }) : new Response(null, { status });
    });
    const got: (string[] | null)[] = [];
    const stop = startUnitsList({ fetch: f as unknown as typeof fetch, base: "http://api", onUnits: (u) => got.push(u && u.map((x) => x.id)) });
    await vi.advanceTimersByTimeAsync(10);
    expect(urls).toEqual(["http://api/open-view"]);
    expect(got).toEqual([["W4", "ER", "ICU", "MED3A", "MED3B", "SURG5A"]]);
    status = 404;
    await vi.advanceTimersByTimeAsync(OPEN_RETRY_MS);
    expect(got.at(-1)).toBeNull();
    status = 503;
    await vi.advanceTimersByTimeAsync(OPEN_RETRY_MS);
    expect(got).toHaveLength(2); // down: the last list stays
    expect(urls).toHaveLength(3);
    stop();
    await vi.advanceTimersByTimeAsync(5 * OPEN_RETRY_MS);
    expect(urls).toHaveLength(3);
    expect((await fetchOpenUnits({ fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch, base: "http://api" })).ok).toBe(false);
  });
});

describe("one bed's card, from the server", () => {
  const parse = (change: object, unit = "MED3A", bed = "MED3A-30") => parseOpenCard(JSON.stringify({ ...CARD, ...change }), unit, bed);

  it("reads a ranked card whole, and refuses one that is not for the bed asked or is missing a part", () => {
    const c = parse({}) as Extract<OpenCard, { state: "ranked" }>;
    expect([c.score, c.risk, c.trend, c.vitals.heart_rate.value, c.vitals.blood_pressure.systolic, c.vitals.blood_pressure.source]).toEqual([6, "medium", "rising", 96, 104, "nurse"]);
    expect(c.vitals.temperature.atMs).toBe(NOW - 12 * 60_000);
    expect(parse({}, "MED3A", "MED3A-31")).toBeNull();
    expect(parse({}, "MED3B")).toBeNull();
    expect(parse({ synthetic: false })).toBeNull();
    expect(parse({ score: 21 })).toBeNull();
    expect(parse({ risk: "severe" })).toBeNull();
    expect(parse({ trend: "up" })).toBeNull();
    expect(parse({ vitals: { ...CARD.vitals, spo2: undefined } })).toBeNull();
    expect(parse({ vitals: { ...CARD.vitals, heart_rate: { ...CARD.vitals.heart_rate, source: "someone" } } })).toBeNull();
    expect(parse({ vitals: { ...CARD.vitals, heart_rate: { ...CARD.vitals.heart_rate, observed_at: "yesterday" } } })).toBeNull();
    expect(parse({ vitals: { ...CARD.vitals, blood_pressure: { ...CARD.vitals.blood_pressure, systolic: "104" } } })).toBeNull();
  });

  it("keeps nothing the contract does not list, and a bed that is not ranked may hold a reason and nothing else", () => {
    const c = parse({ name: "A Person", age: 70, sex: "F", context: "x", patient_id: "p-1", notes: ["n"] })!;
    expect(JSON.stringify(c)).not.toMatch(/A Person|patient_id|context|notes|"age"|"sex"/);
    const nr = { state: "not_ranked", score: null, risk: null, vitals: null, trend: null, reason: "Not enough usable readings." };
    expect(parse(nr)).toEqual({ unit: "MED3A", bed: "MED3A-30", floor: 3, kind: "ranked", state: "not_ranked", reason: "Not enough usable readings." });
    expect(parse({ ...nr, reason: null })).toMatchObject({ reason: null });
    expect(parse({ ...nr, vitals: CARD.vitals })).toBeNull(); // vitals on a bed that is not ranked: refused whole
    expect(parse({ ...nr, score: 3 })).toBeNull();
    expect(parse({ ...nr, reason: "x".repeat(301) })).toBeNull();
  });

  it("asks the bed's own open route once, with no credential, and tells an empty bed from a server that is down", async () => {
    const urls: string[] = [];
    const answer = (status: number, body?: object) => (async (url: string, init: RequestInit) => {
      urls.push(url);
      expect(init).toMatchObject({ credentials: "omit", cache: "no-store", redirect: "error" });
      expect("headers" in init).toBe(false);
      return new Response(body ? JSON.stringify(body) : null, { status });
    }) as unknown as typeof fetch;
    const ask = (f: typeof fetch) => fetchOpenCard({ fetch: f, base: "http://api", unit: "MED3A", bed: "MED3A-30" });
    expect(await ask(answer(200, CARD))).toMatchObject({ ok: true, body: { score: 6 } });
    expect(await ask(answer(404))).toEqual({ ok: false, kind: "gone" });
    expect(await ask(answer(503))).toEqual({ ok: false, kind: "down" });
    expect(await ask(answer(200, { ...CARD, bed: "MED3A-31" }))).toEqual({ ok: false, kind: "gone" });
    expect(urls).toEqual(Array(4).fill("http://api/wards/MED3A/open-view/beds/MED3A-30")); // one request each: no retry
    await fetchOpenCard({ fetch: answer(404), base: "http://api", unit: "ER", bed: "ER 5.a" });
    expect(urls.at(-1)).toBe("http://api/wards/ER/open-view/beds/ER%205.a"); // the label is one path part, encoded
  });
});

describe("the page's wiring", () => {
  const app = readFileSync("src/App.tsx", "utf8");

  it("draws the building only when another unit has answered, and takes clicks only on floors and beds", () => {
    expect(app).toContain("const hosp = HOSPITAL || (!!VIEW_API && Object.keys(others).some((id) => id !== OPEN_WARD));");
    expect(app).toContain("serverHospital: (!!VIEW_API && hosp),");
    expect(app).toContain("sim.hospital = openHospital(othersRef.current, minuteOf(sim));"); // signed in: the rest of the building beside the live ward
    expect(app).toContain("viewRef.current !== OPEN_FLOOR) return go(\"empty\");"); // signed in: only W4's own beds open
    expect(app).toContain('const id = watch && hit && !hit.startsWith("floor:") && !openBedOf(views, hit, units) ? "" : hit;');
  });

  it("reads the unit list from the server, and with no list asks no other unit", () => {
    expect(app).toContain("return startUnitsList({ fetch: window.fetch.bind(window), base: VIEW_API!, onUnits: (list) => { setUnits(list ?? []); setUnitsAsked(true); } });");
    expect(app).toContain('if (unitIds === "") return;');
    expect(app).not.toMatch(/RUN_UNITS|OPEN_UNITS/); // the runner's own list is no longer the page's
  });

  it("asks for a card once per pick: in an effect of the pick alone, never on a timer, and a new pick ends the old request", () => {
    expect(app.match(/fetchOpenCard\(/g)).toHaveLength(1);
    const i = app.indexOf("const cardFor = watch && hosp && !admin ? selected : null;"); // a signed-in admin reads the signed-in routes instead
    const effect = app.slice(i, app.indexOf("}, [cardFor]);", i));
    expect(i).toBeGreaterThan(-1);
    expect(effect).toContain("fetchOpenCard(");
    expect(effect).toContain("return () => ctl.abort();");
    expect(effect).not.toMatch(/setInterval|setTimeout|while \(|retry/i);
  });
});
