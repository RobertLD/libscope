import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../fixtures/test-db.js";
import {
  resolveDocumentByUrl,
  resolveDocumentByTitle,
  resolveDocumentLink,
  extractAndStoreDocumentLinks,
  getDocumentLinks,
} from "../../src/core/links.js";

function insertDocWithUrl(
  db: Database.Database,
  id: string,
  title: string,
  url: string | null,
): void {
  db.prepare(
    `INSERT INTO documents (id, title, content, source_type, url) VALUES (?, ?, '', 'manual', ?)`,
  ).run(id, title, url);
}

describe("document link resolution", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertDocWithUrl(db, "doc-a", "Document A", "https://example.com/a");
    insertDocWithUrl(db, "doc-b", "Document B", "https://example.com/b");
    insertDocWithUrl(db, "doc-c", "Document C", null);
  });

  afterEach(() => {
    db.close();
  });

  describe("resolveDocumentByUrl", () => {
    it("should return document id for existing URL", () => {
      expect(resolveDocumentByUrl(db, "https://example.com/a")).toBe("doc-a");
    });

    it("should return null for nonexistent URL", () => {
      expect(resolveDocumentByUrl(db, "https://example.com/missing")).toBeNull();
    });
  });

  describe("resolveDocumentByTitle", () => {
    it("should match case-insensitively", () => {
      expect(resolveDocumentByTitle(db, "document a")).toBe("doc-a");
      expect(resolveDocumentByTitle(db, "DOCUMENT B")).toBe("doc-b");
    });

    it("should return null when no match", () => {
      expect(resolveDocumentByTitle(db, "Nonexistent Doc")).toBeNull();
    });
  });

  describe("resolveDocumentLink", () => {
    it("should resolve by URL first", () => {
      expect(resolveDocumentLink(db, "https://example.com/a")).toBe("doc-a");
    });

    it("should fall back to title when URL does not match", () => {
      expect(resolveDocumentLink(db, "Document C")).toBe("doc-c");
    });

    it("should return null if neither URL nor title matches", () => {
      expect(resolveDocumentLink(db, "nothing matches")).toBeNull();
    });
  });

  describe("extractAndStoreDocumentLinks", () => {
    it("should create references links for resolvable markdown refs", () => {
      const content = "See [Doc B](https://example.com/b) for more.";
      extractAndStoreDocumentLinks(db, "doc-a", content);

      const { outgoing } = getDocumentLinks(db, "doc-a");
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0]!.targetId).toBe("doc-b");
      expect(outgoing[0]!.linkType).toBe("references");
    });

    it("should create references links for resolvable wikilinks", () => {
      const content = "See [[Document B]] for more.";
      extractAndStoreDocumentLinks(db, "doc-a", content);

      const { outgoing } = getDocumentLinks(db, "doc-a");
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0]!.targetId).toBe("doc-b");
      expect(outgoing[0]!.linkType).toBe("references");
    });

    it("should skip unresolvable references", () => {
      const content = "See [missing](https://example.com/missing) and [[Unknown Page]].";
      extractAndStoreDocumentLinks(db, "doc-a", content);

      const { outgoing } = getDocumentLinks(db, "doc-a");
      expect(outgoing).toHaveLength(0);
    });

    it("should skip self-links", () => {
      const content = "See [self](https://example.com/a).";
      extractAndStoreDocumentLinks(db, "doc-a", content);

      const { outgoing } = getDocumentLinks(db, "doc-a");
      expect(outgoing).toHaveLength(0);
    });
  });
});
