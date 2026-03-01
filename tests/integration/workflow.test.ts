import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { indexDocument } from "../../src/core/indexing.js";
import { searchDocuments } from "../../src/core/search.js";
import { rateDocument, getDocumentRatings } from "../../src/core/ratings.js";
import { getDocument, listDocuments } from "../../src/core/documents.js";
import { createTopic, listTopics } from "../../src/core/topics.js";
import type Database from "better-sqlite3";

describe("integration: full workflow", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    db = createTestDb();
    // Create a simple chunk_embeddings table for the mock (no vec0)
    db.exec(`
      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunk_id TEXT PRIMARY KEY,
        embedding BLOB
      );
    `);
    provider = new MockEmbeddingProvider();
  });

  it("should index, search, and rate a document end-to-end", async () => {
    // 1. Create a topic
    const topic = createTopic(db, {
      name: "Authentication",
      description: "Auth docs",
    });
    expect(topic.id).toBe("authentication");

    // 2. Index a document
    const indexed = await indexDocument(db, provider, {
      title: "JWT Authentication Guide",
      content: `# JWT Auth\n\nUse Bearer tokens for API auth.\n\n## Setup\n\nInstall jsonwebtoken package.\n\n## Usage\n\nSign tokens with jwt.sign().`,
      sourceType: "topic",
      topicId: topic.id,
    });

    expect(indexed.id).toBeTruthy();
    expect(indexed.chunkCount).toBeGreaterThan(0);

    // 3. Verify document was stored
    const doc = getDocument(db, indexed.id);
    expect(doc.title).toBe("JWT Authentication Guide");
    expect(doc.topicId).toBe("authentication");
    expect(doc.sourceType).toBe("topic");

    // 4. Verify chunks were created
    const chunks = db
      .prepare("SELECT * FROM chunks WHERE document_id = ?")
      .all(indexed.id) as Array<{ id: string; content: string }>;
    expect(chunks.length).toBe(indexed.chunkCount);

    // 5. Search (falls back to keyword since we don't have vec0)
    const results = await searchDocuments(db, provider, {
      query: "JWT tokens authentication",
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.title).toBe("JWT Authentication Guide");

    // 6. Rate the document
    const rating = rateDocument(db, {
      documentId: indexed.id,
      rating: 4,
      feedback: "Clear and helpful",
    });
    expect(rating.rating).toBe(4);

    // 7. Check ratings
    const summary = getDocumentRatings(db, indexed.id);
    expect(summary.averageRating).toBe(4);
    expect(summary.totalRatings).toBe(1);
  });

  it("should index library docs with version", async () => {
    const indexed = await indexDocument(db, provider, {
      title: "React Hooks API",
      content:
        "# useState\n\nManage state in function components.\n\n# useEffect\n\nPerform side effects.",
      sourceType: "library",
      library: "react",
      version: "18.2.0",
      url: "https://react.dev/reference/react/useState",
    });

    const doc = getDocument(db, indexed.id);
    expect(doc.library).toBe("react");
    expect(doc.version).toBe("18.2.0");
    expect(doc.url).toBe("https://react.dev/reference/react/useState");

    // List by library
    const docs = listDocuments(db, { library: "react" });
    expect(docs.length).toBe(1);
    expect(docs[0]!.library).toBe("react");
  });

  it("should handle model-submitted documents", async () => {
    const indexed = await indexDocument(db, provider, {
      title: "Auto-generated: Express.js Middleware",
      content: "Middleware functions have access to req, res, and next.",
      sourceType: "model-generated",
      submittedBy: "model",
    });

    const doc = getDocument(db, indexed.id);
    expect(doc.sourceType).toBe("model-generated");
    expect(doc.submittedBy).toBe("model");
  });

  it("should support topic hierarchy", () => {
    const infra = createTopic(db, { name: "Infrastructure" });
    createTopic(db, { name: "Kubernetes", parentId: infra.id });
    createTopic(db, { name: "Docker", parentId: infra.id });
    createTopic(db, { name: "Networking" });

    // Root topics
    const roots = listTopics(db);
    expect(roots.length).toBe(2); // Infrastructure, Networking

    // Children of Infrastructure
    const children = listTopics(db, infra.id);
    expect(children.length).toBe(2);
    expect(children.map((c) => c.name).sort()).toEqual(["Docker", "Kubernetes"]);
  });

  it("should allow model to rate and suggest corrections", async () => {
    const indexed = await indexDocument(db, provider, {
      title: "Old API Docs",
      content: "Use POST /v1/users to create a user.",
      sourceType: "library",
      library: "my-api",
      version: "1.0.0",
    });

    rateDocument(db, {
      documentId: indexed.id,
      rating: 2,
      feedback: "Endpoint was moved in v2",
      suggestedCorrection: "Use POST /v2/users to create a user.",
      ratedBy: "model:claude-3",
    });

    const summary = getDocumentRatings(db, indexed.id);
    expect(summary.averageRating).toBe(2);
    expect(summary.corrections).toBe(1);
  });

  it("should handle multiple documents and search across them", async () => {
    await indexDocument(db, provider, {
      title: "Database Setup",
      content: "PostgreSQL connection setup with connection pooling.",
      sourceType: "topic",
    });

    await indexDocument(db, provider, {
      title: "Redis Caching",
      content: "Redis caching layer for API responses.",
      sourceType: "topic",
    });

    await indexDocument(db, provider, {
      title: "Authentication",
      content: "JWT token based authentication flow.",
      sourceType: "topic",
    });

    // Keyword search should find the right docs
    const dbResults = await searchDocuments(db, provider, {
      query: "PostgreSQL connection",
    });
    expect(dbResults.length).toBeGreaterThan(0);
    expect(dbResults[0]!.title).toBe("Database Setup");

    const authResults = await searchDocuments(db, provider, {
      query: "JWT authentication token",
    });
    expect(authResults.length).toBeGreaterThan(0);
    expect(authResults[0]!.title).toBe("Authentication");
  });

  it("should validate inputs during indexing", async () => {
    await expect(
      indexDocument(db, provider, {
        title: "",
        content: "Some content",
        sourceType: "manual",
      }),
    ).rejects.toThrow("title is required");

    await expect(
      indexDocument(db, provider, {
        title: "Valid title",
        content: "",
        sourceType: "manual",
      }),
    ).rejects.toThrow("content is required");
  });

  it("should track embedding provider calls", async () => {
    await indexDocument(db, provider, {
      title: "Test Doc",
      content: "Short content without headings.",
      sourceType: "manual",
    });

    expect(provider.embedBatchCallCount).toBe(1);

    await searchDocuments(db, provider, { query: "test" });
    expect(provider.embedCallCount).toBe(1);
  });
});
