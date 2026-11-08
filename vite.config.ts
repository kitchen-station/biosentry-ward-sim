import react from "@vitejs/plugin-react";
import { defineConfig, type Connect, type Plugin } from "vite";
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

export default defineConfig({ plugins: [react(), wardApi()] });
