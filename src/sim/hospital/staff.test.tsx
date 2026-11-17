import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SIGN_IN } from "../../sign-in-list";
import { STAFF } from "../sim";
import { UNITS } from "./params";
import { assigned, UNIT_STAFF, unitPeople } from "./staff";

const OTHER = ["ER", "ICU", "MED3A", "MED3B", "SURG5A"];

describe("the staff of each unit outside W4", () => {
  it("every unit has one charge nurse, two staff nurses and one physician, with the API's ids, each once", () => {
    expect(Object.keys(UNIT_STAFF).sort()).toEqual([...OTHER].sort());
    expect(UNITS.filter((u) => u.id !== "W4" && u.id !== "MORGUE").map((u) => u.id).sort()).toEqual([...OTHER].sort());
    const ids = OTHER.flatMap((u) => unitPeople(u).map((p) => p[0]));
    expect(ids).toEqual([
      "cn-er", "rn-pangilinan", "rn-guevarra", "md-sarmiento",
      "cn-icu", "rn-abad", "rn-lacson", "md-ocampo",
      "cn-med3a", "rn-pascual", "rn-domingo", "md-hizon",
      "cn-med3b", "rn-salazar", "rn-tolentino", "md-evangelista",
      "cn-surg5a", "rn-ilagan", "rn-cabrera", "md-estrada",
    ]);
    expect(new Set(ids).size).toBe(20);
    for (const id of ids) expect(STAFF.map((m) => m[0])).not.toContain(id); // W4's five are not reused
    for (const u of OTHER) expect(unitPeople(u).map((p) => p[2])).toEqual(["Charge nurse", "Staff nurse", "Staff nurse", "Attending"]);
    expect(unitPeople("ER")[3][1]).toBe("Dr. Sarmiento");
    expect(unitPeople("W4")).toEqual([]);
  });

  it("a patient is on one of the unit's two staff nurses, in turn, and on its physician; never on the charge nurse", () => {
    for (const u of OTHER) {
      const [a, b] = UNIT_STAFF[u].nurses;
      expect([0, 1, 2, 3, 40, 41].map((n) => assigned(u, n).rn)).toEqual([a[0], b[0], a[0], b[0], a[0], b[0]]);
      expect(assigned(u, 7).md).toBe(UNIT_STAFF[u].md[0]);
      expect(assigned(u, 7).rn).not.toBe(UNIT_STAFF[u].charge[0]);
    }
    expect(assigned("NEW9", 3)).toEqual({ rn: "cn-new9", md: null }); // a unit with no named staff keeps what it had
  });

  it("W4 is untouched: its staff table and its patients' lists are the ward's own", () => {
    expect(STAFF.map((m) => m[0])).toEqual(["rn-delacruz", "rn-reyes", "rn-manalo", "md-santos", "md-aquino"]);
    const publish = readFileSync("src/sim/hospital/publish.ts", "utf8");
    expect(publish).toContain('if (pv.unit === "W4") { stays[pv.id] = { id: null, unit: "W4", visit: pv.visit, reads: pv.reads, k }; continue; }'); // W4's people are never given a list here
    expect(publish.indexOf('if (pv.unit === "W4")')).toBeLessThan(publish.indexOf("assigned(pv.unit, pv.n)"));
  });

  it("the sign-in list shows each person under their floor and unit: W4 first, then from the top floor down", () => {
    expect(SIGN_IN.map((g) => g.label)).toEqual(["4F Ward W4", "5F Surgery 5A", "3F Medicine 3A", "2F Intensive Care", "1F Medicine 3B", "GF Emergency Room"]);
    expect(SIGN_IN[0].people).toEqual(STAFF.map(([id, name, title]) => [id, name, title]));
    expect(SIGN_IN[5].people).toEqual([["cn-er", "Dizon", "Charge nurse"], ["rn-pangilinan", "Pangilinan", "Staff nurse"], ["rn-guevarra", "Guevarra", "Staff nurse"], ["md-sarmiento", "Dr. Sarmiento", "Attending"]]);
    expect(SIGN_IN.flatMap((g) => g.people)).toHaveLength(25);
    const app = readFileSync("src/App.tsx", "utf8");
    expect(app).toContain("<optgroup key={g.label} label={g.label}>");
    expect(app).toContain("<option value={ADMIN_ID}>Hospital admin</option>");
    // The staff card of a simulated figure says the role and the unit.
    expect(readFileSync("src/panels.tsx", "utf8")).toContain('<p className="mono">{m.title} · Ward W4</p>');
  });
});
