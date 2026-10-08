import type Database from "better-sqlite3";
import { z } from "zod";
import { ValidationError } from "../../errors.js";
import { answer, type RagOptions } from "../rag.js";
import { firstChunkId, getRelatedChunks, searchDocuments, type SearchResult } from "../search.js";
import { topicForFilter } from "./documents.js";
import * as s from "./schemas.js";
import { defineOperation, type ListResult, type OperationContext } from "./types.js";

const minRating = z.number().min(1).max(5).optional().describe("Minimum average rating");

/** Chunk to start a "related" search from: `ref` as a chunk ID, else a document's first chunk. */
function relatedSeedChunk(db: Database.Database, ref: string): string {
  if (db.prepare("SELECT 1 FROM chunks WHERE id = ?").get(ref)) return ref;
  return firstChunkId(db, ref);
}

interface SearchFilters {
  version?: string | undefined;
  sourceType?: string | undefined;
  minRating?: number | undefined;
}

/** Filters getRelatedChunks does not apply in SQL. */
function matchesFilters(r: SearchResult, f: SearchFilters): boolean {
  if (f.version !== undefined && r.version !== f.version) return false;
  if (f.sourceType !== undefined && r.sourceType !== f.sourceType) return false;
  return f.minRating === undefined || (r.avgRating ?? 0) >= f.minRating;
}

export const searchOperation = defineOperation({
  name: "search",
  group: "search",
  summary:
    "Search the knowledge base by meaning and keywords, or find content related to a document or chunk",
  input: z.object({
    query: z.string().min(1).max(10_000).optional().describe("What to search for"),
    relatedTo: z
      .string()
      .min(1)
      .optional()
      .describe("Document or chunk ID: return similar content instead of running a query"),
    ...s.documentFilters,
    minRating,
    limit: s.limit(10, 100),
    offset: s.offset,
    maxChunksPerDocument: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("At most this many chunks per document (default: no limit)"),
    contextChunks: z
      .number()
      .int()
      .min(0)
      .max(2)
      .default(0)
      .describe("Neighbouring chunks to include before and after each result"),
    diversity: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Query search: MMR reranking, 0 = relevance only (default), 1 = most diverse"),
  }),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/search" },
  async handler(ctx, input): Promise<ListResult<SearchResult>> {
    if ((input.query === undefined) === (input.relatedTo === undefined)) {
      throw new ValidationError("Give either query or relatedTo");
    }
    const topic = topicForFilter(ctx, input.topic);
    if (input.relatedTo !== undefined) {
      const related = getRelatedChunks(ctx.db, {
        chunkId: relatedSeedChunk(ctx.db, input.relatedTo),
        limit: input.offset + input.limit,
        ...(topic === undefined ? {} : { topic }),
        ...(input.library === undefined ? {} : { library: input.library }),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
      });
      const matches = related.chunks.filter((r) => matchesFilters(r, input));
      return {
        items: matches.slice(input.offset, input.offset + input.limit),
        total: matches.length,
        limit: input.limit,
        offset: input.offset,
      };
    }
    const { results, totalCount } = await searchDocuments(ctx.db, ctx.provider, {
      query: input.query ?? "",
      topic,
      library: input.library,
      version: input.version,
      source: input.sourceType,
      tags: input.tags,
      minRating: input.minRating,
      limit: input.limit,
      offset: input.offset,
      maxChunksPerDocument: input.maxChunksPerDocument,
      contextChunks: input.contextChunks,
      diversity: input.diversity,
    });
    return { items: results, total: totalCount, limit: input.limit, offset: input.offset };
  },
});

const askInput = z.object({
  question: z.string().min(1).max(10_000).describe("The question"),
  ...s.documentFilters,
  minRating,
  topK: z.number().int().min(1).max(20).default(5).describe("Chunks to retrieve as context"),
  systemPrompt: z
    .string()
    .min(1)
    .max(10_000)
    .optional()
    .describe("System prompt for the LLM (default: answer from the context and cite titles)"),
});

/** RAG options for a parsed `ask` input (topic names resolved). Shared with streaming ask. */
export function toRagOptions(ctx: OperationContext, input: z.output<typeof askInput>): RagOptions {
  return {
    question: input.question,
    topK: input.topK,
    topic: topicForFilter(ctx, input.topic),
    library: input.library,
    version: input.version,
    sourceType: input.sourceType,
    tags: input.tags,
    minRating: input.minRating,
    systemPrompt: input.systemPrompt,
  };
}

export const askOperation = defineOperation({
  name: "ask",
  group: "search",
  summary:
    "Answer a question from the knowledge base with an LLM, or (passthrough) return the context to answer from",
  input: askInput,
  annotations: { readOnly: true },
  http: { method: "POST", path: "/ask" },
  handler: (ctx: OperationContext, input) =>
    answer(
      ctx.db,
      ctx.provider,
      { passthrough: ctx.isPassthrough(), llm: ctx.isPassthrough() ? null : ctx.getLlm() },
      toRagOptions(ctx, input),
    ),
});

export const searchOperations = [searchOperation, askOperation] as const;
