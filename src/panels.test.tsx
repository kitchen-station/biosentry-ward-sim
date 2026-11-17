import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createSim } from "./sim/sim";
import { createSyntheticSource, FIXTURE_SEED, SYNTHETIC_RULES, type VitalsSource } from "./sim/source";

// VIEW_API is read when panels loads, so the viewer build is set first.
vi.stubEnv("VITE_VIEW_API_URL", "http://api");
const { Inspector, RunBar, SidePanel, TopBar } = await import("./panels");

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

  it("offers Skip ahead only to a clinician who may control the run: four choices, each asked of the server", () => {
    expect(renderToStaticMarkup(<TopBar s={s} src={VIEW_SOURCE} notice={null} />)).not.toContain("Skip ahead"); // a viewer
    expect(renderToStaticMarkup(<TopBar s={s} src={VIEW_SOURCE} notice={null} admin />)).not.toContain("Skip ahead"); // the hospital admin
    expect(renderToStaticMarkup(<TopBar s={s} src={VIEW_SOURCE} notice={null} onReset={noop} onSpeed={noop} />)).not.toContain("Skip ahead");
    expect(renderToStaticMarkup(<RunBar s={s} src={VIEW_SOURCE} notice={null} onReset={noop} onSpeed={noop} />)).not.toContain("Skip ahead");
    const html = renderToStaticMarkup(<RunBar s={s} src={VIEW_SOURCE} notice={null} onReset={noop} onSpeed={noop} onSkipAhead={noop} />);
    expect(html).toMatch(/<details class="skipmenu"><summary class="hw-button hw-button--sm hw-button--icon dock__item" aria-label="Skip ahead" data-hw-tooltip="[^"]+"><i class="hw-icon fa-solid fa-forward" aria-hidden="true"><\/i><\/summary><div role="group" aria-label="Skip ahead">/);
    expect([...html.matchAll(/<button[^>]*>(\+[^<]+)<\/button>/g)].map((x) => x[1])).toEqual(["+1 h", "+6 h", "+12 h", "+1 day"]);
    // The page only asks: the one sender exists when the server said can_control, and nothing is stepped here.
    const app = readFileSync("src/App.tsx", "utf8");
    expect(app).toContain('onSkipAhead: (send && ((minutes) => void send({ kind: "skip", patient_id: null, speed: null, minutes }))),');
    expect(app).toMatch(/const send = canControl\n\s+\? async \(body: CommandBody\) => \{/);
    expect(app).toContain("setCanControl(live.can_control === true);");
  });

  it("shows the runner's speed as read-only text in viewer, and the clock with seconds", () => {
    const html = renderToStaticMarkup(<TopBar s={s} src={VIEW_SOURCE} notice={null} />);
    expect(html).toContain('title="1 minute here is 60 ward minutes"');
    expect(html.replace(/<[^>]+>/g, "")).toContain("Running 60x");
    expect(html.replace(/<[^>]+>/g, "")).toContain("3 Sept 2026, 15:00:00 Manila");
  });

  it("shows the runner's speed, and offers pause, 1x, 10x, 60x and Reset, once control is on", () => {
    expect(renderToStaticMarkup(<TopBar s={s} src={VIEW_SOURCE} notice={null} onReset={noop} onSpeed={noop} />)).not.toContain("Pause"); // the controls live in the dock, not the app bar
    const html = renderToStaticMarkup(<RunBar s={s} src={VIEW_SOURCE} notice={null} onReset={noop} onSpeed={noop} />);
    for (const label of ["1x", "10x", "60x"]) expect(html).toContain(`>${label}</button>`);
    for (const label of ["Pause", "Reset the run"]) expect(html).toContain(`aria-label="${label}"`);
    expect(html).toMatch(/hw-button--accent" aria-label="Speed 60x" aria-pressed="true"/); // createSim starts at 60x: the published speed, not a local guess
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

describe("the side panel's fold", () => {
  const render = () => renderToStaticMarkup(<SidePanel><p>body</p></SidePanel>);
  const stored = (v: string | null) => vi.stubGlobal("localStorage", { getItem: () => v, setItem: () => {} });

  it("is open by default, with a button that says so", () => {
    stored(null);
    const html = render();
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("<p>body</p>");
  });

  it("starts shut when the browser remembers it, and the button says so", () => {
    stored("closed");
    const html = render();
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("side shut");
    expect(html).not.toContain("<p>body</p>");
  });

  it("is open when storage throws", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(render()).toContain("<p>body</p>");
    vi.unstubAllGlobals();
  });
});
