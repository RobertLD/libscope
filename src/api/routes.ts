import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import type Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import type { EmbeddingProvider } from "../providers/embedding.js";
import {
  searchDocuments,
  listDocuments,
  getDocument,
  indexDocument,
  deleteDocument,
  listTopics,
  createTopic,
  listTags,
  addTagsToDocument,
  getStats,
  fetchAndConvert,
  askQuestion,
  createLlmProvider,
} from "../core/index.js";
import { loadConfig } from "../config.js";
import { DocumentNotFoundError, LibScopeError } from "../errors.js";
import { getLogger } from "../logger.js";
import { parseJsonBody, sendJson, sendError } from "./middleware.js";
import { OPENAPI_SPEC } from "./openapi.js";

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers["host"] ?? "localhost"}`);
}

function extractPathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

/** Match a path like /api/v1/documents/:id and return the id, or null. */
function matchDocumentId(segments: string[]): string | null {
  // ["api", "v1", "documents", "<id>"]
  if (
    segments.length === 4 &&
    segments[0] === "api" &&
    segments[1] === "v1" &&
    segments[2] === "documents"
  ) {
    const id = segments[3];
    // Exclude sub-paths that are named routes
    if (id === "url") return null;
    return id ?? null;
  }
  return null;
}

/** Match /api/v1/documents/:id/tags */
function matchDocumentTags(segments: string[]): string | null {
  if (
    segments.length === 5 &&
    segments[0] === "api" &&
    segments[1] === "v1" &&
    segments[2] === "documents" &&
    segments[4] === "tags"
  ) {
    return segments[3] ?? null;
  }
  return null;
}

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  provider: EmbeddingProvider,
): Promise<void> {
  const log = getLogger();
  const start = performance.now();
  const url = parseUrl(req);
  const pathname = url.pathname;
  const method = req.method ?? "GET";
  const segments = extractPathSegments(pathname);

  try {
    // OpenAPI spec
    if (pathname === "/openapi.json" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(OPENAPI_SPEC));
      return;
    }

    // Health check
    if (pathname === "/api/v1/health" && method === "GET") {
      const stats = getStats(db);
      const took = Math.round(performance.now() - start);
      sendJson(
        res,
        200,
        { status: "ok", docCount: stats.totalDocuments, dbSize: stats.databaseSizeBytes },
        took,
      );
      return;
    }

    // Search
    if (pathname === "/api/v1/search" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      if (!q) {
        sendError(res, 400, "VALIDATION_ERROR", "Query parameter 'q' is required");
        return;
      }
      const topic = url.searchParams.get("topic") ?? undefined;
      const tag = url.searchParams.get("tag") ?? undefined;
      const limitRaw = url.searchParams.get("limit");
      const limitParsed = limitRaw ? parseInt(limitRaw, 10) : NaN;
      const limit = Number.isNaN(limitParsed) ? undefined : limitParsed;
      const tags = tag ? [tag] : undefined;

      const result = await searchDocuments(db, provider, { query: q, topic, tags, limit });
      const took = Math.round(performance.now() - start);
      sendJson(res, 200, result, took);
      return;
    }

    // List documents
    if (pathname === "/api/v1/documents" && method === "GET") {
      const topicId = url.searchParams.get("topic") ?? undefined;
      const limitRaw = url.searchParams.get("limit");
      const limitParsed = limitRaw ? parseInt(limitRaw, 10) : NaN;
      const limit = Number.isNaN(limitParsed) ? undefined : limitParsed;
      const docs = listDocuments(db, { topicId, limit });
      const took = Math.round(performance.now() - start);
      sendJson(res, 200, docs, took);
      return;
    }

    // Index new document
    if (pathname === "/api/v1/documents" && method === "POST") {
      const body = await parseJsonBody(req);
      if (!body || typeof body !== "object") {
        sendError(res, 400, "VALIDATION_ERROR", "Request body must be a JSON object");
        return;
      }
      const b = body as Record<string, unknown>;
      if (typeof b["content"] !== "string" || typeof b["title"] !== "string") {
        sendError(
          res,
          400,
          "VALIDATION_ERROR",
          "Fields 'content' and 'title' are required strings",
        );
        return;
      }

      const topicId = typeof b["topic"] === "string" ? b["topic"] : undefined;
      const source = typeof b["source"] === "string" ? b["source"] : undefined;
      const sourceType =
        source === "library" ||
        source === "topic" ||
        source === "manual" ||
        source === "model-generated"
          ? source
          : "manual";

      const doc = await indexDocument(db, provider, {
        content: b["content"],
        title: b["title"],
        sourceType,
        topicId,
      });

      // Add tags if provided
      if (Array.isArray(b["tags"])) {
        const tagNames = (b["tags"] as unknown[]).filter((t): t is string => typeof t === "string");
        if (tagNames.length > 0) {
          addTagsToDocument(db, doc.id, tagNames);
        }
      }

      const took = Math.round(performance.now() - start);
      sendJson(res, 201, doc, took);
      return;
    }

    // Index from URL
    if (pathname === "/api/v1/documents/url" && method === "POST") {
      const body = await parseJsonBody(req);
      if (!body || typeof body !== "object") {
        sendError(res, 400, "VALIDATION_ERROR", "Request body must be a JSON object");
        return;
      }
      const b = body as Record<string, unknown>;
      if (typeof b["url"] !== "string") {
        sendError(res, 400, "VALIDATION_ERROR", "Field 'url' is required");
        return;
      }
      const fetched = await fetchAndConvert(b["url"]);
      const topicId = typeof b["topic"] === "string" ? b["topic"] : undefined;
      const doc = await indexDocument(db, provider, {
        content: fetched.content,
        title: fetched.title,
        sourceType: "manual",
        url: b["url"],
        topicId,
      });
      const took = Math.round(performance.now() - start);
      sendJson(res, 201, doc, took);
      return;
    }

    // Ask question (RAG)
    if (pathname === "/api/v1/ask" && method === "POST") {
      const body = await parseJsonBody(req);
      if (!body || typeof body !== "object") {
        sendError(res, 400, "VALIDATION_ERROR", "Request body must be a JSON object");
        return;
      }
      const b = body as Record<string, unknown>;
      if (typeof b["question"] !== "string") {
        sendError(res, 400, "VALIDATION_ERROR", "Field 'question' is required");
        return;
      }
      const config = loadConfig();
      const llm = createLlmProvider(config);
      const topic = typeof b["topic"] === "string" ? b["topic"] : undefined;
      const result = await askQuestion(db, provider, llm, { question: b["question"], topic });
      const took = Math.round(performance.now() - start);
      sendJson(res, 200, result, took);
      return;
    }

    // Topics
    if (pathname === "/api/v1/topics" && method === "GET") {
      const topics = listTopics(db);
      const took = Math.round(performance.now() - start);
      sendJson(res, 200, topics, took);
      return;
    }

    if (pathname === "/api/v1/topics" && method === "POST") {
      const body = await parseJsonBody(req);
      if (!body || typeof body !== "object") {
        sendError(res, 400, "VALIDATION_ERROR", "Request body must be a JSON object");
        return;
      }
      const b = body as Record<string, unknown>;
      if (typeof b["name"] !== "string") {
        sendError(res, 400, "VALIDATION_ERROR", "Field 'name' is required");
        return;
      }
      const parentId = typeof b["parentId"] === "string" ? b["parentId"] : undefined;
      const topic = createTopic(db, { name: b["name"], parentId });
      const took = Math.round(performance.now() - start);
      sendJson(res, 201, topic, took);
      return;
    }

    // Tags
    if (pathname === "/api/v1/tags" && method === "GET") {
      const tags = listTags(db);
      const took = Math.round(performance.now() - start);
      sendJson(res, 200, tags, took);
      return;
    }

    // Add tags to document
    const tagDocId = matchDocumentTags(segments);
    if (tagDocId && method === "POST") {
      const body = await parseJsonBody(req);
      if (!body || typeof body !== "object") {
        sendError(res, 400, "VALIDATION_ERROR", "Request body must be a JSON object");
        return;
      }
      const b = body as Record<string, unknown>;
      if (!Array.isArray(b["tags"])) {
        sendError(res, 400, "VALIDATION_ERROR", "Field 'tags' must be an array of strings");
        return;
      }
      const tagNames = (b["tags"] as unknown[]).filter((t): t is string => typeof t === "string");
      const tags = addTagsToDocument(db, tagDocId, tagNames);
      const took = Math.round(performance.now() - start);
      sendJson(res, 200, tags, took);
      return;
    }

    // Stats
    if (pathname === "/api/v1/stats" && method === "GET") {
      const stats = getStats(db);
      const took = Math.round(performance.now() - start);
      sendJson(res, 200, stats, took);
      return;
    }

    // Single document GET / DELETE
    const docId = matchDocumentId(segments);
    if (docId && method === "GET") {
      const doc = getDocument(db, docId);
      const took = Math.round(performance.now() - start);
      sendJson(res, 200, doc, took);
      return;
    }

    if (docId && method === "DELETE") {
      deleteDocument(db, docId);
      const took = Math.round(performance.now() - start);
      sendJson(res, 200, { deleted: true }, took);
      return;
    }

    // Unknown route
    sendError(res, 404, "NOT_FOUND", `Route not found: ${method} ${pathname}`);
  } catch (err: unknown) {
    log.error({ err, method, pathname }, "API request error");

    if (err instanceof DocumentNotFoundError) {
      sendError(res, 404, "NOT_FOUND", err.message);
      return;
    }
    if (err instanceof LibScopeError && err.code === "VALIDATION_ERROR") {
      sendError(res, 400, "VALIDATION_ERROR", err.message);
      return;
    }
    if (err instanceof Error && err.message === "Invalid JSON body") {
      sendError(res, 400, "INVALID_JSON", "Request body contains invalid JSON");
      return;
    }

    const message = err instanceof Error ? err.message : "Internal server error";
    sendError(res, 500, "INTERNAL_ERROR", message);
  }
}
