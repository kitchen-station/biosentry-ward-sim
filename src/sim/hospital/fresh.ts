// A new hospital for the headless runner, at the runner's speed.
// Owner decision orch-h4: the server's default is the typical hospital. "typical" is the typical scenario at seed 101 with ward
// W4's 12 starting patients drawn from that seed. The 12 hand-written pitch patients stay a named scenario ("pitch"), as do
// the page's other named scenarios.
import { buildWorld, NAMED } from "../../scenarios";
import { setSpeed, type Sim, type Speed } from "../sim";
import type { VitalsSource } from "../source";

export const RUNNER_SEED = 101;
export const HOSPITAL_SCENARIOS: string[] = ["typical", ...NAMED.map((n) => n.id)];

export function freshHospital(speed: Speed, scenario = "typical"): { s: Sim; src: VitalsSource } {
  if (!HOSPITAL_SCENARIOS.includes(scenario)) throw new Error(`Unknown hospital scenario "${scenario}": use one of ${HOSPITAL_SCENARIOS.join(", ")}`);
  // A seed makes buildWorld draw W4's 12 from it; no seed keeps the named scenario's own patients.
  const { s, src } = scenario === "typical" ? buildWorld("pitch", RUNNER_SEED) : buildWorld(scenario, null);
  setSpeed(s, speed);
  return { s, src };
}
