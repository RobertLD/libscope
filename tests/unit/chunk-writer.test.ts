import { describe, it, expect, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDatabase } from "../../src/db/connection.js";
import { runMigrations, createVectorTable } from "../../src/db/schema.js";
import { createChunkWriter } from "../../src/core/indexing.js";
import { EmbeddingError } from "../../src/errors.js";

function hasSqliteVec(): boolean {
  const db = createDatabase(":memory:");
  try {
    db.prepare("SELECT vec_version()").get();
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

describe.skipIf(!hasSqliteVec())("createChunkWriter (sqlite-vec)", () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function openIndexedDb(): Database.Database {
    const database = createDatabase(":memory:");
    runMigrations(database);
    createVectorTable(database, 4);
    database
      .prepare("INSERT INTO documents (id, title, content, source_type) VALUES (?, ?, ?, ?)")
      .run("doc-1", "Doc", "content", "manual");
    return database;
  }

  it("stores chunks whose vectors match the index size", () => {
    db = openIndexedDb();
    createChunkWriter(db).insertChunks("doc-1", ["a"], [[0.1, 0.2, 0.3, 0.4]]);
    const row = db.prepare("SELECT COUNT(*) AS n FROM chunk_embeddings").get() as { n: number };
    expect(row.n).toBe(1);
  });

  it("explains how to rebuild when a vector does not match the index size", () => {
    db = openIndexedDb();
    const writer = createChunkWriter(db);
    let error: unknown;
    try {
      writer.insertChunks("doc-1", ["a"], [[0.1, 0.2, 0.3]]);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(EmbeddingError);
    expect((error as Error).message).toMatch(/3 dimensions.*libscope admin reindex --rebuild/);
  });
});
