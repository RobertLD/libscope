import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { z } from "zod";
import { getLogger } from "../logger.js";
import { validateRow, validateRows } from "../db/validate.js";

export interface SearchLogEntry {
  query: string;
  searchMethod: string;
  resultCount: number;
  latencyMs: number;
  documentIds?: string[];
}

export interface OverviewStats {
  totalDocuments: number;
  totalChunks: number;
  totalTopics: number;
  databaseSizeBytes: number;
  totalSearches: number;
  avgLatencyMs: number;
}

export interface PopularDocument {
  documentId: string;
  title: string;
  hitCount: number;
}

export interface StaleDocument {
  documentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface TopQuery {
  query: string;
  count: number;
  avgLatencyMs: number;
}

export interface SearchTrend {
  date: string;
  count: number;
}

/** Record a search query and its result documents. */
export function logSearch(db: Database.Database, entry: SearchLogEntry): string {
  const log = getLogger();
  const id = randomUUID();

  const insertLog = db.transaction(() => {
    db.prepare(
      `INSERT INTO search_log (id, query, search_method, result_count, latency_ms)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, entry.query, entry.searchMethod, entry.resultCount, Math.round(entry.latencyMs));

    if (entry.documentIds && entry.documentIds.length > 0) {
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO document_hits (document_id, search_log_id, rank)
         VALUES (?, ?, ?)`,
      );
      for (let i = 0; i < entry.documentIds.length; i++) {
        stmt.run(entry.documentIds[i], id, i + 1);
      }
    }
  });

  insertLog();
  log.debug({ searchLogId: id, query: entry.query }, "Search logged");
  return id;
}

/** Return overview stats for the knowledge base. */
export function getStats(db: Database.Database, dbPath?: string): OverviewStats {
  const StatsRowSchema = z.object({
    doc_count: z.number(),
    chunk_count: z.number(),
    topic_count: z.number(),
    search_count: z.number(),
    avg_latency: z.number().nullable(),
  });
  const row = validateRow(
    StatsRowSchema,
    db
      .prepare(
        `
    SELECT
      (SELECT COUNT(*) FROM documents) AS doc_count,
      (SELECT COUNT(*) FROM chunks) AS chunk_count,
      (SELECT COUNT(*) FROM topics) AS topic_count,
      (SELECT COUNT(*) FROM search_log) AS search_count,
      (SELECT AVG(latency_ms) FROM search_log) AS avg_latency
  `,
      )
      .get(),
    "getStats.row",
  );

  let databaseSizeBytes = 0;
  if (dbPath) {
    try {
      databaseSizeBytes = statSync(dbPath).size;
    } catch {
      // Inaccessible paths report 0
    }
  }

  return {
    totalDocuments: row.doc_count,
    totalChunks: row.chunk_count,
    totalTopics: row.topic_count,
    databaseSizeBytes,
    totalSearches: row.search_count,
    avgLatencyMs: Math.round(row.avg_latency ?? 0),
  };
}

/** Return the most frequently returned documents in search results. */
export function getPopularDocuments(db: Database.Database, limit = 10): PopularDocument[] {
  const PopularDocSchema = z.object({
    documentId: z.string(),
    title: z.string(),
    hitCount: z.number(),
  });
  return validateRows(
    PopularDocSchema,
    db
      .prepare(
        `SELECT dh.document_id AS documentId, d.title, COUNT(*) AS hitCount
       FROM document_hits dh
       JOIN documents d ON d.id = dh.document_id
       GROUP BY dh.document_id
       ORDER BY hitCount DESC
       LIMIT ?`,
      )
      .all(limit),
    "getPopularDocuments.rows",
  );
}

/** Return documents that have never appeared in search results within the last N days. */
export function getStaleDocuments(db: Database.Database, days = 90): StaleDocument[] {
  const StaleDocSchema = z.object({
    documentId: z.string(),
    title: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  });
  return validateRows(
    StaleDocSchema,
    db
      .prepare(
        `SELECT d.id AS documentId, d.title, d.created_at AS createdAt, d.updated_at AS updatedAt
       FROM documents d
       WHERE d.id NOT IN (
         SELECT DISTINCT dh.document_id
         FROM document_hits dh
         JOIN search_log sl ON sl.id = dh.search_log_id
         WHERE sl.created_at >= datetime('now', ?)
       )
       ORDER BY d.updated_at ASC`,
      )
      .all(`-${days} days`),
    "getStaleDocuments.rows",
  );
}

/** Return the most frequent search queries. */
export function getTopQueries(db: Database.Database, limit = 10): TopQuery[] {
  const TopQuerySchema = z.object({
    query: z.string(),
    count: z.number(),
    avgLatencyMs: z.number(),
  });
  return validateRows(
    TopQuerySchema,
    db
      .prepare(
        `SELECT query, COUNT(*) AS count, ROUND(AVG(latency_ms)) AS avgLatencyMs
       FROM search_log
       GROUP BY query
       ORDER BY count DESC
       LIMIT ?`,
      )
      .all(limit),
    "getTopQueries.rows",
  );
}

/** Return search counts per day for the last N days. */
export function getSearchTrends(db: Database.Database, days = 30): SearchTrend[] {
  const SearchTrendSchema = z.object({ date: z.string(), count: z.number() });
  return validateRows(
    SearchTrendSchema,
    db
      .prepare(
        `SELECT DATE(created_at) AS date, COUNT(*) AS count
       FROM search_log
       WHERE created_at >= datetime('now', ?)
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      )
      .all(`-${days} days`),
    "getSearchTrends.rows",
  );
}

// --- Search-query analytics (search_queries table, migration v11) ---

export interface RecordSearchQueryInput {
  query: string;
  resultCount: number;
  topScore: number | null;
  searchType: string;
}

/** Persist a search query into the search_queries analytics table. */
export function recordSearchQuery(db: Database.Database, entry: RecordSearchQueryInput): void {
  try {
    db.prepare(
      "INSERT INTO search_queries (query, result_count, top_score, search_type) VALUES (?, ?, ?, ?)",
    ).run(entry.query, entry.resultCount, entry.topScore, entry.searchType);
  } catch (err) {
    getLogger().debug({ err }, "search_queries insert skipped (table may not exist yet)");
  }
}

export interface SearchAnalytics {
  totalSearches: number;
  avgResultCount: number;
  topQueries: Array<{ query: string; count: number }>;
  zeroResultQueries: Array<{ query: string; count: number }>;
  queriesPerDay: Array<{ date: string; count: number }>;
}

/** Aggregate search analytics from the search_queries table. */
export function getSearchAnalytics(db: Database.Database, days = 30): SearchAnalytics {
  const since = `-${days} days`;

  const TotalsSchema = z.object({ total: z.number(), avg_results: z.number().nullable() });
  const totals = validateRow(
    TotalsSchema,
    db
      .prepare(
        `SELECT COUNT(*) AS total, AVG(result_count) AS avg_results
       FROM search_queries WHERE created_at >= datetime('now', ?)`,
      )
      .get(since),
    "getSearchAnalytics.totals",
  );

  const QueryCountSchema = z.object({ query: z.string(), count: z.number() });
  const topQueries = validateRows(
    QueryCountSchema,
    db
      .prepare(
        `SELECT query, COUNT(*) AS count FROM search_queries
       WHERE created_at >= datetime('now', ?)
       GROUP BY query ORDER BY count DESC LIMIT 10`,
      )
      .all(since),
    "getSearchAnalytics.topQueries",
  );

  const zeroResultQueries = validateRows(
    QueryCountSchema,
    db
      .prepare(
        `SELECT query, COUNT(*) AS count FROM search_queries
       WHERE result_count = 0 AND created_at >= datetime('now', ?)
       GROUP BY query ORDER BY count DESC LIMIT 10`,
      )
      .all(since),
    "getSearchAnalytics.zeroResultQueries",
  );

  const DateCountSchema = z.object({ date: z.string(), count: z.number() });
  const queriesPerDay = validateRows(
    DateCountSchema,
    db
      .prepare(
        `SELECT DATE(created_at) AS date, COUNT(*) AS count FROM search_queries
       WHERE created_at >= datetime('now', ?)
       GROUP BY DATE(created_at) ORDER BY date ASC`,
      )
      .all(since),
    "getSearchAnalytics.queriesPerDay",
  );

  return {
    totalSearches: totals.total,
    avgResultCount: Math.round((totals.avg_results ?? 0) * 100) / 100,
    topQueries,
    zeroResultQueries,
    queriesPerDay,
  };
}

export interface KnowledgeGap {
  query: string;
  count: number;
  lastSearched: string;
}

/** Identify knowledge gaps: queries that consistently return zero results. */
export function getKnowledgeGaps(db: Database.Database, days = 30): KnowledgeGap[] {
  const KnowledgeGapSchema = z.object({
    query: z.string(),
    count: z.number(),
    lastSearched: z.string(),
  });
  return validateRows(
    KnowledgeGapSchema,
    db
      .prepare(
        `SELECT query, COUNT(*) AS count, MAX(created_at) AS lastSearched
       FROM search_queries
       WHERE result_count = 0 AND created_at >= datetime('now', ?)
       GROUP BY query
       ORDER BY count DESC
       LIMIT 20`,
      )
      .all(`-${days} days`),
    "getKnowledgeGaps.rows",
  );
}
