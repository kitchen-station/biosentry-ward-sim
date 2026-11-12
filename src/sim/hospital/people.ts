// Person n: every draw it will ever need, made once at arrival from the stream `person:${n}`, always in this order and
// always the same number of draws, so the same seed gives the same people under every scenario.
import { GIVEN, INITIALS, LEGACY, SURNAMES } from "./names";
import { PARAMS, type Group, type Triage } from "./params";
import { exponential, lognormal, normal, stream, weightedPick } from "./rng";
import type { Course, PersonDraw } from "./types";

export const GROUPS: Group[] = ["cardiac", "stroke", "hypertensive", "respiratory", "infection", "trauma", "minor"];
export const TRIAGES: Triage[] = ["emergent", "urgent", "non_urgent"];
export const DAY_MIN = 1440;

// Wording only: the group decides everything that matters.
const PHRASES: Record<Group, string[]> = {
  cardiac: ["chest pain", "chest tightness with sweating", "palpitations", "shortness of breath on exertion"],
  stroke: ["sudden weakness on one side", "slurred speech", "facial droop"],
  hypertensive: ["severe headache with high blood pressure", "dizziness with high blood pressure", "blurred vision with high blood pressure"],
  respiratory: ["difficulty of breathing", "cough and fever", "wheezing"],
  infection: ["fever for three days", "vomiting and loose stools", "painful urination", "fever with rash"],
  trauma: ["motorcycle crash", "fall from a height", "stab wound", "fracture after a fall", "burn injury"],
  minor: ["cough and colds", "headache", "mild fever", "skin rash"],
};

const stayKind = (g: Group) => PARAMS.stay.kindOfGroup.value[g === "stroke" || g === "trauma" ? g : "others"] as "medicine" | "stroke" | "surgery";
const stayDays = (u: { medianDays: { value: number }; sigma: { value: number } }, r: () => number) =>
  Math.min(lognormal(r, u.medianDays.value, u.sigma.value), PARAMS.stay.capDays.value);

/** P(dies in the stay | admitted and alive), by group; the ICU-indicated cardiac share is the higher one. */
export function stayDeathP(group: Group, icuIndicated: boolean): number {
  const d = PARAMS.death.admitted;
  if (group === "cardiac") return (icuIndicated ? d.cardiacIcuIndicated : d.cardiac).value;
  if (group === "stroke") return d.stroke.value;
  if (group === "trauma") return d.trauma.value;
  if (group === "minor") return d.minor.value;
  return d.medicine.value;
}

/** Slice A3: three small integers a screen can draw: skin 0-3, hair 0-4 (0-2 under 60; 3 grey and 4 white from 60), shirt 0-5. Own stream, so no other draw moves. */
export function lookOf(seed: number, n: number, age: number): [number, number, number] {
  const r = stream(seed, `person:${n}:look`);
  const [skin, hair, shirt] = [Math.floor(r() * 4), r(), Math.floor(r() * 6)];
  return [skin, age >= 60 ? 3 + Math.floor(hair * 2) : Math.floor(hair * 3), shirt];
}

/** Visit 1 draws from `person:${n}`; a return (visit 2 and on) draws every visit number from `person:${n}:v${visit}`, but keeps the
 *  index visit's sex, name, age and group (the wording of the complaint is redrawn inside the group), so the same person comes back. */
export function drawPerson(seed: number, n: number, visit = 1): PersonDraw {
  const index = visit === 1 ? null : drawPerson(seed, n, 1);
  const r = stream(seed, visit === 1 ? `person:${n}` : `person:${n}:v${visit}`);
  const P = PARAMS.people;
  const drawnSex = r() < P.maleShare.value ? "M" : "F";
  const sex = index ? index.sex : drawnSex;
  const ageZ = normal(r, P.ageMean.value, P.ageSd.value);
  const cardiacAgeU = r();
  const [surname, given, initial] = [r(), r(), r()];
  const drawnGroup = GROUPS[weightedPick(r, GROUPS.map((g) => PARAMS.complaint[g].value))];
  const group = index ? index.group : drawnGroup;
  const phrases = PHRASES[group];
  const complaint = phrases[Math.floor(r() * phrases.length)];
  const triage = TRIAGES[weightedPick(r, TRIAGES.map((t) => PARAMS.triage[t].value))];
  const [admitU, icuU] = [r(), r()];
  const decisionMin = Math.max(1, Math.round(lognormal(r, PARAMS.decisionDelay.medianH[triage].value * 60, PARAMS.decisionDelay.sigma.value)));
  const S = PARAMS.stay;
  const kind = stayKind(group);
  const stayMin = Math.max(60, Math.round(stayDays(S[kind], r) * DAY_MIN));
  const icuStayMin = Math.max(60, Math.round(stayDays({ medianDays: PARAMS.icuStay.medianDays, sigma: PARAMS.icuStay.sigma }, r) * DAY_MIN));
  const [earlyU, hourU] = [r(), r()];
  const C = S.dischargeClock.value;
  const dischargeHour = earlyU < C.earlyShare ? C.earlyHours[0] + hourU * (C.earlyHours[1] - C.earlyHours[0]) : C.lateHours[0] + hourU * (C.lateHours[1] - C.lateHours[0]);
  const patience = Math.max(1, Math.round(exponential(r, PARAMS.patienceMeanH.value * 60)));
  // Pre-drawn fates (design section 2 row 14). An ER-phase death is fixed per person: crowding does not change it. A stay death
  // is timed from the minute of placement, so boarding delays it. A person transferred out, or who left without being seen,
  // leaves our record before any stay fate: their outcome is not observed here, not prevented.
  const [erU, erF, deathU, deathF] = [r(), r(), r(), r()];
  const [lo, hi] = P.cardiacAgeRange.value;
  const [alo, ahi] = P.ageRange.value;
  // shortcut: a return is within 30 days, so no whole year passes and it keeps the index age; upgrade if returns ever span years
  const age = index ? index.age : group === "cardiac" ? lo + Math.floor(cardiacAgeU * (hi - lo + 1)) : Math.min(ahi, Math.max(alo, Math.round(ageZ)));
  const admit = admitU < PARAMS.admitRate[group].value;
  const pool = PARAMS.returns.enabled.value ? { SURNAMES, GIVEN } : LEGACY;
  return {
    id: `h-${String(n).padStart(6, "0")}`, n,
    name: index ? index.name : `${pool.SURNAMES[Math.floor(surname * pool.SURNAMES.length)]}, ${pool.GIVEN[sex][Math.floor(given * pool.GIVEN[sex].length)]} ${INITIALS[Math.floor(initial * 26)]}.`,
    age, sex, group, complaint, triage, look: lookOf(seed, n, age),
    patienceMin: triage === "emergent" ? null : patience,
    admit, icuU, icuIndicated: admit && icuU < PARAMS.icuIndicated[group].value,
    decisionMin, stayMin, icuStayMin, dischargeHour,
    erDeathAfterMin: erU < PARAMS.death.erPhase[triage].value ? 1 + Math.floor(erF * PARAMS.death.erPhaseWindowH.value * 60) : null,
    deathU, deathF,
  };
}

/** Slice A2: person n's course for an admission decided at `decidedMin`, from its own stream `person:${n}:course` (three draws, in
 *  this order), so no draw of `person:${n}` moves and nobody else's fate shifts. Whether and when relative to the decision is the
 *  same under every scenario; where the person is at onset, and when the next round comes, are not. */
export function drawCourse(seed: number, n: number, group: Group, stayMin: number, decidedMin: number, visit = 1): Course {
  const r = stream(seed, visit === 1 ? `person:${n}:course` : `person:${n}:v${visit}:course`);
  const [detU, detF, excessU] = [r(), r(), r()];
  const R = PARAMS.course.ratePerDay;
  const rate = (group === "stroke" || group === "cardiac" || group === "trauma" || group === "minor" ? R[group] : R.medicine).value;
  const deteriorates = detU < 1 - Math.exp(-rate * stayMin / DAY_MIN);
  return { atMin: deteriorates ? decidedMin + Math.floor(detF * stayMin) : null, excessU, onsetMin: null, noticedMin: null, unnoticedMin: null, escalated: false, excess: false };
}
