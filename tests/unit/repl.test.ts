import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";
import { startRepl } from "../../src/cli/repl.js";
import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../../src/providers/embedding.js";
import { EventEmitter } from "node:events";

/** Minimal mock readline.Interface that yields pre-programmed answers. */
function createMockInterface(inputs: string[]) {
  const queue = [...inputs];
  const emitter = new EventEmitter();

  const questionFn = vi.fn(() => {
    const next = queue.shift();
    if (next === undefined) return Promise.reject(new Error("closed"));
    return Promise.resolve(next);
  });
  const closeFn = vi.fn();

  const iface = {
    question: questionFn,
    close: closeFn,
    on: emitter.on.bind(emitter),
  } as unknown as import("node:readline/promises").Interface;

  return { iface, questionFn, closeFn };
}

function createMockDb() {
  return {} as unknown as Database.Database;
}

function createMockProvider() {
  return {
    dimensions: 3,
    generateEmbedding: vi.fn(() => Promise.resolve(new Float32Array([0.1, 0.2, 0.3]))),
  } as unknown as EmbeddingProvider;
}

describe("startRepl", () => {
  let consoleSpy: MockInstance;
  let consoleErrorSpy: MockInstance;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("exits on 'quit' command", async () => {
    const { iface, closeFn } = createMockInterface(["quit"]);

    await startRepl({
      db: createMockDb(),
      provider: createMockProvider(),
      createInterface: () => iface,
    });

    expect(closeFn).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith("Goodbye!");
  });

  it("exits on 'exit' command", async () => {
    const { iface, closeFn } = createMockInterface(["exit"]);

    await startRepl({
      db: createMockDb(),
      provider: createMockProvider(),
      createInterface: () => iface,
    });

    expect(closeFn).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith("Goodbye!");
  });

  it("skips empty input lines", async () => {
    const { iface, questionFn, closeFn } = createMockInterface(["", "  ", "quit"]);

    await startRepl({
      db: createMockDb(),
      provider: createMockProvider(),
      createInterface: () => iface,
    });

    expect(questionFn).toHaveBeenCalledTimes(3);
    expect(closeFn).toHaveBeenCalled();
  });

  it("exits gracefully on readline close (Ctrl+C)", async () => {
    const { iface, closeFn } = createMockInterface([]);

    await startRepl({
      db: createMockDb(),
      provider: createMockProvider(),
      createInterface: () => iface,
    });

    expect(closeFn).toHaveBeenCalled();
  });

  it("handles search errors gracefully", async () => {
    const { iface, closeFn } = createMockInterface(["test query", "quit"]);

    await startRepl({
      db: createMockDb(),
      provider: createMockProvider(),
      createInterface: () => iface,
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Search error:"));
    expect(closeFn).toHaveBeenCalled();
  });

  it("prints banner on start", async () => {
    const { iface } = createMockInterface(["quit"]);

    await startRepl({
      db: createMockDb(),
      provider: createMockProvider(),
      createInterface: () => iface,
    });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("LibScope interactive search"));
  });
});
