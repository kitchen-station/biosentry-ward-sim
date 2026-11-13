import { readdirSync, readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Flip, FlipView, FLIP_GAP_MS, nextFlip } from "./flip";
import { createSim } from "./sim/sim";
import { createSyntheticSource, FIXTURE_SEED } from "./sim/source";

vi.stubEnv("VITE_VIEW_API_URL", "http://api");
const { TopBar } = await import("./panels");

describe("nextFlip", () => {
  it("the first value does not flip", () => {
    expect(nextFlip(null, "a", 0).n).toBe(0);
  });
  it("a change flips and keeps the old value", () => {
    const a = nextFlip(null, "a", 0);
    expect(nextFlip(a, "b", 1000)).toMatchObject({ n: 1, old: "a", value: "b" });
  });
  it("a change inside the gap swaps the text in place", () => {
    const b = nextFlip(nextFlip(null, "a", 0), "b", 1000);
    expect(nextFlip(b, "c", 1000 + FLIP_GAP_MS - 1)).toMatchObject({ n: 1, value: "c" });
    expect(nextFlip(b, "c", 1000 + FLIP_GAP_MS).n).toBe(2);
  });
  it("an equal value returns the same object", () => {
    const a = nextFlip(null, "a", 0);
    expect(nextFlip(a, "a", 5000)).toBe(a);
  });
});

describe("Flip", () => {
  it("renders the plain value on first render: no flip class, no ghost", () => {
    expect(renderToStaticMarkup(<Flip value={7} />)).toBe('<span class="flipbox"><span>7</span></span>');
  });
});

describe("the ghost", () => {
  const st = { value: "b", old: "a", n: 1, at: 0 };
  it("after a flip the old value is a hidden ghost beside the new one", () => {
    const html = renderToStaticMarkup(<FlipView st={st} />);
    expect(html).toContain('<span class="flip-old" aria-hidden="true">a</span>');
    expect(html).toContain('<span class="flip">b</span>');
  });
  it("is gone from the DOM once its animation has ended", () => {
    expect(renderToStaticMarkup(<FlipView st={st} done={1} />)).toBe('<span class="flipbox"><span class="flip">b</span></span>');
  });
});

describe("the top bar", () => {
  const src = createSyntheticSource(FIXTURE_SEED, true);
  const s = createSim(src);
  const modes = { standalone: { onReset: () => {}, onSpeed: () => {} }, viewer: {}, watching: { onSignIn: () => {} } };
  for (const [name, props] of Object.entries(modes)) {
    it(`${name}: clock with seconds, a 60x pill, no flip on first render`, () => {
      const html = renderToStaticMarkup(<TopBar s={s} src={src} notice={null} {...props} />);
      expect(html).toMatch(/class="clock"/);
      expect(html.replace(/<[^>]+>/g, "")).toMatch(/3 Sept 2026, 15:00:00 Manila/);
      expect(html).toContain('<span class="pill" title="Simulation speed">60x</span>');
      expect(html).not.toContain('class="flip"');
    });
  }
  it.each([[60, 2], [10, 3], [1, 3]])("at %ix the clock has %i flipboxes, and the seconds are plain text", (speed, boxes) => {
    const html = renderToStaticMarkup(<TopBar s={{ ...s, speed: speed as 1 } as typeof s} src={src} notice={null} />);
    const clock = html.replace(/<!-- -->/g, "").match(/<span class="clock">.*?<\/span><span class="pill"/)![0];
    expect(clock.match(/class="flipbox"/g)).toHaveLength(boxes); // date, hour, and the minute only at 10x or slower
    expect(clock).toMatch(/:00 Manila<\/span><span class="pill"/);
    expect(clock).toContain(speed > 10 ? "</span></span>:00:00 Manila" : "</span></span>:00 Manila"); // 60x: the minute is bare text too
  });
  it("a paused sim reads Paused", () => {
    const html = renderToStaticMarkup(<TopBar s={{ ...s, speed: 0 }} src={src} notice={null} />);
    expect(html).toContain(">Paused</span>");
  });
});

describe("app.css", () => {
  const css = readFileSync("src/app.css", "utf8");
  const num = (v: string) => Number(v.replace("ms", ""));
  it("holds the shared values", () => {
    expect(css).toContain("--flip-ms: 320ms");
    expect(css).toContain("--flip-ease: cubic-bezier(0.2, 0.8, 0.2, 1)");
    expect(css).toContain("perspective: 400px");
    expect(css).toContain("@keyframes flip-in");
    expect(css).toContain("@keyframes flip-out");
  });
  it("animates transform and opacity only", () => {
    for (const name of ["flip-in", "flip-out"]) {
      const body = css.match(new RegExp(`@keyframes ${name} \\{([^@]*?\\})\\s*\\}`))![1];
      const props = [...body.matchAll(/([a-z-]+):/g)].map((m) => m[1]);
      expect(new Set(props)).toEqual(new Set(["transform", "opacity"]));
    }
  });
  it("is off under reduced motion", () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{ \.flip \{ animation: none; \}/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)[^}]*\}[^}]*\.flip-old \{ display: none/);
  });
  it("the gap is longer than the flip", () => {
    expect(FLIP_GAP_MS).toBeGreaterThan(num(css.match(/--flip-ms: (\d+ms)/)![1]));
  });
});

describe("where Flip is not used", () => {
  const read = (f: string) => readFileSync(f, "utf8");
  it("not under src/render or src/analytics", () => {
    for (const dir of ["src/render", "src/analytics"]) {
      for (const f of readdirSync(dir, { recursive: true }) as string[]) {
        if (/\.(tsx?|css)$/.test(f)) expect(read(`${dir}/${f}`)).not.toMatch(/from "[^"]*\/flip"|<Flip/);
      }
    }
  });
  it("not in a role=status line of panels.tsx", () => {
    const live = [...read("src/panels.tsx").matchAll(/role="(?:status|alert)"[^>]*>[\s\S]*?<\/span>/g)];
    expect(live.length).toBeGreaterThan(0);
    for (const m of live) expect(m[0]).not.toContain("<Flip");
  });
});
