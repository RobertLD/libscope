import { describe, it, expect } from "vitest";
import type { SearchResult } from "../../src/core/search.js";
import type { Task } from "../../src/core/tasks.js";
import type { DocumentView } from "../../src/core/document-view.js";
import {
  formatAnswer,
  formatDocumentList,
  formatDocumentView,
  formatIngestResult,
  formatOverview,
  formatPackList,
  formatRating,
  formatReindex,
  formatSearchResults,
  formatSyncResult,
  formatTask,
  formatTaskCancel,
  formatTaskList,
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

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    type: "operation",
    operation: "add",
    status: "running",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const page = <T>(
  items: T[],
  total = items.length,
  offset = 0,
): { items: T[]; total: number; limit: number; offset: number } => ({
  items,
  total,
  limit: 10,
  offset,
});

describe("MCP output formatting", () => {
  it("search results carry documentId, chunkId, metadata and context", () => {
    const text = formatSearchResults(
      page(
        [
          makeResult({
            library: "react",
            version: "18",
            url: "https://example.com",
            avgRating: 4,
            contextBefore: [{ chunkId: "c0", content: "before text", chunkIndex: 0 }],
            contextAfter: [{ chunkId: "c2", content: "after text", chunkIndex: 2 }],
          }),
          makeResult({ documentId: "doc-2", chunkId: "chunk-2", title: "Second" }),
        ],
        20,
        10,
      ),
    );
    expect(text).toMatch(/^Results 11-12 of 20 — next page: offset 12\n/);
    expect(text).toContain("[11] Doc One · score 0.50 · rating 4.0/5");
    expect(text).toContain(
      "documentId: doc-1 · chunkId: chunk-1 · react v18 · https://example.com",
    );
    expect(text).toContain(
      "[context before]\nbefore text\nchunk body\n[context after]\nafter text",
    );
    expect(text).toContain("---\n[12] Second");
    expect(text).toContain("documentId: doc-2 · chunkId: chunk-2");
  });

  it("an empty page past the end says so", () => {
    expect(formatSearchResults(page([], 3, 10))).toBe("No more results (total 3).");
    expect(formatSearchResults(page([], 0))).toBe("No results found.");
  });

  it("search header offers the next page when more results exist", () => {
    expect(formatSearchResults(page([makeResult()], 5))).toMatch(
      /^Results 1-1 of 5 — next page: offset 1\n/,
    );
  });

  it("ask: passthrough context and LLM answers list sources with documentIds", () => {
    const sources = [{ documentId: "doc-1", title: "Doc One", chunk: "x", score: 0.9 }];
    const context = formatAnswer({ mode: "context", contextPrompt: "PROMPT", sources });
    expect(context).toMatch(/^Passthrough mode: no LLM was called/);
    expect(context).toContain("PROMPT\n\nSources:\n- Doc One (documentId: doc-1, score 0.90)");

    const answer = formatAnswer({ mode: "answer", answer: "Yes.", sources: [], model: "m" });
    expect(answer).toBe("Yes.\n\n(model: m)");
    const withTokens = formatAnswer({
      mode: "answer",
      answer: "Yes.",
      sources,
      model: "m",
      tokensUsed: 12,
    });
    expect(withTokens).toContain("(model: m, 12 tokens)");
  });

  it("document view shows metadata, url, suggested corrections and the whole content", () => {
    const view: DocumentView = {
      document: {
        documentId: "doc-1",
        title: "Title",
        sourceType: "library",
        library: "lib",
        version: null,
        topicId: "topic-1",
        url: "https://x.test",
        contentHash: null,
        submittedBy: "manual",
        createdAt: "c",
        updatedAt: "u",
      },
      content: "body",
      contentLength: 4,
      offset: 0,
      nextOffset: null,
      tags: [],
      links: { outgoing: [], incoming: [] },
      ratings: { documentId: "doc-1", averageRating: 2, totalRatings: 2, corrections: 1 },
    };
    const text = formatDocumentView(view);
    expect(text).toContain("documentId: doc-1 · library · lib · topic: topic-1");
    expect(text).toContain("url: https://x.test");
    expect(text).toContain("rating: 2.0/5 (2 ratings, 1 suggested corrections)");
    expect(text).not.toContain("characters");
    expect(text.endsWith("\n\nbody")).toBe(true);
  });

  it("document list includes IDs and metadata", () => {
    const text = formatDocumentList(
      page([
        {
          documentId: "doc-1",
          title: "T",
          sourceType: "library",
          library: "lib",
          version: "2",
          topicId: null,
          url: null,
          contentHash: null,
          submittedBy: "manual",
          createdAt: "c",
          updatedAt: "u",
          contentLength: 3,
        },
      ]),
    );
    expect(text).toBe("Documents 1-1 of 1\n- T (documentId: doc-1) library · lib v2");
  });

  it("overview lists topics with IDs and the configured model", () => {
    const text = formatOverview({
      stats: {
        totalDocuments: 2,
        totalChunks: 3,
        totalTopics: 1,
        databaseSizeBytes: 0,
        totalSearches: 0,
        avgLatencyMs: 0,
      },
      topics: [{ id: "t1", name: "Infra", description: null, parentId: null, documentCount: 2 }],
      packs: [],
      index: {
        stored: {},
        configured: { provider: "mock", model: "m", dimensions: 4 },
      },
      health: { database: "ok", fts: "error", vectorSearch: false },
    });
    expect(text).toContain("keyword index error · vector search unavailable");
    expect(text).toContain("Index embeddings: unknown · configured: mock/m, 4 dimensions");
    expect(text).toContain("Topics:\n- Infra (topic: t1, 2 docs)");
  });

  it("ingest results: dry run, crawl stats, skipped and errors", () => {
    const text = formatIngestResult({
      kind: "url",
      documents: [{ documentId: "d1", title: "Page", chunkCount: 2, source: "https://a.test" }],
      errors: [{ source: "https://b.test", error: "404" }],
      skipped: [{ source: "https://c.test", reason: "unchanged" }],
      planned: ["https://a.test"],
      crawl: { pagesCrawled: 3, pagesSkipped: 1, abortReason: "maxPages" },
    });
    expect(text).toContain("Dry run: 1 source(s) would be added.\n- https://a.test");
    expect(text).toContain("- Page (documentId: d1, 2 chunks) https://a.test");
    expect(text).toContain("Crawled 3 page(s), skipped 1; stopped early: maxPages");
    expect(text).toContain("Skipped 1:\n- https://c.test: unchanged");
    expect(text).toContain("Errors 1:\n- https://b.test: 404");
  });

  it("rating of a chunk includes the chunkId", () => {
    expect(
      formatRating({
        id: "r1",
        documentId: "d1",
        chunkId: "c1",
        rating: 2,
        feedback: null,
        suggestedCorrection: "fix",
        ratedBy: "model",
        createdAt: "now",
      }),
    ).toBe("Rated 2/5 (documentId: d1, chunkId: c1) · correction saved");
  });

  it("task status shows progress, errors, and formats or passes through results", () => {
    const failed = formatTask(
      makeTask({ status: "failed", error: "boom", progress: { current: 1, total: 0 } }),
    );
    expect(failed).toContain("taskId: task-1 · add · failed 1/?");
    expect(failed).toContain("\nerror: boom");

    const done = makeTask({ status: "completed", result: '{"n":1}' });
    expect(formatTask(done)).toContain('result:\n{"n":1}');
    expect(formatTask(done, () => "formatted")).toContain("result:\nformatted");
    expect(formatTask(done, () => undefined)).toContain('result:\n{"n":1}');
    const broken = makeTask({ status: "completed", result: "not json" });
    expect(formatTask(broken, () => "formatted")).toContain("result:\nnot json");
    const legacy = makeTask({ type: "sync_connector", operation: undefined, status: "pending" });
    expect(formatTask(legacy)).toContain("sync_connector · pending");
  });

  it("task cancel and list", () => {
    expect(formatTaskCancel({ taskId: "t", cancelRequested: false, status: "completed" })).toBe(
      "Task t is already completed; nothing to cancel.",
    );
    expect(formatTaskList({ items: [] })).toBe("No tasks in the last hour.");
    expect(formatTaskList({ items: [makeTask()] })).toMatch(/^- taskId: task-1 · add · running/);
  });

  it("sync results show failures and per-item errors", () => {
    const text = formatSyncResult({
      items: [
        { name: "a", status: "failed", error: "offline" },
        {
          name: "b",
          type: "slack",
          status: "completed",
          summary: { added: 1, updated: 2, deleted: 0, errors: ["#general: denied"] },
        },
      ],
    });
    expect(text).toBe(
      "- a: failed: offline\n- b (slack): 1 added, 2 updated, 0 deleted, 1 errors:\n    #general: denied",
    );
  });

  it("pack list formats registry packs", () => {
    expect(
      formatPackList({ items: [{ name: "p", version: "1", description: "desc", docCount: 3 }] }),
    ).toBe("- p v1 (3 docs): desc");
  });

  it("reindex reports failures and a rebuilt index", () => {
    const text = formatReindex({
      total: 3,
      completed: 2,
      failed: 1,
      failedChunkIds: ["c9"],
      rebuiltIndex: "mock/m, 4 dimensions",
    });
    expect(text).toBe(
      "Re-embedded 2 of 3 chunks; 1 failed.\nRebuilt vector index: mock/m, 4 dimensions\nFailed chunkIds: c9",
    );
  });
});
