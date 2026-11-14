// Plain words shared by the hospital panels and the Analytics page. A small module: no code, so the lazy chunk pulls in nothing heavy.
import type { UnitId } from "./sim/hospital/params";

/** The plan's labels, by unit. W4 is listed for the docs and the tests; the page keeps W4's own panels as they were. */
export const UNIT_LABEL: Partial<Record<UnitId, string>> = {
  W4: "Synthetic. Generator fitted to ICU data at ward-like baselines.",
  MED3A: "Synthetic. Same generator as W4.",
  MED3B: "Synthetic. Same generator as W4.",
  SURG5A: "Synthetic. Adult generator, not fitted to surgical patients.",
  ER: "Synthetic. Not ER data: ward generator.",
  ICU: "Synthetic. ICU vitals are not modelled: ward generator values.",
};
export const FIRST_DAY = "First day: everyone starts as a new admission, so scores run high.";
