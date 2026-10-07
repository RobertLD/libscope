import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Bootstrapped } from "../core/bootstrap.js";
import { createOperationContext } from "../core/operations/index.js";
import { ConnectorScheduler, loadScheduleEntries } from "../core/scheduler.js";
import { getLogger } from "../logger.js";
import {
  checkApiKey,
  checkRateLimit,
  corsMiddleware,
  rejectForeignWrite,
  sendError,
  setSecurityHeaders,
} from "./middleware.js";
import { handleRequest } from "./routes.js";

/** What a server needs from bootstrap(). */
export type ServerApp = Pick<Bootstrapped, "db" | "provider" | "config">;

/** Close an HTTP server, returning a promise that resolves when done. */
function closeHttpServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/** Listen on `port`/`host`; resolves with the port actually bound (for port 0). */
export function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** Answer 429 when `ip` is over the rate limit. Returns true when the request was rejected. */
export function rejectRateLimited(
  ip: string | undefined,
  res: Parameters<typeof sendError>[0],
): boolean {
  if (checkRateLimit(ip ?? "unknown")) return false;
  res.setHeader("Retry-After", "60");
  sendError(res, 429, "RATE_LIMITED", "Too many requests");
  return true;
}

export interface ApiServerOptions {
  port?: number | undefined;
  host?: string | undefined;
  /**
   * Browser origins allowed to call the API. Default: ["http://localhost",
   * "http://localhost:3000"]. "*" lets any origin read (GET) but not write.
   */
  corsOrigins?: string[] | undefined;
  enableScheduler?: boolean | undefined;
}

/** Start the REST API server (default http://localhost:3378). */
export async function startApiServer(
  app: ServerApp,
  options?: ApiServerOptions,
): Promise<{
  close: () => Promise<void>;
  port: number;
  scheduler?: ConnectorScheduler | undefined;
}> {
  const log = getLogger();
  const host = options?.host ?? "localhost";
  const corsOrigins = options?.corsOrigins ?? ["http://localhost", "http://localhost:3000"];
  const ctx = createOperationContext({ ...app, surface: "api" });

  const server = createServer((req, res) => {
    setSecurityHeaders(res);
    if (rejectRateLimited(req.socket.remoteAddress, res)) return;
    if (corsMiddleware(req, res, corsOrigins)) return;
    if (rejectForeignWrite(req, res, corsOrigins)) return;
    if (!checkApiKey(req, res)) return;
    // handleRequest answers every error itself.
    void handleRequest(req, res, ctx);
  });

  const port = await listen(server, options?.port ?? 3378, host);
  log.info({ port, host }, "API server started");

  let scheduler: ConnectorScheduler | undefined;
  if (options?.enableScheduler !== false) {
    const entries = loadScheduleEntries();
    if (entries.length > 0) {
      scheduler = new ConnectorScheduler(app.db, app.provider);
      scheduler.start(entries);
      log.info({ scheduledJobs: entries.length }, "Connector scheduler started with API server");
    }
  }

  return {
    close: async (): Promise<void> => {
      await scheduler?.stop();
      await closeHttpServer(server);
    },
    port,
    scheduler,
  };
}
