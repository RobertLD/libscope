import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { searchDocuments } from "../../src/core/search.js";

function insertDoc(
  db: Database.Database,
  id: string,
  title: string,
  opts: { library?: string; topicId?: string } = {},
): void {
  db.prepare(
    `INSERT INTO documents (id, title, content, source_type, library, topic_id)
     VALUES (?, ?, '', 'manual', ?, ?)`,
  ).run(id, title, opts.library ?? null, opts.topicId ?? null);
}

function insertChunk(db: Database.Database, id: string, documentId: string, content: string): void {
  db.prepare(`INSERT INTO chunks (id, document_id, content, chunk_index) VALUES (?, ?, ?, 0)`).run(
    id,
    documentId,
    content,
  );
}

describe("searchDocuments (FTS5 fallback)", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    db = createTestDb();
    provider = new MockEmbeddingProvider();
  });

  afterEach(() => {
    db.close();
  });

  it("should return FTS5 BM25-ranked results", async () => {
    insertDoc(db, "doc1", "Intro to TypeScript");
    insertChunk(db, "c1", "doc1", "TypeScript is a typed superset of JavaScript");

    insertDoc(db, "doc2", "Advanced TypeScript");
    insertChunk(db, "c2", "doc2", "TypeScript generics and advanced type patterns");

    const { results, totalCount } = await searchDocuments(db, provider, { query: "TypeScript" });

    expect(results.length).toBe(2);
    expect(totalCount).toBe(2);
    expect(results[0].content).toContain("TypeScript");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("should filter by library", async () => {
    insertDoc(db, "doc1", "React Hooks", { library: "react" });
    insertChunk(db, "c1", "doc1", "React hooks allow state in functional components");

    insertDoc(db, "doc2", "Vue Composition", { library: "vue" });
    insertChunk(db, "c2", "doc2", "Vue composition API for state management");

    const { results } = await searchDocuments(db, provider, {
      query: "state",
      library: "react",
    });

    expect(results.length).toBe(1);
    expect(results[0].library).toBe("react");
  });

  it("should filter by topic", async () => {
    db.prepare(`INSERT INTO topics (id, name) VALUES (?, ?)`).run("testing", "Testing");
    db.prepare(`INSERT INTO topics (id, name) VALUES (?, ?)`).run("deployment", "Deployment");

    insertDoc(db, "doc1", "Testing Guide", { topicId: "testing" });
    insertChunk(db, "c1", "doc1", "Unit testing best practices for Node.js applications");

    insertDoc(db, "doc2", "Deploy Guide", { topicId: "deployment" });
    insertChunk(db, "c2", "doc2", "Deployment best practices for production");

    const { results } = await searchDocuments(db, provider, {
      query: "best practices",
      topic: "testing",
    });

    expect(results.length).toBe(1);
    expect(results[0].topicId).toBe("testing");
  });

  it("should return empty results for no matches", async () => {
    insertDoc(db, "doc1", "Some Doc");
    insertChunk(db, "c1", "doc1", "Content about databases and SQL");

    const { results } = await searchDocuments(db, provider, {
      query: "xyznonexistent",
    });

    expect(results).toEqual([]);
  });

  it("should paginate results with offset", async () => {
    insertDoc(db, "doc1", "First TypeScript Guide");
    insertChunk(db, "c1", "doc1", "TypeScript basics and fundamentals");

    insertDoc(db, "doc2", "Second TypeScript Guide");
    insertChunk(db, "c2", "doc2", "TypeScript advanced patterns");

    insertDoc(db, "doc3", "Third TypeScript Guide");
    insertChunk(db, "c3", "doc3", "TypeScript generics and utilities");

    const page1 = await searchDocuments(db, provider, {
      query: "TypeScript",
      limit: 2,
      offset: 0,
    });

    expect(page1.totalCount).toBe(3);
    expect(page1.results.length).toBe(2);

    const page2 = await searchDocuments(db, provider, {
      query: "TypeScript",
      limit: 2,
      offset: 2,
    });

    expect(page2.totalCount).toBe(3);
    expect(page2.results.length).toBe(1);
  });
});
