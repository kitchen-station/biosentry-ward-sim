import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createSim } from "./sim/sim";
import { createSyntheticSource, FIXTURE_SEED, SYNTHETIC_RULES, type VitalsSource } from "./sim/source";

// VIEW_API is read when panels loads, so the viewer build is set first.
vi.stubEnv("VITE_VIEW_API_URL", "http://api");
const { Inspector, TopBar } = await import("./panels");

// The viewer's source, as App builds it: no inject, startAf or admit.
const VIEW_SOURCE: VitalsSource = { synthetic: true, rules: SYNTHETIC_RULES, seeds: () => [], read: () => null, cuff: () => null };
const src = createSyntheticSource(FIXTURE_SEED, true);
const s = createSim(src);
const noop = () => {};

describe("the top bar", () => {
  it("has no speed or reset buttons in viewer mode until the clinician may control the ward", () => {
    expect(renderToStaticMarkup(<TopBar s={s} src={VIEW_SOURCE} notice={null} />)).not.toContain("Pause");
    const bar = renderToStaticMarkup(<TopBar s={s} src={VIEW_SOURCE} notice={null} />);
    expect(bar).not.toContain("<nav");
    expect(bar).not.toContain("href=");
    expect(bar).not.toMatch(/Analytics|Developer/);
  });

  it("shows the runner's speed, and offers pause, 1x, 10x, 60x and Reset, once control is on", () => {
    const html = renderToStaticMarkup(<TopBar s={s} src={VIEW_SOURCE} notice={null} onReset={noop} onSpeed={noop} />);
    for (const label of ["Pause", "1x", "10x", "60x", "Reset"]) expect(html).toContain(`>${label}</button>`);
    expect(html).toMatch(/class="on" aria-pressed="true"[^>]*>60x</); // createSim starts at 60x: the published speed, not a local guess
  });
});

describe("a patient's buttons in viewer mode", () => {
  const patient = s.patients[0];
  const panel = (send?: () => void) => renderToStaticMarkup(<Inspector s={s} src={VIEW_SOURCE} selected={patient.id} onSelect={noop} onTimeline={noop} send={send} />);

  it("show none of the controls as before", () => {
    const html = panel();
    for (const label of ["Start deterioration", "Start AF", "Apply patch", "Detach patch"]) expect(html).not.toContain(label);
  });

  it("show the controls once control is on", () => {
    const html = panel(noop);
    for (const label of ["Start deterioration", "Start AF", "Detach patch"]) expect(html).toContain(label);
    expect(html).not.toContain("Apply patch"); // the patient already has a patch
  });
});
