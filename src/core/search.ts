import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { z } from "zod";
import { withCorrelationId, createChildLogger } from "../logger.js";
import { validateCountRow } from "../utils/db-validation.js";
import { validateRow, validateRows } from "../db/validate.js";
import { logSearch, recordSearchQuery } from "./analytics.js";
import { performance } from "node:perf_hooks";

/** Build SQL clause and params for AND-logic tag filtering on a document alias. */
function buildTagFilter(
  tags: string[] | undefined,
  docAlias: string,
): { clause: string; params: unknown[] } {
  if (!tags || tags.length === 0) return { clause: "", params: [] };
  const normalized = tags.map((t) => t.trim().toLowerCase());
  const placeholders = normalized.map(() => "?").join(", ");
  const clause = ` AND ${docAlias}.id IN (
    SELECT dt_f.document_id FROM document_tags dt_f
    JOIN tags t_f ON t_f.id = dt_f.tag_id
    WHERE t_f.name IN (${placeholders})
    GROUP BY dt_f.document_id
    HAVING COUNT(DISTINCT t_f.name) = ?
  )`;
  return { clause, params: [...normalized, normalized.length] };
}

/** Errors that indicate the vector table is missing or unusable – safe to fall back from. */
const VECTOR_TABLE_MISSING_PATTERNS = [
  "no such table: chunk_embeddings",
  "no such module: vec",
  "no such column: distance",
];

function isVectorTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return VECTOR_TABLE_MISSING_PATTERNS.some((p) => msg.includes(p));
}

/** Escape LIKE special characters so user input is treated literally. */
export function escapeLikePattern(input: string): string {
  // prettier-ignore
  return input
    .replace(/\\/g, String.raw`\\`)
    .replace(/%/g, String.raw`\%`)
    .replace(/_/g, String.raw`\_`)
    .replace(/\[/g, String.raw`\[`);
}

export interface SearchOptions {
  query: string;
  topic?: string | undefined;
  library?: string | undefined;
  version?: string | undefined;
  minRating?: number | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  source?: string | undefined;
  tags?: string[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  maxChunksPerDocument?: number | undefined;
  contextChunks?: number | undefined;
  analyticsEnabled?: boolean | undefined;
  /** MMR diversity factor 0–1. 0 = pure relevance, 1 = maximum diversity. */
  diversity?: number | undefined;
}

export interface SearchResponse {
  results: SearchResult[];
  totalCount: number;
}

export type SearchMethod = "vector" | "fts5" | "keyword" | "hybrid";

export interface ScoreExplanation {
  method: SearchMethod;
  rawScore: number;
  boostFactors: string[];
  details: string;
}

export interface ContextChunk {
  chunkId: string;
  content: string;
  chunkIndex: number;
}

export interface SearchResult {
  documentId: string;
  chunkId: string;
  title: string;
  content: string;
  sourceType: string;
  library: string | null;
  version: string | null;
  topicId: string | null;
  url: string | null;
  score: number;
  avgRating: number | null;
  scoreExplanation: ScoreExplanation;
  contextBefore?: ContextChunk[] | undefined;
  contextAfter?: ContextChunk[] | undefined;
}

export interface RelatedChunksOptions {
  chunkId: string;
  limit?: number; // default 10
  excludeDocumentId?: string; // exclude the source document (default: auto-detected from chunkId)
  topic?: string;
  library?: string;
  tags?: string[];
  minScore?: number; // default 0.0
  includeLinkedDocuments?: boolean; // blend in explicit document_links (default false)
}

export interface RelatedChunksResult {
  chunks: SearchResult[];
  sourceChunk: {
    id: string;
    documentId: string;
    content: string;
    chunkIndex: number;
  };
}

// ---------------------------------------------------------------------------
// Title boost multiplier: chunks whose document title contains any query word
// receive this multiplicative boost to their final score.
// ---------------------------------------------------------------------------
const TITLE_BOOST_MULTIPLIER = 1.5;

/**
 * Check whether any query word appears in the document title (case-insensitive).
 */
function titleMatchesQuery(title: string, query: string): boolean {
  const words = query.split(/\s+/).filter((w) => w.length > 0);
  const lowerTitle = title.toLowerCase();
  return words.some((w) => lowerTitle.includes(w.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion (RRF)
// ---------------------------------------------------------------------------
/** Constant k for RRF scoring – standard value from the literature. */
const RRF_K = 60;

interface RankedItem {
  result: SearchResult;
  /** Ranks across contributing lists (1-indexed). */
  ranks: number[];
}

/** Add ranked results from a single list into the RRF accumulator map. */
function addRankedList(
  list: SearchResult[],
  map: Map<string, RankedItem>,
  preferVector: boolean,
): void {
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (r === undefined) continue;
    const existing = map.get(r.chunkId);
    if (!existing) {
      map.set(r.chunkId, { result: r, ranks: [i + 1] });
      continue;
    }
    existing.ranks.push(i + 1);
    // Prefer result with richer explanation (vector > fts5 > keyword)
    if (
      preferVector &&
      r.scoreExplanation.method === "vector" &&
      existing.result.scoreExplanation.method !== "vector"
    ) {
      existing.result = r;
    }
  }
}

/** Compute final RRF scores from the accumulated rank map. */
function computeRrfScores(map: Map<string, RankedItem>): SearchResult[] {
  const fused: Array<{ result: SearchResult; score: number }> = [];
  for (const item of map.values()) {
    let rrfScore = 0;
    for (const rank of item.ranks) {
      rrfScore += 1.0 / (RRF_K + rank);
    }
    const boostFactors = [...item.result.scoreExplanation.boostFactors];
    fused.push({
      result: {
        ...item.result,
        score: rrfScore,
        scoreExplanation: {
          method: "hybrid" as SearchMethod,
          rawScore: rrfScore,
          boostFactors,
          details: `Hybrid RRF: ranks=[${item.ranks.join(",")}], score=${rrfScore.toFixed(6)}`,
        },
      },
      score: rrfScore,
    });
  }
  fused.sort((a, b) => b.score - a.score);
  return fused.map((f) => f.result);
}

/**
 * Merge two ranked result lists via Reciprocal Rank Fusion.
 * Returns results sorted by fused score in descending order.
 */
function reciprocalRankFusion(listA: SearchResult[], listB: SearchResult[]): SearchResult[] {
  const map = new Map<string, RankedItem>();
  addRankedList(listA, map, false);
  addRankedList(listB, map, true);
  return computeRrfScores(map);
}

/** Fetch neighboring chunks for a given chunk within its document. */
function fetchContextChunks(
  db: Database.Database,
  chunkId: string,
  documentId: string,
  contextSize: number,
): { before: ContextChunk[]; after: ContextChunk[] } {
  const CurrentRowSchema = z.object({ chunk_index: z.number() }).optional();
  const currentRow = validateRow(
    CurrentRowSchema,
    db
      .prepare(`SELECT chunk_index FROM chunks WHERE id = ? AND document_id = ?`)
      .get(chunkId, documentId),
    "fetchContextChunks.currentRow",
  );

  if (!currentRow) return { before: [], after: [] };

  const idx = currentRow.chunk_index;

  const ChunkRowSchema = z.object({ id: z.string(), content: z.string(), chunk_index: z.number() });
  const beforeRows = validateRows(
    ChunkRowSchema,
    db
      .prepare(
        `SELECT id, content, chunk_index FROM chunks
       WHERE document_id = ? AND chunk_index >= ? AND chunk_index < ?
       ORDER BY chunk_index ASC`,
      )
      .all(documentId, Math.max(0, idx - contextSize), idx),
    "fetchContextChunks.beforeRows",
  );

  const afterRows = validateRows(
    ChunkRowSchema,
    db
      .prepare(
        `SELECT id, content, chunk_index FROM chunks
       WHERE document_id = ? AND chunk_index > ? AND chunk_index <= ?
       ORDER BY chunk_index ASC`,
      )
      .all(documentId, idx, idx + contextSize),
    "fetchContextChunks.afterRows",
  );

  return {
    before: beforeRows.map((r) => ({
      chunkId: r.id,
      content: r.content,
      chunkIndex: r.chunk_index,
    })),
    after: afterRows.map((r) => ({ chunkId: r.id, content: r.content, chunkIndex: r.chunk_index })),
  };
}

/** Attach context chunks to search results when requested. */
function attachContext(
  db: Database.Database,
  results: SearchResult[],
  contextSize: number,
): SearchResult[] {
  if (contextSize <= 0) return results;
  const capped = Math.min(contextSize, 2);

  return results.map((r) => {
    const { before, after } = fetchContextChunks(db, r.chunkId, r.documentId, capped);
    return { ...r, contextBefore: before, contextAfter: after };
  });
}

/** Apply title boost to search results whose document title matches the query. */
function applyTitleBoost(results: SearchResult[], query: string): SearchResult[] {
  return results.map((r) => {
    if (titleMatchesQuery(r.title, query)) {
      const boosted = r.score * TITLE_BOOST_MULTIPLIER;
      return {
        ...r,
        score: boosted,
        scoreExplanation: {
          ...r.scoreExplanation,
          boostFactors: [
            ...r.scoreExplanation.boostFactors,
            `title_match:x${TITLE_BOOST_MULTIPLIER}`,
          ],
          details: r.scoreExplanation.details + ` (title boost x${TITLE_BOOST_MULTIPLIER})`,
        },
      };
    }
    return r;
  });
}

/** Compute the maximum similarity between a candidate and the already-selected set. */
function maxSimilarityToSelected(candidate: SearchResult, selected: SearchResult[]): number {
  let maxSim = 0;
  for (const sel of selected) {
    const sim = 1 - Math.abs(candidate.score - sel.score);
    if (sim > maxSim) maxSim = sim;
  }
  return maxSim;
}

/** Find the index of the candidate with the best MMR score. */
function findBestMMRCandidate(
  remaining: SearchResult[],
  selected: SearchResult[],
  lambda: number,
): number {
  let bestIdx = 0;
  let bestMmrScore = -Infinity;

  for (let i = 0; i < remaining.length; i++) {
    const candidate = remaining[i];
    if (candidate === undefined) continue;
    const maxSim = maxSimilarityToSelected(candidate, selected);
    const mmrScore = lambda * candidate.score - (1 - lambda) * maxSim;
    if (mmrScore > bestMmrScore) {
      bestMmrScore = mmrScore;
      bestIdx = i;
    }
  }

  return bestIdx;
}

/**
 * Rerank results using Maximal Marginal Relevance for diversity.
 * @param results - Pre-sorted results (highest score first)
 * @param diversity - 0–1 where 1 = maximum diversity
 */
function applyMMR(results: SearchResult[], diversity: number): SearchResult[] {
  if (results.length <= 1) return results;
  const lambda = 1 - Math.max(0, Math.min(diversity, 1));
  const selected: SearchResult[] = [];
  const remaining = [...results];

  const first = remaining.shift();
  if (!first) return selected;
  selected.push(first);

  while (remaining.length > 0) {
    const bestIdx = findBestMMRCandidate(remaining, selected, lambda);
    const picked = remaining.splice(bestIdx, 1)[0];
    if (picked === undefined) break;
    selected.push(picked);
  }

  return selected;
}

/** Deduplicate results by document, keeping at most N chunks per document. */
function deduplicateByDocument(results: SearchResult[], maxPerDoc: number): SearchResult[] {
  const countByDoc = new Map<string, number>();
  return results.filter((r) => {
    const count = countByDoc.get(r.documentId) ?? 0;
    if (count >= maxPerDoc) return false;
    countByDoc.set(r.documentId, count + 1);
    return true;
  });
}

/** Append standard filter clauses and params to a SQL query. */
function appendFilters(
  sql: string,
  params: unknown[],
  options: SearchOptions,
  docAlias: string,
): string {
  if (options.library) {
    sql += ` AND ${docAlias}.library = ?`;
    params.push(options.library);
  }
  if (options.topic) {
    sql += ` AND ${docAlias}.topic_id = ?`;
    params.push(options.topic);
  }
  if (options.version) {
    sql += ` AND ${docAlias}.version = ?`;
    params.push(options.version);
  }
  if (options.minRating !== undefined) {
    sql += " AND avg_r.avg_rating >= ?";
    params.push(options.minRating);
  }
  if (options.dateFrom) {
    sql += ` AND ${docAlias}.created_at >= ?`;
    params.push(options.dateFrom);
  }
  if (options.dateTo) {
    sql += ` AND ${docAlias}.created_at <= ?`;
    params.push(options.dateTo);
  }
  if (options.source) {
    sql += ` AND ${docAlias}.source_type = ?`;
    params.push(options.source);
  }

  const tagFilter = buildTagFilter(options.tags, docAlias);
  sql += tagFilter.clause;
  params.push(...tagFilter.params);

  return sql;
}

/**
 * Lazy totalCount: skip the expensive COUNT query when we can infer the total
 * from the result set (offset === 0 and fewer results than the limit).
 * Always returns a non-negative count.
 */
function lazyCount(
  db: Database.Database,
  baseSql: string,
  baseParams: unknown[],
  offset: number,
  resultLen: number,
  limit: number,
  label: string,
): number {
  // If offset is 0 and we got fewer results than the limit, we know the total
  if (offset === 0 && resultLen < limit) {
    return resultLen;
  }
  return validateCountRow(
    db.prepare(`SELECT COUNT(*) AS cnt FROM (${baseSql})`).get(...baseParams),
    label,
  );
}

/** Apply common post-processing: title boost, re-sort, MMR, dedup. */
function postProcessResults(results: SearchResult[], options: SearchOptions): SearchResult[] {
  let processed = applyTitleBoost(results, options.query);
  processed.sort((a, b) => b.score - a.score);

  if (options.diversity !== undefined && options.diversity > 0) {
    processed = applyMMR(processed, options.diversity);
  }

  if (options.maxChunksPerDocument !== undefined && options.maxChunksPerDocument > 0) {
    processed = deduplicateByDocument(processed, options.maxChunksPerDocument);
  }

  return processed;
}

/** Record search analytics if enabled. */
function recordAnalytics(
  db: Database.Database,
  options: SearchOptions,
  response: SearchResponse,
  method: SearchMethod,
  startTime: number,
  analyticsEnabled: boolean,
): void {
  if (!analyticsEnabled) return;
  logSearch(db, {
    query: options.query,
    searchMethod: method,
    resultCount: response.totalCount,
    latencyMs: performance.now() - startTime,
    documentIds: response.results.map((r) => r.documentId),
  });
  recordSearchQuery(db, {
    query: options.query,
    resultCount: response.results.length,
    topScore: response.results[0]?.score ?? null,
    searchType: method,
  });
}

/** Finalize a response: attach ratings (if no min filter) and context chunks. */
function finalizeResponse(
  db: Database.Database,
  response: SearchResponse,
  options: SearchOptions,
): SearchResponse {
  if (options.minRating === undefined) {
    response.results = attachRatings(db, response.results);
  }
  if (options.contextChunks) {
    response.results = attachContext(db, response.results, options.contextChunks);
  }
  return response;
}

/** Perform semantic search across indexed documents. */
export async function searchDocuments(
  db: Database.Database,
  provider: EmbeddingProvider,
  options: SearchOptions,
): Promise<SearchResponse> {
  const log = withCorrelationId({ operation: "searchDocuments" });
  const limit = Math.max(1, Math.min(options.limit ?? 10, 1000));
  const offset = Math.max(0, options.offset ?? 0);
  const analyticsEnabled = options.analyticsEnabled ?? true;
  const startTime = performance.now();

  log.info({ query: options.query, limit, offset }, "Searching documents");

  const queryEmbedding = await provider.embed(options.query);
  const vecBuffer = Buffer.from(new Float32Array(queryEmbedding).buffer);

  const overfetchFactor = 3;
  const maxCandidateLimit = 5000;
  const candidateLimit = Math.min((offset + limit) * overfetchFactor, maxCandidateLimit);

  try {
    const vectorResults = vectorSearch(db, options, vecBuffer, candidateLimit, 0);
    let ftsResults: SearchResult[] | null = null;
    let ftsTotalCount = 0;

    try {
      const ftsResponse = fts5Search(db, options, candidateLimit, 0);
      ftsResults = ftsResponse.results;
      ftsTotalCount = ftsResponse.totalCount;
    } catch {
      // FTS5 not available
    }

    const isHybrid = ftsResults !== null && ftsResults.length > 0;
    const mergedResults = isHybrid
      ? reciprocalRankFusion(vectorResults.results, ftsResults!)
      : vectorResults.results;
    const searchMethod: SearchMethod = isHybrid ? "hybrid" : "vector";

    const processed = postProcessResults(mergedResults, options);
    const paginatedResults = processed.slice(offset, offset + limit);

    const totalCount = isHybrid
      ? Math.max(processed.length, vectorResults.totalCount, ftsTotalCount)
      : vectorResults.totalCount;

    const response: SearchResponse = { totalCount, results: paginatedResults };
    recordAnalytics(db, options, response, searchMethod, startTime, analyticsEnabled);
    return finalizeResponse(db, response, options);
  } catch (err) {
    if (!isVectorTableError(err)) throw err;

    log.warn({ err }, "Vector table missing, falling back to keyword search");
    const response = keywordSearch(db, options, limit, offset);
    response.results = postProcessResults(response.results, options);

    const method = response.results[0]?.scoreExplanation.method ?? "keyword";
    recordAnalytics(db, options, response, method, startTime, analyticsEnabled);
    return finalizeResponse(db, response, options);
  }
}

/** Pure vector search — returns candidates for fusion/pagination.
 *  `limit` should already account for offset (i.e. caller passes offset+limit). */
function vectorSearch(
  db: Database.Database,
  options: SearchOptions,
  vecBuffer: Buffer,
  limit: number,
  _offset: number,
): SearchResponse {
  // The caller already over-fetches; use the limit directly.
  const annCandidateLimit = limit;

  const needsRatingJoin = options.minRating !== undefined;

  let sql = `
    SELECT
      candidates.chunk_id,
      candidates.distance,
      c.document_id,
      c.content AS chunk_content,
      d.title,
      d.source_type,
      d.library,
      d.version,
      d.topic_id,
      d.url${needsRatingJoin ? ",\n      avg_r.avg_rating" : ""}
    FROM (
      SELECT chunk_id, distance
      FROM chunk_embeddings
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    ) candidates
    JOIN chunks c ON c.id = candidates.chunk_id
    JOIN documents d ON d.id = c.document_id${
      needsRatingJoin
        ? `
    LEFT JOIN (
      SELECT document_id, AVG(rating) AS avg_rating
      FROM ratings
      GROUP BY document_id
    ) avg_r ON avg_r.document_id = d.id`
        : ""
    }
    WHERE 1=1
  `;

  const params: unknown[] = [vecBuffer, annCandidateLimit];
  sql = appendFilters(sql, params, options, "d");

  sql += ` ORDER BY candidates.distance`;

  const VectorRowSchema = z.object({
    chunk_id: z.string(),
    distance: z.number(),
    document_id: z.string(),
    chunk_content: z.string(),
    title: z.string(),
    source_type: z.string(),
    library: z.string().nullable(),
    version: z.string().nullable(),
    topic_id: z.string().nullable(),
    url: z.string().nullable(),
    avg_rating: z.number().nullable().optional(),
  });
  const rows = validateRows(VectorRowSchema, db.prepare(sql).all(...params), "vectorSearch.rows");

  // totalCount: if we got fewer rows than the ANN candidate limit, we know
  // the true total (all candidates survived filtering). Otherwise the real
  // total may be larger than what we fetched — report the row count as a
  // lower bound (exact COUNT is not feasible over an ANN index).
  const totalCount = rows.length;

  return {
    totalCount,
    results: rows.map((row) => {
      const similarity = 1 - row.distance;
      return {
        documentId: row.document_id,
        chunkId: row.chunk_id,
        title: row.title,
        content: row.chunk_content,
        sourceType: row.source_type,
        library: row.library,
        version: row.version,
        topicId: row.topic_id,
        url: row.url,
        score: similarity,
        avgRating: row.avg_rating ?? null,
        scoreExplanation: {
          method: "vector" as SearchMethod,
          rawScore: row.distance,
          boostFactors: [],
          details: `Vector similarity: distance=${row.distance.toFixed(4)}, similarity=${similarity.toFixed(4)}`,
        },
      };
    }),
  };
}

/** Fallback keyword search when vector search is unavailable.
 *  Tries FTS5 first, falls back to LIKE search. */
function keywordSearch(
  db: Database.Database,
  options: SearchOptions,
  limit: number,
  offset: number,
): SearchResponse {
  const log = createChildLogger({ operation: "keywordSearch" });

  // Try FTS5 first
  try {
    return fts5Search(db, options, limit, offset);
  } catch (err) {
    log.debug({ err }, "FTS5 unavailable, falling back to LIKE search");
  }

  const words = options.query.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return { results: [], totalCount: 0 };

  const needsRatingJoin = options.minRating !== undefined;

  const likeConditions = words.map(() => "c.content LIKE ? ESCAPE '\\'").join(" OR ");
  const params: unknown[] = words.map((w) => `%${escapeLikePattern(w)}%`);

  let sql = `
    SELECT
      c.id AS chunk_id,
      c.document_id,
      c.content AS chunk_content,
      d.title,
      d.source_type,
      d.library,
      d.version,
      d.topic_id,
      d.url${needsRatingJoin ? ",\n      avg_r.avg_rating" : ""}
    FROM chunks c
    JOIN documents d ON d.id = c.document_id${
      needsRatingJoin
        ? `
    LEFT JOIN (
      SELECT document_id, AVG(rating) AS avg_rating
      FROM ratings
      GROUP BY document_id
    ) avg_r ON avg_r.document_id = d.id`
        : ""
    }
    WHERE (${likeConditions})
  `;

  sql = appendFilters(sql, params, options, "d");

  // Lazy count: avoid expensive COUNT when not needed
  const baseSql = sql;
  const baseParams = [...params];

  sql += " LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const KeywordRowSchema = z.object({
    chunk_id: z.string(),
    document_id: z.string(),
    chunk_content: z.string(),
    title: z.string(),
    source_type: z.string(),
    library: z.string().nullable(),
    version: z.string().nullable(),
    topic_id: z.string().nullable(),
    url: z.string().nullable(),
    avg_rating: z.number().nullable().optional(),
  });
  const rows = validateRows(KeywordRowSchema, db.prepare(sql).all(...params), "keywordSearch.rows");

  const totalCount = lazyCount(
    db,
    baseSql,
    baseParams,
    offset,
    rows.length,
    limit,
    "keyword search count",
  );

  return {
    totalCount,
    results: rows.map((row, index) => {
      const rankScore = Math.max(0, 1 - index * 0.1);
      return {
        documentId: row.document_id,
        chunkId: row.chunk_id,
        title: row.title,
        content: row.chunk_content,
        sourceType: row.source_type,
        library: row.library,
        version: row.version,
        topicId: row.topic_id,
        url: row.url,
        score: rankScore,
        avgRating: row.avg_rating ?? null,
        scoreExplanation: {
          method: "keyword" as SearchMethod,
          rawScore: rankScore,
          boostFactors: [],
          details: `Keyword LIKE match: rank=${index + 1}, score=${rankScore.toFixed(4)}`,
        },
      };
    }),
  };
}

/** Strip FTS5 special syntax from a single query word before quoting. */
function sanitizeFtsWord(word: string): string {
  // Strip column-filter syntax (e.g. "chunk_id:foo" → "foo")
  const colonIdx = word.indexOf(":");
  if (colonIdx !== -1) {
    word = word.slice(colonIdx + 1);
  }
  // Strip prefix/suffix wildcards using index scan to avoid ReDoS
  let start = 0;
  while (start < word.length && word[start] === "*") start++;
  let end = word.length;
  while (end > start && word[end - 1] === "*") end--;
  word = word.slice(start, end);
  // If the remaining word is a standalone FTS5 operator, return empty
  if (/^(NEAR|AND|OR|NOT)$/i.test(word)) {
    return "";
  }
  return word;
}

/** Fetch avg ratings for a small set of documents and attach to results. */
function attachRatings(db: Database.Database, results: SearchResult[]): SearchResult[] {
  if (results.length === 0) return results;
  const ids = [...new Set(results.map((r) => r.documentId))];
  const placeholders = ids.map(() => "?").join(", ");
  const RatingRowSchema = z.object({ document_id: z.string(), avg_rating: z.number().nullable() });
  const rows = validateRows(
    RatingRowSchema,
    db
      .prepare(
        `SELECT document_id, AVG(rating) AS avg_rating
       FROM ratings
       WHERE document_id IN (${placeholders})
       GROUP BY document_id`,
      )
      .all(...ids),
    "attachRatings.rows",
  );
  const ratingMap = new Map(rows.map((r) => [r.document_id, r.avg_rating]));
  return results.map((r) => ({ ...r, avgRating: ratingMap.get(r.documentId) ?? null }));
}

/**
 * Find chunks related to a given chunk by vector similarity.
 * Looks up the source chunk's embedding, then searches for similar chunks
 * excluding the source document (by default). Returns synchronously.
 */
export function getRelatedChunks(
  db: Database.Database,
  options: RelatedChunksOptions,
): RelatedChunksResult {
  const { chunkId } = options;
  const limit = Math.max(1, Math.min(options.limit ?? 10, 1000));
  const minScore = options.minScore ?? 0.0;

  // Look up the source chunk
  const SourceChunkSchema = z.object({
    id: z.string(),
    document_id: z.string(),
    content: z.string(),
    chunk_index: z.number(),
  });
  const sourceChunkRow = validateRow(
    SourceChunkSchema.optional(),
    db
      .prepare(`SELECT id, document_id, content, chunk_index FROM chunks WHERE id = ?`)
      .get(chunkId),
    "getRelatedChunks.sourceChunk",
  );
  if (!sourceChunkRow) {
    throw new Error(`Chunk not found: ${chunkId}`);
  }

  const sourceChunk = {
    id: sourceChunkRow.id,
    documentId: sourceChunkRow.document_id,
    content: sourceChunkRow.content,
    chunkIndex: sourceChunkRow.chunk_index,
  };

  const excludeDocumentId = options.excludeDocumentId ?? sourceChunkRow.document_id;

  // Fetch the embedding for the source chunk
  const EmbeddingRowSchema = z.object({ embedding: z.instanceof(Buffer) });
  const embeddingRow = validateRow(
    EmbeddingRowSchema.optional(),
    db.prepare(`SELECT embedding FROM chunk_embeddings WHERE chunk_id = ?`).get(chunkId),
    "getRelatedChunks.embedding",
  );
  if (!embeddingRow) {
    throw new Error(`No embedding found for chunk: ${chunkId}`);
  }

  const vecBuffer = embeddingRow.embedding;

  // Build SQL: vector ANN search excluding the source document
  const tagFilter = buildTagFilter(options.tags, "d");

  let sql = `
    SELECT
      candidates.chunk_id,
      candidates.distance,
      c.document_id,
      c.content AS chunk_content,
      d.title,
      d.source_type,
      d.library,
      d.version,
      d.topic_id,
      d.url
    FROM (
      SELECT chunk_id, distance
      FROM chunk_embeddings
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    ) candidates
    JOIN chunks c ON c.id = candidates.chunk_id
    JOIN documents d ON d.id = c.document_id
    WHERE c.document_id != ?
  `;

  const params: unknown[] = [vecBuffer, limit * 10, excludeDocumentId];

  if (options.library) {
    sql += ` AND d.library = ?`;
    params.push(options.library);
  }
  if (options.topic) {
    sql += ` AND d.topic_id = ?`;
    params.push(options.topic);
  }
  sql += tagFilter.clause;
  params.push(...tagFilter.params);

  sql += ` ORDER BY candidates.distance LIMIT ?`;
  params.push(limit * 2); // over-fetch to allow minScore filtering

  const RelatedRowSchema = z.object({
    chunk_id: z.string(),
    distance: z.number(),
    document_id: z.string(),
    chunk_content: z.string(),
    title: z.string(),
    source_type: z.string(),
    library: z.string().nullable(),
    version: z.string().nullable(),
    topic_id: z.string().nullable(),
    url: z.string().nullable(),
  });

  const rows = validateRows(
    RelatedRowSchema,
    db.prepare(sql).all(...params),
    "getRelatedChunks.rows",
  );

  let results: SearchResult[] = rows.map((row) => {
    const similarity = 1 - row.distance;
    return {
      documentId: row.document_id,
      chunkId: row.chunk_id,
      title: row.title,
      content: row.chunk_content,
      sourceType: row.source_type,
      library: row.library,
      version: row.version,
      topicId: row.topic_id,
      url: row.url,
      score: similarity,
      avgRating: null,
      scoreExplanation: {
        method: "vector" as SearchMethod,
        rawScore: row.distance,
        boostFactors: [],
        details: `Vector similarity: distance=${row.distance.toFixed(4)}, similarity=${similarity.toFixed(4)}`,
      },
    };
  });

  // Apply minScore filter
  if (minScore > 0) {
    results = results.filter((r) => r.score >= minScore);
  }

  // Optional: blend in explicitly linked documents
  if (options.includeLinkedDocuments) {
    const linkedDocs = db
      .prepare(
        `SELECT DISTINCT
          CASE WHEN source_id = ? THEN target_id ELSE source_id END AS linked_doc_id
        FROM document_links
        WHERE source_id = ? OR target_id = ?`,
      )
      .all(sourceChunk.documentId, sourceChunk.documentId, sourceChunk.documentId) as {
      linked_doc_id: string;
    }[];

    const LinkedChunkSchema = z.object({
      id: z.string(),
      document_id: z.string(),
      content: z.string(),
      chunk_index: z.number(),
      title: z.string(),
      source_type: z.string(),
      library: z.string().nullable(),
      version: z.string().nullable(),
      topic_id: z.string().nullable(),
      url: z.string().nullable(),
    });

    const presentDocIds = new Set(results.map((r) => r.documentId));
    for (const { linked_doc_id } of linkedDocs) {
      if (!presentDocIds.has(linked_doc_id)) {
        const linkedChunk = validateRow(
          LinkedChunkSchema.optional(),
          db
            .prepare(
              `SELECT c.id, c.document_id, c.content, c.chunk_index,
                      d.title, d.source_type, d.library, d.version, d.topic_id, d.url
               FROM chunks c
               JOIN documents d ON d.id = c.document_id
               WHERE c.document_id = ?
               ORDER BY c.chunk_index ASC
               LIMIT 1`,
            )
            .get(linked_doc_id),
          "getRelatedChunks.linkedChunk",
        );
        if (linkedChunk) {
          results.push({
            documentId: linkedChunk.document_id,
            chunkId: linkedChunk.id,
            title: linkedChunk.title,
            content: linkedChunk.content,
            sourceType: linkedChunk.source_type,
            library: linkedChunk.library,
            version: linkedChunk.version,
            topicId: linkedChunk.topic_id,
            url: linkedChunk.url,
            score: 0.6,
            avgRating: null,
            scoreExplanation: {
              method: "vector" as SearchMethod,
              rawScore: 0.6,
              boostFactors: ["linked_document"],
              details: "Explicitly linked document",
            },
          });
        }
      }
    }
    results.sort((a, b) => b.score - a.score);
  }

  // Trim to requested limit
  results = results.slice(0, limit);

  return { chunks: results, sourceChunk };
}

/** FTS5-based full-text search with BM25 ranking. Uses AND logic by default. */
function fts5Search(
  db: Database.Database,
  options: SearchOptions,
  limit: number,
  offset: number,
): SearchResponse {
  // Sanitize and escape FTS5 query: strip dangerous syntax, wrap each word in quotes.
  // AND-by-default: require all terms to match for better precision.
  const words = options.query
    .split(/\s+/)
    .map((w) => sanitizeFtsWord(w))
    .filter((w) => w.length > 0);
  if (words.length === 0) return { results: [], totalCount: 0 };

  const needsRatingJoin = options.minRating !== undefined;

  const ftsQuery = words.map((w) => `"${w.replaceAll('"', '""')}"`).join(" AND ");
  const params: unknown[] = [ftsQuery];

  let sql = `
    SELECT
      f.chunk_id,
      f.document_id,
      f.content AS chunk_content,
      d.title,
      d.source_type,
      d.library,
      d.version,
      d.topic_id,
      d.url,
      rank AS fts_rank${needsRatingJoin ? ",\n      avg_r.avg_rating" : ""}
    FROM chunks_fts f
    JOIN documents d ON d.id = f.document_id${
      needsRatingJoin
        ? `
    LEFT JOIN (
      SELECT document_id, AVG(rating) AS avg_rating
      FROM ratings
      GROUP BY document_id
    ) avg_r ON avg_r.document_id = d.id`
        : ""
    }
    WHERE chunks_fts MATCH ?
  `;

  sql = appendFilters(sql, params, options, "d");

  // Lazy count – may be updated if OR fallback is used
  let baseSql = sql;
  let baseParams = [...params];

  sql += " ORDER BY rank LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const Fts5RowSchema = z.object({
    chunk_id: z.string(),
    document_id: z.string(),
    chunk_content: z.string(),
    title: z.string(),
    source_type: z.string(),
    library: z.string().nullable(),
    version: z.string().nullable(),
    topic_id: z.string().nullable(),
    url: z.string().nullable(),
    fts_rank: z.number(),
    avg_rating: z.number().nullable().optional(),
  });
  let rows = validateRows(Fts5RowSchema, db.prepare(sql).all(...params), "fts5Search.rows");

  // If AND returned nothing, retry with OR for recall
  if (rows.length === 0 && words.length > 1) {
    const orQuery = words.map((w) => `"${w.replace(/"/g, '""')}"`).join(" OR ");
    const orParams: unknown[] = [orQuery];
    let orSql = `
      SELECT
        f.chunk_id,
        f.document_id,
        f.content AS chunk_content,
        d.title,
        d.source_type,
        d.library,
        d.version,
        d.topic_id,
        d.url,
        rank AS fts_rank${needsRatingJoin ? ",\n        avg_r.avg_rating" : ""}
      FROM chunks_fts f
      JOIN documents d ON d.id = f.document_id${
        needsRatingJoin
          ? `
      LEFT JOIN (
        SELECT document_id, AVG(rating) AS avg_rating
        FROM ratings
        GROUP BY document_id
      ) avg_r ON avg_r.document_id = d.id`
          : ""
      }
      WHERE chunks_fts MATCH ?
    `;
    orSql = appendFilters(orSql, orParams, options, "d");

    // Update count base to use OR query
    baseSql = orSql;
    baseParams = [...orParams];

    orSql += " ORDER BY rank LIMIT ? OFFSET ?";
    orParams.push(limit);
    orParams.push(offset);

    rows = validateRows(Fts5RowSchema, db.prepare(orSql).all(...orParams), "fts5Search.orRows");
  }

  const totalCount = lazyCount(
    db,
    baseSql,
    baseParams,
    offset,
    rows.length,
    limit,
    "FTS5 search count",
  );

  return {
    totalCount,
    results: rows.map((row) => {
      const bm25Score = -row.fts_rank;
      return {
        documentId: row.document_id,
        chunkId: row.chunk_id,
        title: row.title,
        content: row.chunk_content,
        sourceType: row.source_type,
        library: row.library,
        version: row.version,
        topicId: row.topic_id,
        url: row.url,
        score: bm25Score,
        avgRating: row.avg_rating ?? null,
        scoreExplanation: {
          method: "fts5" as SearchMethod,
          rawScore: row.fts_rank,
          boostFactors: [],
          details: `FTS5 BM25 ranking: raw_rank=${row.fts_rank.toFixed(4)}, score=${bm25Score.toFixed(4)}`,
        },
      };
    }),
  };
}
