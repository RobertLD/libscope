import { describe, it, expect, beforeEach } from "vitest";
import DatabaseConstructor from "better-sqlite3";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../src/db/schema.js";
import { searchDocuments } from "../../src/core/search.js";
import { initLogger } from "../../src/logger.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";

function newDb(): Database.Database {
  const db = new DatabaseConstructor(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

function seedChunks(db: Database.Database, docCount: number, chunksPerDoc: number): void {
  const insertDoc = db.prepare(
    "INSERT INTO documents (id, source_type, title, content) VALUES (?, 'manual', ?, ?)",
  );
  const insertChunk = db.prepare(
    "INSERT INTO chunks (id, document_id, content, chunk_index) VALUES (?, ?, ?, ?)",
  );
  for (let d = 0; d < docCount; d++) {
    insertDoc.run(`doc-${d}`, `Document ${d}`, `content of document ${d}`);
    for (let c = 0; c < chunksPerDoc; c++) {
      insertChunk.run(`chunk-${d}-${c}`, `doc-${d}`, `alpha bravo doc${d} part${c}`, c);
    }
  }
}

function seedChunksForDoc(db: Database.Database, docId: string, chunkCount: number): void {
  db.prepare(
    "INSERT INTO documents (id, source_type, title, content) VALUES (?, 'manual', ?, '')",
  ).run(docId, docId);
  const insertChunk = db.prepare(
    "INSERT INTO chunks (id, document_id, content, chunk_index) VALUES (?, ?, ?, ?)",
  );
  for (let c = 0; c < chunkCount; c++) {
    insertChunk.run(`${docId}-chunk-${c}`, docId, `charlie ${docId} part${c}`, c);
  }
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** FTS rows whose rowid does not point at the chunk they describe. */
function misalignedFtsRows(db: Database.Database): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM chunks_fts f
         LEFT JOIN chunks c ON c.rowid = f.rowid
         WHERE c.id IS NULL OR c.id != f.chunk_id`,
      )
      .get() as { n: number }
  ).n;
}

async function keywordHits(db: Database.Database, query: string): Promise<string[]> {
  const { results } = await searchDocuments(db, new MockEmbeddingProvider(), {
    query,
    limit: 50,
  });
  return results.map((r) => `${r.chunkId}:${r.score.toFixed(6)}`);
}

describe("schema migrations", () => {
  beforeEach(() => {
    initLogger("silent");
  });

  describe("FTS backfill", () => {
    it("does not duplicate FTS rows when upgrading a populated database", () => {
      const db = newDb();
      runMigrations(db, 16);
      seedChunks(db, 3, 4);
      expect(count(db, "chunks_fts")).toBe(12);

      runMigrations(db);

      expect(count(db, "chunks_fts")).toBe(count(db, "chunks"));
    });

    it("backfills an empty FTS index from existing chunks", () => {
      const db = newDb();
      runMigrations(db, 16);
      seedChunks(db, 2, 3);
      db.exec("DELETE FROM chunks_fts");
      expect(count(db, "chunks_fts")).toBe(0);

      runMigrations(db);

      expect(count(db, "chunks_fts")).toBe(6);
    });
  });

  describe("migration 18: chunks_fts keyed by chunk rowid", () => {
    it("keeps keyword search results unchanged", async () => {
      const db = newDb();
      runMigrations(db, 17);
      seedChunks(db, 4, 5);
      const before = await keywordHits(db, "bravo doc2");
      expect(before.length).toBeGreaterThan(0);

      runMigrations(db);

      expect(await keywordHits(db, "bravo doc2")).toEqual(before);
      expect(count(db, "chunks_fts")).toBe(count(db, "chunks"));
      expect(misalignedFtsRows(db)).toBe(0);
    });

    it("removes duplicate FTS rows left by earlier backfills", async () => {
      const db = newDb();
      runMigrations(db, 17);
      seedChunks(db, 3, 4);
      const clean = await keywordHits(db, "alpha");
      // Simulate the old backfill bug: every chunk indexed twice.
      db.exec(
        "INSERT INTO chunks_fts(content, chunk_id, document_id) SELECT content, id, document_id FROM chunks",
      );
      expect(count(db, "chunks_fts")).toBe(24);

      runMigrations(db);

      expect(count(db, "chunks_fts")).toBe(12);
      expect(await keywordHits(db, "alpha")).toEqual(clean);
    });

    it("keeps chunks_fts in sync on insert, update and delete", () => {
      const db = newDb();
      runMigrations(db);
      seedChunks(db, 3, 4);
      expect(count(db, "chunks_fts")).toBe(12);

      db.prepare("UPDATE chunks SET content = 'zulu replaced' WHERE id = 'chunk-0-0'").run();
      const updated = db
        .prepare("SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH 'zulu'")
        .all() as Array<{ chunk_id: string }>;
      expect(updated).toEqual([{ chunk_id: "chunk-0-0" }]);

      db.prepare("DELETE FROM documents WHERE id = 'doc-1'").run();
      expect(count(db, "chunks_fts")).toBe(8);
      expect(misalignedFtsRows(db)).toBe(0);
    });

    it("stays aligned with chunks after VACUUM", () => {
      const dir = mkdtempSync(join(tmpdir(), "libscope-fts-"));
      try {
        const db = new DatabaseConstructor(join(dir, "test.db"));
        db.pragma("foreign_keys = ON");
        runMigrations(db);
        seedChunks(db, 6, 5);
        db.prepare("DELETE FROM documents WHERE id IN ('doc-1', 'doc-3')").run();
        db.exec("VACUUM");
        expect(misalignedFtsRows(db)).toBe(0);

        db.prepare("DELETE FROM documents WHERE id = 'doc-4'").run();
        seedChunksForDoc(db, "doc-new", 3);
        expect(count(db, "chunks_fts")).toBe(count(db, "chunks"));
        expect(misalignedFtsRows(db)).toBe(0);
        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("migration 18: documents title index", () => {
    it("indexes documents.title and uses it for the dedup lookup", () => {
      const db = newDb();
      runMigrations(db, 17);
      seedChunks(db, 2, 1);

      runMigrations(db);

      const index = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_documents_title'",
        )
        .get();
      expect(index).toBeDefined();
      const plan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM documents WHERE title = ? AND LENGTH(content) = ?",
        )
        .all("Document 1", 22) as Array<{ detail: string }>;
      expect(plan.map((p) => p.detail).join(" ")).toContain("idx_documents_title");
    });
  });
});
