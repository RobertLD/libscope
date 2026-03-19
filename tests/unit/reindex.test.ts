import { describe, it, expect, vi, beforeEach } from "vitest";
import { reindex } from "../../src/core/reindex.js";
import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../../src/providers/embedding.js";

// Mock logger
vi.mock("../../src/logger.js", () => ({
  getLogger: (): Record<string, ReturnType<typeof vi.fn>> => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

interface MockProviderResult {
  provider: EmbeddingProvider;
  embedBatchFn: ReturnType<typeof vi.fn>;
}

function createMockProvider(overrides?: Partial<EmbeddingProvider>): MockProviderResult {
  const embedBatchFn =
    overrides?.embedBatch ??
    vi
      .fn()
      .mockImplementation((texts: string[]) =>
        Promise.resolve(texts.map(() => new Array<number>(384).fill(0))),
      );
  const provider: EmbeddingProvider = {
    name: "mock",
    dimensions: 384,
    embed: vi.fn().mockResolvedValue(new Array(384).fill(0)),
    embedBatch: embedBatchFn as EmbeddingProvider["embedBatch"],
    ...overrides,
  };
  return { provider, embedBatchFn: embedBatchFn as ReturnType<typeof vi.fn> };
}

interface MockStmt {
  all: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

interface MockDbResult {
  db: Database.Database;
  prepareFn: ReturnType<typeof vi.fn>;
}

function createMockDb(chunks: Array<{ id: string; content: string }> = []): MockDbResult {
  const stmts: Record<string, MockStmt> = {};

  const prepareFn = vi.fn().mockImplementation((sql: string) => {
    stmts[sql] ??= {
      all: vi.fn().mockReturnValue(chunks),
      run: vi.fn(),
    };
    return stmts[sql];
  });

  const db = {
    prepare: prepareFn,
    exec: vi.fn(),
    transaction: vi.fn().mockImplementation((fn: () => void) => fn),
  } as unknown as Database.Database;

  return { db, prepareFn };
}

describe("reindex", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return zeros when there are no chunks", async () => {
    const { db } = createMockDb([]);
    const { provider, embedBatchFn } = createMockProvider();

    const result = await reindex(db, provider);

    expect(result.total).toBe(0);
    expect(result.completed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.failedChunkIds).toEqual([]);
    expect(embedBatchFn).not.toHaveBeenCalled();
  });

  it("should re-embed all chunks", async () => {
    const chunks = [
      { id: "c1", content: "Hello world" },
      { id: "c2", content: "Another chunk" },
    ];
    const { db } = createMockDb(chunks);
    const { provider, embedBatchFn } = createMockProvider();

    const result = await reindex(db, provider);

    expect(result.total).toBe(2);
    expect(result.completed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.failedChunkIds).toEqual([]);
    expect(embedBatchFn).toHaveBeenCalledWith(["Hello world", "Another chunk"]);
  });

  it("should respect batchSize option", async () => {
    const chunks = [
      { id: "c1", content: "chunk 1" },
      { id: "c2", content: "chunk 2" },
      { id: "c3", content: "chunk 3" },
    ];
    const { db } = createMockDb(chunks);
    const { provider, embedBatchFn } = createMockProvider();

    await reindex(db, provider, { batchSize: 2 });

    expect(embedBatchFn).toHaveBeenCalledTimes(2);
    expect(embedBatchFn).toHaveBeenNthCalledWith(1, ["chunk 1", "chunk 2"]);
    expect(embedBatchFn).toHaveBeenNthCalledWith(2, ["chunk 3"]);
  });

  it("should call onProgress after each batch", async () => {
    const chunks = [
      { id: "c1", content: "chunk 1" },
      { id: "c2", content: "chunk 2" },
      { id: "c3", content: "chunk 3" },
    ];
    const { db } = createMockDb(chunks);
    const { provider } = createMockProvider();
    const progressCalls: Array<{ completed: number; failed: number; total: number }> = [];

    await reindex(db, provider, {
      batchSize: 2,
      onProgress: (progress) => {
        progressCalls.push({
          total: progress.total,
          completed: progress.completed,
          failed: progress.failed,
        });
      },
    });

    expect(progressCalls).toHaveLength(2);
    expect(progressCalls[0]).toEqual({ total: 3, completed: 2, failed: 0 });
    expect(progressCalls[1]).toEqual({ total: 3, completed: 3, failed: 0 });
  });

  it("should handle batch embedding failure gracefully", async () => {
    const chunks = [
      { id: "c1", content: "chunk 1" },
      { id: "c2", content: "chunk 2" },
      { id: "c3", content: "chunk 3" },
    ];
    const { db } = createMockDb(chunks);
    const { provider } = createMockProvider({
      embedBatch: vi
        .fn()
        .mockRejectedValueOnce(new Error("API down"))
        .mockResolvedValueOnce([new Array(384).fill(0)]),
    });

    const result = await reindex(db, provider, { batchSize: 2 });

    expect(result.total).toBe(3);
    expect(result.completed).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.failedChunkIds).toContain("c1");
    expect(result.failedChunkIds).toContain("c2");
    expect(result.failedChunkIds).not.toContain("c3");
  });

  it("should pass documentIds filter to query", async () => {
    const { db, prepareFn } = createMockDb([]);
    const { provider } = createMockProvider();

    await reindex(db, provider, { documentIds: ["doc-1", "doc-2"] });

    const prepareCall = (prepareFn.mock.calls as string[][]).find(
      (call) => typeof call[0] === "string" && call[0].includes("SELECT c.id"),
    );
    expect(prepareCall).toBeDefined();
    const sql = prepareCall![0];
    expect(sql).toContain("c.document_id IN");
  });

  it("should pass date filters to query", async () => {
    const { db, prepareFn } = createMockDb([]);
    const { provider } = createMockProvider();

    await reindex(db, provider, { since: "2024-01-01", before: "2024-12-31" });

    const prepareCall = (prepareFn.mock.calls as string[][]).find(
      (call) => typeof call[0] === "string" && call[0].includes("SELECT c.id"),
    );
    expect(prepareCall).toBeDefined();
    const sql = prepareCall![0];
    expect(sql).toContain("d.created_at >=");
    expect(sql).toContain("d.created_at <=");
  });

  it("should default batchSize to 50", async () => {
    const chunks = Array.from({ length: 60 }, (_, i) => ({
      id: `c${i}`,
      content: `chunk ${i}`,
    }));
    const { db } = createMockDb(chunks);
    const { provider, embedBatchFn } = createMockProvider();

    await reindex(db, provider);

    expect(embedBatchFn).toHaveBeenCalledTimes(2);
    const firstCallTexts = embedBatchFn.mock.calls[0]![0] as string[];
    expect(firstCallTexts).toHaveLength(50);
  });

  it("should report failed chunk IDs", async () => {
    const chunks = [
      { id: "c1", content: "chunk 1" },
      { id: "c2", content: "chunk 2" },
    ];
    const { db } = createMockDb(chunks);
    const { provider } = createMockProvider({
      embedBatch: vi.fn().mockRejectedValue(new Error("fail")),
    });

    const result = await reindex(db, provider);

    expect(result.failedChunkIds).toEqual(["c1", "c2"]);
    expect(result.failed).toBe(2);
    expect(result.completed).toBe(0);
  });
});
