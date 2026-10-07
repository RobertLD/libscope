import { describe, it, expect, vi } from "vitest";
import { initLogger } from "../../src/logger.js";
import { makeContext } from "./operations/helpers.js";

const mocks = vi.hoisted(() => ({
  transports: [] as unknown[],
  bootstrap: vi.fn(),
  initLogger: vi.fn(),
}));

// A stand-in stdio transport, so no test touches the real stdin/stdout.
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {
    onclose?: () => void;
    constructor() {
      mocks.transports.push(this);
    }
    start(): Promise<void> {
      return Promise.resolve();
    }
    send(): Promise<void> {
      return Promise.resolve();
    }
    close(): Promise<void> {
      this.onclose?.();
      return Promise.resolve();
    }
  },
}));

vi.mock("../../src/core/bootstrap.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/core/bootstrap.js")>();
  return {
    ...orig,
    bootstrap: (...args: Parameters<typeof orig.bootstrap>): ReturnType<typeof orig.bootstrap> => {
      mocks.bootstrap();
      return orig.bootstrap(...args);
    },
  };
});

vi.mock("../../src/logger.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/logger.js")>();
  return {
    ...orig,
    initLogger: (...args: Parameters<typeof orig.initLogger>): void => {
      mocks.initLogger(...args);
      orig.initLogger(...args);
    },
  };
});

initLogger("silent");

describe("libscope/mcp entry points", () => {
  it("importing the server module starts nothing", async () => {
    const sigint = process.listenerCount("SIGINT");
    const mod = await import("../../src/mcp/server.js");
    expect(typeof mod.createMcpServer).toBe("function");
    expect(typeof mod.runStdioServer).toBe("function");
    expect(mocks.transports).toHaveLength(0);
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(process.listenerCount("SIGINT")).toBe(sigint);
  });

  it("runStdioServer logs to stderr and connects the stdio transport", async () => {
    const { runStdioServer } = await import("../../src/mcp/server.js");
    const t = makeContext({ surface: "mcp", llm: undefined });
    const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
    const mcp = await runStdioServer({ ctx: t.ctx, logLevel: "silent", toolsets: [] });
    try {
      expect(mocks.initLogger).toHaveBeenCalledWith("silent", { destination: "stderr" });
      expect(mocks.transports).toHaveLength(1);
      expect(mocks.bootstrap).not.toHaveBeenCalled();
      expect(mcp.tools).toHaveLength(11);
      expect(process.listenerCount("SIGINT")).toBe(before.SIGINT.length + 1);
    } finally {
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        for (const listener of process.listeners(signal)) {
          if (!before[signal].includes(listener)) process.removeListener(signal, listener);
        }
      }
      await mcp.close();
      t.db.close();
    }
  });
});
