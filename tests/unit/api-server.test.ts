import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDbWithVec } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { initLogger } from "../../src/logger.js";
import type Database from "better-sqlite3";

// Mock the scheduler to avoid real cron
vi.mock("../../src/core/scheduler.js", () => ({
  ConnectorScheduler: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
  loadScheduleEntries: vi.fn().mockReturnValue([]),
}));

const { startApiServer } = await import("../../src/api/server.js");

describe("startApiServer", () => {
  let db: Database.Database;

  beforeEach(() => {
    initLogger("silent");
    db = createTestDbWithVec();
  });

  afterEach(() => {
    db.close();
  });

  it("starts on port 0 and returns a close function", async () => {
    const provider = new MockEmbeddingProvider();
    const result = await startApiServer(db, provider, {
      port: 0,
      host: "127.0.0.1",
      enableScheduler: false,
    });

    expect(result.port).toBe(0);
    expect(typeof result.close).toBe("function");
    result.close();
  });

  it("starts with scheduler enabled but no entries", async () => {
    const provider = new MockEmbeddingProvider();
    const result = await startApiServer(db, provider, {
      port: 0,
      host: "127.0.0.1",
      enableScheduler: true,
    });

    expect(typeof result.close).toBe("function");
    expect(result.scheduler).toBeUndefined();
    result.close();
  });

  it("starts with default options (scheduler enabled by default)", async () => {
    const provider = new MockEmbeddingProvider();
    const result = await startApiServer(db, provider, {
      port: 0,
      host: "127.0.0.1",
    });

    expect(typeof result.close).toBe("function");
    result.close();
  });
});
