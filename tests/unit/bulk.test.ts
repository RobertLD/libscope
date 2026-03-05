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

    it("filters by dateFrom", () => {
      insertDoc(db, "doc-old", "Old Doc", {
        library: "react",
        createdAt: "2020-01-01T00:00:00.000Z",
      });
      const ids = resolveSelector(db, { library: "react", dateFrom: "2024-01-01T00:00:00.000Z" });
      expect(ids).not.toContain("doc-old");
      expect(ids).toContain("doc-a");
    });

    it("filters by dateTo", () => {
      insertDoc(db, "doc-future", "Future Doc", {
        library: "react",
        createdAt: "2099-01-01T00:00:00.000Z",
      });
      const ids = resolveSelector(db, { library: "react", dateTo: "2025-01-01T00:00:00.000Z" });
      expect(ids).not.toContain("doc-future");
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

    it("throws ValidationError for negative limit", () => {
      expect(() => resolveSelector(db, { library: "react" }, -5)).toThrow(ValidationError);
      expect(() => resolveSelector(db, { library: "react" }, -1)).toThrow(
        "limit must be a non-negative integer",
      );
    });

    it("applies dateFrom filter at SQL level before LIMIT", () => {
      // Insert enough docs to exceed a small limit, with varying dates
      for (let i = 0; i < 20; i++) {
        insertDoc(db, `old-${i}`, `Old Doc ${i}`, {
          library: "test-lib",
          createdAt: "2020-01-01T00:00:00.000Z",
        });
      }
      for (let i = 0; i < 5; i++) {
        insertDoc(db, `new-${i}`, `New Doc ${i}`, {
          library: "test-lib",
          createdAt: "2025-06-01T00:00:00.000Z",
        });
      }

      // With a limit of 10, date filter must happen in SQL before LIMIT,
      // otherwise old docs could fill the limit and exclude new ones
      const ids = resolveSelector(
        db,
        { library: "test-lib", dateFrom: "2025-01-01T00:00:00.000Z" },
        10,
      );
      expect(ids).toHaveLength(5);
      for (const id of ids) {
        expect(id).toMatch(/^new-/);
      }
    });

    it("applies dateTo filter at SQL level before LIMIT", () => {
      for (let i = 0; i < 20; i++) {
        insertDoc(db, `future-${i}`, `Future Doc ${i}`, {
          library: "test-lib",
          createdAt: "2099-01-01T00:00:00.000Z",
        });
      }
      for (let i = 0; i < 5; i++) {
        insertDoc(db, `past-${i}`, `Past Doc ${i}`, {
          library: "test-lib",
          createdAt: "2020-06-01T00:00:00.000Z",
        });
      }

      const ids = resolveSelector(
        db,
        { library: "test-lib", dateTo: "2025-01-01T00:00:00.000Z" },
        10,
      );
      expect(ids).toHaveLength(5);
      for (const id of ids) {
        expect(id).toMatch(/^past-/);
      }
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

    it("rolls back all deletions if one fails", () => {
      // Use a trigger to simulate failure on the second document deletion
      db.exec(`
        CREATE TABLE _del_flag (count INTEGER DEFAULT 0);
        INSERT INTO _del_flag VALUES (0);
        CREATE TRIGGER _fail_on_second_delete
        BEFORE DELETE ON documents
        BEGIN
          UPDATE _del_flag SET count = (SELECT count + 1 FROM _del_flag);
          SELECT CASE WHEN (SELECT count FROM _del_flag) > 1
            THEN RAISE(ABORT, 'Simulated delete failure')
          END;
        END;
      `);

      expect(() => bulkDelete(db, { library: "react" })).toThrow("Simulated delete failure");

      // Clean up trigger before assertions
      db.exec("DROP TRIGGER IF EXISTS _fail_on_second_delete; DROP TABLE IF EXISTS _del_flag;");

      // Verify nothing was deleted (transaction rolled back)
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

    it("rolls back tag changes if one fails mid-operation", () => {
      // Use a trigger to simulate failure on the second document_tags insert
      db.exec(`
        CREATE TABLE _tag_flag (count INTEGER DEFAULT 0);
        INSERT INTO _tag_flag VALUES (0);
        CREATE TRIGGER _fail_on_second_tag
        AFTER INSERT ON document_tags
        BEGIN
          UPDATE _tag_flag SET count = (SELECT count + 1 FROM _tag_flag);
          SELECT CASE WHEN (SELECT count FROM _tag_flag) > 1
            THEN RAISE(ABORT, 'Simulated tag failure')
          END;
        END;
      `);

      expect(() => bulkRetag(db, { library: "react" }, ["rollback-tag"])).toThrow(
        "Simulated tag failure",
      );

      // Clean up trigger before assertions
      db.exec("DROP TRIGGER IF EXISTS _fail_on_second_tag; DROP TABLE IF EXISTS _tag_flag;");

      // Verify no tags were added (transaction rolled back)
      const tagsA = getDocumentTags(db, "doc-a").map((t) => t.name);
      const tagsB = getDocumentTags(db, "doc-b").map((t) => t.name);
      expect(tagsA).not.toContain("rollback-tag");
      expect(tagsB).not.toContain("rollback-tag");
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

    it("rolls back all moves on constraint violation", () => {
      // Moving to a non-existent topic should trigger FK constraint failure
      expect(() => bulkMove(db, { library: "react" }, "nonexistent-topic")).toThrow();

      // Verify no documents were moved (transaction rolled back)
      const docA = getDocument(db, "doc-a");
      const docB = getDocument(db, "doc-b");
      expect(docA.topicId).toBe("topic-1");
      expect(docB.topicId).toBe("topic-1");
    });
  });
});
