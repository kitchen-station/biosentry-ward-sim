import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The developer page as its own static site: dev-site/index.html builds to dist-dev. No ward API.
export default defineConfig({
  root: "dev-site",
  plugins: [react()],
  build: { outDir: "../dist-dev", emptyOutDir: true },
});
