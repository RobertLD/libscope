import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { searchDocuments } from "../core/search.js";
import { getDocument, deleteDocument, listDocuments } from "../core/documents.js";
import { getTopicStats } from "../core/topics.js";
import { getDashboardHtml, getGraphPageHtml } from "./dashboard.js";
import { handleGraphRequest } from "./graph-api.js";
import { DocumentNotFoundError } from "../errors.js";
import { validateCountRow } from "../utils/db-validation.js";
import { getLogger } from "../logger.js";
import { checkRateLimit } from "../api/middleware.js";

export interface WebServerOptions {
  port?: number;
  host?: string;
}

let server: Server | null = null;

/** Start the web UI server. */
export function startWebServer(
  db: Database.Database,
  provider: EmbeddingProvider,
  options?: WebServerOptions,
): Promise<Server> {
  const port = options?.port ?? 3377;
  const host = options?.host ?? "localhost";

  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      const ip = req.socket.remoteAddress ?? "unknown";
      if (!checkRateLimit(ip)) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
        res.end(JSON.stringify({ error: "Too many requests" }));
        return;
      }
      handleRequest(db, provider, req, res).catch((err) => {
        getLogger().error({ err, url: req.url }, "Unhandled error in web request handler");
        if (res.headersSent) {
          req.socket.destroy();
        } else {
          sendJson(res, 500, { error: "Internal server error" });
        }
      });
    });

    server.on("error", reject);
    server.listen(port, host, () => resolve(server!));
  });
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

async function handleRequest(
  db: Database.Database,
  provider: EmbeddingProvider,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;
  const method = req.method ?? "GET";

  setCorsHeaders(res);

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (method === "GET") {
    const handled = await handleGetRoute(db, provider, pathname, url, res, req);
    if (handled) return;
  }

  const docMatch = pathname.match(/^\/api\/documents\/([^/]+)$/);
  if (docMatch) {
    const id = decodeURIComponent(docMatch[1]!);
    const handled = handleDocumentByIdRoute(db, method, id, res);
    if (handled) return;
  }

  sendJson(res, 404, { error: "Not found" });
}

/** Handle all GET routes. Returns true if a route matched. */
async function handleGetRoute(
  db: Database.Database,
  provider: EmbeddingProvider,
  pathname: string,
  url: URL,
  res: ServerResponse,
  req: IncomingMessage,
): Promise<boolean> {
  if (pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getDashboardHtml());
    return true;
  }

  if (pathname === "/graph") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getGraphPageHtml());
    return true;
  }

  if (pathname === "/api/graph") {
    await handleGraphRequest(db, req, res);
    return true;
  }

  if (pathname === "/api/search") {
    await handleSearchRoute(db, provider, url, res);
    return true;
  }

  if (pathname === "/api/documents") {
    handleDocumentsListRoute(db, url, res);
    return true;
  }

  if (pathname === "/api/topics") {
    sendJson(res, 200, getTopicStats(db));
    return true;
  }

  if (pathname === "/api/stats") {
    handleStatsRoute(db, res);
    return true;
  }

  return false;
}

/** Handle GET /api/search */
async function handleSearchRoute(
  db: Database.Database,
  provider: EmbeddingProvider,
  url: URL,
  res: ServerResponse,
): Promise<void> {
  const query = url.searchParams.get("q") ?? "";
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "10", 10);
  const limit = Number.isNaN(rawLimit) ? 10 : Math.max(1, Math.min(100, rawLimit));
  const topic = url.searchParams.get("topic") ?? undefined;

  if (!query) {
    sendJson(res, 400, { error: "Missing query parameter 'q'" });
    return;
  }

  const results = await searchDocuments(db, provider, { query, limit, topic });
  sendJson(res, 200, results);
}

/** Handle GET /api/documents */
function handleDocumentsListRoute(db: Database.Database, url: URL, res: ServerResponse): void {
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isNaN(rawLimit) ? 50 : Math.max(1, Math.min(500, rawLimit));
  const topic = url.searchParams.get("topic") ?? undefined;
  const docs = listDocuments(db, { limit, topicId: topic });
  sendJson(res, 200, docs);
}

/** Handle GET/DELETE /api/documents/:id. Returns true if method matched. */
function handleDocumentByIdRoute(
  db: Database.Database,
  method: string,
  id: string,
  res: ServerResponse,
): boolean {
  if (method === "GET") {
    handleGetDocumentById(db, id, res);
    return true;
  }
  if (method === "DELETE") {
    handleDeleteDocumentById(db, id, res);
    return true;
  }
  return false;
}

/** Handle GET /api/documents/:id */
function handleGetDocumentById(db: Database.Database, id: string, res: ServerResponse): void {
  try {
    const doc = getDocument(db, id);
    sendJson(res, 200, doc);
  } catch (err) {
    if (err instanceof DocumentNotFoundError) {
      sendJson(res, 404, { error: "Document not found" });
    } else {
      throw err;
    }
  }
}

/** Handle DELETE /api/documents/:id */
function handleDeleteDocumentById(db: Database.Database, id: string, res: ServerResponse): void {
  try {
    deleteDocument(db, id);
    sendJson(res, 200, { success: true });
  } catch (err) {
    if (err instanceof DocumentNotFoundError) {
      sendJson(res, 404, { error: "Document not found" });
    } else {
      throw err;
    }
  }
}

/** Handle GET /api/stats */
function handleStatsRoute(db: Database.Database, res: ServerResponse): void {
  const docCount = validateCountRow(
    db.prepare("SELECT COUNT(*) AS cnt FROM documents").get(),
    "document count",
  );
  const topicCount = validateCountRow(
    db.prepare("SELECT COUNT(*) AS cnt FROM topics").get(),
    "topic count",
  );
  const chunkCount = validateCountRow(
    db.prepare("SELECT COUNT(*) AS cnt FROM chunks").get(),
    "chunk count",
  );
  sendJson(res, 200, { documentCount: docCount, topicCount, chunkCount });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
}
