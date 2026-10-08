import { z } from "zod";
import { ValidationError } from "../../errors.js";
import { describeEmbeddingIdentity, rebuildVectorTable } from "../../db/index-meta.js";
import { createVectorTable } from "../../db/schema.js";
import { bulkDelete, bulkMove, bulkRetag, type BulkSelector } from "../bulk.js";
import { findDuplicates } from "../dedup.js";
import { exportKnowledgeBase, importFromBackup } from "../export.js";
import { getOverview } from "../overview.js";
import { reindex } from "../reindex.js";
import { resolveTopicId } from "../topics.js";
import { pruneExpiredDocuments } from "../ttl.js";
import * as s from "./schemas.js";
import { defineOperation, type OperationContext } from "./types.js";

export const overviewOperation = defineOperation({
  name: "overview",
  group: "admin",
  summary:
    "Knowledge base overview: counts, topics, installed packs, embedding model of the index, and health",
  input: z.object({}),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/overview" },
  handler: (ctx) => getOverview(ctx.db, ctx.provider),
});

export const reindexOperation = defineOperation({
  name: "reindex",
  group: "admin",
  summary: "Re-embed chunks with the configured embedding model (rebuild after changing models)",
  input: z.object({
    documentIds: z.array(s.documentId).optional().describe("Only these documents"),
    since: z.iso
      .date()
      .or(z.iso.datetime())
      .optional()
      .describe("Only documents created on or after"),
    before: z.iso
      .date()
      .or(z.iso.datetime())
      .optional()
      .describe("Only documents created on or before"),
    batchSize: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("Chunks per embedding call (default 50)"),
    rebuild: z
      .boolean()
      .default(false)
      .describe(
        "Drop and recreate the vector table for the configured model, then re-embed everything",
      ),
  }),
  annotations: { longRunning: true, idempotent: true },
  http: { method: "POST", path: "/admin/reindex" },
  async handler(ctx, input) {
    const filtered = input.documentIds ?? input.since ?? input.before;
    if (input.rebuild && filtered !== undefined) {
      throw new ValidationError(
        "rebuild re-embeds every chunk; it cannot be combined with filters",
      );
    }
    let index: string | undefined;
    if (input.rebuild) {
      index = describeEmbeddingIdentity(await rebuildVectorTable(ctx.db, ctx.provider));
    } else {
      createVectorTable(ctx.db, ctx.provider);
    }
    const result = await reindex(ctx.db, ctx.provider, {
      documentIds: input.documentIds,
      since: input.since,
      before: input.before,
      batchSize: input.batchSize,
      signal: ctx.signal,
      onProgress: (p) => ctx.onProgress?.({ done: p.completed + p.failed, total: p.total }),
    });
    return { ...result, ...(index === undefined ? {} : { rebuiltIndex: index }) };
  },
});

export const dedupeOperation = defineOperation({
  name: "dedupe",
  group: "admin",
  summary: "Find groups of duplicate or near-duplicate documents",
  input: z.object({
    threshold: z
      .number()
      .min(0)
      .max(1)
      .default(0.95)
      .describe("Similarity threshold for near-duplicates"),
    strategy: z
      .enum(["exact", "semantic", "both"])
      .default("both")
      .describe("exact: same content hash; semantic: embedding similarity"),
  }),
  annotations: { readOnly: true, longRunning: true },
  http: { method: "GET", path: "/admin/duplicates" },
  async handler(ctx, input) {
    return { items: await findDuplicates(ctx.db, ctx.provider, input) };
  },
});

function assertLocalFilesAllowed(ctx: OperationContext, what: string): void {
  if (ctx.surface === "api" || ctx.surface === "mcp") {
    throw new ValidationError(`${what} is only available from the CLI and SDK`);
  }
}

export const backupOperation = defineOperation({
  name: "backup",
  group: "admin",
  summary: "Export the whole knowledge base to a JSON file",
  input: z.object({ outputPath: z.string().min(1).describe("File to write") }),
  annotations: { readOnly: true },
  handler(ctx, input) {
    assertLocalFilesAllowed(ctx, "Backup");
    const data = exportKnowledgeBase(ctx.db, input.outputPath);
    return { path: input.outputPath, counts: data.metadata.counts };
  },
});

export const restoreOperation = defineOperation({
  name: "restore",
  group: "admin",
  summary: "Import a backup file written by backup",
  input: z.object({ backupPath: z.string().min(1).describe("Backup file to read") }),
  handler(ctx, input) {
    assertLocalFilesAllowed(ctx, "Restore");
    const data = importFromBackup(ctx.db, input.backupPath);
    return { path: input.backupPath, counts: data.metadata.counts };
  },
});

export const pruneExpiredOperation = defineOperation({
  name: "prune-expired",
  group: "admin",
  summary: "Delete documents whose expiry time (expiresAt) has passed",
  input: z.object({}),
  annotations: { destructive: true, idempotent: true },
  http: { method: "POST", path: "/admin/prune-expired" },
  handler: (ctx) => pruneExpiredDocuments(ctx.db),
});

const selector = {
  topic: s.opt(s.topic),
  library: s.opt(s.library),
  sourceType: s.opt(s.sourceType),
  tags: s.tags.optional().describe("Documents carrying all of these tags"),
  dateFrom: z.string().min(1).optional().describe("Created on or after (ISO 8601)"),
  dateTo: z.string().min(1).optional().describe("Created on or before (ISO 8601)"),
  dryRun: z
    .boolean()
    .default(false)
    .describe("Report the matching documents without changing them"),
};

function toSelector(
  ctx: OperationContext,
  input: {
    topic?: string | undefined;
    library?: string | undefined;
    sourceType?: string | undefined;
    tags?: string[] | undefined;
    dateFrom?: string | undefined;
    dateTo?: string | undefined;
  },
): BulkSelector {
  const sel: BulkSelector = {};
  if (input.topic !== undefined) sel.topicId = resolveTopicId(ctx.db, input.topic);
  if (input.library !== undefined) sel.library = input.library;
  if (input.sourceType !== undefined) sel.sourceType = input.sourceType;
  if (input.tags !== undefined) sel.tags = input.tags;
  if (input.dateFrom !== undefined) sel.dateFrom = input.dateFrom;
  if (input.dateTo !== undefined) sel.dateTo = input.dateTo;
  return sel;
}

export const bulkDeleteOperation = defineOperation({
  name: "bulk-delete",
  group: "admin",
  summary: "Delete every document matching the filters (at most 1000 per call)",
  input: z.object(selector),
  annotations: { destructive: true },
  http: { method: "POST", path: "/bulk/delete" },
  handler: (ctx, input) => bulkDelete(ctx.db, toSelector(ctx, input), input.dryRun),
});

export const bulkRetagOperation = defineOperation({
  name: "bulk-retag",
  group: "admin",
  summary: "Add and/or remove tags on every document matching the filters",
  input: z.object({
    ...selector,
    addTags: s.tags.optional().describe("Tags to add"),
    removeTags: s.tags.optional().describe("Tags to remove"),
  }),
  annotations: { idempotent: true },
  http: { method: "POST", path: "/bulk/retag" },
  handler: (ctx, input) =>
    bulkRetag(ctx.db, toSelector(ctx, input), input.addTags, input.removeTags, input.dryRun),
});

export const bulkMoveOperation = defineOperation({
  name: "bulk-move",
  group: "admin",
  summary: "Move every document matching the filters to another topic",
  input: z.object({ ...selector, targetTopic: s.topic.describe("Destination topic ID or name") }),
  annotations: { idempotent: true },
  http: { method: "POST", path: "/bulk/move" },
  handler: (ctx, input) =>
    bulkMove(
      ctx.db,
      toSelector(ctx, input),
      resolveTopicId(ctx.db, input.targetTopic),
      input.dryRun,
    ),
});

export const adminOperations = [
  overviewOperation,
  reindexOperation,
  dedupeOperation,
  backupOperation,
  restoreOperation,
  pruneExpiredOperation,
  bulkDeleteOperation,
  bulkRetagOperation,
  bulkMoveOperation,
] as const;
