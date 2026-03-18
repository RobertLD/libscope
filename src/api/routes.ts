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
  updateDocument,
  listTopics,
  createTopic,
  listTags,
  addTagsToDocument,
  suggestTags,
  getStats,
  getSearchAnalytics,
  getKnowledgeGaps,
  fetchAndConvert,
  askQuestion,
  askQuestionStream,
  createLlmProvider,
  createLink,
  getDocumentLinks,
  deleteLink,
  createSavedSearch,
  listSavedSearches,
  runSavedSearch,
  deleteSavedSearch,
  bulkDelete,
  bulkRetag,
  bulkMove,
  searchBatch,
} from "../core/index.js";
import type { LinkType, BulkSelector, BatchSearchRequest } from "../core/index.js";
import { loadConfig } from "../config.js";
import { DocumentNotFoundError, FetchError, LibScopeError } from "../errors.js";
import { getLogger } from "../logger.js";
import { parseJsonBody, sendJson, sendError } from "./middleware.js";
import { OPENAPI_SPEC } from "./openapi.js";
import { getConnectorStatus, getSyncHistory } from "../connectors/sync-tracker.js";
import {
  createWebhook,
  listWebhooks,
  deleteWebhook,
  getWebhook,
  buildPayload,
  signPayload,
  redactWebhook,
  validateWebhookUrlSsrf,
} from "../core/webhooks.js";
import type { WebhookEvent } from "../core/webhooks.js";
import { loadScheduleEntries } from "../core/scheduler.js";
import { spiderUrl } from "../core/spider.js";
import type { SpiderOptions, SpiderStats } from "../core/spider.js";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Context passed to every route handler. */
interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  db: Database.Database;
  provider: EmbeddingProvider;
  url: URL;
  start: number;
}

// ---------------------------------------------------------------------------
// URL / path helpers
// ---------------------------------------------------------------------------

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

/** Match /api/v1/documents/:id/suggest-tags */
function matchDocumentSuggestTags(segments: string[]): string | null {
  if (
    segments.length === 5 &&
    segments[0] === "api" &&
    segments[1] === "v1" &&
    segments[2] === "documents" &&
    segments[4] === "suggest-tags"
  ) {
    return segments[3] ?? null;
  }
  return null;
}

/** Match /api/v1/documents/:id/links */
function matchDocumentLinks(segments: string[]): string | null {
  if (
    segments.length === 5 &&
    segments[0] === "api" &&
    segments[1] === "v1" &&
    segments[2] === "documents" &&
    segments[4] === "links"
  ) {
    return segments[3] ?? null;
  }
  return null;
}

/** Match /api/v1/links/:id */
function matchLinkId(segments: string[]): string | null {
  if (
    segments.length === 4 &&
    segments[0] === "api" &&
    segments[1] === "v1" &&
    segments[2] === "links"
  ) {
    return segments[3] ?? null;
  }
  return null;
}

/** Match /api/v1/searches/:id */
function matchSearchId(segments: string[]): string | null {
  if (
    segments.length === 4 &&
    segments[0] === "api" &&
    segments[1] === "v1" &&
    segments[2] === "searches"
  ) {
    return segments[3] ?? null;
  }
  return null;
}

/** Match /api/v1/searches/:id/run */
function matchSearchRun(segments: string[]): string | null {
  if (
    segments.length === 5 &&
    segments[0] === "api" &&
    segments[1] === "v1" &&
    segments[2] === "searches" &&
    segments[4] === "run"
  ) {
    return segments[3] ?? null;
  }
  return null;
}

/** Match /api/v1/webhooks/:id */
function matchWebhookId(segments: string[]): string | null {
  if (
    segments.length === 4 &&
    segments[0] === "api" &&
    segments[1] === "v1" &&
    segments[2] === "webhooks"
  ) {
    const id = segments[3];
    return id ?? null;
  }
  return null;
}

/** Match /api/v1/webhooks/:id/test */
function matchWebhookTest(segments: string[]): string | null {
  if (
    segments.length === 5 &&
    segments[0] === "api" &&
    segments[1] === "v1" &&
    segments[2] === "webhooks" &&
    segments[4] === "test"
  ) {
    return segments[3] ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parameter parsing helpers
// ---------------------------------------------------------------------------

/** Parse an optional integer search param, returning NaN if absent/invalid. */
function parseOptionalInt(url: URL, name: string): number {
  const raw = url.searchParams.get(name);
  return raw ? Number.parseInt(raw, 10) : Number.NaN;
}

/** Parse an optional integer param clamped to [min, max], with a fallback default. */
function parseClampedInt(
  url: URL,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = parseOptionalInt(url, name);
  return Number.isNaN(parsed) ? fallback : Math.max(min, Math.min(parsed, max));
}

/** Parse an optional integer param clamped to [min, max], returning undefined if absent. */
function parseClampedIntOrUndefined(
  url: URL,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const parsed = parseOptionalInt(url, name);
  return Number.isNaN(parsed) ? undefined : Math.max(min, Math.min(parsed, max));
}

/** Compute elapsed milliseconds since start. */
function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

/** Parse a JSON request body, returning null-guarded record or sending a 400 error. */
async function requireJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {
  const body = await parseJsonBody(req);
  if (!body || typeof body !== "object") {
    sendError(res, 400, "VALIDATION_ERROR", "Request body must be a JSON object");
    return null;
  }
  return body as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Route handlers — each has low cognitive complexity
// ---------------------------------------------------------------------------

function handleOpenApiSpec(ctx: RouteContext): void {
  ctx.res.writeHead(200, { "Content-Type": "application/json" });
  ctx.res.end(JSON.stringify(OPENAPI_SPEC));
}

function handleHealthCheck(ctx: RouteContext): void {
  const config = loadConfig();
  const dbPath = config.database?.path;
  const stats = getStats(ctx.db, dbPath);
  sendJson(
    ctx.res,
    200,
    { status: "ok", docCount: stats.totalDocuments, dbSize: stats.databaseSizeBytes },
    elapsed(ctx.start),
  );
}

async function handleSearch(ctx: RouteContext): Promise<void> {
  const q = ctx.url.searchParams.get("q") ?? "";
  if (!q) {
    sendError(ctx.res, 400, "VALIDATION_ERROR", "Query parameter 'q' is required");
    return;
  }
  if (q.length > 10_000) {
    sendError(
      ctx.res,
      400,
      "VALIDATION_ERROR",
      "Query parameter 'q' exceeds maximum length (10000)",
    );
    return;
  }
  const topic = ctx.url.searchParams.get("topic") ?? undefined;
  const source = ctx.url.searchParams.get("source") ?? undefined;
  const tag = ctx.url.searchParams.get("tag") ?? undefined;
  const limit = parseClampedIntOrUndefined(ctx.url, "limit", 1, 1000);
  const offsetParsed = parseOptionalInt(ctx.url, "offset");
  const offset = Number.isNaN(offsetParsed) ? undefined : Math.max(0, offsetParsed);
  const tags = tag ? [tag] : undefined;
  const maxChunksPerDocument = parseClampedIntOrUndefined(ctx.url, "maxChunksPerDocument", 1, 100);

  const result = await searchDocuments(ctx.db, ctx.provider, {
    query: q,
    topic,
    tags,
    source,
    limit,
    offset,
    maxChunksPerDocument,
  });
  sendJson(ctx.res, 200, result, elapsed(ctx.start));
}

async function handleBatchSearch(ctx: RouteContext): Promise<void> {
  const b = await requireJsonBody(ctx.req, ctx.res);
  if (!b) return;
  if (!Array.isArray(b["requests"])) {
    sendError(ctx.res, 400, "VALIDATION_ERROR", "Field 'requests' must be an array");
    return;
  }
  const result = await searchBatch(ctx.db, ctx.provider, b["requests"] as BatchSearchRequest[]);
  sendJson(ctx.res, 200, result, elapsed(ctx.start));
}

function handleListDocuments(ctx: RouteContext): void {
  const topicId = ctx.url.searchParams.get("topic") ?? undefined;
  const limit = parseClampedInt(ctx.url, "limit", 1, 1000, 100);
  const docs = listDocuments(ctx.db, { topicId, limit });
  sendJson(ctx.res, 200, docs, elapsed(ctx.start));
}

async function handleCreateDocument(ctx: RouteContext): Promise<void> {
  const b = await requireJsonBody(ctx.req, ctx.res);
  if (!b) return;
  if (typeof b["content"] !== "string" || typeof b["title"] !== "string") {
    sendError(
      ctx.res,
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

  const doc = await indexDocument(ctx.db, ctx.provider, {
    content: b["content"],
    title: b["title"],
    sourceType,
    topicId,
  });

  // Add tags if provided
  if (Array.isArray(b["tags"])) {
    const tagNames = (b["tags"] as unknown[]).filter((t): t is string => typeof t === "string");
    if (tagNames.length > 0) {
      addTagsToDocument(ctx.db, doc.id, tagNames);
    }
  }

  sendJson(ctx.res, 201, doc, elapsed(ctx.start));
}

/** Build spider options from the request body fields. */
function buildSpiderOptions(
  b: Record<string, unknown>,
  fetchOptions: { allowPrivateUrls: boolean; allowSelfSignedCerts: boolean },
): SpiderOptions {
  return {
    fetchOptions,
    ...(typeof b["maxPages"] === "number" ? { maxPages: b["maxPages"] } : {}),
    ...(typeof b["maxDepth"] === "number" ? { maxDepth: b["maxDepth"] } : {}),
    ...(typeof b["sameDomain"] === "boolean" ? { sameDomain: b["sameDomain"] } : {}),
    ...(typeof b["pathPrefix"] === "string" ? { pathPrefix: b["pathPrefix"] } : {}),
    ...(Array.isArray(b["excludePatterns"])
      ? {
          excludePatterns: (b["excludePatterns"] as unknown[]).filter(
            (p): p is string => typeof p === "string",
          ),
        }
      : {}),
  };
}

/** Validate that a body field is a positive integer (if present). Returns error message or null. */
function validatePositiveInt(
  b: Record<string, unknown>,
  field: string,
  label: string,
): string | null {
  if (b[field] === undefined) return null;
  const v = b[field];
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
    return `${label} must be a positive integer`;
  }
  return null;
}

/** Validate that a body field is a non-negative integer (if present). Returns error message or null. */
function validateNonNegativeInt(
  b: Record<string, unknown>,
  field: string,
  label: string,
): string | null {
  if (b[field] === undefined) return null;
  const v = b[field];
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
    return `${label} must be a non-negative integer`;
  }
  return null;
}

/** Handle spidering (crawling) a URL and indexing all pages. */
async function handleSpiderUrl(
  ctx: RouteContext,
  b: Record<string, unknown>,
  urlStr: string,
  topicId: string | undefined,
  fetchOptions: { allowPrivateUrls: boolean; allowSelfSignedCerts: boolean },
): Promise<void> {
  const maxPagesErr = validatePositiveInt(b, "maxPages", "maxPages");
  if (maxPagesErr) {
    sendError(ctx.res, 400, "VALIDATION_ERROR", maxPagesErr);
    return;
  }
  const maxDepthErr = validateNonNegativeInt(b, "maxDepth", "maxDepth");
  if (maxDepthErr) {
    sendError(ctx.res, 400, "VALIDATION_ERROR", maxDepthErr);
    return;
  }

  const spiderOptions = buildSpiderOptions(b, fetchOptions);
  const indexedDocs: Array<{ id: string; title: string; url: string }> = [];
  const errors: Array<{ url: string; error: string }> = [];
  let stats: SpiderStats = { pagesFetched: 0, pagesCrawled: 0, pagesSkipped: 0, errors };

  const gen = spiderUrl(urlStr, spiderOptions);
  let result = await gen.next();
  while (!result.done) {
    const page = result.value;
    try {
      const doc = await indexDocument(ctx.db, ctx.provider, {
        content: page.content,
        title: page.title,
        sourceType: "manual",
        url: page.url,
        topicId,
      });
      indexedDocs.push({ id: doc.id, title: page.title, url: page.url });
    } catch (indexErr) {
      const msg = indexErr instanceof Error ? indexErr.message : String(indexErr);
      errors.push({ url: page.url, error: msg });
    }
    result = await gen.next();
  }
  // result.value is SpiderStats when done (generator is exhausted)
  if (result.done && result.value) {
    stats = result.value;
    stats.errors = errors;
  }

  sendJson(
    ctx.res,
    201,
    {
      documents: indexedDocs,
      pagesFetched: indexedDocs.length,
      pagesCrawled: stats.pagesCrawled,
      pagesSkipped: stats.pagesSkipped,
      errors,
      abortReason: stats.abortReason ?? null,
    },
    elapsed(ctx.start),
  );
}

async function handleIndexFromUrl(ctx: RouteContext): Promise<void> {
  const b = await requireJsonBody(ctx.req, ctx.res);
  if (!b) return;
  if (typeof b["url"] !== "string") {
    sendError(ctx.res, 400, "VALIDATION_ERROR", "Field 'url' is required");
    return;
  }
  const urlStr = b["url"];
  const topicId = typeof b["topic"] === "string" ? b["topic"] : undefined;
  const config = loadConfig();
  const fetchOptions = {
    allowPrivateUrls: config.indexing.allowPrivateUrls,
    allowSelfSignedCerts: config.indexing.allowSelfSignedCerts,
  };

  // Spider mode — crawl linked pages
  if (b["spider"] === true) {
    await handleSpiderUrl(ctx, b, urlStr, topicId, fetchOptions);
    return;
  }

  // Single-URL mode (default)
  const fetched = await fetchAndConvert(urlStr, fetchOptions);
  const doc = await indexDocument(ctx.db, ctx.provider, {
    content: fetched.content,
    title: fetched.title,
    sourceType: "manual",
    url: urlStr,
    topicId,
  });
  sendJson(ctx.res, 201, doc, elapsed(ctx.start));
}

/** Handle SSE streaming for ask endpoint. */
async function handleAskStream(ctx: RouteContext, b: Record<string, unknown>): Promise<void> {
  const config = loadConfig();
  const llm = createLlmProvider(config);
  const topic = typeof b["topic"] === "string" ? b["topic"] : undefined;

  ctx.res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let clientDisconnected = false;
  const disconnectPromise = new Promise<void>((resolve) => {
    ctx.req.on("close", () => {
      clientDisconnected = true;
      resolve();
    });
  });

  try {
    const stream = askQuestionStream(ctx.db, ctx.provider, llm, {
      question: b["question"] as string,
      topic,
    });

    for await (const event of stream) {
      if (clientDisconnected) break;
      const ok = ctx.res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (!ok) {
        await Promise.race([
          new Promise<void>((resolve) => ctx.res.once("drain", resolve)),
          disconnectPromise,
        ]);
      }
    }
  } catch (streamErr: unknown) {
    const message = streamErr instanceof Error ? streamErr.message : "Internal server error";
    ctx.res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  }

  ctx.res.end();
}

async function handleAsk(ctx: RouteContext): Promise<void> {
  const b = await requireJsonBody(ctx.req, ctx.res);
  if (!b) return;
  if (typeof b["question"] !== "string") {
    sendError(ctx.res, 400, "VALIDATION_ERROR", "Field 'question' is required");
    return;
  }

  const accept = ctx.req.headers["accept"] ?? "";
  if (accept.includes("text/event-stream")) {
    await handleAskStream(ctx, b);
    return;
  }

  const config = loadConfig();
  const llm = createLlmProvider(config);
  const topic = typeof b["topic"] === "string" ? b["topic"] : undefined;
  const result = await askQuestion(ctx.db, ctx.provider, llm, { question: b["question"], topic });
  sendJson(ctx.res, 200, result, elapsed(ctx.start));
}

function handleListTopics(ctx: RouteContext): void {
  const topics = listTopics(ctx.db);
  sendJson(ctx.res, 200, topics, elapsed(ctx.start));
}

async function handleCreateTopic(ctx: RouteContext): Promise<void> {
  const b = await requireJsonBody(ctx.req, ctx.res);
  if (!b) return;
  if (typeof b["name"] !== "string") {
    sendError(ctx.res, 400, "VALIDATION_ERROR", "Field 'name' is required");
    return;
  }
  const parentId = typeof b["parentId"] === "string" ? b["parentId"] : undefined;
  const topic = createTopic(ctx.db, { name: b["name"], parentId });
  sendJson(ctx.res, 201, topic, elapsed(ctx.start));
}

function handleListTags(ctx: RouteContext): void {
  const tags = listTags(ctx.db);
  sendJson(ctx.res, 200, tags, elapsed(ctx.start));
}

async function handleAddTagsToDocument(ctx: RouteContext, docId: string): Promise<void> {
  const b = await requireJsonBody(ctx.req, ctx.res);
  if (!b) return;
  if (!Array.isArray(b["tags"])) {
    sendError(ctx.res, 400, "VALIDATION_ERROR", "Field 'tags' must be an array of strings");
    return;
  }
  const tagNames = (b["tags"] as unknown[]).filter((t): t is string => typeof t === "string");
  const tags = addTagsToDocument(ctx.db, docId, tagNames);
  sendJson(ctx.res, 200, tags, elapsed(ctx.start));
}

function handleSuggestTags(ctx: RouteContext, docId: string): void {
  const limitRaw = ctx.url.searchParams.get("limit");
  const limit = limitRaw ? parseInt(limitRaw, 10) : 5;
  const suggestions = suggestTags(ctx.db, docId, limit);
  sendJson(ctx.res, 200, { documentId: docId, suggestions }, elapsed(ctx.start));
}

function handleSearchAnalytics(ctx: RouteContext): void {
  const days = parseClampedInt(ctx.url, "days", 1, 365, 30);
  const analytics = getSearchAnalytics(ctx.db, days);
  const gaps = getKnowledgeGaps(ctx.db, days);
  sendJson(ctx.res, 200, { ...analytics, knowledgeGaps: gaps }, elapsed(ctx.start));
}

function handleConnectorStatus(ctx: RouteContext): void {
  const connectorType = ctx.url.searchParams.get("type") ?? undefined;
  const connectorName = ctx.url.searchParams.get("name") ?? undefined;
  const history = ctx.url.searchParams.get("history");
  const limit = parseClampedIntOrUndefined(ctx.url, "limit", 1, 1000);

  let data;
  if (history === "true") {
    data = getSyncHistory(ctx.db, connectorType, limit);
  } else {
    data = getConnectorStatus(ctx.db, connectorType, connectorName);
  }
  sendJson(ctx.res, 200, data, elapsed(ctx.start));
}

function handleScheduleStatus(ctx: RouteContext): void {
  const entries = loadScheduleEntries();
  sendJson(ctx.res, 200, { schedules: entries }, elapsed(ctx.start));
}

function handleStats(ctx: RouteContext): void {
  const config = loadConfig();
  const dbPath = config.database?.path;
  const stats = getStats(ctx.db, dbPath);
  sendJson(ctx.res, 200, stats, elapsed(ctx.start));
}

function handleGetDocument(ctx: RouteContext, docId: string): void {
  const doc = getDocument(ctx.db, docId);
  sendJson(ctx.res, 200, doc, elapsed(ctx.start));
}

function handleDeleteDocument(ctx: RouteContext, docId: string): void {
  deleteDocument(ctx.db, docId);
  ctx.res.writeHead(204);
  ctx.res.end();
}

/** Parse and validate URL metadata for PATCH. Returns error message or null. */
function validateUrlMetadata(urlStr: string): string | null {
  try {
    const parsedUrl = new URL(urlStr);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return "URL must use http or https scheme";
    }
  } catch {
    return "Invalid URL format";
  }
  return null;
}

/** Extract an optional string field from the body, returning null for non-strings. */
function extractOptionalString(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (body[key] === undefined) return undefined;
  return typeof body[key] === "string" ? body[key] : null;
}

/** Parse metadata fields from an update request body. */
function parseUpdateMetadata(body: Record<string, unknown>):
  | {
      library?: string | null;
      version?: string | null;
      url?: string | null;
      topicId?: string | null;
    }
  | undefined {
  const metadata: Record<string, string | null | undefined> = {};
  const library = extractOptionalString(body, "library");
  if (library !== undefined) metadata.library = library;
  const version = extractOptionalString(body, "version");
  if (version !== undefined) metadata.version = version;
  const url = extractOptionalString(body, "url");
  if (url !== undefined) metadata.url = url;
  const topicId = extractOptionalString(body, "topicId");
  if (topicId !== undefined) metadata.topicId = topicId;
  return Object.keys(metadata).length > 0
    ? (metadata as {
        library?: string | null;
        version?: string | null;
        url?: string | null;
        topicId?: string | null;
      })
    : undefined;
}

async function handleUpdateDocument(ctx: RouteContext, docId: string): Promise<void> {
  const b = await requireJsonBody(ctx.req, ctx.res);
  if (!b) return;
  const title = typeof b["title"] === "string" ? b["title"] : undefined;
  const content = typeof b["content"] === "string" ? b["content"] : undefined;
  const metadata = parseUpdateMetadata(b);
  if (metadata?.url) {
    const urlErr = validateUrlMetadata(metadata.url);
    if (urlErr) {
      sendError(ctx.res, 400, "VALIDATION_ERROR", urlErr);
      return;
    }
  }
  const doc = await updateDocument(ctx.db, ctx.provider, docId, { title, content, metadata });
  sendJson(ctx.res, 200, doc, elapsed(ctx.start));
}

function handleGetDocumentLinks(ctx: RouteContext, docId: string): void {
  const links = getDocumentLinks(ctx.db, docId);
  sendJson(ctx.res, 200, links, elapsed(ctx.start));
}

async function handleCreateDocumentLink(ctx: RouteContext, docId: string): Promise<void> {
  const body = (await parseJsonBody(ctx.req)) as {
    targetId?: string;
    linkType?: string;
    label?: string;
  };
  if (!body.targetId || !body.linkType) {
    sendError(ctx.res, 400, "VALIDATION_ERROR", "targetId and linkType are required");
    return;
  }
  const validLinkTypes = ["see_also", "prerequisite", "supersedes", "related"];
  if (!validLinkTypes.includes(body.linkType)) {
    sendError(
      ctx.res,
      400,
      "VALIDATION_ERROR",
      `Invalid linkType: ${body.linkType}. Must be one of: ${validLinkTypes.join(", ")}`,
    );
    return;
  }
  const link = createLink(ctx.db, docId, body.targetId, body.linkType as LinkType, body.label);
  sendJson(ctx.res, 201, link, elapsed(ctx.start));
}

function handleDeleteLink(ctx: RouteContext, linkId: string): void {
  deleteLink(ctx.db, linkId);
  ctx.res.writeHead(204);
  ctx.res.end();
}

async function handleRunSavedSearch(ctx: RouteContext, searchId: string): Promise<void> {
  const { search, results } = await runSavedSearch(ctx.db, ctx.provider, searchId);
  sendJson(ctx.res, 200, { search, resultCount: results.length, results }, elapsed(ctx.start));
}

function handleListSavedSearches(ctx: RouteContext): void {
  const searchLimit = parseClampedInt(ctx.url, "limit", 1, 1000, 50);
  const searchOffset = parseClampedInt(ctx.url, "offset", 0, Number.MAX_SAFE_INTEGER, 0);
  const searches = listSavedSearches(ctx.db, searchLimit, searchOffset);
  sendJson(ctx.res, 200, searches, elapsed(ctx.start));
}

async function handleCreateSavedSearch(ctx: RouteContext): Promise<void> {
  const body = (await parseJsonBody(ctx.req)) as {
    name?: string;
    query?: string;
    filters?: Record<string, unknown>;
  };
  if (!body.name || !body.query) {
    sendError(ctx.res, 400, "VALIDATION_ERROR", "name and query are required");
    return;
  }
  const saved = createSavedSearch(ctx.db, body.name, body.query, body.filters);
  sendJson(ctx.res, 201, saved, elapsed(ctx.start));
}

function handleDeleteSavedSearch(ctx: RouteContext, searchId: string): void {
  deleteSavedSearch(ctx.db, searchId);
  ctx.res.writeHead(204);
  ctx.res.end();
}

async function handleBulkOperation(ctx: RouteContext, operation: string): Promise<void> {
  const body = (await parseJsonBody(ctx.req)) as {
    selector?: BulkSelector;
    dryRun?: boolean;
    addTags?: string[];
    removeTags?: string[];
    targetTopicId?: string;
  };

  if (!body.selector) {
    sendError(ctx.res, 400, "VALIDATION_ERROR", "selector is required");
    return;
  }

  if (operation === "delete") {
    const result = bulkDelete(ctx.db, body.selector, body.dryRun ?? false);
    sendJson(ctx.res, 200, result, elapsed(ctx.start));
    return;
  }

  if (operation === "retag") {
    const result = bulkRetag(
      ctx.db,
      body.selector,
      body.addTags,
      body.removeTags,
      body.dryRun ?? false,
    );
    sendJson(ctx.res, 200, result, elapsed(ctx.start));
    return;
  }

  if (operation === "move") {
    if (!body.targetTopicId) {
      sendError(ctx.res, 400, "VALIDATION_ERROR", "targetTopicId is required");
      return;
    }
    const result = bulkMove(ctx.db, body.selector, body.targetTopicId, body.dryRun ?? false);
    sendJson(ctx.res, 200, result, elapsed(ctx.start));
    return;
  }

  sendError(
    ctx.res,
    400,
    "VALIDATION_ERROR",
    `Invalid bulk operation: ${operation}. Valid operations are: delete, retag, move`,
  );
}

function handleListWebhooks(ctx: RouteContext): void {
  const webhookLimit = parseClampedInt(ctx.url, "limit", 1, 1000, 50);
  const webhookOffset = parseClampedInt(ctx.url, "offset", 0, Number.MAX_SAFE_INTEGER, 0);
  const webhooks = listWebhooks(ctx.db, webhookLimit, webhookOffset);
  sendJson(ctx.res, 200, webhooks.map(redactWebhook), elapsed(ctx.start));
}

async function handleCreateWebhook(ctx: RouteContext): Promise<void> {
  const body = (await parseJsonBody(ctx.req)) as {
    url?: string;
    events?: string[];
    secret?: string;
  };
  if (!body.url || !body.events) {
    sendError(ctx.res, 400, "VALIDATION_ERROR", "url and events are required");
    return;
  }
  const webhook = await createWebhook(ctx.db, body.url, body.events as WebhookEvent[], body.secret);
  sendJson(ctx.res, 201, redactWebhook(webhook), elapsed(ctx.start));
}

async function handleTestWebhook(ctx: RouteContext, webhookId: string): Promise<void> {
  const webhook = getWebhook(ctx.db, webhookId);
  await validateWebhookUrlSsrf(webhook.url);
  const body = buildPayload("document.created", { test: true, message: "Webhook test ping" });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (webhook.secret) {
    headers["X-LibScope-Signature"] = signPayload(body, webhook.secret);
  }
  const resp = await fetch(webhook.url, {
    method: "POST",
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  sendJson(ctx.res, 200, { status: resp.status, statusText: resp.statusText }, elapsed(ctx.start));
}

function handleDeleteWebhook(ctx: RouteContext, webhookId: string): void {
  deleteWebhook(ctx.db, webhookId);
  ctx.res.writeHead(204);
  ctx.res.end();
}

// ---------------------------------------------------------------------------
// Error classification helper
// ---------------------------------------------------------------------------

function handleRouteError(
  res: ServerResponse,
  err: unknown,
  method: string,
  pathname: string,
): void {
  const log = getLogger();
  log.error({ err, method, pathname }, "API request error");

  if (err instanceof DocumentNotFoundError) {
    sendError(res, 404, "NOT_FOUND", err.message);
    return;
  }
  if (err instanceof FetchError) {
    sendError(res, 502, "FETCH_ERROR", err.message);
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

  log.error({ err }, "Unhandled error in request handler");
  sendError(res, 500, "INTERNAL_ERROR", "Internal server error");
}

// ---------------------------------------------------------------------------
// Path-based route matching helpers (for segment-matched routes)
// ---------------------------------------------------------------------------

function isApiV1Path(segments: string[], resource: string): boolean {
  return (
    segments.length === 3 &&
    segments[0] === "api" &&
    segments[1] === "v1" &&
    segments[2] === resource
  );
}

function isBulkPath(segments: string[]): boolean {
  return (
    segments.length === 4 && segments[0] === "api" && segments[1] === "v1" && segments[2] === "bulk"
  );
}

// ---------------------------------------------------------------------------
// Segment-based route dispatcher (document/:id, links, searches, webhooks, bulk)
// ---------------------------------------------------------------------------

/** Dispatch single-document CRUD routes (GET/DELETE/PATCH /documents/:id). */
async function dispatchDocumentCrudRoutes(
  ctx: RouteContext,
  docId: string,
  method: string,
): Promise<boolean> {
  if (method === "GET") {
    handleGetDocument(ctx, docId);
    return true;
  }
  if (method === "DELETE") {
    handleDeleteDocument(ctx, docId);
    return true;
  }
  if (method === "PATCH") {
    await handleUpdateDocument(ctx, docId);
    return true;
  }
  return false;
}

/** Dispatch document-related segment routes (tags, suggest, CRUD, links). */
async function dispatchDocumentRoutes(
  ctx: RouteContext,
  segments: string[],
  method: string,
): Promise<boolean> {
  const tagDocId = matchDocumentTags(segments);
  if (tagDocId && method === "POST") {
    await handleAddTagsToDocument(ctx, tagDocId);
    return true;
  }
  const suggestDocId = matchDocumentSuggestTags(segments);
  if (suggestDocId && method === "GET") {
    handleSuggestTags(ctx, suggestDocId);
    return true;
  }
  const docId = matchDocumentId(segments);
  if (docId) return dispatchDocumentCrudRoutes(ctx, docId, method);
  const linksDocId = matchDocumentLinks(segments);
  if (linksDocId && method === "GET") {
    handleGetDocumentLinks(ctx, linksDocId);
    return true;
  }
  if (linksDocId && method === "POST") {
    await handleCreateDocumentLink(ctx, linksDocId);
    return true;
  }
  const linkId = matchLinkId(segments);
  if (linkId && method === "DELETE") {
    handleDeleteLink(ctx, linkId);
    return true;
  }
  return false;
}

/** Dispatch webhook segment routes. */
async function dispatchWebhookRoutes(
  ctx: RouteContext,
  segments: string[],
  method: string,
): Promise<boolean> {
  if (isApiV1Path(segments, "webhooks") && method === "GET") {
    handleListWebhooks(ctx);
    return true;
  }
  if (isApiV1Path(segments, "webhooks") && method === "POST") {
    await handleCreateWebhook(ctx);
    return true;
  }
  const webhookTestId = matchWebhookTest(segments);
  if (webhookTestId && method === "POST") {
    await handleTestWebhook(ctx, webhookTestId);
    return true;
  }
  const webhookId = matchWebhookId(segments);
  if (webhookId && method === "DELETE") {
    handleDeleteWebhook(ctx, webhookId);
    return true;
  }
  return false;
}

/** Dispatch search, bulk, and webhook segment routes. */
async function dispatchMiscSegmentRoutes(
  ctx: RouteContext,
  segments: string[],
  method: string,
): Promise<boolean> {
  const searchRunId = matchSearchRun(segments);
  if (searchRunId && method === "POST") {
    await handleRunSavedSearch(ctx, searchRunId);
    return true;
  }
  if (isApiV1Path(segments, "searches") && method === "GET") {
    handleListSavedSearches(ctx);
    return true;
  }
  if (isApiV1Path(segments, "searches") && method === "POST") {
    await handleCreateSavedSearch(ctx);
    return true;
  }
  if (isBulkPath(segments) && method === "POST") {
    const operation = segments[3] as string;
    await handleBulkOperation(ctx, operation);
    return true;
  }
  const savedSearchId = matchSearchId(segments);
  if (savedSearchId && method === "DELETE") {
    handleDeleteSavedSearch(ctx, savedSearchId);
    return true;
  }
  return dispatchWebhookRoutes(ctx, segments, method);
}

async function dispatchSegmentRoutes(
  ctx: RouteContext,
  segments: string[],
  method: string,
): Promise<boolean> {
  const docHandled = await dispatchDocumentRoutes(ctx, segments, method);
  if (docHandled) return true;
  return dispatchMiscSegmentRoutes(ctx, segments, method);
}

// ---------------------------------------------------------------------------
// Pathname-based route dispatcher (simple /api/v1/... paths)
// ---------------------------------------------------------------------------

/** Route table: maps "METHOD /path" → handler. */
const PATHNAME_ROUTES: Record<string, (ctx: RouteContext) => void | Promise<void>> = {
  "GET /openapi.json": handleOpenApiSpec,
  "GET /api/v1/health": handleHealthCheck,
  "GET /api/v1/search": handleSearch,
  "POST /api/v1/batch-search": handleBatchSearch,
  "GET /api/v1/documents": handleListDocuments,
  "POST /api/v1/documents": handleCreateDocument,
  "POST /api/v1/documents/url": handleIndexFromUrl,
  "POST /api/v1/ask": handleAsk,
  "GET /api/v1/topics": handleListTopics,
  "POST /api/v1/topics": handleCreateTopic,
  "GET /api/v1/tags": handleListTags,
  "GET /api/v1/analytics/searches": handleSearchAnalytics,
  "GET /api/v1/connectors/status": handleConnectorStatus,
  "GET /api/v1/connectors/schedules": handleScheduleStatus,
  "GET /api/v1/stats": handleStats,
};

async function dispatchPathnameRoutes(
  ctx: RouteContext,
  pathname: string,
  method: string,
): Promise<boolean> {
  const handler = PATHNAME_ROUTES[`${method} ${pathname}`];
  if (!handler) return false;
  await handler(ctx);
  return true;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  provider: EmbeddingProvider,
): Promise<void> {
  const start = performance.now();
  const url = parseUrl(req);
  const pathname = url.pathname;
  const method = req.method ?? "GET";
  const segments = extractPathSegments(pathname);

  const ctx: RouteContext = { req, res, db, provider, url, start };

  try {
    // Try simple pathname-based routes first
    const pathnameHandled = await dispatchPathnameRoutes(ctx, pathname, method);
    if (pathnameHandled) return;

    // Try segment-matched routes (document/:id, links, searches, webhooks, bulk)
    const segmentHandled = await dispatchSegmentRoutes(ctx, segments, method);
    if (segmentHandled) return;

    // Unknown route — don't leak method/pathname to prevent endpoint enumeration
    sendError(res, 404, "NOT_FOUND", "Route not found");
  } catch (err: unknown) {
    handleRouteError(res, err, method, pathname);
  }
}
