import { createServer } from "node:http";
import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { getLogger } from "../logger.js";
import { corsMiddleware, checkRateLimit, checkApiKey } from "./middleware.js";
import { handleRequest } from "./routes.js";

export interface ApiServerOptions {
  port?: number | undefined;
  host?: string | undefined;
  corsOrigins?: string[] | undefined;
}

export async function startApiServer(
  db: Database.Database,
  provider: EmbeddingProvider,
  options?: ApiServerOptions,
): Promise<{ close: () => void; port: number }> {
  const log = getLogger();
  const port = options?.port ?? 3378;
  const host = options?.host ?? "localhost";
  const corsOrigins = options?.corsOrigins ?? ["*"];

  const server = createServer((req, res) => {
    // Rate limiting
    const ip = req.socket.remoteAddress ?? "unknown";
    if (!checkRateLimit(ip)) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
      res.end(JSON.stringify({ error: { code: "RATE_LIMITED", message: "Too many requests" } }));
      return;
    }

    if (corsMiddleware(req, res, corsOrigins)) return;
    if (!checkApiKey(req, res)) return;
    handleRequest(req, res, db, provider).catch((err: unknown) => {
      log.error({ err }, "Unhandled error in request handler");
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }),
        );
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      log.info({ port, host }, "API server started");
      resolve({
        close: () => server.close(),
        port,
      });
    });
  });
}
