import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../fixtures/test-db.js";
import { insertDoc } from "../fixtures/helpers.js";
import { resolveSelector, bulkDelete, bulkRetag, bulkMove } from "../../src/core/bulk.js";
import { getDocument, listDocuments } from "../../src/core/documents.js";
import { addTagsToDocument, getDocumentTags } from "../../src/core/tags.js";
import { ValidationError } from "../../src/errors.js";
import { initLogger } from "../../src/logger.js";

initLogger("silent");

describe("bulk operations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();

    // Create topics first (foreign key constraint)
    db.prepare("INSERT INTO topics (id, name) VALUES (?, ?)").run("topic-1", "Topic 1");
    db.prepare("INSERT INTO topics (id, name) VALUES (?, ?)").run("topic-2", "Topic 2");
    db.prepare("INSERT INTO topics (id, name) VALUES (?, ?)").run("topic-3", "Topic 3");

    // Seed test documents
    insertDoc(db, "doc-a", "Doc A", {
      library: "react",
      topicId: "topic-1",
      sourceType: "library",
    });
    insertDoc(db, "doc-b", "Doc B", { library: "react", topicId: "topic-1", sourceType: "manual" });
    insertDoc(db, "doc-c", "Doc C", { library: "vue", topicId: "topic-2", sourceType: "library" });
    insertDoc(db, "doc-d", "Doc D", { library: "vue", topicId: "topic-2", sourceType: "library" });
    insertDoc(db, "doc-e", "Doc E", {
      library: "angular",
      topicId: "topic-3",
      sourceType: "manual",
    });
  });

  describe("resolveSelector", () => {
    it("resolves by topicId", () => {
      const ids = resolveSelector(db, { topicId: "topic-1" });
      expect(ids).toHaveLength(2);
      expect(ids).toContain("doc-a");
      expect(ids).toContain("doc-b");
    });

    it("resolves by library", () => {
      const ids = resolveSelector(db, { library: "vue" });
      expect(ids).toHaveLength(2);
      expect(ids).toContain("doc-c");
      expect(ids).toContain("doc-d");
    });

    it("resolves by sourceType", () => {
      const ids = resolveSelector(db, { sourceType: "library" });
      expect(ids).toHaveLength(3);
      expect(ids).toContain("doc-a");
      expect(ids).toContain("doc-c");
      expect(ids).toContain("doc-d");
    });

    it("resolves by multiple filters", () => {
      const ids = resolveSelector(db, { library: "react", sourceType: "library" });
      expect(ids).toEqual(["doc-a"]);
    });

    it("resolves by tags", () => {
      addTagsToDocument(db, "doc-a", ["frontend"]);
      addTagsToDocument(db, "doc-b", ["frontend"]);
      addTagsToDocument(db, "doc-c", ["frontend"]);

      const ids = resolveSelector(db, { tags: ["frontend"], library: "react" });
      expect(ids).toHaveLength(2);
      expect(ids).toContain("doc-a");
      expect(ids).toContain("doc-b");
    });

    it("throws on empty selector", () => {
      expect(() => resolveSelector(db, {})).toThrow(ValidationError);
    });

    it("respects max batch size limit", () => {
      // Insert many docs
      for (let i = 0; i < 50; i++) {
        insertDoc(db, `bulk-${i}`, `Bulk Doc ${i}`, { library: "mass" });
      }

      const ids = resolveSelector(db, { library: "mass" }, 10);
      expect(ids.length).toBeLessThanOrEqual(10);
    });
  });

  describe("bulkDelete", () => {
    it("deletes matching documents", () => {
      const result = bulkDelete(db, { library: "react" });
      expect(result.affected).toBe(2);
      expect(result.documentIds).toContain("doc-a");
      expect(result.documentIds).toContain("doc-b");

      // Verify they're actually gone
      const remaining = listDocuments(db, { limit: 100 });
      expect(remaining).toHaveLength(3);
      expect(remaining.map((d) => d.id)).not.toContain("doc-a");
      expect(remaining.map((d) => d.id)).not.toContain("doc-b");
    });

    it("dry run does not delete", () => {
      const result = bulkDelete(db, { library: "react" }, true);
      expect(result.affected).toBe(2);

      // Verify nothing was deleted
      const remaining = listDocuments(db, { limit: 100 });
      expect(remaining).toHaveLength(5);
    });
  });

  describe("bulkRetag", () => {
    it("adds tags to matching documents", () => {
      const result = bulkRetag(db, { library: "react" }, ["important", "v2"]);
      expect(result.affected).toBe(2);

      const tagsA = getDocumentTags(db, "doc-a").map((t) => t.name);
      const tagsB = getDocumentTags(db, "doc-b").map((t) => t.name);
      expect(tagsA).toContain("important");
      expect(tagsA).toContain("v2");
      expect(tagsB).toContain("important");
      expect(tagsB).toContain("v2");
    });

    it("removes tags from matching documents", () => {
      addTagsToDocument(db, "doc-a", ["old-tag"]);
      addTagsToDocument(db, "doc-b", ["old-tag"]);

      const result = bulkRetag(db, { library: "react" }, undefined, ["old-tag"]);
      expect(result.affected).toBe(2);

      const tagsA = getDocumentTags(db, "doc-a").map((t) => t.name);
      const tagsB = getDocumentTags(db, "doc-b").map((t) => t.name);
      expect(tagsA).not.toContain("old-tag");
      expect(tagsB).not.toContain("old-tag");
    });

    it("dry run does not modify tags", () => {
      const result = bulkRetag(db, { library: "react" }, ["new-tag"], undefined, true);
      expect(result.affected).toBe(2);

      const tagsA = getDocumentTags(db, "doc-a").map((t) => t.name);
      expect(tagsA).not.toContain("new-tag");
    });

    it("throws if no addTags or removeTags specified", () => {
      expect(() => bulkRetag(db, { library: "react" })).toThrow(ValidationError);
    });
  });

  describe("bulkMove", () => {
    it("moves matching documents to target topic", () => {
      db.prepare("INSERT INTO topics (id, name) VALUES (?, ?)").run("topic-99", "Target Topic");
      const result = bulkMove(db, { library: "react" }, "topic-99");
      expect(result.affected).toBe(2);

      const docA = getDocument(db, "doc-a");
      const docB = getDocument(db, "doc-b");
      expect(docA.topicId).toBe("topic-99");
      expect(docB.topicId).toBe("topic-99");
    });

    it("dry run does not move documents", () => {
      db.prepare("INSERT INTO topics (id, name) VALUES (?, ?)").run("topic-99", "Target Topic");
      const result = bulkMove(db, { library: "react" }, "topic-99", true);
      expect(result.affected).toBe(2);

      const docA = getDocument(db, "doc-a");
      expect(docA.topicId).toBe("topic-1");
    });
  });
});
