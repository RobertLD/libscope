import { describe, expect, it } from "vitest";
import type { DocumentView } from "../../src/core/document-view.js";
import { formatDocumentView, formatIngestResult, formatRating } from "../../src/mcp/format.js";

function makeView(overrides: Partial<DocumentView>): DocumentView {
  return {
    document: {
      documentId: "doc-1",
      title: "Title",
      sourceType: "manual",
      library: null,
      version: null,
      topicId: null,
      url: null,
      contentHash: null,
      submittedBy: "manual",
      createdAt: "c",
      updatedAt: "u",
    },
    content: "body",
    contentLength: 12,
    offset: 0,
    nextOffset: null,
    tags: [],
    links: { outgoing: [], incoming: [] },
    ratings: { documentId: "doc-1", averageRating: 0, totalRatings: 0, corrections: 0 },
    ...overrides,
  };
}

describe("formatDocumentView paging", () => {
  it("shows the range and the next offset on a first page", () => {
    const text = formatDocumentView(makeView({ nextOffset: 4 }));
    expect(text).toContain("\n\n[characters 0-4 of 12; next page: offset 4]\n\nbody");
  });

  it("shows the range without a next offset on the last page", () => {
    const text = formatDocumentView(makeView({ offset: 8 }));
    expect(text).toContain("\n\n[characters 8-12 of 12]\n\nbody");
  });

  it("shows no range for a whole document", () => {
    expect(formatDocumentView(makeView({}))).not.toContain("[characters");
  });
});

describe("formatIngestResult lines", () => {
  it("lists added documents without a dry-run header", () => {
    const text = formatIngestResult({
      kind: "file",
      documents: [{ documentId: "d1", title: "Doc", chunkCount: 1 }],
      errors: [],
      skipped: [],
    });
    expect(text).toBe("Added 1 document(s).\n- Doc (documentId: d1, 1 chunks)");
  });
});

describe("formatRating without a chunk", () => {
  it("leaves out the chunkId", () => {
    expect(
      formatRating({
        id: "r1",
        documentId: "d1",
        chunkId: null,
        rating: 4,
        feedback: "good",
        suggestedCorrection: null,
        ratedBy: "model",
        createdAt: "now",
      }),
    ).toBe("Rated 4/5 (documentId: d1) · feedback saved");
  });
});
