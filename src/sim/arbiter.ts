// The escalation arbiter: the only component allowed to change displayed priority.
// Ported from BioSentry rules 1 and 5. Tier B, Tier C and notes hooks are not part of this demo.

import type { InputName, InputProblem, News2Result, News2Score, Risk } from "./news2";

export const LEVEL: Record<Risk, number> = { low: 0, low_medium: 1, medium: 2, high: 3 };

const NURSE_ENTRY: [InputName, string, string][] = [
  ["systolic_bp", "Systolic BP", "Record a blood pressure"],
  ["consciousness", "Level of consciousness", "Record ACVPU"],
  ["supplemental_o2", "Supplemental oxygen", "Record whether the patient is on oxygen"],
  ["spo2_scale", "SpO2 scale", "Record the SpO2 scale (a clinician's decision)"],
];
const DEVICE: [InputName, string][] = [
  ["respiratory_rate", "Respiratory rate"],
  ["spo2", "SpO2"],
  ["heart_rate", "Heart rate"],
  ["temperature", "Temperature"],
];
const DEVICE_INSTRUCTION = "Check the patch is applied and the signal is verified";
const NO_DEVICE_INSTRUCTION = "Apply the patch and verify the signal";

export interface Ranked {
  kind: "ranked";
  patientId: string;
  news2: News2Score;
  escalated: boolean;
  reasons: string[];
}

export interface NotRanked {
  kind: "not_ranked";
  patientId: string;
  reason: string;
  instruction: string;
}

export type Decision = Ranked | NotRanked;

function notRankedText(problems: InputProblem[]): [string, string] {
  const find = (name: InputName) => problems.find((p) => p.input === name);
  const deviceMissing = DEVICE.filter(([key]) => find(key));
  const parts: string[] = [];
  const steps: string[] = [];
  if (deviceMissing.length === DEVICE.length) {
    parts.push("No device data");
    steps.push(NO_DEVICE_INSTRUCTION);
  } else if (deviceMissing.length > 0) {
    for (const [key, label] of deviceMissing) parts.push(`${label} ${find(key)!.problem}`);
    steps.push(DEVICE_INSTRUCTION);
  }
  for (const [key, label, instruction] of NURSE_ENTRY) {
    const hit = find(key);
    if (hit) {
      parts.push(`${label} ${hit.problem}`);
      steps.push(hit.problem === "missing" ? instruction : `Re-enter ${label.toLowerCase()}`);
    }
  }
  return [parts.join(", "), [...new Set(steps)].join("; ")];
}

export function arbitrate(patientId: string, tierA: News2Result): Decision {
  if (tierA.kind === "abstained") {
    const [reason, instruction] = notRankedText(tierA.problems);
    return { kind: "not_ranked", patientId, reason, instruction };
  }
  const reasons: string[] = [];
  const escalated = tierA.risk !== "low";
  if (escalated) {
    if (tierA.risk === "medium" || tierA.risk === "high") reasons.push(tierA.totalReason);
    if (tierA.triggerReason !== null) reasons.push(tierA.triggerReason);
  }
  return { kind: "ranked", patientId, news2: tierA, escalated, reasons };
}

/** Order a ward: trigger level, then NEWS2 total, then patient id (deterministic tie-break). */
export function rankWard(decisions: Decision[]): { ranked: Ranked[]; notRanked: NotRanked[] } {
  const ranked = decisions
    .filter((d): d is Ranked => d.kind === "ranked")
    .sort(
      (a, b) =>
        LEVEL[b.news2.risk] - LEVEL[a.news2.risk] ||
        b.news2.total - a.news2.total ||
        a.patientId.localeCompare(b.patientId),
    );
  const notRanked = decisions
    .filter((d): d is NotRanked => d.kind === "not_ranked")
    .sort((a, b) => a.patientId.localeCompare(b.patientId));
  return { ranked, notRanked };
}
