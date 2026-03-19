import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { FileWatcher, DEFAULT_WATCH_EXTENSIONS } from "../../src/core/watcher.js";
import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../../src/providers/embedding.js";

// Mock node:fs
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    watch: vi.fn(),
    readFileSync: vi.fn(),
    statSync: vi.fn(),
  };
});

import { watch, readFileSync, statSync } from "node:fs";

const mockWatch = vi.mocked(watch);
const mockReadFileSync = vi.mocked(readFileSync);
const mockStatSync = vi.mocked(statSync);

function createMockDb(): Database.Database {
  return {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue(undefined),
      run: vi.fn(),
    }),
  } as unknown as Database.Database;
}

function createMockProvider(): EmbeddingProvider {
  return {
    embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    dimensions: 3,
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  } as unknown as EmbeddingProvider;
}

type WatchCallback = (eventType: string, filename: string) => void;
type ErrorCallback = (err: Error) => void;

describe("FileWatcher", () => {
  let watchCallback: WatchCallback;
  let errorCallback: ErrorCallback;
  let closeFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    closeFn = vi.fn();

    mockWatch.mockImplementation((_path: unknown, _opts: unknown, cb?: unknown) => {
      if (typeof cb === "function") {
        watchCallback = cb as WatchCallback;
      }
      const watcher = {
        close: closeFn,
        on: vi.fn().mockImplementation((event: string, handler: ErrorCallback) => {
          if (event === "error") {
            errorCallback = handler;
          }
          return watcher;
        }),
      };
      return watcher as unknown as import("node:fs").FSWatcher;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("should export default watch extensions", () => {
    expect(DEFAULT_WATCH_EXTENSIONS).toEqual([".md", ".mdx", ".txt", ".rst"]);
  });

  it("should filter files by extension", () => {
    const db = createMockDb();
    const provider = createMockProvider();
    const onIndex = vi.fn();

    const watcher = new FileWatcher(db, provider, {
      directory: "/tmp/docs",
      extensions: [".md"],
      onIndex,
    });

    watcher.start();

    // Trigger a .js file — should be ignored
    watchCallback("change", "file.js");
    vi.advanceTimersByTime(500);

    expect(mockStatSync).not.toHaveBeenCalled();

    watcher.stop();
  });

  it("should debounce rapid changes to the same file", () => {
    const db = createMockDb();
    const provider = createMockProvider();

    const watcher = new FileWatcher(db, provider, {
      directory: "/tmp/docs",
      extensions: [".md"],
      debounceMs: 200,
    });

    watcher.start();

    mockStatSync.mockReturnValue({ isFile: () => true } as import("node:fs").Stats);
    mockReadFileSync.mockReturnValue("content");

    watchCallback("change", "file.md");
    watchCallback("change", "file.md");
    watchCallback("change", "file.md");

    // Before debounce expires, statSync should not be called
    vi.advanceTimersByTime(100);
    expect(mockStatSync).not.toHaveBeenCalled();

    // After debounce expires, it should process once
    vi.advanceTimersByTime(200);
    expect(mockStatSync).toHaveBeenCalledTimes(1);

    watcher.stop();
  });

  it("should skip unchanged files based on content_hash", async () => {
    const db = createMockDb();
    const provider = createMockProvider();
    const onIndex = vi.fn();

    const contentHash = createHash("sha256").update("hello").digest("hex");
    (db.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
      get: vi.fn().mockReturnValue({ id: "doc-1", content_hash: contentHash }),
      run: vi.fn(),
    });

    mockStatSync.mockReturnValue({ isFile: () => true } as import("node:fs").Stats);
    mockReadFileSync.mockReturnValue("hello");

    const watcher = new FileWatcher(db, provider, {
      directory: "/tmp/docs",
      extensions: [".md"],
      onIndex,
    });

    watcher.start();
    watchCallback("change", "file.md");

    vi.advanceTimersByTime(500);
    await vi.advanceTimersByTimeAsync(0);

    expect(onIndex).not.toHaveBeenCalled();

    watcher.stop();
  });

  it("should remove document when file is deleted", async () => {
    const db = createMockDb();
    const onRemove = vi.fn();
    const runFn = vi.fn();

    (db.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
      get: vi.fn().mockReturnValue({ id: "doc-1" }),
      run: runFn,
    });

    mockStatSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const provider = createMockProvider();
    const watcher = new FileWatcher(db, provider, {
      directory: "/tmp/docs",
      extensions: [".md"],
      onRemove,
    });

    watcher.start();
    watchCallback("change", "deleted.md");

    vi.advanceTimersByTime(500);
    await vi.advanceTimersByTimeAsync(0);

    expect(onRemove).toHaveBeenCalled();

    watcher.stop();
  });

  it("should call onError callback when watcher emits an error", () => {
    const db = createMockDb();
    const provider = createMockProvider();
    const onError = vi.fn();

    const watcher = new FileWatcher(db, provider, {
      directory: "/tmp/docs",
      onError,
    });

    watcher.start();

    const err = new Error("watch failed");
    errorCallback(err);

    expect(onError).toHaveBeenCalledWith(err);

    watcher.stop();
  });

  it("should handle non-Error watcher error events", () => {
    const db = createMockDb();
    const provider = createMockProvider();
    const onError = vi.fn();

    const watcher = new FileWatcher(db, provider, {
      directory: "/tmp/docs",
      onError,
    });

    watcher.start();

    // Simulate a non-Error object being emitted
    errorCallback("string error" as unknown as Error);

    expect(onError).toHaveBeenCalledWith(expect.any(Error));

    watcher.stop();
  });

  it("should ignore events with no filename", () => {
    const db = createMockDb();
    const provider = createMockProvider();

    const watcher = new FileWatcher(db, provider, {
      directory: "/tmp/docs",
      extensions: [".md"],
    });

    watcher.start();

    // Trigger event with null filename — should be ignored
    watchCallback("change", null as unknown as string);

    expect(mockStatSync).not.toHaveBeenCalled();

    watcher.stop();
  });

  it("should skip non-file entries (directories)", async () => {
    const db = createMockDb();
    const provider = createMockProvider();
    const onIndex = vi.fn();

    mockStatSync.mockReturnValue({ isFile: () => false } as import("node:fs").Stats);

    const watcher = new FileWatcher(db, provider, {
      directory: "/tmp/docs",
      extensions: [".md"],
      onIndex,
    });

    watcher.start();
    watchCallback("change", "subdir.md");

    vi.advanceTimersByTime(500);
    await vi.advanceTimersByTimeAsync(0);

    expect(onIndex).not.toHaveBeenCalled();

    watcher.stop();
  });

  it("should not call onRemove when deleted file has no corresponding document", async () => {
    const db = createMockDb();
    const onRemove = vi.fn();

    // Return undefined for document lookup (no existing doc)
    (db.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
      get: vi.fn().mockReturnValue(undefined),
      run: vi.fn(),
    });

    mockStatSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const provider = createMockProvider();
    const watcher = new FileWatcher(db, provider, {
      directory: "/tmp/docs",
      extensions: [".md"],
      onRemove,
    });

    watcher.start();
    watchCallback("change", "ghost.md");

    vi.advanceTimersByTime(500);
    await vi.advanceTimersByTimeAsync(0);

    expect(onRemove).not.toHaveBeenCalled();

    watcher.stop();
  });

  it("should clean up timers and close watcher on stop", () => {
    const db = createMockDb();
    const provider = createMockProvider();

    const watcher = new FileWatcher(db, provider, {
      directory: "/tmp/docs",
      extensions: [".md"],
      debounceMs: 1000,
    });

    watcher.start();

    // Queue a debounced event
    watchCallback("change", "file.md");

    watcher.stop();

    expect(closeFn).toHaveBeenCalled();

    // The timer should have been cleared — reset call tracking before asserting
    mockStatSync.mockClear();
    vi.advanceTimersByTime(2000);
    expect(mockStatSync).not.toHaveBeenCalled();
  });
});
