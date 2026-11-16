import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Insights from "./insights/Insights";
import type { OpenViews } from "./open-hospital";
import { ER_TAG, HIGH_TAG, ICU_USE, OCCUPANCY, openOps } from "./open-ops";
import type { OpenBed, OpenWard } from "./open-view";
import { UNITS } from "./sim/hospital/params";
import { RUN_UNITS } from "./sim/hospital/units";

const beds = (unit: string, n: number, risks: Partial<Record<NonNullable<OpenBed["risk"]>, number>> = {}): OpenWard => {
  const list: OpenBed[] = [];
  for (const [risk, count] of Object.entries(risks)) for (let i = 0; i < count; i += 1) list.push({ bed: `${unit}-${list.length + 1}`, state: "ranked", rank: list.length + 1, risk: risk as OpenBed["risk"] });
  while (list.length < n) list.push({ bed: `${unit}-${list.length + 1}`, state: "not_ranked", rank: null, risk: null });
  return { ward: unit, synthetic: true, can_control: false, sim: null, beds: list };
};
const cap = (id: string) => UNITS.find((u) => u.id === id)!.beds.value;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("hospital operations from the open views", () => {
  // MED3A 30 beds: 26 = 87% (above 85), SURG5A 24 beds: 22 = 92% (90 or more), ICU 10: 7 = 70% (high tier), ER 10 bays: 14.
  const views: OpenViews = {
    W4: beds("W4", 10, { high: 1, medium: 2, low: 7 }),
    MED3A: beds("MED3A", 26, { high: 2, medium: 1 }),
    SURG5A: beds("SURG5A", 22),
    ICU: beds("ICU", 7, { high: 5 }),
    ER: beds("ER", 14, { high: 3 }),
  };
  const ops = openOps(RUN_UNITS, views);
  const row = (id: string) => ops.units.find((u) => u.id === id)!;

  it("counts beds in use against this page's bed table, top floor first, and says when a unit has not answered", () => {
    expect(ops.units.map((u) => u.id)).toEqual(["SURG5A", "W4", "MED3A", "ICU", "MED3B", "ER"]);
    expect([row("MED3A").inUse, row("MED3A").beds, row("MED3A").pct]).toEqual([26, cap("MED3A"), 87]);
    expect([row("MED3B").inUse, row("MED3B").pct, row("MED3B").flag, row("MED3B").high]).toEqual([null, null, null, null]);
    // The house total: inpatient units that answered. Not the emergency room, not the unit with no answer.
    expect([ops.inUse, ops.beds]).toEqual([10 + 26 + 22 + 7, cap("W4") + cap("MED3A") + cap("SURG5A") + cap("ICU")]);
    expect(ops.pct).toBe(Math.round((100 * 65) / ops.beds));
  });

  it("reads each kind of unit against its own line: ward, intensive care, emergency room", () => {
    expect([row("W4").pct, row("W4").flag]).toEqual([50, null]);
    expect(row("MED3A").flag).toBe("above 85%");
    expect(row("SURG5A").flag).toBe("90% or more");
    expect([row("ICU").pct, row("ICU").flag]).toEqual([70, "high tier"]);
    expect(row("ER").flag).toBe("over its bays");
    expect(openOps(RUN_UNITS, { ER: beds("ER", cap("ER")), ICU: beds("ICU", 5), MED3A: beds("MED3A", 25) }).units.map((u) => u.flag).filter(Boolean)).toEqual([]); // 100% of bays, 50% and 83%: nothing passed
    expect(openOps(RUN_UNITS, { ICU: beds("ICU", 6) }).units.find((u) => u.id === "ICU")!.flag).toBe("moderate tier");
    expect(openOps(RUN_UNITS, { ICU: beds("ICU", 9) }).units.find((u) => u.id === "ICU")!.flag).toBe("critical tier");
    expect([OCCUPANCY.amberAbove, OCCUPANCY.redFrom, ICU_USE.moderateFrom, ICU_USE.highFrom, ICU_USE.criticalFrom]).toEqual([85, 90, 60, 70, 85]);
  });

  it("counts NEWS2 bands only where the unit is ranked: never in intensive care or the emergency room", () => {
    expect([row("W4").high, row("W4").medium]).toEqual([1, 2]);
    expect([row("MED3A").high, row("MED3A").medium]).toEqual([2, 1]);
    expect([row("ICU").high, row("ER").high, row("ER").medium]).toEqual([null, null, null]);
  });

  it("lists the issues, each with the kind of source it is read against, and never calls a study a rule", () => {
    expect(ops.issues).toEqual([
      `Surgery 5A: 92% of beds in use, 90% or more (${OCCUPANCY.tag})`,
      `Medicine 3A: 87% of beds in use, above 85% (${OCCUPANCY.tag})`,
      `Intensive Care: 70% of beds in use, high tier (${ICU_USE.tag})`,
      `Emergency Room: 14 patients for 10 bays (${ER_TAG})`,
      `NEWS2 7 or more outside intensive care: Ward W4 1, Medicine 3A 2 (${HIGH_TAG})`,
    ]);
    expect(OCCUPANCY.tag).toContain("a simulation study, not a rule");
    expect(ICU_USE.tag).toContain("source not confirmed");
    expect(openOps(RUN_UNITS, { W4: beds("W4", 3, { low: 3 }) }).issues).toEqual([]);
  });

  it("the panel prints those counts, the sources, and what the server does not send", () => {
    const page = (o?: ReturnType<typeof openOps>) => renderToStaticMarkup(<Insights mode="viewer" summary={null} patients={[]} label={(m) => `${m}`} ops={o} />);
    const html = page(ops);
    const t = text(html);
    expect(t).toContain("3F Medicine 3A 26 30 87% (above 85%) 2 1");
    expect(t).toContain("2F Intensive Care 7 10 70% (high tier) not scored not scored");
    expect(t).toContain("1F Medicine 3B no answer yet 30 none not scored not scored");
    expect(t).toContain(`Inpatient beds in use: 65 of ${ops.beds}, ${ops.pct}%`);
    expect([...html.matchAll(/<ul aria-label="Issues now">(.*?)<\/ul>/gs)][0][1].match(/<li>/g)).toHaveLength(5);
    expect(t).toContain("Bagust 1999 (BMJ), a simulation study, not a rule");
    expect(t).toContain("DOH 2021 COVID-19 tiers, source not confirmed");
    expect(t).toContain("1 nurse to 12 patients (DOH guideline, source not confirmed)");
    expect(t).toContain("California Title 22 (a law of one US state)");
    for (const word of ["Nurses on duty", "patients boarding", "waiting for an intensive care bed", "outside their own department", "Transfers and deaths"]) expect(t).toContain(word);
    expect(t).toContain("Not served: the server runs the whole hospital, but sends this page no totals per unit and hour."); // the hourly charts are still not served
    expect(text(page(openOps(RUN_UNITS, { W4: beds("W4", 3, { low: 3 }) })))).toContain("Issues now None in what the server sends.");
    // Without the counts (a ward-only server, or no unit list yet) the section is as it was.
    expect(page()).not.toContain("Operations now");
  });

  it("the page gives the panel the open views only, and only while it watches a hospital", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    expect(app).toContain("const ops = VIEW_API && hosp && units.length > 0 ? openOps(units, views) : undefined;");
    expect(app.match(/openOps\(/g)).toHaveLength(1);
    // A watcher gets the sign-in line and this panel, and nothing else of the Analytics page: no patient, no summary.
    const at = app.indexOf("{watch ? (");
    const watcher = app.slice(at, app.indexOf(") : (", at));
    expect(watcher).toContain("<Operations ops={ops} />");
    expect(watcher).not.toMatch(/<Insights|patients=|summary=|world\./);
    const panel = readFileSync("src/insights/operations.tsx", "utf8");
    expect(panel).not.toMatch(/^import /m); // it draws what it is given: no engine, no patient type, no fetch
    const src = readFileSync("src/open-ops.ts", "utf8");
    expect(src.match(/^import .*$/gm)).toEqual(['import type { OpenViews } from "./open-hospital";', 'import { UNITS } from "./sim/hospital/params";', 'import type { RunUnit } from "./sim/hospital/units";']); // no engine, no fetch
    expect(src).not.toMatch(/fetch\(|step\(|Math\.random/);
  });
});
