import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PanelSkeleton, WardSkeleton } from "./skeleton";

const blocks = (html: string) => html.match(/class="hw-skeleton/g)?.length ?? 0;

describe("skeleton screens", () => {
  it("the ward skeleton is a busy status with a spoken label and kit skeleton blocks, all hidden from readers", () => {
    const html = renderToStaticMarkup(<WardSkeleton />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('<span class="hw-visually-hidden">Loading the hospital</span>');
    expect(blocks(html)).toBeGreaterThan(6);
    expect(html.match(/hw-skeleton[^>]*aria-hidden/g)?.length ?? 0).toBe(0); // blocks sit inside aria-hidden parents or carry it themselves
  });
  it("the panel skeleton takes its own label", () => {
    const html = renderToStaticMarkup(<PanelSkeleton label="Loading the analytics" />);
    expect(html).toContain("Loading the analytics");
    expect(html).toContain('aria-busy="true"');
    expect(blocks(html)).toBe(3);
  });
});
