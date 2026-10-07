import { describe, it, expect, beforeEach } from "vitest";
import DatabaseConstructor from "better-sqlite3";
import type Database from "better-sqlite3";
import { runMigrations } from "../../src/db/schema.js";
import { initLogger } from "../../src/logger.js";

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

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
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
});
