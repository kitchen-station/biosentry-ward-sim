import { relative } from "node:path";
import type { Plugin } from "vite";

// The customer build must not contain the developer page or the evaluation data. This plugin is the real guard.
// Rule 1 (load): no module under src/analytics/ or src/data/evaluation/ may enter the build, in any import form.
// Rule 2 (transform): no customer source file may name a path into those folders (this catches new URL(...) and template paths).
// Limit: a path built at run time from pieces that never spell the folder name is not seen. Review must catch that.

const DEV_DIRS = ["src/analytics/", "src/data/evaluation/"];
// A relative or src/ path into the folder, in any letter case. A URL such as "/wards/W4/analytics/" is not one.
const NAMES_DEV_PATH = /data\/evaluation|(?:\.\.?\/|src\/)analytics\//i;

const clean = (id: string) => id.split("?")[0].replace(/\\/g, "/");

/** True if the id (a query and OS separators allowed) is a module of the developer page or its data. */
export function isDevModule(id: string, root: string): boolean {
  const base = `${root.replace(/\\/g, "/").replace(/\/$/, "")}/`;
  const path = clean(id);
  return DEV_DIRS.some((d) => path.toLowerCase().startsWith((base + d).toLowerCase())); // macOS and Windows also resolve ./Analytics/
}

/** True if the id is a customer source file: under src/, not a developer module, not virtual. */
export function isCustomerSource(id: string, root: string): boolean {
  const base = `${root.replace(/\\/g, "/").replace(/\/$/, "")}/`;
  return !id.startsWith("\0") && clean(id).toLowerCase().startsWith(`${base}src/`.toLowerCase()) && !isDevModule(id, root);
}

export function namesDevPath(code: string): string | null {
  return NAMES_DEV_PATH.exec(code)?.[0] ?? null;
}

export function buildGuard(): Plugin {
  let root = process.cwd();
  return {
    name: "biosentry-customer-build-guard",
    apply: "build",
    enforce: "pre",
    configResolved: (c) => void (root = c.root),
    load(id) {
      if (isDevModule(id, root)) this.error(`developer page module in the customer build: ${relative(root, clean(id))}`);
      return null;
    },
    transform(code, id) {
      const hit = isCustomerSource(id, root) ? namesDevPath(code) : null;
      if (hit) this.error(`developer page path in the customer build: ${relative(root, clean(id))} names "${hit}"`);
      return null;
    },
  };
}
