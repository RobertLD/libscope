import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { withCorrelationId, createChildLogger } from "../logger.js";
import { validateCountRow } from "../utils/db-validation.js";
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
  return input
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")
    .replace(/\[/g, "\\[");
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
}

export interface SearchResponse {
  results: SearchResult[];
  totalCount: number;
}

export type SearchMethod = "vector" | "fts5" | "keyword";

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

interface ChunkRow {
  id: string;
  content: string;
  chunk_index: number;
}

/** Fetch neighboring chunks for a given chunk within its document. */
function fetchContextChunks(
  db: Database.Database,
  chunkId: string,
  documentId: string,
  contextSize: number,
): { before: ContextChunk[]; after: ContextChunk[] } {
  const currentRow = db
    .prepare(`SELECT chunk_index FROM chunks WHERE id = ? AND document_id = ?`)
    .get(chunkId, documentId) as { chunk_index: number } | undefined;

  if (!currentRow) return { before: [], after: [] };

  const idx = currentRow.chunk_index;

  const beforeRows = db
    .prepare(
      `SELECT id, content, chunk_index FROM chunks
       WHERE document_id = ? AND chunk_index >= ? AND chunk_index < ?
       ORDER BY chunk_index ASC`,
    )
    .all(documentId, Math.max(0, idx - contextSize), idx) as ChunkRow[];

  const afterRows = db
    .prepare(
      `SELECT id, content, chunk_index FROM chunks
       WHERE document_id = ? AND chunk_index > ? AND chunk_index <= ?
       ORDER BY chunk_index ASC`,
    )
    .all(documentId, idx, idx + contextSize) as ChunkRow[];

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

  // Generate query embedding
  const queryEmbedding = await provider.embed(options.query);
  const vecBuffer = Buffer.from(new Float32Array(queryEmbedding).buffer);

  // Try vector search first
  try {
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
        d.url,
        avg_r.avg_rating
      FROM (
        SELECT chunk_id, distance
        FROM chunk_embeddings
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
      ) candidates
      JOIN chunks c ON c.id = candidates.chunk_id
      JOIN documents d ON d.id = c.document_id
      LEFT JOIN (
        SELECT document_id, AVG(rating) AS avg_rating
        FROM ratings
        GROUP BY document_id
      ) avg_r ON avg_r.document_id = d.id
      WHERE 1=1
    `;

    const params: unknown[] = [vecBuffer, limit * 3];

    if (options.library) {
      sql += " AND d.library = ?";
      params.push(options.library);
    }
    if (options.topic) {
      sql += " AND d.topic_id = ?";
      params.push(options.topic);
    }
    if (options.version) {
      sql += " AND d.version = ?";
      params.push(options.version);
    }
    if (options.minRating) {
      sql += " AND avg_r.avg_rating >= ?";
      params.push(options.minRating);
    }
    if (options.dateFrom) {
      sql += " AND d.created_at >= ?";
      params.push(options.dateFrom);
    }
    if (options.dateTo) {
      sql += " AND d.created_at <= ?";
      params.push(options.dateTo);
    }
    if (options.source) {
      sql += " AND d.source_type = ?";
      params.push(options.source);
    }

    const tagFilterVec = buildTagFilter(options.tags, "d");
    sql += tagFilterVec.clause;
    params.push(...tagFilterVec.params);

    // Build count query from base SQL (before adding ORDER BY/LIMIT/OFFSET)
    const baseSql = sql;
    const baseParams = [...params];
    const totalCount = validateCountRow(
      db.prepare(`SELECT COUNT(*) AS cnt FROM (${baseSql})`).get(...baseParams),
      "vector search count",
    );

    sql += ` ORDER BY candidates.distance LIMIT ? OFFSET ?`;
    params.push(limit);
    params.push(offset);

    const rows = db.prepare(sql).all(...params) as Array<{
      chunk_id: string;
      distance: number;
      document_id: string;
      chunk_content: string;
      title: string;
      source_type: string;
      library: string | null;
      version: string | null;
      topic_id: string | null;
      url: string | null;
      avg_rating: number | null;
    }>;

    const response: SearchResponse = {
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
          avgRating: row.avg_rating,
          scoreExplanation: {
            method: "vector" as SearchMethod,
            rawScore: row.distance,
            boostFactors: [],
            details: `Vector similarity: distance=${row.distance.toFixed(4)}, similarity=${similarity.toFixed(4)}`,
          },
        };
      }),
    };

    if (analyticsEnabled) {
      logSearch(db, {
        query: options.query,
        searchMethod: "vector",
        resultCount: response.totalCount,
        latencyMs: performance.now() - startTime,
        documentIds: response.results.map((r) => r.documentId),
      });
      recordSearchQuery(db, {
        query: options.query,
        resultCount: response.results.length,
        topScore: response.results[0]?.score ?? null,
        searchType: "vector",
      });
    }

    // Deduplicate by document — keep top N chunks per document
    if (options.maxChunksPerDocument !== undefined && options.maxChunksPerDocument > 0) {
      const countByDoc = new Map<string, number>();
      response.results = response.results.filter((r) => {
        const count = countByDoc.get(r.documentId) ?? 0;
        if (count >= options.maxChunksPerDocument!) return false;
        countByDoc.set(r.documentId, count + 1);
        return true;
      });
    }

    if (options.contextChunks) {
      response.results = attachContext(db, response.results, options.contextChunks);
    }

    return response;
  } catch (err) {
    if (!isVectorTableError(err)) {
      throw err;
    }
    log.warn({ err }, "Vector table missing, falling back to keyword search");
    const response = keywordSearch(db, options, limit, offset);

    if (analyticsEnabled) {
      const method = response.results[0]?.scoreExplanation.method ?? "keyword";
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

    // Deduplicate by document — keep top N chunks per document
    if (options.maxChunksPerDocument !== undefined && options.maxChunksPerDocument > 0) {
      const countByDoc = new Map<string, number>();
      response.results = response.results.filter((r) => {
        const count = countByDoc.get(r.documentId) ?? 0;
        if (count >= options.maxChunksPerDocument!) return false;
        countByDoc.set(r.documentId, count + 1);
        return true;
      });
    }

    if (options.contextChunks) {
      response.results = attachContext(db, response.results, options.contextChunks);
    }

    return response;
  }
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

  const words = options.query.split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return { results: [], totalCount: 0 };

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
      d.url,
      avg_r.avg_rating
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    LEFT JOIN (
      SELECT document_id, AVG(rating) AS avg_rating
      FROM ratings
      GROUP BY document_id
    ) avg_r ON avg_r.document_id = d.id
    WHERE (${likeConditions})
  `;

  if (options.library) {
    sql += " AND d.library = ?";
    params.push(options.library);
  }
  if (options.topic) {
    sql += " AND d.topic_id = ?";
    params.push(options.topic);
  }
  if (options.version) {
    sql += " AND d.version = ?";
    params.push(options.version);
  }
  if (options.minRating) {
    sql += " AND (SELECT AVG(r.rating) FROM ratings r WHERE r.document_id = d.id) >= ?";
    params.push(options.minRating);
  }
  if (options.dateFrom) {
    sql += " AND d.created_at >= ?";
    params.push(options.dateFrom);
  }
  if (options.dateTo) {
    sql += " AND d.created_at <= ?";
    params.push(options.dateTo);
  }
  if (options.source) {
    sql += " AND d.source_type = ?";
    params.push(options.source);
  }

  const tagFilterKw = buildTagFilter(options.tags, "d");
  sql += tagFilterKw.clause;
  params.push(...tagFilterKw.params);

  // Build count query from base SQL (before adding LIMIT/OFFSET)
  const baseSql = sql;
  const baseParams = [...params];
  const totalCount = validateCountRow(
    db.prepare(`SELECT COUNT(*) AS cnt FROM (${baseSql})`).get(...baseParams),
    "keyword search count",
  );

  sql += " LIMIT ? OFFSET ?";
  params.push(limit);
  params.push(offset);

  const rows = db.prepare(sql).all(...params) as Array<{
    chunk_id: string;
    document_id: string;
    chunk_content: string;
    title: string;
    source_type: string;
    library: string | null;
    version: string | null;
    topic_id: string | null;
    url: string | null;
    avg_rating: number | null;
  }>;

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
        avgRating: row.avg_rating,
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

/** FTS5-based full-text search with BM25 ranking. */
function fts5Search(
  db: Database.Database,
  options: SearchOptions,
  limit: number,
  offset: number,
): SearchResponse {
  // Escape FTS5 query: wrap each word in quotes for safety
  const words = options.query.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return { results: [], totalCount: 0 };

  const ftsQuery = words.map((w) => `"${w.replace(/"/g, '""')}"`).join(" OR ");
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
      rank AS fts_rank,
      avg_r.avg_rating
    FROM chunks_fts f
    JOIN documents d ON d.id = f.document_id
    LEFT JOIN (
      SELECT document_id, AVG(rating) AS avg_rating
      FROM ratings
      GROUP BY document_id
    ) avg_r ON avg_r.document_id = d.id
    WHERE chunks_fts MATCH ?
  `;

  if (options.library) {
    sql += " AND d.library = ?";
    params.push(options.library);
  }
  if (options.topic) {
    sql += " AND d.topic_id = ?";
    params.push(options.topic);
  }
  if (options.version) {
    sql += " AND d.version = ?";
    params.push(options.version);
  }
  if (options.minRating) {
    sql += " AND (SELECT AVG(r.rating) FROM ratings r WHERE r.document_id = d.id) >= ?";
    params.push(options.minRating);
  }
  if (options.dateFrom) {
    sql += " AND d.created_at >= ?";
    params.push(options.dateFrom);
  }
  if (options.dateTo) {
    sql += " AND d.created_at <= ?";
    params.push(options.dateTo);
  }
  if (options.source) {
    sql += " AND d.source_type = ?";
    params.push(options.source);
  }

  const tagFilterFts = buildTagFilter(options.tags, "d");
  sql += tagFilterFts.clause;
  params.push(...tagFilterFts.params);

  // Build count query from base SQL (before adding ORDER BY/LIMIT/OFFSET)
  const baseSql = sql;
  const baseParams = [...params];
  const totalCount = validateCountRow(
    db.prepare(`SELECT COUNT(*) AS cnt FROM (${baseSql})`).get(...baseParams),
    "FTS5 search count",
  );

  sql += " ORDER BY rank LIMIT ? OFFSET ?";
  params.push(limit);
  params.push(offset);

  const rows = db.prepare(sql).all(...params) as Array<{
    chunk_id: string;
    document_id: string;
    chunk_content: string;
    title: string;
    source_type: string;
    library: string | null;
    version: string | null;
    topic_id: string | null;
    url: string | null;
    fts_rank: number;
    avg_rating: number | null;
  }>;

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
        avgRating: row.avg_rating,
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
