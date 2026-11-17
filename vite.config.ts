import react from "@vitejs/plugin-react";
import { defineConfig, type Connect, type Plugin } from "vite";
import { buildGuard } from "./build-guard.ts";
import { createApiState, handle } from "./src/bridge/api.ts";

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const MAX_BODY = 2_000_000;

/** Serves the BioSentry dashboard's API at /api from the ward the sim page publishes. */
function wardApi(): Plugin {
  const state = createApiState();
  const middleware: Connect.NextHandleFunction = (req, res) => {
    const origin = req.headers.origin;
    const send = (status: number, body?: unknown) => {
      if (origin && LOCAL.test(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      res.statusCode = status;
      if (body === undefined) return res.end();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE");
      return send(204);
    }
    const path = (req.url ?? "/").split("?")[0];
    // Only the sim page itself may publish the ward.
    if (path === "/snapshot" && origin && origin !== `http://${req.headers.host}`) {
      return send(403, { detail: "Only the sim page publishes the ward" });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(chunk);
    });
    req.on("end", () => {
      const response = handle(state, {
        method: req.method ?? "GET",
        path,
        authorization: req.headers.authorization ?? null,
        body: chunks.length ? Buffer.concat(chunks).toString("utf8") : null,
      });
      send(response.status, response.body);
    });
  };
  return {
    name: "biosentry-ward-api",
    configureServer: (server) => void server.middlewares.use("/api", middleware),
    configurePreviewServer: (server) => void server.middlewares.use("/api", middleware),
  };
}

const plugins = [buildGuard(), react(), wardApi()];

// Files that run weeks of simulated days or spawn many git processes, and so take minutes when the machine is busy. They get their own project and a long limit.
const LONG = [
  "src/sim/hospital/hospital.test.ts",
  "src/sim/hospital/month.test.ts",
  "src/sim/hospital/vitals.long.test.ts",
  "src/sim/hospital/trial.test.ts",
  "src/sim/trial.long.test.ts",
  "src/sim/ward-stats.test.ts",
  "src/sim/published.test.ts",
  "src/compare.test.ts",
  "src/sim/hospital/vitals.test.ts",
  "src/sim/trial.test.ts",
  "src/render/stack.test.ts",
  "scripts/sync-evaluation.test.mjs",
];

export default defineConfig({
  plugins,
  test: {
    // Other jobs often share this machine: a few workers each get a real share of the CPU, and a test that is only slow is not cut off.
    maxWorkers: 4,
    projects: [
      { extends: true, test: { name: "fast", exclude: ["node_modules/**", "dist/**", ...LONG], testTimeout: 20_000, hookTimeout: 20_000 } },
      { extends: true, test: { name: "long", include: LONG, testTimeout: 600_000, hookTimeout: 600_000 } },
    ],
  },
});
