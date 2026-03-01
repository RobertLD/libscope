import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, createTestDbWithVec } from "../fixtures/test-db.js";
import { getDocument, deleteDocument, listDocuments } from "../../src/core/documents.js";
import { indexDocument, type IndexDocumentInput } from "../../src/core/indexing.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { ValidationError } from "../../src/errors.js";
import type Database from "better-sqlite3";

describe("documents", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    // Seed some documents
    db.prepare(
      `
      INSERT INTO documents (id, source_type, library, version, title, content, submitted_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run("doc-1", "library", "react", "18.2.0", "React Hooks", "Content about hooks", "manual");

    db.prepare(
      `
      INSERT INTO documents (id, source_type, library, version, title, content, submitted_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "doc-2",
      "library",
      "react",
      "18.2.0",
      "React Components",
      "Content about components",
      "manual",
    );

    db.prepare(
      `
      INSERT INTO documents (id, source_type, title, content, submitted_by)
      VALUES (?, ?, ?, ?, ?)
    `,
    ).run("doc-3", "topic", "Deployment Guide", "How to deploy", "manual");
  });

  describe("getDocument", () => {
    it("should return document by ID", () => {
      const doc = getDocument(db, "doc-1");
      expect(doc.id).toBe("doc-1");
      expect(doc.title).toBe("React Hooks");
      expect(doc.library).toBe("react");
      expect(doc.version).toBe("18.2.0");
      expect(doc.sourceType).toBe("library");
    });

    it("should throw for nonexistent document", () => {
      expect(() => getDocument(db, "nonexistent")).toThrow("Document not found");
    });
  });

  describe("deleteDocument", () => {
    it("should delete an existing document", () => {
      deleteDocument(db, "doc-1");
      expect(() => getDocument(db, "doc-1")).toThrow("Document not found");
    });

    it("should throw for nonexistent document", () => {
      expect(() => deleteDocument(db, "nonexistent")).toThrow("Document not found");
    });

    it("should cascade delete chunks", () => {
      // Insert a chunk for doc-1
      db.prepare(
        `
        INSERT INTO chunks (id, document_id, content, chunk_index)
        VALUES ('chunk-1', 'doc-1', 'Some chunk', 0)
      `,
      ).run();

      deleteDocument(db, "doc-1");

      const chunk = db.prepare("SELECT id FROM chunks WHERE id = 'chunk-1'").get();
      expect(chunk).toBeUndefined();
    });

    it("should cascade delete ratings", () => {
      db.prepare(
        `
        INSERT INTO ratings (id, document_id, rating, rated_by)
        VALUES ('rating-1', 'doc-1', 5, 'user')
      `,
      ).run();

      deleteDocument(db, "doc-1");

      const rating = db.prepare("SELECT id FROM ratings WHERE id = 'rating-1'").get();
      expect(rating).toBeUndefined();
    });
  });

  describe("listDocuments", () => {
    it("should list all documents", () => {
      const docs = listDocuments(db);
      expect(docs.length).toBe(3);
    });

    it("should filter by library", () => {
      const docs = listDocuments(db, { library: "react" });
      expect(docs.length).toBe(2);
      expect(docs.every((d) => d.library === "react")).toBe(true);
    });

    it("should filter by source type", () => {
      const docs = listDocuments(db, { sourceType: "topic" });
      expect(docs.length).toBe(1);
      expect(docs[0]!.title).toBe("Deployment Guide");
    });

    it("should respect limit", () => {
      const docs = listDocuments(db, { limit: 1 });
      expect(docs.length).toBe(1);
    });

    it("should return empty array when no matches", () => {
      const docs = listDocuments(db, { library: "nonexistent" });
      expect(docs.length).toBe(0);
    });
  });

  describe("duplicate detection", () => {
    let vecDb: Database.Database;
    let provider: MockEmbeddingProvider;

    const baseInput: IndexDocumentInput = {
      title: "Test Doc",
      content: "Some test content here.",
      sourceType: "library",
      library: "react",
      url: "https://example.com/doc",
    };

    beforeEach(() => {
      vecDb = createTestDbWithVec();
      provider = new MockEmbeddingProvider();
    });

    it("should reject duplicate URL", async () => {
      await indexDocument(vecDb, provider, baseInput);

      await expect(
        indexDocument(vecDb, provider, {
          ...baseInput,
          title: "Different Title",
          content: "Different content",
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        indexDocument(vecDb, provider, {
          ...baseInput,
          title: "Different Title",
          content: "Different content",
        }),
      ).rejects.toThrow("Document with URL already exists");
    });

    it("should reject duplicate title + content length", async () => {
      const inputNoUrl: IndexDocumentInput = { ...baseInput, url: undefined };
      await indexDocument(vecDb, provider, inputNoUrl);

      // Same title and same content length but different URL
      await expect(indexDocument(vecDb, provider, inputNoUrl)).rejects.toThrow(
        "Document with same title and content length already exists",
      );
    });

    it("should allow same URL if undefined", async () => {
      const inputNoUrl: IndexDocumentInput = { ...baseInput, url: undefined, content: "Content A" };
      await indexDocument(vecDb, provider, inputNoUrl);

      const inputNoUrl2: IndexDocumentInput = {
        ...baseInput,
        url: undefined,
        title: "Other Title",
        content: "Content B",
      };
      const result = await indexDocument(vecDb, provider, inputNoUrl2);
      expect(result.id).toBeDefined();
    });
  });
});
