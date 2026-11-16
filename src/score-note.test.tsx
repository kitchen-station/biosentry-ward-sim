// A unit's `score_note`: the run's own line on how to read that unit's NEWS2 (the emergency room's, once the runner sends it).
// The page prints it exactly as served, as text, and writes no note of its own.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminPanel } from "./admin-panels";
import { parseAdminUnits } from "./admin-view";
import { drawnUnits, type OpenViews } from "./open-hospital";
import { OpenHospitalPanel } from "./open-panels";
import { parseOpenUnits, scoreNote } from "./open-view";

const NOTE = "NEWS2 in the emergency room is an aid, read with triage. <b>Not</b> a ward rank.";
const list = (er: object) => JSON.stringify({ synthetic: true, units: [{ id: "W4", name: "Ward W4", floor: 4, kind: "ranked" }, { id: "ER", name: "Emergency", floor: 0, kind: "ranked", ...er }] });
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const noop = () => {};

describe("a unit's score note", () => {
  it("is one printable line of 1 to 300 characters, or nothing", () => {
    expect(scoreNote(NOTE)).toBe(NOTE);
    expect(scoreNote("x".repeat(300))).toHaveLength(300);
    for (const bad of ["", "x".repeat(301), "two\nlines", "tab\there", "bell\u0007", "c1\u0085", null, undefined, 7, ["a"], { a: 1 }]) expect(scoreNote(bad)).toBeNull();
  });

  it("the public unit list keeps it; a unit with none, or with one out of shape, is kept without it", () => {
    expect(parseOpenUnits(list({ score_note: NOTE }))![1]).toEqual({ id: "ER", name: "Emergency", floor: 0, kind: "ranked", note: NOTE });
    expect(parseOpenUnits(list({}))![1]).toEqual({ id: "ER", name: "Emergency", floor: 0, kind: "ranked" });
    expect(parseOpenUnits(list({ score_note: null }))![1]).toEqual({ id: "ER", name: "Emergency", floor: 0, kind: "ranked" });
    expect(parseOpenUnits(list({ score_note: "two\nlines" }))).toHaveLength(2); // the list still draws
    expect(parseOpenUnits(list({ score_note: "two\nlines" }))![1]).not.toHaveProperty("note");
    expect(drawnUnits(parseOpenUnits(list({ score_note: NOTE }))!).find((u) => u.id === "ER")!.note).toBe(NOTE);
    expect(drawnUnits(parseOpenUnits(list({}))!).find((u) => u.id === "ER")).not.toHaveProperty("note");
  });

  it("the public panel prints it under the unit's name, as text, and prints nothing in its place when there is none", () => {
    const views: OpenViews = { ER: { ward: "ER", synthetic: true, can_control: false, sim: null, beds: [{ bed: "ER-1", state: "ranked", rank: 1, risk: "medium" }] } };
    const panel = (er: object) => renderToStaticMarkup(<OpenHospitalPanel units={drawnUnits(parseOpenUnits(list(er))!)} views={views} view={0} selected={null} speed={10} card={null} nowMs={0} onView={noop} onSelect={noop} />);
    const html = panel({ score_note: NOTE });
    expect(html).toContain('<h2 class="ptitle">Emergency</h2><p class="tiny">NEWS2 in the emergency room is an aid, read with triage. &lt;b&gt;Not&lt;/b&gt; a ward rank.</p>');
    expect(html).not.toContain("<b>Not</b>"); // served text is never markup
    const none = panel({});
    expect(none).toContain('<h2 class="ptitle">Emergency</h2><ul class="beds"'); // no line of the page's own
    expect(text(none)).not.toMatch(/aid|triage/);
  });

  it("the Hospital admin's unit list keeps it and the unit view prints it", () => {
    const body = (er: object) => JSON.stringify([{ id: "ER", name: "Emergency", floor: 0, kind: "ranked", patients: 3, ...er }]);
    const units = parseAdminUnits(body({ score_note: NOTE }))!;
    expect(units[0].note).toBe(NOTE);
    expect(parseAdminUnits(body({}))![0]).toEqual({ id: "ER", name: "Emergency", floor: 0, kind: "ranked", patients: 3 });
    expect(parseAdminUnits(body({ score_note: 7 }))![0]).not.toHaveProperty("note");
    const panel = (u: typeof units) => renderToStaticMarkup(<AdminPanel units={u} view={0} rows="loading" stays="loading" picked={null} patient={null} onView={noop} onPatient={noop} />);
    expect(panel(units)).toContain('<h2 class="ptitle">Emergency</h2><p class="tiny">NEWS2 in the emergency room is an aid, read with triage. &lt;b&gt;Not&lt;/b&gt; a ward rank.</p>');
    expect(text(panel(parseAdminUnits(body({}))!))).not.toMatch(/aid|triage/);
  });
});
