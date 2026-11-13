import { Component, type ReactNode } from "react";

export type Page = "simulation" | "analytics";

/** Only exactly #analytics opens Analytics. */
export const pageFromHash = (hash: string): Page => (hash === "#analytics" ? "analytics" : "simulation");

/** Adds the hashchange listener and returns the function that removes it. */
export const onHashChange = (target: Pick<Window, "addEventListener" | "removeEventListener">, handler: () => void): (() => void) => {
  target.addEventListener("hashchange", handler);
  return () => target.removeEventListener("hashchange", handler);
};

export function PageNav({ page }: { page: Page }) {
  return (
    <nav aria-label="Pages">
      <a href="#simulation" aria-current={page === "simulation" ? "page" : undefined}>
        Simulation
      </a>
      <a href="#analytics" aria-current={page === "analytics" ? "page" : undefined}>
        Analytics
      </a>
    </nav>
  );
}

/** A page that fails to load (a missing chunk) leaves the nav, so the user can go back. */
export class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="app">
        <p>could not load</p>
        <PageNav page="simulation" />
      </div>
    ) : (
      this.props.children
    );
  }
}
