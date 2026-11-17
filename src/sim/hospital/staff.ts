// The named staff of each unit outside ward W4: one charge nurse, two staff nurses and one physician (the owner's decision,
// 17 Nov 2026). The ids and surnames are the API's own (its migration 0019). Every one is synthetic: no real person.
// W4's five are the ward's own (STAFF in sim.ts) and are not listed here. Nothing here changes care: it only says whose
// list a published patient is on.
type Person = readonly [id: string, surname: string];
export interface UnitStaff { charge: Person; nurses: readonly [Person, Person]; md: Person }

export const UNIT_STAFF: Record<string, UnitStaff> = {
  ER: { charge: ["cn-er", "Dizon"], nurses: [["rn-pangilinan", "Pangilinan"], ["rn-guevarra", "Guevarra"]], md: ["md-sarmiento", "Sarmiento"] },
  ICU: { charge: ["cn-icu", "Macaraeg"], nurses: [["rn-abad", "Abad"], ["rn-lacson", "Lacson"]], md: ["md-ocampo", "Ocampo"] },
  MED3A: { charge: ["cn-med3a", "Navarro"], nurses: [["rn-pascual", "Pascual"], ["rn-domingo", "Domingo"]], md: ["md-hizon", "Hizon"] },
  MED3B: { charge: ["cn-med3b", "Gonzales"], nurses: [["rn-salazar", "Salazar"], ["rn-tolentino", "Tolentino"]], md: ["md-evangelista", "Evangelista"] },
  SURG5A: { charge: ["cn-surg5a", "Valdez"], nurses: [["rn-ilagan", "Ilagan"], ["rn-cabrera", "Cabrera"]], md: ["md-estrada", "Estrada"] },
};

/**
 * Whose lists a person published outside W4 is on: one of the unit's two staff nurses and its physician. The charge nurse
 * is not named here: the API puts every patient of a unit on that unit's charge nurse's list by itself.
 * A unit with no named staff keeps what it had: its charge nurse and no physician.
 */
// shortcut: the two nurses take turns by the person's own number, not by the length of each nurse's open list; count open stays per nurse if the two lists drift apart.
export function assigned(unit: string, n: number): { rn: string; md: string | null } {
  const u = UNIT_STAFF[unit];
  return u ? { rn: u.nurses[n % 2][0], md: u.md[0] } : { rn: `cn-${unit.toLowerCase()}`, md: null };
}

/** Each unit's people as the sign-in list names them: id, name, title. Charge nurse first, as on W4's own list the order is the ward's. */
export function unitPeople(unit: string): [id: string, name: string, title: string][] {
  const u = UNIT_STAFF[unit];
  if (!u) return [];
  return [[u.charge[0], u.charge[1], "Charge nurse"], ...u.nurses.map((p): [string, string, string] => [p[0], p[1], "Staff nurse"]), [u.md[0], `Dr. ${u.md[1]}`, "Attending"]];
}
