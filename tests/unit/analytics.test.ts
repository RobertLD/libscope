import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../fixtures/test-db.js";
import { insertDoc, insertChunk } from "../fixtures/helpers.js";
import {
  logSearch,
  getStats,
  getPopularDocuments,
  getStaleDocuments,
  getTopQueries,
  getSearchTrends,
} from "../../src/core/analytics.js";

describe("analytics", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertDoc(db, "doc-1", "Getting Started");
    insertDoc(db, "doc-2", "API Reference");
    insertDoc(db, "doc-3", "Troubleshooting");
    insertChunk(db, "chunk-1", "doc-1", "How to get started with the project");
    insertChunk(db, "chunk-2", "doc-2", "API reference for the REST endpoints");
    insertChunk(db, "chunk-3", "doc-3", "Common troubleshooting steps");
  });

  afterEach(() => {
    db.close();
  });

  describe("logSearch", () => {
    it("should record a search log entry", () => {
      const id = logSearch(db, {
        query: "getting started",
        searchMethod: "fts5",
        resultCount: 2,
        latencyMs: 15.7,
        documentIds: ["doc-1", "doc-2"],
      });

      expect(id).toBeTruthy();

      const row = db.prepare("SELECT * FROM search_log WHERE id = ?").get(id) as Record<
        string,
        unknown
      >;
      expect(row.query).toBe("getting started");
      expect(row.search_method).toBe("fts5");
      expect(row.result_count).toBe(2);
      expect(row.latency_ms).toBe(16); // rounded

      const hits = db.prepare("SELECT * FROM document_hits WHERE search_log_id = ?").all(id);
      expect(hits).toHaveLength(2);
    });

    it("should handle searches with no document hits", () => {
      const id = logSearch(db, {
        query: "nonexistent topic",
        searchMethod: "keyword",
        resultCount: 0,
        latencyMs: 3.2,
      });

      const row = db.prepare("SELECT * FROM search_log WHERE id = ?").get(id) as Record<
        string,
        unknown
      >;
      expect(row.result_count).toBe(0);

      const hits = db.prepare("SELECT * FROM document_hits WHERE search_log_id = ?").all(id);
      expect(hits).toHaveLength(0);
    });
  });

  describe("getStats", () => {
    it("should return expected shape with correct counts", () => {
      logSearch(db, {
        query: "test",
        searchMethod: "fts5",
        resultCount: 1,
        latencyMs: 10,
      });
      logSearch(db, {
        query: "test2",
        searchMethod: "fts5",
        resultCount: 2,
        latencyMs: 20,
      });

      const stats = getStats(db);
      expect(stats.totalDocuments).toBe(3);
      expect(stats.totalChunks).toBe(3);
      expect(stats.totalTopics).toBe(0);
      expect(stats.totalSearches).toBe(2);
      expect(stats.avgLatencyMs).toBe(15);
      expect(stats.databaseSizeBytes).toBe(0); // in-memory
    });
  });

  describe("getPopularDocuments", () => {
    it("should return documents ranked by hit count", () => {
      logSearch(db, {
        query: "start",
        searchMethod: "fts5",
        resultCount: 1,
        latencyMs: 5,
        documentIds: ["doc-1"],
      });
      logSearch(db, {
        query: "api",
        searchMethod: "fts5",
        resultCount: 2,
        latencyMs: 5,
        documentIds: ["doc-1", "doc-2"],
      });
      logSearch(db, {
        query: "rest",
        searchMethod: "fts5",
        resultCount: 1,
        latencyMs: 5,
        documentIds: ["doc-1"],
      });

      const popular = getPopularDocuments(db, 5);
      expect(popular).toHaveLength(2);
      expect(popular[0]!.documentId).toBe("doc-1");
      expect(popular[0]!.hitCount).toBe(3);
      expect(popular[1]!.documentId).toBe("doc-2");
      expect(popular[1]!.hitCount).toBe(1);
    });
  });

  describe("getStaleDocuments", () => {
    it("should return documents never returned in search results", () => {
      logSearch(db, {
        query: "start",
        searchMethod: "fts5",
        resultCount: 1,
        latencyMs: 5,
        documentIds: ["doc-1"],
      });

      const stale = getStaleDocuments(db, 90);
      const staleIds = stale.map((d) => d.documentId);
      expect(staleIds).toContain("doc-2");
      expect(staleIds).toContain("doc-3");
      expect(staleIds).not.toContain("doc-1");
    });
  });

  describe("getTopQueries", () => {
    it("should return queries ranked by frequency", () => {
      logSearch(db, { query: "react hooks", searchMethod: "fts5", resultCount: 3, latencyMs: 10 });
      logSearch(db, { query: "react hooks", searchMethod: "fts5", resultCount: 2, latencyMs: 20 });
      logSearch(db, { query: "typescript", searchMethod: "fts5", resultCount: 1, latencyMs: 5 });

      const top = getTopQueries(db, 5);
      expect(top).toHaveLength(2);
      expect(top[0]!.query).toBe("react hooks");
      expect(top[0]!.count).toBe(2);
      expect(top[0]!.avgLatencyMs).toBe(15);
      expect(top[1]!.query).toBe("typescript");
      expect(top[1]!.count).toBe(1);
    });
  });

  describe("getSearchTrends", () => {
    it("should return daily search counts", () => {
      logSearch(db, { query: "test", searchMethod: "fts5", resultCount: 1, latencyMs: 5 });
      logSearch(db, { query: "test2", searchMethod: "fts5", resultCount: 1, latencyMs: 5 });

      const trends = getSearchTrends(db, 7);
      expect(trends.length).toBeGreaterThanOrEqual(1);

      const today = trends[trends.length - 1]!;
      expect(today.count).toBe(2);
      expect(today.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
