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
      handleRequest(db, provider, req, res).catch((err) => {
        sendJson(res, 500, { error: String(err) });
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

  // Route: GET /
  if (method === "GET" && pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getDashboardHtml());
    return;
  }

  // Route: GET /graph
  if (method === "GET" && pathname === "/graph") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getGraphPageHtml());
    return;
  }

  // Route: GET /api/graph
  if (method === "GET" && pathname === "/api/graph") {
    await handleGraphRequest(db, req, res);
    return;
  }

  // Route: GET /api/search
  if (method === "GET" && pathname === "/api/search") {
    const query = url.searchParams.get("q") ?? "";
    const limit = parseInt(url.searchParams.get("limit") ?? "10", 10);
    const topic = url.searchParams.get("topic") ?? undefined;

    if (!query) {
      sendJson(res, 400, { error: "Missing query parameter 'q'" });
      return;
    }

    const results = await searchDocuments(db, provider, { query, limit, topic });
    sendJson(res, 200, results);
    return;
  }

  // Route: GET /api/documents
  if (method === "GET" && pathname === "/api/documents") {
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
    const topic = url.searchParams.get("topic") ?? undefined;
    const docs = listDocuments(db, { limit, topicId: topic });
    sendJson(res, 200, docs);
    return;
  }

  // Route: GET/DELETE /api/documents/:id
  const docMatch = pathname.match(/^\/api\/documents\/([^/]+)$/);
  if (docMatch) {
    const id = decodeURIComponent(docMatch[1]!);

    if (method === "GET") {
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
      return;
    }

    if (method === "DELETE") {
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
      return;
    }
  }

  // Route: GET /api/topics
  if (method === "GET" && pathname === "/api/topics") {
    const topics = getTopicStats(db);
    sendJson(res, 200, topics);
    return;
  }

  // Route: GET /api/stats
  if (method === "GET" && pathname === "/api/stats") {
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
    return;
  }

  // 404
  sendJson(res, 404, { error: "Not found" });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
