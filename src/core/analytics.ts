import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { getLogger } from "../logger.js";

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
  const docs = db.prepare("SELECT COUNT(*) AS cnt FROM documents").get() as { cnt: number };
  const chunks = db.prepare("SELECT COUNT(*) AS cnt FROM chunks").get() as { cnt: number };
  const topics = db.prepare("SELECT COUNT(*) AS cnt FROM topics").get() as { cnt: number };
  const searches = db.prepare("SELECT COUNT(*) AS cnt FROM search_log").get() as { cnt: number };
  const latency = db.prepare("SELECT AVG(latency_ms) AS avg FROM search_log").get() as {
    avg: number | null;
  };

  let databaseSizeBytes = 0;
  if (dbPath) {
    try {
      databaseSizeBytes = statSync(dbPath).size;
    } catch {
      // Inaccessible paths report 0
    }
  }

  return {
    totalDocuments: docs.cnt,
    totalChunks: chunks.cnt,
    totalTopics: topics.cnt,
    databaseSizeBytes,
    totalSearches: searches.cnt,
    avgLatencyMs: Math.round(latency.avg ?? 0),
  };
}

/** Return the most frequently returned documents in search results. */
export function getPopularDocuments(db: Database.Database, limit = 10): PopularDocument[] {
  return db
    .prepare(
      `SELECT dh.document_id AS documentId, d.title, COUNT(*) AS hitCount
       FROM document_hits dh
       JOIN documents d ON d.id = dh.document_id
       GROUP BY dh.document_id
       ORDER BY hitCount DESC
       LIMIT ?`,
    )
    .all(limit) as PopularDocument[];
}

/** Return documents that have never appeared in search results within the last N days. */
export function getStaleDocuments(db: Database.Database, days = 90): StaleDocument[] {
  return db
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
    .all(`-${days} days`) as StaleDocument[];
}

/** Return the most frequent search queries. */
export function getTopQueries(db: Database.Database, limit = 10): TopQuery[] {
  return db
    .prepare(
      `SELECT query, COUNT(*) AS count, ROUND(AVG(latency_ms)) AS avgLatencyMs
       FROM search_log
       GROUP BY query
       ORDER BY count DESC
       LIMIT ?`,
    )
    .all(limit) as TopQuery[];
}

/** Return search counts per day for the last N days. */
export function getSearchTrends(db: Database.Database, days = 30): SearchTrend[] {
  return db
    .prepare(
      `SELECT DATE(created_at) AS date, COUNT(*) AS count
       FROM search_log
       WHERE created_at >= datetime('now', ?)
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
    )
    .all(`-${days} days`) as SearchTrend[];
}
