import { describe, it, expect, vi } from "vitest";
import { batchImport } from "../../src/core/batch.js";
import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../../src/providers/embedding.js";

// Mock indexing module
vi.mock("../../src/core/indexing.js", () => ({
  indexDocument: vi.fn().mockResolvedValue({ id: "doc-1", chunkCount: 3 }),
}));

// Mock fs
vi.mock("node:fs", () => ({
  readFileSync: vi.fn().mockReturnValue("# Test content\nSome text."),
}));

// Mock logger
vi.mock("../../src/logger.js", () => ({
  getLogger: (): Record<string, ReturnType<typeof vi.fn>> => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function createMockDb(): Database.Database {
  return {} as Database.Database;
}

function createMockProvider(): EmbeddingProvider {
  return {
    name: "mock",
    dimensions: 384,
    embed: vi.fn().mockResolvedValue(new Array(384).fill(0)),
    embedBatch: vi.fn().mockResolvedValue([new Array(384).fill(0)]),
  };
}

describe("batchImport", () => {
  it("should return empty results for no files", async () => {
    const result = await batchImport(createMockDb(), createMockProvider(), []);

    expect(result.total).toBe(0);
    expect(result.completed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("should process files and return results", async () => {
    const files = ["file1.md", "file2.md", "file3.md"];
    const result = await batchImport(createMockDb(), createMockProvider(), files);

    expect(result.total).toBe(3);
    expect(result.completed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.results).toHaveLength(3);
    for (const r of result.results) {
      expect(r.success).toBe(true);
      expect(r.chunkCount).toBe(3);
      expect(r.documentId).toBe("doc-1");
    }
  });

  it("should respect concurrency option", async () => {
    const files = Array.from({ length: 10 }, (_, i) => `file${i}.md`);
    const result = await batchImport(createMockDb(), createMockProvider(), files, {
      concurrency: 2,
    });

    expect(result.total).toBe(10);
    expect(result.completed).toBe(10);
  });

  it("should call onProgress callback", async () => {
    const files = ["a.md", "b.md"];
    const progressCalls: Array<{ completed: number; failed: number }> = [];

    await batchImport(createMockDb(), createMockProvider(), files, {
      onProgress: (progress) => {
        progressCalls.push({ completed: progress.completed, failed: progress.failed });
      },
    });

    expect(progressCalls.length).toBe(2);
    const lastCall = progressCalls.at(-1)!;
    expect(lastCall.completed + lastCall.failed).toBe(2);
  });

  it("should handle failed files gracefully", async () => {
    const { indexDocument } = await import("../../src/core/indexing.js");
    const mockedIndex = vi.mocked(indexDocument);

    mockedIndex.mockRejectedValueOnce(new Error("bad file"));
    mockedIndex.mockResolvedValueOnce({ id: "doc-2", chunkCount: 1 });

    const files = ["bad.md", "good.md"];
    const result = await batchImport(createMockDb(), createMockProvider(), files, {
      concurrency: 1,
    });

    expect(result.total).toBe(2);
    expect(result.completed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toBe("bad file");
    expect(result.results[1].success).toBe(true);
  });

  it("should pass library and topic options through", async () => {
    const { indexDocument } = await import("../../src/core/indexing.js");
    const mockedIndex = vi.mocked(indexDocument);
    mockedIndex.mockResolvedValue({ id: "doc-3", chunkCount: 2 });

    await batchImport(createMockDb(), createMockProvider(), ["test.md"], {
      library: "react",
      version: "18.0",
      topicId: "frontend",
    });

    expect(mockedIndex).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        library: "react",
        version: "18.0",
        topicId: "frontend",
        sourceType: "library",
      }),
    );
  });

  it("should default concurrency to 5", async () => {
    const files = Array.from({ length: 8 }, (_, i) => `file${i}.md`);
    const result = await batchImport(createMockDb(), createMockProvider(), files);

    expect(result.total).toBe(8);
    expect(result.completed).toBe(8);
  });
});
