import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";
import { startInteractiveSearch } from "../../src/cli/repl.js";
import type { Interface } from "node:readline/promises";

/** Minimal readline.Interface that yields pre-programmed answers, then "closes". */
function createMockInterface(inputs: string[]): { iface: Interface; closeFn: MockInstance } {
  const queue = [...inputs];
  const closeFn = vi.fn();
  const iface = {
    question: vi.fn(() => {
      const next = queue.shift();
      return next === undefined ? Promise.reject(new Error("closed")) : Promise.resolve(next);
    }),
    close: closeFn,
  } as unknown as Interface;
  return { iface, closeFn };
}

describe("startInteractiveSearch", () => {
  let log: MockInstance;
  let error: MockInstance;

  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    error.mockRestore();
  });

  it("runs each non-empty query and stops on 'quit'", async () => {
    const { iface, closeFn } = createMockInterface(["  first ", "", "second", "quit", "never"]);
    const onQuery = vi.fn(() => Promise.resolve());
    await startInteractiveSearch({ onQuery, createInterface: () => iface });
    expect(onQuery.mock.calls).toEqual([["first"], ["second"]]);
    expect(closeFn).toHaveBeenCalledOnce();
  });

  it("stops when input closes (Ctrl+D)", async () => {
    const { iface, closeFn } = createMockInterface(["one"]);
    const onQuery = vi.fn(() => Promise.resolve());
    await startInteractiveSearch({ onQuery, createInterface: () => iface });
    expect(onQuery).toHaveBeenCalledTimes(1);
    expect(closeFn).toHaveBeenCalledOnce();
  });

  it("prints an error and keeps going when a query fails", async () => {
    const { iface } = createMockInterface(["bad", "good", "exit"]);
    const onQuery = vi
      .fn<(q: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    await startInteractiveSearch({ onQuery, createInterface: () => iface });
    expect(error).toHaveBeenCalledWith("✗ boom");
    expect(onQuery).toHaveBeenCalledTimes(2);
  });
});
