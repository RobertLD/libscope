import { z } from "zod";
import { ValidationError } from "../../errors.js";
import {
  assertDocumentExists,
  countDocuments,
  deleteDocument,
  listDocuments,
  updateDocument,
  type Document,
} from "../documents.js";
import { getDocumentView } from "../document-view.js";
import { detectIngestKind, ingest } from "../ingest.js";
import { rateDocument } from "../ratings.js";
import { addTagsToDocument, getDocumentTags, removeTagsFromDocument } from "../tags.js";
import { findTopicId, resolveTopicId } from "../topics.js";
import { getVersionHistory, rollbackToVersion } from "../versioning.js";
import * as s from "./schemas.js";
import { defineOperation, type ListResult, type OperationContext } from "./types.js";

/** A document without its content, for listings. */
export type DocumentSummary = Omit<Document, "content" | "id"> & {
  documentId: string;
  contentLength: number;
};

export function toDocumentSummary(doc: Document): DocumentSummary {
  const { id, content, ...rest } = doc;
  return { documentId: id, contentLength: content.length, ...rest };
}

/** Topic ID for a write: the topic must exist (by ID or name). */
function topicForWrite(ctx: OperationContext, topic: string | undefined): string | undefined {
  return topic === undefined ? undefined : resolveTopicId(ctx.db, topic);
}

/** Topic ID for a filter: a name is resolved; an unknown value filters by itself (no match). */
export function topicForFilter(
  ctx: OperationContext,
  topic: string | undefined,
): string | undefined {
  return topic === undefined ? undefined : (findTopicId(ctx.db, topic) ?? topic);
}

export const addOperation = defineOperation({
  name: "add",
  group: "documents",
  summary:
    "Add content to the knowledge base: inline content, a URL (optionally crawled), a GitHub/GitLab repository, or (CLI/SDK only) a local file or directory",
  input: z.object({
    source: z
      .string()
      .min(1)
      .optional()
      .describe("What to add: a URL, a repository URL, or (CLI/SDK) a file or directory path"),
    content: z.string().min(1).optional().describe("Inline document content (markdown)"),
    title: z
      .string()
      .min(1)
      .optional()
      .describe("Title (required with content; detected for files and URLs)"),
    url: s.url
      .optional()
      .describe("Source URL. Without content, the URL is fetched; with content, it is stored"),
    kind: z
      .enum(["auto", "content", "file", "directory", "url", "repo"])
      .default("auto")
      .describe("How to read source (default: detect from the value)"),
    topic: s.opt(s.topic),
    library: s.opt(s.library),
    version: s.opt(s.version),
    sourceType: s.sourceType
      .optional()
      .describe(
        "Source type (default: library if library is set, topic if topic is set, else manual)",
      ),
    tags: s.tags.optional().describe("Tags to add to every new document"),
    expiresAt: z.iso
      .datetime()
      .optional()
      .describe("ISO 8601 time after which the document is pruned"),
    dedup: z
      .enum(["skip", "warn", "force"])
      .optional()
      .describe(
        "Duplicate handling: skip returns the existing document, warn indexes anyway, force skips the check",
      ),
    format: z.string().min(1).optional().describe("Force a file format, e.g. .pdf"),
    include: z.array(z.string()).optional().describe("Directory: globs of files to include"),
    exclude: z.array(z.string()).optional().describe("Directory: globs of files to skip"),
    spider: z.boolean().default(false).describe("URL: also crawl linked pages"),
    maxPages: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Crawl: page limit (default 25, max 200)"),
    maxDepth: z.number().int().min(0).optional().describe("Crawl: link depth (default 2, max 5)"),
    sameDomain: z.boolean().optional().describe("Crawl: stay on the seed domain (default true)"),
    pathPrefix: z.string().optional().describe("Crawl: only follow links under this path"),
    excludePatterns: z.array(z.string()).optional().describe("Crawl: globs of URLs to skip"),
    branch: z
      .string()
      .min(1)
      .optional()
      .describe("Repository: branch (default: from URL, else main)"),
    paths: z.array(z.string()).optional().describe("Repository: only these subdirectories"),
    extensions: z
      .array(z.string())
      .optional()
      .describe("Repository: file extensions (default .md, .mdx, .txt, .rst)"),
    token: z
      .string()
      .min(1)
      .optional()
      .describe("Repository: access token for private repositories"),
    dryRun: z.boolean().default(false).describe("List what would be added without adding it"),
  }),
  annotations: { longRunning: true },
  http: { method: "POST", path: "/documents" },
  async handler(ctx, input) {
    const source = input.source ?? (input.content === undefined ? input.url : undefined);
    const ingestInput = {
      ...input,
      source,
      topic: topicForWrite(ctx, input.topic),
    };
    const kind = detectIngestKind(ingestInput);
    // Remote callers must not read files from the server's disk.
    if (
      (kind === "file" || kind === "directory") &&
      (ctx.surface === "mcp" || ctx.surface === "api")
    ) {
      throw new ValidationError(
        "Adding local files or directories is only available from the CLI and SDK",
      );
    }
    return ingest(
      {
        db: ctx.db,
        provider: ctx.provider,
        fetchOptions: {
          allowPrivateUrls: ctx.config.indexing.allowPrivateUrls,
          allowSelfSignedCerts: ctx.config.indexing.allowSelfSignedCerts,
        },
        submittedBy: ctx.surface === "mcp" ? "model" : "manual",
        signal: ctx.signal,
        onProgress: ctx.onProgress,
      },
      { ...ingestInput, kind },
    );
  },
});

export const getDocumentOperation = defineOperation({
  name: "get-document",
  group: "documents",
  summary: "Get a document with its tags, links and rating summary; long content can be paged",
  input: z.object({
    documentId: s.documentId,
    offset: z.number().int().min(0).default(0).describe("Character offset into the content"),
    maxLength: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum characters of content to return (default: all)"),
  }),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/documents/:documentId" },
  handler: (ctx, input) =>
    getDocumentView(ctx.db, input.documentId, { offset: input.offset, maxLength: input.maxLength }),
});

export const listDocumentsOperation = defineOperation({
  name: "list-documents",
  group: "documents",
  summary: "List documents (newest first) with optional filters",
  input: z.object({
    ...s.documentFilters,
    limit: s.limit(50, 1000),
    offset: s.offset,
  }),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/documents" },
  handler(ctx, input): ListResult<DocumentSummary> {
    const filters = {
      library: input.library,
      version: input.version,
      topicId: topicForFilter(ctx, input.topic),
      sourceType: input.sourceType,
      tags: input.tags,
    };
    return {
      items: listDocuments(ctx.db, { ...filters, limit: input.limit, offset: input.offset }).map(
        toDocumentSummary,
      ),
      total: countDocuments(ctx.db, filters),
      limit: input.limit,
      offset: input.offset,
    };
  },
});

/** Make the document's tags exactly `tags`. */
function replaceTags(ctx: OperationContext, documentId: string, tags: string[]): void {
  const wanted = new Set(tags.map((t) => t.trim().toLowerCase()));
  const current = getDocumentTags(ctx.db, documentId).map((t) => t.name);
  removeTagsFromDocument(
    ctx.db,
    documentId,
    current.filter((t) => !wanted.has(t)),
  );
  addTagsToDocument(ctx.db, documentId, [...wanted]);
}

export const updateDocumentOperation = defineOperation({
  name: "update-document",
  group: "documents",
  summary: "Update a document's title, content, metadata or tags (content changes are re-indexed)",
  input: z.object({
    documentId: s.documentId,
    title: z.string().min(1).optional().describe("New title"),
    content: z.string().min(1).optional().describe("New content (re-chunked and re-embedded)"),
    library: s.library.nullable().optional().describe("New library (null clears it)"),
    version: s.version.nullable().optional().describe("New version (null clears it)"),
    url: s.url.nullable().optional().describe("New URL (null clears it)"),
    topic: s.topic.nullable().optional().describe("New topic ID or name (null clears it)"),
    tags: s.tags.optional().describe("Replace the document's tags with these"),
  }),
  annotations: { idempotent: true },
  http: { method: "PATCH", path: "/documents/:documentId" },
  async handler(ctx, input) {
    const { documentId, title, content, tags, topic, ...meta } = input;
    if (Object.values(input).filter((v) => v !== undefined).length === 1) {
      throw new ValidationError("Nothing to update: give at least one field to change");
    }
    assertDocumentExists(ctx.db, documentId);
    const metadata = {
      ...meta,
      ...(topic === undefined
        ? {}
        : { topicId: topic === null ? null : resolveTopicId(ctx.db, topic) }),
    };
    const hasDocChange =
      title !== undefined || content !== undefined || Object.keys(metadata).length > 0;
    if (hasDocChange) {
      await updateDocument(ctx.db, ctx.provider, documentId, { title, content, metadata });
    }
    if (tags) replaceTags(ctx, documentId, tags);
    return getDocumentView(ctx.db, documentId, { maxLength: 0 });
  },
});

export const deleteDocumentOperation = defineOperation({
  name: "delete-document",
  group: "documents",
  summary: "Delete a document with its chunks, vectors, tags, links and ratings",
  input: z.object({ documentId: s.documentId }),
  annotations: { destructive: true },
  http: { method: "DELETE", path: "/documents/:documentId" },
  handler(ctx, input) {
    deleteDocument(ctx.db, input.documentId);
    return { documentId: input.documentId, deleted: true };
  },
});

export const rateDocumentOperation = defineOperation({
  name: "rate-document",
  group: "documents",
  summary: "Rate a document (1-5), optionally with feedback or a suggested correction",
  input: z.object({
    documentId: s.documentId,
    chunkId: s.chunkId.optional().describe("Rate one chunk of the document"),
    rating: z.number().int().min(1).max(5).describe("1 (poor) to 5 (excellent)"),
    feedback: z.string().min(1).optional().describe("What is good or wrong"),
    suggestedCorrection: z
      .string()
      .min(1)
      .optional()
      .describe("Replacement text if the content is wrong"),
  }),
  http: { method: "POST", path: "/documents/:documentId/ratings" },
  handler: (ctx, input) =>
    rateDocument(ctx.db, { ...input, ratedBy: ctx.surface === "mcp" ? "model" : "user" }),
});

export const documentHistoryOperation = defineOperation({
  name: "document-history",
  group: "documents",
  summary: "List saved versions of a document, newest first",
  input: z.object({ documentId: s.documentId }),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/documents/:documentId/versions" },
  handler: (ctx, input) => ({ items: getVersionHistory(ctx.db, input.documentId) }),
});

export const rollbackDocumentOperation = defineOperation({
  name: "rollback-document",
  group: "documents",
  summary: "Restore a document to a saved version (the current state is saved first)",
  input: z.object({
    documentId: s.documentId,
    version: z.number().int().positive().describe("Version number from document-history"),
  }),
  http: { method: "POST", path: "/documents/:documentId/rollback" },
  handler: (ctx, input) => rollbackToVersion(ctx.db, ctx.provider, input.documentId, input.version),
});

export const documentOperations = [
  addOperation,
  getDocumentOperation,
  listDocumentsOperation,
  updateDocumentOperation,
  deleteDocumentOperation,
  rateDocumentOperation,
  documentHistoryOperation,
  rollbackDocumentOperation,
] as const;
