import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { z } from "zod";
import { createTestDb } from "../fixtures/test-db.js";
import { insertDoc } from "../fixtures/helpers.js";
import { createLink, deleteLink, getDocumentLinks, LINK_TYPES } from "../../src/core/links.js";
import type { SearchResult } from "../../src/core/search.js";
import {
  formatDocumentLinks,
  formatLinkCreated,
  formatSearchResults,
} from "../../src/mcp/format.js";

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    documentId: "doc-1",
    chunkId: "chunk-1",
    title: "Doc One",
    content: "chunk body",
    sourceType: "manual",
    library: null,
    version: null,
    topicId: null,
    url: null,
    score: 0.5,
    avgRating: null,
    scoreExplanation: { method: "vector", rawScore: 0.5, boostFactors: [], details: "" },
    ...overrides,
  };
}

describe("MCP output formatting", () => {
  describe("formatSearchResults", () => {
    it("returns the no-results message for an empty list", () => {
      expect(formatSearchResults([], 0)).toBe("No documents found matching your query.");
    });

    it("includes the document ID and chunk ID of every result", () => {
      const text = formatSearchResults(
        [makeResult(), makeResult({ documentId: "doc-2", chunkId: "chunk-2", title: "Doc Two" })],
        2,
      );
      expect(text).toContain("**Document ID:** doc-1 | **Chunk ID:** chunk-1");
      expect(text).toContain("**Document ID:** doc-2 | **Chunk ID:** chunk-2");
    });

    it("keeps the existing header, metadata, context, and separator layout", () => {
      const text = formatSearchResults(
        [
          makeResult({
            library: "react",
            version: "18",
            url: "https://example.com",
            avgRating: 4,
            contextBefore: [{ chunkId: "c0", content: "before text", chunkIndex: 0 }],
            contextAfter: [{ chunkId: "c2", content: "after text", chunkIndex: 2 }],
          }),
          makeResult({ title: "Second" }),
        ],
        7,
      );
      expect(text.startsWith("**Total results: 7**\n\n## Result 1: Doc One (score: 0.50)\n")).toBe(
        true,
      );
      expect(text).toContain("**Library:** react v18\n");
      expect(text).toContain("**Source:** https://example.com\n");
      expect(text).toContain("**Rating:** 4.0/5\n");
      expect(text).toContain("**Context (before):**\nbefore text\n");
      expect(text).toContain("\nchunk body\n");
      expect(text).toContain("**Context (after):**\nafter text\n");
      expect(text).toContain("\n---\n\n## Result 2: Second");
    });
  });

  describe("link formatting", () => {
    let db: Database.Database;

    beforeEach(() => {
      db = createTestDb();
      insertDoc(db, "doc-a", "Document A");
      insertDoc(db, "doc-b", "Document B");
    });

    afterEach(() => {
      db.close();
    });

    it("formatLinkCreated includes the link ID, which delete-link accepts", () => {
      const link = createLink(db, "doc-a", "doc-b", "see_also", "read next");
      const text = formatLinkCreated(link);
      expect(text).toContain("doc-a → doc-b (see_also) — read next");
      const id = /Link ID: (\S+)/.exec(text)?.[1];
      expect(id).toBe(link.id);
      deleteLink(db, id!);
      expect(getDocumentLinks(db, "doc-a").outgoing).toHaveLength(0);
    });

    it("formatDocumentLinks includes the link ID on outgoing and incoming lines", () => {
      const link = createLink(db, "doc-a", "doc-b", "references");
      const outgoing = formatDocumentLinks(getDocumentLinks(db, "doc-a"));
      const incoming = formatDocumentLinks(getDocumentLinks(db, "doc-b"));
      expect(outgoing).toContain(
        `**Outgoing links:**\n  → [references] Document B (doc-b) [link ID: ${link.id}]`,
      );
      expect(incoming).toContain(
        `**Incoming links:**\n  ← [references] Document A (doc-a) [link ID: ${link.id}]`,
      );
    });

    it("formatDocumentLinks returns the no-links message when there are none", () => {
      expect(formatDocumentLinks(getDocumentLinks(db, "doc-a"))).toBe(
        "No links found for this document.",
      );
    });
  });

  describe("LINK_TYPES", () => {
    it("includes 'references' and every value is accepted by createLink", () => {
      const db = createTestDb();
      insertDoc(db, "doc-a", "Document A");
      insertDoc(db, "doc-b", "Document B");
      expect(LINK_TYPES).toContain("references");
      for (const type of LINK_TYPES) {
        expect(createLink(db, "doc-a", "doc-b", type).linkType).toBe(type);
      }
      db.close();
    });

    it("works as the link-documents zod enum", () => {
      const schema = z.enum(LINK_TYPES);
      expect(schema.parse("references")).toBe("references");
      expect(() => schema.parse("bogus")).toThrow();
    });
  });
});
