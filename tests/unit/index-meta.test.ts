import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import DatabaseConstructor from "better-sqlite3";
import { createDatabase } from "../../src/db/connection.js";
import { runMigrations, createVectorTable } from "../../src/db/schema.js";
import {
  getVectorTableDimensions,
  readEmbeddingIdentity,
  rebuildVectorTable,
} from "../../src/db/index-meta.js";
import { searchDocuments } from "../../src/core/search.js";
import { ConfigError, DatabaseError } from "../../src/errors.js";
import { initLogger } from "../../src/logger.js";
import type { EmbeddingProvider } from "../../src/providers/embedding.js";

/** Provider stub that returns constant vectors of a fixed size. */
class FixedProvider implements EmbeddingProvider {
  embedCalls = 0;
  constructor(
    readonly name: string,
    readonly model: string,
    private size: number,
    private readonly reportedSize: number = size,
  ) {}

  get dimensions(): number {
    return this.reportedSize === 0 && this.embedCalls > 0 ? this.size : this.reportedSize;
  }

  embed(_text: string): Promise<number[]> {
    this.embedCalls++;
    return Promise.resolve(Array.from({ length: this.size }, (_, i) => (i + 1) / this.size));
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

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

const vecAvailable = hasSqliteVec();

function vecRowCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM chunk_embeddings").get() as { n: number }).n;
}

describe.skipIf(!vecAvailable)("vector index metadata (sqlite-vec)", () => {
  let db: Database.Database;

  beforeEach(() => {
    initLogger("silent");
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("records provider, model and dimensions when it creates the vector table", () => {
    runMigrations(db);
    createVectorTable(db, new FixedProvider("ollama", "nomic-embed-text", 768));

    expect(getVectorTableDimensions(db)).toBe(768);
    expect(readEmbeddingIdentity(db)).toEqual({
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: 768,
    });
  });

  it("populates metadata for a vector table built before schema v18", () => {
    runMigrations(db, 17);
    db.exec(
      "CREATE VIRTUAL TABLE chunk_embeddings USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[4])",
    );
    runMigrations(db);
    expect(readEmbeddingIdentity(db)).toEqual({
      provider: undefined,
      model: undefined,
      dimensions: undefined,
    });

    createVectorTable(db, 4);
    expect(readEmbeddingIdentity(db).dimensions).toBe(4);

    createVectorTable(db, new FixedProvider("mock", "m1", 4));
    expect(readEmbeddingIdentity(db)).toEqual({ provider: "mock", model: "m1", dimensions: 4 });
  });

  it("rejects a provider whose vector size differs from the index", () => {
    runMigrations(db);
    createVectorTable(db, new FixedProvider("ollama", "nomic-embed-text", 768));

    const change = (): void =>
      createVectorTable(db, new FixedProvider("ollama", "mxbai-embed-large", 1024));
    expect(change).toThrow(ConfigError);
    expect(change).toThrow(/vector index \(ollama\/nomic-embed-text, 768 dimensions\)/);
    expect(change).toThrow(
      /configured embedding model \(ollama\/mxbai-embed-large, 1024 dimensions\)/,
    );
    expect(change).toThrow(/libscope reindex --rebuild/);
    // A bare vector size is checked against the table too.
    expect(() => createVectorTable(db, 1024)).toThrow(
      /does not match the configured embedding model \(1024 dimensions\)/,
    );
  });

  it("rejects a different model with the same vector size", () => {
    runMigrations(db);
    createVectorTable(db, new FixedProvider("openai", "text-embedding-3-small", 1536));

    expect(() =>
      createVectorTable(db, new FixedProvider("openai", "text-embedding-ada-002", 1536)),
    ).toThrow(/text-embedding-3-small.*text-embedding-ada-002/);
  });

  it("accepts the same provider again and a provider whose size is not known yet", () => {
    runMigrations(db);
    createVectorTable(db, new FixedProvider("ollama", "custom", 512));

    expect(() => createVectorTable(db, new FixedProvider("ollama", "custom", 512))).not.toThrow();
    expect(() =>
      createVectorTable(db, new FixedProvider("ollama", "custom", 512, 0)),
    ).not.toThrow();
    expect(() => createVectorTable(db, 512)).not.toThrow();
  });

  it("refuses to create a table when the vector size is unknown", () => {
    runMigrations(db);
    const unknown = (): void =>
      createVectorTable(db, new FixedProvider("ollama", "custom", 512, 0));
    expect(unknown).toThrow(DatabaseError);
    expect(unknown).toThrow(/embedding\.dimensions/);
  });

  it("rebuildVectorTable recreates the table with the new size and records it", async () => {
    runMigrations(db);
    createVectorTable(db, new FixedProvider("ollama", "nomic-embed-text", 4));
    db.prepare("INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)").run(
      "c1",
      Buffer.from(new Float32Array([1, 0, 0, 0]).buffer),
    );

    const next = new FixedProvider("ollama", "mxbai-embed-large", 8);
    const identity = await rebuildVectorTable(db, next);

    expect(identity).toEqual({ provider: "ollama", model: "mxbai-embed-large", dimensions: 8 });
    expect(getVectorTableDimensions(db)).toBe(8);
    expect(vecRowCount(db)).toBe(0);
    expect(readEmbeddingIdentity(db)).toEqual(identity);
    expect(() => createVectorTable(db, next)).not.toThrow();
  });

  it("rebuildVectorTable embeds a probe text when the provider size is unknown", async () => {
    runMigrations(db);
    const provider = new FixedProvider("ollama", "custom", 6, 0);

    const identity = await rebuildVectorTable(db, provider);

    expect(provider.embedCalls).toBe(1);
    expect(identity.dimensions).toBe(6);
    expect(getVectorTableDimensions(db)).toBe(6);
  });

  it("rebuildVectorTable keeps the old table when the model output does not match its size", async () => {
    runMigrations(db);
    createVectorTable(db, 4);
    // Reports 12 dimensions but returns 40-dimension vectors (a wrong embedding.dimensions).
    const provider = new FixedProvider("ollama", "custom", 40, 12);

    await expect(rebuildVectorTable(db, provider)).rejects.toThrow(
      "Expected embedding dimension 12, got 40",
    );
    expect(getVectorTableDimensions(db)).toBe(4);
  });

  it("search falls back to keyword results when the query vector size does not match", async () => {
    runMigrations(db);
    createVectorTable(db, 4);
    db.prepare(
      "INSERT INTO documents (id, source_type, title, content) VALUES ('d1', 'manual', 'Doc', 'x')",
    ).run();
    db.prepare(
      "INSERT INTO chunks (id, document_id, content, chunk_index) VALUES ('c1', 'd1', 'kiwi orchard', 0)",
    ).run();
    db.prepare("INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)").run(
      "c1",
      Buffer.from(new Float32Array([1, 0, 0, 0]).buffer),
    );

    const { results } = await searchDocuments(db, new FixedProvider("mock", "m", 3), {
      query: "kiwi",
    });

    expect(results.map((r) => r.chunkId)).toEqual(["c1"]);
    expect(results[0]?.scoreExplanation.method).not.toBe("vector");
  });
});

describe("vector index metadata (no sqlite-vec)", () => {
  beforeEach(() => {
    initLogger("silent");
  });

  it("rebuildVectorTable reports that sqlite-vec is required", async () => {
    const db = new DatabaseConstructor(":memory:");
    runMigrations(db);
    await expect(rebuildVectorTable(db, new FixedProvider("mock", "m", 4))).rejects.toThrow(
      /sqlite-vec/,
    );
    db.close();
  });

  it("readEmbeddingIdentity returns nothing before migration 18", () => {
    const db = new DatabaseConstructor(":memory:");
    runMigrations(db, 17);
    expect(readEmbeddingIdentity(db)).toEqual({});
    db.close();
  });
});
