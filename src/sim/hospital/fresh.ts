// A new hospital for the headless runner: the page's "Pitch ward" world (typical scenario, seed 101), at the runner's speed.
import { buildWorld } from "../../scenarios";
import { setSpeed, type Sim, type Speed } from "../sim";
import type { VitalsSource } from "../source";

export function freshHospital(speed: Speed): { s: Sim; src: VitalsSource } {
  const { s, src } = buildWorld("pitch", null);
  setSpeed(s, speed);
  return { s, src };
}
