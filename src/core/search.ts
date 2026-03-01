import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { getLogger } from "../logger.js";

export interface SearchOptions {
  query: string;
  topic?: string | undefined;
  library?: string | undefined;
  version?: string | undefined;
  minRating?: number | undefined;
  limit?: number | undefined;
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
}

/** Perform semantic search across indexed documents. */
export async function searchDocuments(
  db: Database.Database,
  provider: EmbeddingProvider,
  options: SearchOptions,
): Promise<SearchResult[]> {
  const log = getLogger();
  const limit = options.limit ?? 10;

  log.info({ query: options.query, limit }, "Searching documents");

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
        (SELECT AVG(r.rating) FROM ratings r WHERE r.document_id = d.id) AS avg_rating
      FROM (
        SELECT chunk_id, distance
        FROM chunk_embeddings
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
      ) candidates
      JOIN chunks c ON c.id = candidates.chunk_id
      JOIN documents d ON d.id = c.document_id
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
      sql += " AND (SELECT AVG(r.rating) FROM ratings r WHERE r.document_id = d.id) >= ?";
      params.push(options.minRating);
    }

    sql += ` ORDER BY candidates.distance LIMIT ?`;
    params.push(limit);

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

    return rows.map((row) => ({
      documentId: row.document_id,
      chunkId: row.chunk_id,
      title: row.title,
      content: row.chunk_content,
      sourceType: row.source_type,
      library: row.library,
      version: row.version,
      topicId: row.topic_id,
      url: row.url,
      score: 1 - row.distance, // Convert distance to similarity
      avgRating: row.avg_rating,
    }));
  } catch {
    log.warn("Vector search unavailable, falling back to keyword search");
    return keywordSearch(db, options, limit);
  }
}

/** Fallback keyword search when vector search is unavailable.
 *  Tries FTS5 first, falls back to LIKE search. */
function keywordSearch(
  db: Database.Database,
  options: SearchOptions,
  limit: number,
): SearchResult[] {
  const log = getLogger();

  // Try FTS5 first
  try {
    return fts5Search(db, options, limit);
  } catch {
    log.debug("FTS5 unavailable, falling back to LIKE search");
  }

  const words = options.query.split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return [];

  const likeConditions = words.map(() => "c.content LIKE ?").join(" OR ");
  const params: unknown[] = words.map((w) => `%${w}%`);

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
      (SELECT AVG(r.rating) FROM ratings r WHERE r.document_id = d.id) AS avg_rating
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
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

  sql += " LIMIT ?";
  params.push(limit);

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

  return rows.map((row, index) => ({
    documentId: row.document_id,
    chunkId: row.chunk_id,
    title: row.title,
    content: row.chunk_content,
    sourceType: row.source_type,
    library: row.library,
    version: row.version,
    topicId: row.topic_id,
    url: row.url,
    score: 1 - index * 0.1, // Simple rank-based score
    avgRating: row.avg_rating,
  }));
}

/** FTS5-based full-text search with BM25 ranking. */
function fts5Search(db: Database.Database, options: SearchOptions, limit: number): SearchResult[] {
  // Escape FTS5 query: wrap each word in quotes for safety
  const words = options.query.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];

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
      (SELECT AVG(r.rating) FROM ratings r WHERE r.document_id = d.id) AS avg_rating
    FROM chunks_fts f
    JOIN documents d ON d.id = f.document_id
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

  sql += " ORDER BY rank LIMIT ?";
  params.push(limit);

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

  return rows.map((row) => ({
    documentId: row.document_id,
    chunkId: row.chunk_id,
    title: row.title,
    content: row.chunk_content,
    sourceType: row.source_type,
    library: row.library,
    version: row.version,
    topicId: row.topic_id,
    url: row.url,
    score: -row.fts_rank, // BM25 rank is negative, lower = better
    avgRating: row.avg_rating,
  }));
}
