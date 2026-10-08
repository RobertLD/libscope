import { describe, it, expect, vi } from "vitest";
import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../../src/providers/embedding.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    watch: vi.fn(() => ({ on: vi.fn(), close: vi.fn() })),
    readFileSync: vi.fn(() => "# Doc\n\nBody"),
    statSync: vi.fn(() => ({ isFile: (): boolean => true })),
  };
});

vi.mock("../../src/core/indexing.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/core/indexing.js")>();
  return { ...original, indexDocument: vi.fn(() => Promise.resolve({ id: "d1", chunkCount: 1 })) };
});

const { watch } = await import("node:fs");
const { indexDocument } = await import("../../src/core/indexing.js");
const { FileWatcher } = await import("../../src/core/watcher.js");

describe("FileWatcher document metadata", () => {
  it("indexes changed files with the given topic, library and source type", async () => {
    vi.useFakeTimers();
    const db = {
      prepare: vi.fn(() => ({ get: vi.fn(() => undefined), run: vi.fn() })),
    } as unknown as Database.Database;
    const onIndex = vi.fn();
    const watcher = new FileWatcher(db, {} as EmbeddingProvider, {
      directory: "/docs",
      extensions: [".md"],
      document: { topicId: "t1", library: "lib", version: "2" },
      onIndex,
    });
    watcher.start();
    const callback = vi.mocked(watch).mock.calls[0]?.[2] as (e: string, f: string) => void;
    callback("change", "guide.md");
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();

    expect(indexDocument).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({
        title: "guide",
        sourceType: "library",
        library: "lib",
        version: "2",
        topicId: "t1",
        url: "/docs/guide.md",
      }),
    );
    expect(onIndex).toHaveBeenCalledWith("/docs/guide.md");
    watcher.stop();
  });
});
