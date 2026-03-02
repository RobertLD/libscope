import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../fixtures/test-db.js";
import {
  createTag,
  deleteTag,
  listTags,
  addTagsToDocument,
  removeTagFromDocument,
  getDocumentTags,
  getDocumentsByTag,
  suggestTags,
} from "../../src/core/tags.js";
import { ValidationError, DocumentNotFoundError } from "../../src/errors.js";
import type Database from "better-sqlite3";

function insertDocument(db: Database.Database, id: string, title: string): void {
  db.prepare(
    `INSERT INTO documents (id, source_type, title, content, submitted_by)
     VALUES (?, 'manual', ?, 'content', 'manual')`,
  ).run(id, title);
}

function insertDocumentWithContent(
  db: Database.Database,
  id: string,
  title: string,
  content: string,
): void {
  db.prepare(
    `INSERT INTO documents (id, source_type, title, content, submitted_by)
     VALUES (?, 'manual', ?, ?, 'manual')`,
  ).run(id, title, content);
}

describe("tags", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  describe("createTag", () => {
    it("should create a new tag", () => {
      const tag = createTag(db, "JavaScript");
      expect(tag.name).toBe("javascript");
      expect(tag.id).toBeDefined();
      expect(tag.createdAt).toBeDefined();
    });

    it("should return existing tag on duplicate name", () => {
      const first = createTag(db, "React");
      const second = createTag(db, "react");
      expect(second.id).toBe(first.id);
      expect(second.name).toBe("react");
    });

    it("should reject empty name", () => {
      expect(() => createTag(db, "")).toThrow(ValidationError);
      expect(() => createTag(db, "   ")).toThrow(ValidationError);
    });
  });

  describe("deleteTag", () => {
    it("should delete tag and cascade associations", () => {
      insertDocument(db, "doc-1", "Test Doc");
      const tags = addTagsToDocument(db, "doc-1", ["important"]);
      deleteTag(db, tags[0].id);

      const docTags = getDocumentTags(db, "doc-1");
      expect(docTags).toHaveLength(0);

      const allTags = listTags(db);
      expect(allTags).toHaveLength(0);
    });
  });

  describe("listTags", () => {
    it("should return tags with document counts", () => {
      insertDocument(db, "doc-1", "Doc 1");
      insertDocument(db, "doc-2", "Doc 2");
      addTagsToDocument(db, "doc-1", ["api", "guide"]);
      addTagsToDocument(db, "doc-2", ["api"]);

      const tags = listTags(db);
      const apiTag = tags.find((t) => t.name === "api");
      const guideTag = tags.find((t) => t.name === "guide");

      expect(apiTag?.documentCount).toBe(2);
      expect(guideTag?.documentCount).toBe(1);
    });
  });

  describe("addTagsToDocument", () => {
    it("should add multiple tags in a single call", () => {
      insertDocument(db, "doc-1", "Test Doc");
      const tags = addTagsToDocument(db, "doc-1", ["tag-a", "tag-b", "tag-c"]);
      expect(tags).toHaveLength(3);

      const docTags = getDocumentTags(db, "doc-1");
      expect(docTags).toHaveLength(3);
    });

    it("should not duplicate tags on repeated calls", () => {
      insertDocument(db, "doc-1", "Test Doc");
      addTagsToDocument(db, "doc-1", ["repeated"]);
      addTagsToDocument(db, "doc-1", ["repeated"]);

      const docTags = getDocumentTags(db, "doc-1");
      expect(docTags).toHaveLength(1);
    });
  });

  describe("removeTagFromDocument", () => {
    it("should remove only the specified tag", () => {
      insertDocument(db, "doc-1", "Test Doc");
      const tags = addTagsToDocument(db, "doc-1", ["keep", "remove"]);
      const removeId = tags.find((t) => t.name === "remove")!.id;

      removeTagFromDocument(db, "doc-1", removeId);

      const docTags = getDocumentTags(db, "doc-1");
      expect(docTags).toHaveLength(1);
      expect(docTags[0].name).toBe("keep");
    });
  });

  describe("getDocumentsByTag", () => {
    it("should return documents matching all specified tags (AND logic)", () => {
      insertDocument(db, "doc-1", "Both Tags");
      insertDocument(db, "doc-2", "One Tag");
      insertDocument(db, "doc-3", "No Tags");

      addTagsToDocument(db, "doc-1", ["alpha", "beta"]);
      addTagsToDocument(db, "doc-2", ["alpha"]);

      const bothTags = getDocumentsByTag(db, ["alpha", "beta"]);
      expect(bothTags).toHaveLength(1);
      expect(bothTags[0].id).toBe("doc-1");

      const singleTag = getDocumentsByTag(db, ["alpha"]);
      expect(singleTag).toHaveLength(2);
    });

    it("should support pagination", () => {
      for (let i = 0; i < 5; i++) {
        insertDocument(db, `doc-${i}`, `Doc ${i}`);
        addTagsToDocument(db, `doc-${i}`, ["paginated"]);
      }

      const page1 = getDocumentsByTag(db, ["paginated"], { limit: 2, offset: 0 });
      const page2 = getDocumentsByTag(db, ["paginated"], { limit: 2, offset: 2 });
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      expect(page1[0].id).not.toBe(page2[0].id);
    });

    it("should return empty array for no matching tags", () => {
      const result = getDocumentsByTag(db, ["nonexistent"]);
      expect(result).toHaveLength(0);
    });

    it("should return empty array for empty tag list", () => {
      const result = getDocumentsByTag(db, []);
      expect(result).toHaveLength(0);
    });
  });

  describe("cascading deletes", () => {
    it("should remove tag associations when a document is deleted", () => {
      insertDocument(db, "doc-del", "To Delete");
      addTagsToDocument(db, "doc-del", ["orphan-tag"]);

      db.prepare("DELETE FROM documents WHERE id = ?").run("doc-del");

      const tags = listTags(db);
      const orphan = tags.find((t) => t.name === "orphan-tag");
      expect(orphan?.documentCount).toBe(0);
    });
  });

  describe("suggestTags", () => {
    it("should suggest tags based on document content", () => {
      insertDocumentWithContent(
        db,
        "doc-s1",
        "TypeScript Guide",
        "TypeScript is a programming language. TypeScript adds types to JavaScript. TypeScript compiler checks types.",
      );

      const suggestions = suggestTags(db, "doc-s1");
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions).toContain("typescript");
    });

    it("should exclude tags already on the document", () => {
      insertDocumentWithContent(
        db,
        "doc-s2",
        "React Tutorial",
        "React components render JSX. React hooks enable state management. React is popular.",
      );
      addTagsToDocument(db, "doc-s2", ["react"]);

      const suggestions = suggestTags(db, "doc-s2");
      expect(suggestions).not.toContain("react");
    });

    it("should boost known system tags", () => {
      // Create a known tag in the system
      insertDocument(db, "doc-other", "Other Doc");
      addTagsToDocument(db, "doc-other", ["javascript"]);

      insertDocumentWithContent(
        db,
        "doc-s3",
        "Web Development",
        "JavaScript and frameworks. JavaScript runs in the browser. Performance optimization techniques.",
      );

      const suggestions = suggestTags(db, "doc-s3");
      expect(suggestions[0]).toBe("javascript");
    });

    it("should return empty array for content with only stopwords", () => {
      insertDocumentWithContent(db, "doc-s4", "a", "the is are was were be an");

      const suggestions = suggestTags(db, "doc-s4");
      expect(suggestions).toHaveLength(0);
    });

    it("should respect maxSuggestions limit", () => {
      insertDocumentWithContent(
        db,
        "doc-s5",
        "Many Topics",
        "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa",
      );

      const suggestions = suggestTags(db, "doc-s5", 3);
      expect(suggestions).toHaveLength(3);
    });

    it("should throw DocumentNotFoundError for missing document", () => {
      expect(() => suggestTags(db, "nonexistent")).toThrow(DocumentNotFoundError);
    });
  });
});
