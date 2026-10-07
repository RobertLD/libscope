/**
 * Web dashboard server: the dashboard pages plus the small unversioned JSON API their
 * scripts call. Each API route runs an operation and reshapes the result into the format
 * the dashboard script expects (src/web/dashboard.ts is not changed).
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { z } from "zod";
import { decodeSegment, inputFromParams, sendRequestError } from "../api/adapter.js";
import {
  corsMiddleware,
  rejectForeignWrite,
  sendError,
  setSecurityHeaders,
} from "../api/middleware.js";
import { listen, rejectRateLimited, type ServerApp } from "../api/server.js";
import {
  createOperationContext,
  deleteDocumentOperation,
  getDocumentOperation,
  graphOperation,
  listDocumentsOperation,
  listTopicsOperation,
  overviewOperation,
  runOperation,
  searchOperation,
  type Operation,
  type OperationContext,
} from "../core/operations/index.js";
import { getDashboardHtml, getGraphPageHtml } from "./dashboard.js";

export interface WebServerOptions {
  port?: number | undefined;
  host?: string | undefined;
  /** Other browser origins allowed to call the dashboard API. Default: none (same origin only). */
  corsOrigins?: string[] | undefined;
}

interface DashboardRoute<S extends z.ZodObject = z.ZodObject, O = unknown> {
  method: "GET" | "DELETE";
  /** Path; a trailing "/:documentId" segment is passed to the operation. */
  path: string;
  operation: Operation<S, O>;
  /** Rename query parameters the dashboard sends under another name. */
  rename?: Record<string, string>;
  /** Dashboard response shape. */
  shape: (result: O) => unknown;
}

function route<S extends z.ZodObject, O>(r: DashboardRoute<S, O>): DashboardRoute {
  return r as unknown as DashboardRoute;
}

/** The JSON routes the dashboard script fetches, each served by one operation. */
const DASHBOARD_ROUTES: DashboardRoute[] = [
  route({
    method: "GET",
    path: "/api/stats",
    operation: overviewOperation,
    shape: ({ stats }) => ({
      documentCount: stats.totalDocuments,
      topicCount: stats.totalTopics,
      chunkCount: stats.totalChunks,
    }),
  }),
  route({
    method: "GET",
    path: "/api/topics",
    operation: listTopicsOperation,
    shape: (result) => result.items,
  }),
  route({
    method: "GET",
    path: "/api/documents",
    operation: listDocumentsOperation,
    shape: (result) => result.items.map(({ documentId, ...rest }) => ({ id: documentId, ...rest })),
  }),
  route({
    method: "GET",
    path: "/api/search",
    operation: searchOperation,
    rename: { q: "query" },
    shape: (result) => ({ results: result.items, totalCount: result.total }),
  }),
  route({
    method: "GET",
    path: "/api/graph",
    operation: graphOperation,
    shape: (graph) => graph,
  }),
  route({
    method: "GET",
    path: "/api/documents/:documentId",
    operation: getDocumentOperation,
    shape: (view) => ({
      id: view.document.documentId,
      ...view.document,
      content: view.content,
      tags: view.tags,
    }),
  }),
  route({
    method: "DELETE",
    path: "/api/documents/:documentId",
    operation: deleteDocumentOperation,
    shape: () => ({ success: true }),
  }),
];

const PAGES: Record<string, () => string> = {
  "/": getDashboardHtml,
  "/graph": getGraphPageHtml,
};

/** The route for a path, with the trailing `:documentId` value when the route has one. */
function findRoute(
  method: string,
  pathname: string,
): { route: DashboardRoute; params: Record<string, string> } | undefined {
  for (const r of DASHBOARD_ROUTES) {
    if (r.method !== method) continue;
    if (r.path === pathname) return { route: r, params: {} };
    const [prefix, param] = r.path.split("/:");
    if (param === undefined || !pathname.startsWith(`${prefix}/`)) continue;
    const value = pathname.slice((prefix ?? "").length + 1);
    if (value !== "" && !value.includes("/")) {
      return { route: r, params: { [param]: decodeSegment(value) } };
    }
  }
  return undefined;
}

async function handleRequest(
  ctx: OperationContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  try {
    const page = method === "GET" ? PAGES[url.pathname] : undefined;
    if (page) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page());
      return;
    }
    const match = findRoute(method, url.pathname);
    if (!match) {
      sendError(res, 404, "NOT_FOUND", "Not found");
      return;
    }
    const { route: r, params } = match;
    const query = new URLSearchParams();
    for (const [name, value] of url.searchParams) query.append(r.rename?.[name] ?? name, value);
    const input = { ...inputFromParams(r.operation, query), ...params };
    const result = await runOperation(r.operation, ctx, input);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(r.shape(result)));
  } catch (err) {
    sendRequestError(res, err, { method, pathname: url.pathname });
  }
}

let server: Server | null = null;

/** Start the web dashboard (default http://localhost:3377). */
export async function startWebServer(app: ServerApp, options?: WebServerOptions): Promise<Server> {
  const corsOrigins = options?.corsOrigins ?? [];
  const ctx = createOperationContext({ ...app, surface: "api" });
  const httpServer = createServer((req, res) => {
    // No Content-Security-Policy: the graph page loads d3 from a CDN.
    setSecurityHeaders(res, false);
    if (rejectRateLimited(req.socket.remoteAddress, res)) return;
    if (corsMiddleware(req, res, corsOrigins)) return;
    if (rejectForeignWrite(req, res, corsOrigins)) return;
    void handleRequest(ctx, req, res);
  });
  await listen(httpServer, options?.port ?? 3377, options?.host ?? "localhost");
  server = httpServer;
  return httpServer;
}

/** Gracefully shut down the web server. */
export function stopWebServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => {
      server = null;
      resolve();
    });
  });
}
