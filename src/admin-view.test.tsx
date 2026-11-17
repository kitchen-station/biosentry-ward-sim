// The hospital admin's view: the signed-in routes, read only. No server: bodies as the API's schemas give them.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AdminPanel, adminFloor, type Load } from "./admin-panels";
import { ADMIN_REFRESH_MS, fetchAdminPatient, fetchAdminRows, fetchAdminStays, fetchAdminUnits, parseAdminPatient, parseAdminRows, parseAdminStays, parseAdminUnits, type AdminPatient, type AdminRows, type AdminStay, type AdminUnit, type AdminVitals } from "./admin-view";
import { noDrawing } from "./open-view";
import { createSim } from "./sim/sim";
import { createSyntheticSource, FIXTURE_SEED } from "./sim/source";

vi.stubEnv("VITE_VIEW_API_URL", "http://api");
const { TopBar } = await import("./panels");

const NOW = Date.parse("2026-09-03T09:00:00.000Z");
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const m = (value: unknown, minAgo: number, source = "device") => ({ data: { present: true, value }, provenance: { source, tier: "A", observed_at: at(minAgo), computed_at: null, model_id: null, synthetic: true, quality: "ok" } });
const absent = (minAgo: number) => ({ data: { present: false, reason: "No usable reading" }, provenance: { source: "device", tier: "A", observed_at: at(minAgo), computed_at: null, model_id: null, synthetic: true, quality: "missing" } });
const VITALS = { heart_rate: m(96, 1), respiratory_rate: m(21, 1), spo2: m(94, 2), temperature: m(37.84, 12), blood_pressure: m({ systolic: 104, diastolic: 62 }, 95, "nurse"), consciousness: m("A", 3, "nurse"), supplemental_o2: m(false, 3, "nurse"), spo2_scale: m(1, 3, "nurse") };
const who = (id: string, name: string, bed: string) => ({ id, name, age: 67, sex: "F", bed, admitting_context: "Chest pain", synthetic: true, unit: "MED3A", floor: 3, person: null });
const ranked = (id: string, name: string, bed: string, rank: number, score: number) => ({ ...who(id, name, bed), rank, score, trend: "rising", mechanism: "m", supporting: "s", vitals: VITALS, vital_trends: {}, labs: {}, sort_tier: "A", tier_status: [], escalation_reasons: [], signal_quality: 97, last_update_s: 20, models: {} });
const ROWS = {
  ward: "MED3A", name: "Medicine 3A", floor: 3, kind: "ranked", clinician: "admin", shift: "day", receiving_data: true, sort_tier: "A", tier_status: [],
  ranked: [ranked("p-2", "Cruz, Ben", "MED3A-12", 2, 4), ranked("p-1", "Abad, Ana", "MED3A-30", 1, 9)],
  abstained: [{ ...who("p-3", "Dizon, Cora", "MED3A-7"), reason: "Systolic BP missing", instruction: "Record a blood pressure", news2_risk: null, last_seen: { ...VITALS, blood_pressure: absent(200) } }],
  now: new Date(NOW).toISOString(),
};
const ER_ROWS = { ...ROWS, ward: "ER", kind: "shown", ranked: [], abstained: [{ ...who("e-1", "Flores, Dino", "ER-5"), reason: "Emergency Room is shown, not ranked: NEWS2 is a ward score.", instruction: "x", news2_risk: "medium" }] };
const UNITS_BODY = [{ id: "W4", name: "Ward W4", floor: 4, kind: "ranked", patients: 11 }, { id: "ER", name: "Emergency Room", floor: 0, kind: "shown", patients: 9 }, { id: "MED3A", name: "Medicine 3A", floor: null, kind: "ranked", patients: 3 }];
const STAYS_BODY = [
  { id: "s-1", name: "Reyes, Marta", bed: "MED3A-7", admitted_at: at(600), left_at: at(40), outcome: "discharged", synthetic: true, to_unit: null },
  { id: "s-2", name: "Santos, Paolo", bed: "MED3A-9", admitted_at: at(900), left_at: at(10), outcome: "transferred", synthetic: true, to_unit: "ICU" },
  { id: "s-3", name: "Still Here", bed: "MED3A-1", admitted_at: at(60), left_at: null, outcome: null, synthetic: true, to_unit: null },
];
const units = parseAdminUnits(JSON.stringify(UNITS_BODY))!;
const rows = parseAdminRows(JSON.stringify(ROWS), "MED3A")!;
const stays = parseAdminStays(JSON.stringify(STAYS_BODY))!;
const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("what the admin's routes return, as the page keeps it", () => {
  it("units: id, name, floor, kind and the count; a floor the server does not know falls back to the page's own", () => {
    expect(units).toEqual([{ id: "W4", name: "Ward W4", floor: 4, kind: "ranked", patients: 11 }, { id: "ER", name: "Emergency Room", floor: 0, kind: "shown", patients: 9 }, { id: "MED3A", name: "Medicine 3A", floor: null, kind: "ranked", patients: 3 }]);
    expect(units.map(adminFloor)).toEqual([4, 0, 3]);
    expect(parseAdminUnits(JSON.stringify([{ ...UNITS_BODY[0], kind: "secret" }]))).toBeNull();
    expect(parseAdminUnits(JSON.stringify([{ ...UNITS_BODY[0], patients: -1 }]))).toBeNull();
    expect(parseAdminUnits("{}")).toBeNull();
  });

  it("rows: the ranked in rank order with score, trend and vitals, then those not ranked with their reason; nothing is filled in", () => {
    expect(rows.rows.map((r) => [r.name, r.ranked?.rank ?? null, r.ranked?.score ?? null])).toEqual([["Abad, Ana", 1, 9], ["Cruz, Ben", 2, 4], ["Dizon, Cora", null, null]]);
    expect(rows.nowMs).toBe(NOW);
    expect((rows.rows[0].vitals as AdminVitals).heart_rate).toEqual({ value: 96, atMs: NOW - 60_000, source: "device" });
    expect((rows.rows[0].vitals as AdminVitals).blood_pressure).toEqual({ systolic: 104, diastolic: 62, atMs: NOW - 95 * 60_000, source: "nurse" });
    // A value the server says is absent stays absent: null, with the time and source it gave.
    expect((rows.rows[2].vitals as AdminVitals).blood_pressure).toEqual({ systolic: null, diastolic: null, atMs: NOW - 200 * 60_000, source: "device" });
    expect(rows.rows[2].reason).toBe("Systolic BP missing");
    // The ER today: rows with no vitals at all. They are null, not zeros.
    const er = parseAdminRows(JSON.stringify(ER_ROWS), "ER")!;
    expect([er.rows[0].vitals, er.rows[0].risk, er.rows[0].ranked]).toEqual([null, "medium", null]);
    // Out of shape: refused whole, so a list never shows with a hole in it.
    expect(parseAdminRows(JSON.stringify(ROWS), "ER")).toBeNull(); // not the unit asked for
    expect(parseAdminRows(JSON.stringify({ ...ROWS, ranked: [{ ...ROWS.ranked[0], score: 99 }] }), "MED3A")).toBeNull();
    expect(parseAdminRows(JSON.stringify({ ...ROWS, now: "soon" }), "MED3A")).toBeNull();
  });

  it("tells vitals that were not served from vitals it could not read", () => {
    const withSeen = (last_seen: unknown) => parseAdminRows(JSON.stringify({ ...ER_ROWS, abstained: [{ ...ER_ROWS.abstained[0], last_seen }] }), "ER")!.rows[0].vitals;
    expect(withSeen(undefined)).toBeNull(); // no field: not served
    expect(withSeen(null)).toBeNull(); // null: not served
    expect(withSeen({ ...VITALS, heart_rate: "96" })).toBe("unreadable"); // something is there, out of shape: none of it is shown
    expect(withSeen("soon")).toBe("unreadable");
    expect(withSeen(VITALS)).toMatchObject({ heart_rate: { value: 96 } }); // served for the ER: read as any other row's
  });

  it("reads an ER or intensive care row's `vitals`, which the API serves for those units, before `last_seen`", () => {
    const row = (extra: object) => parseAdminRows(JSON.stringify({ ...ER_ROWS, abstained: [{ ...ER_ROWS.abstained[0], ...extra }] }), "ER")!.rows[0];
    // The merged API shape: `vitals` and `vital_trends` set, `last_seen` null, still no score and no rank.
    const er = row({ vitals: VITALS, vital_trends: { heart_rate: [96], respiratory_rate: [21], spo2: [94], temperature: [37.8] }, last_seen: null });
    expect(er.vitals).toMatchObject({ heart_rate: { value: 96, source: "device" }, blood_pressure: { systolic: 104, diastolic: 62, source: "nurse" } });
    expect([er.ranked, er.reason]).toEqual([null, "Emergency Room is shown, not ranked: NEWS2 is a ward score."]);
    expect(row({ vitals: null, last_seen: VITALS }).vitals).toMatchObject({ spo2: { value: 94 } }); // a ward's not-ranked row
    expect(row({ vitals: null, last_seen: null }).vitals).toBeNull();
    expect(row({ vitals: { heart_rate: 1 }, last_seen: VITALS }).vitals).toBe("unreadable"); // what was sent first is what is judged
  });

  it("stays and a patient's page", () => {
    expect(stays.map((s) => [s.name, s.outcome, s.toUnit, s.outMs])).toEqual([["Reyes, Marta", "discharged", null, NOW - 40 * 60_000], ["Santos, Paolo", "transferred", "ICU", NOW - 10 * 60_000], ["Still Here", null, null, null]]);
    expect(parseAdminStays(JSON.stringify([{ ...STAYS_BODY[0], outcome: "vanished" }]))).toBeNull();
    const p = parseAdminPatient(JSON.stringify({ ...ROWS.ranked[1], vital_history: {}, tier_breakdown: {}, now: ROWS.now }), "p-1")!;
    expect([p.row.name, p.row.ranked, p.unit, p.nowMs]).toEqual(["Abad, Ana", { rank: 1, score: 9, trend: "rising" }, "MED3A", NOW]);
    const nr = parseAdminPatient(JSON.stringify({ ...ER_ROWS.abstained[0], vital_history: {}, now: ROWS.now }), "e-1")!;
    expect([nr.row.ranked, nr.row.vitals, nr.row.reason]).toEqual([null, null, "Emergency Room is shown, not ranked: NEWS2 is a ward score."]);
    expect(parseAdminPatient(JSON.stringify({ ...ROWS.ranked[1], now: ROWS.now }), "p-9")).toBeNull(); // not the patient asked for
  });
});

describe("the four signed-in requests", () => {
  it("send the token to the signed-in routes only, read nothing else, and tell signed out, refused, gone and down apart", async () => {
    const calls: { url: string; auth: string | null; method: string }[] = [];
    const answer = (status: number, body?: unknown) => (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>)?.Authorization ?? null, method: init.method ?? "GET" });
      expect(init).toMatchObject({ cache: "no-store", redirect: "error" });
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    const req = (f: typeof fetch) => ({ fetch: f, base: "http://api", token: "tok" });
    expect(await fetchAdminUnits(req(answer(200, UNITS_BODY)))).toMatchObject({ ok: true });
    expect(await fetchAdminRows(req(answer(200, ROWS)), "MED3A")).toMatchObject({ ok: true });
    expect(await fetchAdminStays(req(answer(200, STAYS_BODY)), "MED3A")).toMatchObject({ ok: true });
    expect(await fetchAdminPatient(req(answer(200, { ...ROWS.ranked[1], now: ROWS.now })), "p 1/x")).toEqual({ ok: false, kind: "gone" }); // the body is for p-1, not for the id asked
    expect(calls.map((c) => c.url)).toEqual(["http://api/wards", "http://api/wards/MED3A/rows", "http://api/wards/MED3A/stays", "http://api/patients/p%201%2Fx"]);
    expect(calls.every((c) => c.auth === "Bearer tok" && c.method === "GET")).toBe(true); // reads only
    expect(await fetchAdminUnits(req(answer(401)))).toEqual({ ok: false, kind: "signed_out" });
    expect(await fetchAdminUnits(req(answer(403)))).toEqual({ ok: false, kind: "denied" });
    expect(await fetchAdminUnits(req(answer(404)))).toEqual({ ok: false, kind: "gone" });
    expect(await fetchAdminUnits(req(answer(503)))).toEqual({ ok: false, kind: "down" });
    expect(await fetchAdminUnits(req((async () => { throw new Error("offline"); }) as unknown as typeof fetch))).toEqual({ ok: false, kind: "down" });
    expect(ADMIN_REFRESH_MS).toBeGreaterThanOrEqual(2000); // no route faster than every 2 s
  });
});

describe("the admin's panel", () => {
  const panel = (p: { units?: Load<AdminUnit[]>; view?: number | null; rows?: Load<AdminRows>; stays?: Load<AdminStay[]>; picked?: AdminRows["rows"][number] | null; patient?: Load<AdminPatient> }) =>
    renderToStaticMarkup(<AdminPanel units={p.units ?? units} view={p.view ?? null} rows={p.rows ?? null} stays={p.stays ?? null} picked={p.picked ?? null} patient={p.patient ?? null} onView={noop} onPatient={noop} />);

  it("first says who you are and that it is read-only, and lists every unit with its patients, top floor first", () => {
    const html = panel({});
    expect(text(html)).toContain("Hospital admin You are signed in as the hospital admin. Every unit and every patient is shown. Read-only: nothing here changes the hospital. Every patient is synthetic.");
    expect([...html.matchAll(/<li><button[^>]*>([^<]+)<\/button><\/li>/g)].map((x) => x[1])).toEqual(["4F Ward W4 · 11 patients", "3F Medicine 3A · 3 patients", "GF Emergency Room · 9 patients"]);
    expect(text(panel({ units: "loading" }))).toContain("Loading");
    expect(text(panel({ units: "denied" }))).toContain("The server refused this for your sign-in.");
  });

  it("a unit shows each patient's name, bed, NEWS2, rank, trend and vitals, and the unit's history, newest first", () => {
    const html = panel({ view: 3, rows, stays });
    const lines = [...html.matchAll(/<li><button[^>]*>(.*?)<\/button><\/li>/g)].map((x) => text(x[1]).trim());
    expect(lines).toEqual([
      "Abad, Ana · Bed MED3A-30 · NEWS2 9 · Rank 1 · rising HR 96 · RR 21 · SpO2 94 · T 37.8 · BP 104/62",
      "Cruz, Ben · Bed MED3A-12 · NEWS2 4 · Rank 2 · rising HR 96 · RR 21 · SpO2 94 · T 37.8 · BP 104/62",
      "Dizon, Cora · Bed MED3A-7 · Not ranked HR 96 · RR 21 · SpO2 94 · T 37.8 · BP none",
    ]);
    expect(text(html)).toContain("Unit history Santos, Paolo, bed MED3A-9: moved to ICU, 10 min ago Reyes, Marta, bed MED3A-7: discharged, 40 min ago");
    expect(html).not.toContain("Still Here"); // a stay that has not ended is not history
    expect(html).toMatch(/<nav class="crumbs" aria-label="Where you are"><button[^>]*>Hospital<\/button> › <b aria-current="page">3F Medicine 3A<\/b>/);
  });

  it("the ER's rows say their vitals are not served yet, and show none", () => {
    const er = parseAdminRows(JSON.stringify(ER_ROWS), "ER")!;
    const html = panel({ view: 0, rows: er, stays: [] });
    expect(text(html)).toContain("Shown, not ranked: NEWS2 is a ward score.");
    expect(text(html)).toContain("Flores, Dino · Bed ER-5 · Not ranked · Medium risk Vitals not served yet.");
    expect(html).not.toMatch(/HR \d|SpO2 \d|BP \d/);
    expect(text(html)).toContain("No stay has ended here yet.");
  });

  it("a row whose vitals could not be read says so, and an ER row with served vitals shows them with no score or rank", () => {
    const bad = parseAdminRows(JSON.stringify({ ...ER_ROWS, abstained: [{ ...ER_ROWS.abstained[0], last_seen: { ...VITALS, spo2: 5 } }] }), "ER")!;
    expect(text(panel({ view: 0, rows: bad, stays: [] }))).toContain("Not ranked · Medium risk Could not read the vitals in this answer.");
    const p = parseAdminPatient(JSON.stringify({ ...ER_ROWS.abstained[0], last_seen: "x", vital_history: {}, now: ROWS.now }), "e-1")!;
    expect(text(panel({ view: 0, rows: bad, stays: [], picked: bad.rows[0], patient: p }))).toContain("Could not read the vitals in this answer.");
    const served = parseAdminRows(JSON.stringify({ ...ER_ROWS, abstained: [{ ...ER_ROWS.abstained[0], last_seen: VITALS }] }), "ER")!;
    const line = text(panel({ view: 0, rows: served, stays: [] }));
    expect(line).toContain("Flores, Dino · Bed ER-5 · Not ranked · Medium risk HR 96 · RR 21 · SpO2 94 · T 37.8 · BP 104/62");
    expect(line).not.toMatch(/Flores, Dino[^|]*(Rank \d|NEWS2 \d)/);
  });

  it("a patient's page: the name, the score, the vitals with source and age; a page with no vitals says so", () => {
    const p = parseAdminPatient(JSON.stringify({ ...ROWS.ranked[1], vital_history: {}, tier_breakdown: {}, now: ROWS.now }), "p-1")!;
    const html = panel({ view: 3, rows, stays, picked: rows.rows[0], patient: p });
    expect(text(html)).toContain("Abad, Ana NEWS2 9 Synthetic data Bed MED3A-30. Age 67. F. Chest pain Rank 1 in this unit. Trend: rising.");
    expect([...html.matchAll(/<li>(.*?)<\/li>/g)].map((x) => text(x[1]).trim())).toEqual([
      "Heart rate: 96 /min · device · 1 min ago", "Resp. rate: 21 /min · device · 1 min ago", "SpO2: 94 % · device · 2 min ago", "Temperature: 37.8 °C · device · 12 min ago", "Blood pressure: 104/62 mmHg · nurse · 1 h 35 min ago",
    ]);
    expect(text(panel({ view: 3, rows, stays, picked: rows.rows[0], patient: "loading" }))).toContain("Abad, Ana, bed MED3A-30. Loading");
    const er = parseAdminRows(JSON.stringify(ER_ROWS), "ER")!;
    const nr = parseAdminPatient(JSON.stringify({ ...ER_ROWS.abstained[0], vital_history: {}, now: ROWS.now }), "e-1")!;
    expect(text(panel({ view: 0, rows: er, stays: [], picked: er.rows[0], patient: nr }))).toContain("Not ranked Synthetic data Bed ER-5. Age 67. F. Chest pain Emergency Room is shown, not ranked: NEWS2 is a ward score. NEWS2 band: Medium risk. Vitals not served yet.");
  });

  it("has no control: its only buttons go to a unit, a patient or back", () => {
    const p = parseAdminPatient(JSON.stringify({ ...ROWS.ranked[1], vital_history: {}, tier_breakdown: {}, now: ROWS.now }), "p-1")!;
    const all = [panel({}), panel({ view: 3, rows, stays }), panel({ view: 3, rows, stays, picked: rows.rows[0], patient: p })].join(" ");
    const buttons = [...all.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((x) => text(x[1]).trim());
    expect(buttons.every((b) => /^(Hospital|Back to |\dF |GF |3F Medicine 3A|.+ · Bed )/.test(b))).toBe(true);
    expect(all).not.toMatch(/Reset|Pause|Start deterioration|Acknowledge|Record|Admit|<input|<select|<form/);
    expect(readFileSync("src/admin-view.ts", "utf8")).not.toMatch(/method:|"POST"|"PUT"|"DELETE"|localStorage|sessionStorage|document\.cookie/); // reads only, nothing stored
    expect(readFileSync("src/admin-panels.tsx", "utf8")).not.toMatch(/fetch\(|localStorage|sessionStorage/);
  });
});

describe("the page for an admin", () => {
  const s = createSim(createSyntheticSource(FIXTURE_SEED, true));
  const src = createSyntheticSource(FIXTURE_SEED, true);
  const bar = (props: object) => renderToStaticMarkup(createElement(TopBar, { s, src, notice: null, ...props } as never));
  const app = readFileSync("src/App.tsx", "utf8");

  it("the top bar says Hospital admin and read-only, with Sign out and no control", () => {
    const html = bar({ admin: true, serverHospital: true, onSignOut: noop });
    expect(text(html)).toContain("Hospital admin, read-only");
    // The kit icon sits before the word; the gear and its dialog (Settings) are the page's own, not a control of the run.
    const topBar = html.slice(0, html.indexOf("<dialog"));
    expect([...topBar.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((x) => x[1].replace(/<i [^>]*><\/i>/g, ""))).toEqual(["Sign out", ""]);
    expect(bar({})).not.toContain("Hospital admin");
  });

  it("the sign-in offers Hospital admin, takes the role from the API's answer, and keeps the passphrase out of state and storage", () => {
    expect(app).toContain("<option value={ADMIN_ID}>Hospital admin</option>");
    expect(app).toContain('if (typeof answer?.token === "string") return onToken(answer.token, typeof answer.role === "string" ? answer.role : null);');
    expect(app).toContain('const admin = token !== null && role === "admin";'); // the role is the server's word, never the name picked
    expect(app).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    expect(app.match(/form\.get\("passphrase"\)/g)).toHaveLength(1);
  });

  it("with no open view an admin gets no drawing and is told why; the page never draws its own engine's patients beside the server's", () => {
    expect(noDrawing(true, false, "down")).toBe("Server not reachable. No drawing is shown.");
    expect(noDrawing(true, false, null)).toBe("Server not reachable. No drawing is shown.");
    expect(noDrawing(true, false, "gone")).toBe("No drawing: the server's public view is off. The lists still come from the server.");
    expect(noDrawing(true, true, "down")).toBeNull(); // there is a drawing
    expect(noDrawing(false, false, "down")).toBeNull(); // not an admin: the sign-in form, as before
    expect(app).toContain("stageNote={noDrawing(admin, !!watch, probe)}");
    expect(app).toContain('{stageNote && <p className="stagenote" role="status">{stageNote}</p>}');
    // A viewer build starts from an empty world and never steps one: there is no local patient to draw.
    expect(app).toContain("if (VIEW_API) return { s: createReader()({ shared: null, patients: [] }), src: VIEW_SOURCE };");
    expect(app).toContain("if (!VIEW_API && !skippingRef.current) {");
  });

  it("an admin keeps the public drawing, never reads a unit's live view, gets no control, and a clinician's page is as before", () => {
    expect(app).toContain("const shown = screen(VIEW_API, admin ? null : token, gate, first);");
    expect(app).toContain("if (!VIEW_API || watch || admin) return; // an admin does not read a unit's live view");
    expect(app).toContain("onSignIn: (admin ? undefined : watch?.onLeave),");
    expect(app).toContain("{admin ? (\n            <AdminPanel");
    expect(app).toContain("const cardFor = watch && hosp && !admin ? selected : null;");
    // The admin's requests: three timers at the refresh pace, and the patient's page once per pick.
    expect(app.match(/setInterval\(ask, ADMIN_REFRESH_MS\)/g)).toHaveLength(2);
    const patient = app.slice(app.indexOf("const aPickId = aPick?.id ?? null;"), app.indexOf("}, [admin, aPickId]);"));
    expect(patient).toContain("fetchAdminPatient(");
    expect(patient).not.toMatch(/setInterval|setTimeout/);
    expect(app.match(/sendCommand\(/g)).toHaveLength(1); // the clinician's one command path, which an admin never reaches (no live view, so no control)
  });
});
