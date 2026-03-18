import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, createTestDbWithVec } from "../fixtures/test-db.js";
import { pruneExpiredDocuments } from "../../src/core/ttl.js";

describe("pruneExpiredDocuments", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  function insertDocWithExpiry(id: string, expiresAt: string | null): void {
    db.prepare(
      `INSERT INTO documents (id, title, content, source_type, submitted_by, expires_at)
       VALUES (?, ?, ?, 'manual', 'manual', ?)`,
    ).run(id, `Doc ${id}`, `Content for ${id}`, expiresAt);
  }

  function insertChunkForDoc(chunkId: string, docId: string): void {
    db.prepare(
      `INSERT INTO chunks (id, document_id, content, chunk_index) VALUES (?, ?, 'chunk text', 0)`,
    ).run(chunkId, docId);
  }

  it("should return zero when no documents are expired", () => {
    insertDocWithExpiry("doc-1", null);
    insertDocWithExpiry("doc-2", "2099-12-31 23:59:59");

    const result = pruneExpiredDocuments(db);
    expect(result.pruned).toBe(0);

    // Documents should still exist
    const count = db.prepare("SELECT COUNT(*) as cnt FROM documents").get() as { cnt: number };
    expect(count.cnt).toBe(2);
  });

  it("should prune documents with past expires_at", () => {
    insertDocWithExpiry("doc-expired", "2000-01-01 00:00:00");
    insertDocWithExpiry("doc-alive", "2099-12-31 23:59:59");

    const result = pruneExpiredDocuments(db);
    expect(result.pruned).toBe(1);

    // Only the alive document should remain
    const remaining = db.prepare("SELECT id FROM documents").all() as Array<{ id: string }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe("doc-alive");
  });

  it("should cascade delete chunks when pruning", () => {
    insertDocWithExpiry("doc-expired", "2000-01-01 00:00:00");
    insertChunkForDoc("chunk-1", "doc-expired");
    insertChunkForDoc("chunk-2", "doc-expired");

    pruneExpiredDocuments(db);

    const chunks = db.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number };
    expect(chunks.cnt).toBe(0);
  });

  it("should cascade delete chunk_embeddings when table exists", () => {
    const dbVec = createTestDbWithVec();

    dbVec
      .prepare(
        `INSERT INTO documents (id, title, content, source_type, submitted_by, expires_at)
       VALUES (?, ?, ?, 'manual', 'manual', ?)`,
      )
      .run("doc-exp", "Doc", "Content", "2000-01-01 00:00:00");
    dbVec
      .prepare(
        `INSERT INTO chunks (id, document_id, content, chunk_index) VALUES (?, ?, 'text', 0)`,
      )
      .run("chunk-1", "doc-exp");
    dbVec
      .prepare(`INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)`)
      .run("chunk-1", Buffer.from(new Float32Array([1, 0, 0, 0]).buffer));

    pruneExpiredDocuments(dbVec);

    const embeddings = dbVec.prepare("SELECT COUNT(*) as cnt FROM chunk_embeddings").get() as {
      cnt: number;
    };
    expect(embeddings.cnt).toBe(0);
  });

  it("should handle case where chunk_embeddings table does not exist", () => {
    // Default createTestDb() doesn't have chunk_embeddings — should not throw
    insertDocWithExpiry("doc-expired", "2000-01-01 00:00:00");
    insertChunkForDoc("chunk-1", "doc-expired");

    expect(() => pruneExpiredDocuments(db)).not.toThrow();

    const result = pruneExpiredDocuments(db);
    // Already pruned, so nothing left
    expect(result.pruned).toBe(0);
  });

  it("should prune multiple expired documents at once", () => {
    insertDocWithExpiry("doc-1", "2000-01-01 00:00:00");
    insertDocWithExpiry("doc-2", "2000-06-15 12:00:00");
    insertDocWithExpiry("doc-3", "2001-03-20 08:30:00");
    insertDocWithExpiry("doc-alive", "2099-12-31 23:59:59");

    const result = pruneExpiredDocuments(db);
    expect(result.pruned).toBe(3);

    const remaining = db.prepare("SELECT COUNT(*) as cnt FROM documents").get() as { cnt: number };
    expect(remaining.cnt).toBe(1);
  });

  it("should return zero when no documents exist", () => {
    const result = pruneExpiredDocuments(db);
    expect(result.pruned).toBe(0);
  });
});
