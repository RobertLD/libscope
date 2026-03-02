import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../fixtures/test-db.js";
import { insertDoc } from "../fixtures/helpers.js";
import {
  createLink,
  getDocumentLinks,
  deleteLink,
  getPrerequisiteChain,
  listLinks,
} from "../../src/core/links.js";

describe("document links", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertDoc(db, "doc-a", "Document A");
    insertDoc(db, "doc-b", "Document B");
    insertDoc(db, "doc-c", "Document C");
  });

  afterEach(() => {
    db.close();
  });

  describe("createLink", () => {
    it("should create a link between two documents", () => {
      const link = createLink(db, "doc-a", "doc-b", "see_also");
      expect(link.sourceId).toBe("doc-a");
      expect(link.targetId).toBe("doc-b");
      expect(link.linkType).toBe("see_also");
      expect(link.label).toBeNull();
      expect(link.id).toBeDefined();
    });

    it("should create a link with a label", () => {
      const link = createLink(db, "doc-a", "doc-b", "prerequisite", "Read this first");
      expect(link.label).toBe("Read this first");
    });

    it("should return existing link on duplicate", () => {
      const first = createLink(db, "doc-a", "doc-b", "related");
      const second = createLink(db, "doc-a", "doc-b", "related");
      expect(second.id).toBe(first.id);
    });

    it("should allow different link types between same documents", () => {
      const link1 = createLink(db, "doc-a", "doc-b", "see_also");
      const link2 = createLink(db, "doc-a", "doc-b", "prerequisite");
      expect(link1.id).not.toBe(link2.id);
    });

    it("should reject self-links", () => {
      expect(() => createLink(db, "doc-a", "doc-a", "related")).toThrow(
        "Cannot link a document to itself",
      );
    });

    it("should reject invalid link types", () => {
      expect(() => createLink(db, "doc-a", "doc-b", "invalid" as never)).toThrow(
        "Invalid link type",
      );
    });

    it("should reject links to non-existent documents", () => {
      expect(() => createLink(db, "doc-a", "nonexistent", "related")).toThrow(
        "Target document not found",
      );
    });

    it("should reject links from non-existent documents", () => {
      expect(() => createLink(db, "nonexistent", "doc-b", "related")).toThrow(
        "Source document not found",
      );
    });
  });

  describe("getDocumentLinks", () => {
    it("should return outgoing and incoming links with titles", () => {
      createLink(db, "doc-a", "doc-b", "see_also");
      createLink(db, "doc-c", "doc-a", "prerequisite");

      const { outgoing, incoming } = getDocumentLinks(db, "doc-a");

      expect(outgoing.length).toBe(1);
      expect(outgoing[0]!.targetId).toBe("doc-b");
      expect(outgoing[0]!.targetTitle).toBe("Document B");
      expect(outgoing[0]!.sourceTitle).toBe("Document A");

      expect(incoming.length).toBe(1);
      expect(incoming[0]!.sourceId).toBe("doc-c");
      expect(incoming[0]!.sourceTitle).toBe("Document C");
    });

    it("should return empty arrays for document with no links", () => {
      const { outgoing, incoming } = getDocumentLinks(db, "doc-a");
      expect(outgoing).toEqual([]);
      expect(incoming).toEqual([]);
    });
  });

  describe("deleteLink", () => {
    it("should delete an existing link", () => {
      const link = createLink(db, "doc-a", "doc-b", "related");
      deleteLink(db, link.id);

      const { outgoing } = getDocumentLinks(db, "doc-a");
      expect(outgoing.length).toBe(0);
    });

    it("should throw for non-existent link", () => {
      expect(() => deleteLink(db, "nonexistent")).toThrow("Link not found");
    });
  });

  describe("getPrerequisiteChain", () => {
    it("should return ordered prerequisite chain", () => {
      insertDoc(db, "doc-d", "Document D");
      createLink(db, "doc-a", "doc-b", "prerequisite"); // A before B
      createLink(db, "doc-b", "doc-c", "prerequisite"); // B before C
      createLink(db, "doc-c", "doc-d", "prerequisite"); // C before D

      const chain = getPrerequisiteChain(db, "doc-d");
      expect(chain.length).toBe(3);
      expect(chain[0]!.id).toBe("doc-a");
      expect(chain[1]!.id).toBe("doc-b");
      expect(chain[2]!.id).toBe("doc-c");
    });

    it("should return empty array for document with no prerequisites", () => {
      const chain = getPrerequisiteChain(db, "doc-a");
      expect(chain).toEqual([]);
    });

    it("should handle cycles gracefully", () => {
      createLink(db, "doc-a", "doc-b", "prerequisite");
      createLink(db, "doc-b", "doc-c", "prerequisite");
      createLink(db, "doc-c", "doc-a", "prerequisite"); // cycle!

      const chain = getPrerequisiteChain(db, "doc-a");
      // Should not infinite loop — returns chain up to the cycle point
      expect(chain.length).toBeLessThanOrEqual(3);
    });
  });

  describe("listLinks", () => {
    it("should list all links", () => {
      createLink(db, "doc-a", "doc-b", "see_also");
      createLink(db, "doc-b", "doc-c", "prerequisite");

      const links = listLinks(db);
      expect(links.length).toBe(2);
    });

    it("should filter by link type", () => {
      createLink(db, "doc-a", "doc-b", "see_also");
      createLink(db, "doc-b", "doc-c", "prerequisite");

      const links = listLinks(db, "prerequisite");
      expect(links.length).toBe(1);
      expect(links[0]!.linkType).toBe("prerequisite");
    });

    it("should return empty array when no links exist", () => {
      expect(listLinks(db)).toEqual([]);
    });
  });

  describe("cascade delete", () => {
    it("should remove links when source document is deleted", () => {
      createLink(db, "doc-a", "doc-b", "related");
      db.prepare("DELETE FROM documents WHERE id = ?").run("doc-a");

      const { incoming } = getDocumentLinks(db, "doc-b");
      expect(incoming.length).toBe(0);
    });

    it("should remove links when target document is deleted", () => {
      createLink(db, "doc-a", "doc-b", "related");
      db.prepare("DELETE FROM documents WHERE id = ?").run("doc-b");

      const { outgoing } = getDocumentLinks(db, "doc-a");
      expect(outgoing.length).toBe(0);
    });
  });
});
