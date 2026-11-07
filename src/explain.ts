// Stands in for the planned alert explainer agent: plain words from the NEWS2 breakdown.
// A fixed template, not an AI agent. It does not rank and it changes nothing.

import type { ParameterScore } from "./sim/news2";
import type { Patient } from "./sim/sim";

function phrase(r: ParameterScore): string {
  const v = Number(r.value);
  switch (r.parameter) {
    case "respiratory_rate":
      return v > 20 ? `breathing is fast (${r.value}/min)` : `breathing is slow (${r.value}/min)`;
    case "spo2":
      return r.band.includes("on oxygen")
        ? `oxygen saturation is above target for scale 2 (${r.value}%)`
        : `oxygen saturation is low (${r.value}%)`;
    case "supplemental_o2":
      return "the patient is on supplemental oxygen";
    case "systolic_bp":
      return v >= 220 ? `systolic blood pressure is very high (${r.value})` : `systolic blood pressure is low (${r.value})`;
    case "heart_rate":
      return v > 90 ? `heart rate is fast (${r.value}/min)` : `heart rate is slow (${r.value}/min)`;
    case "consciousness":
      return "the patient is newly confused or less responsive";
    case "temperature":
      return v > 38 ? `temperature is high (${r.value} °C)` : `temperature is low (${r.value} °C)`;
    default:
      return r.parameter;
  }
}

const list = (parts: string[]) =>
  parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

// Responses as NEWS2 (RCP 2017) and the Kitchen page state them.
const RESPONSE = {
  high: "NEWS2 7 or more: urgent review by the medical team, at least registrar level.",
  medium: "NEWS2 5 or 6: the nurse informs the medical team now.",
  low_medium: "One parameter scores 3: urgent review by the ward team.",
  low: "NEWS2 1 to 4: ward-based response by the registered nurse.",
};

export function explain(p: Patient): string {
  const d = p.decision;
  if (d.kind === "not_ranked") return `Not on the ranked list: ${d.reason}. ${d.instruction}.`;
  const parts = d.news2.parameters.filter((r) => r.score > 0).map(phrase);
  const sentence = list(parts);
  const why =
    parts.length > 0
      ? `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`
      : "Every observation is in the normal range.";
  const response = d.news2.total === 0 ? "NEWS2 0: routine monitoring." : RESPONSE[d.news2.risk];
  return `Rank ${p.rank}. ${why} ${response}`;
}
