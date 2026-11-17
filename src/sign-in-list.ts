// The sign-in list: each unit's people under its floor and name. A static list: the API has no public staff route.
// W4's five are the ward's own staff; the others are the named staff of each unit (src/sim/hospital/staff.ts). A person
// with no passphrase on the server cannot sign in: the form then says "Sign-in failed", as for a wrong passphrase.
import { UNITS } from "./sim/hospital/params";
import { unitPeople } from "./sim/hospital/staff";
import { STAFF } from "./sim/sim";

const floorWord = (floor: number) => (floor === 0 ? "GF" : `${floor}F`);

/** W4 first, then from the top floor down. Each person: id, name, title. */
export const SIGN_IN: { label: string; people: [id: string, name: string, title: string][] }[] = [...UNITS]
  .filter((u) => u.id === "W4" || unitPeople(u.id).length > 0)
  .sort((a, b) => Number(b.id === "W4") - Number(a.id === "W4") || b.floor - a.floor)
  .map((u) => ({ label: `${floorWord(u.floor)} ${u.name}`, people: u.id === "W4" ? STAFF.map(([id, name, title]): [string, string, string] => [id, name, title]) : unitPeople(u.id) }));
