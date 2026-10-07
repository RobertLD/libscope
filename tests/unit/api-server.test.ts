import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDbWithVec } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { initLogger } from "../../src/logger.js";
import type Database from "better-sqlite3";
import { testConfig } from "./operations/helpers.js";

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
    const result = await startApiServer(
      { db, provider, config: testConfig() },
      {
        port: 0,
        host: "127.0.0.1",
        enableScheduler: false,
      },
    );

    expect(result.port).toBeGreaterThan(0);
    expect(typeof result.close).toBe("function");
    await result.close();
  });

  it("starts with scheduler enabled but no entries", async () => {
    const provider = new MockEmbeddingProvider();
    const result = await startApiServer(
      { db, provider, config: testConfig() },
      {
        port: 0,
        host: "127.0.0.1",
        enableScheduler: true,
      },
    );

    expect(typeof result.close).toBe("function");
    expect(result.scheduler).toBeUndefined();
    await result.close();
  });

  it("starts with default options (scheduler enabled by default)", async () => {
    const provider = new MockEmbeddingProvider();
    const result = await startApiServer(
      { db, provider, config: testConfig() },
      {
        port: 0,
        host: "127.0.0.1",
      },
    );

    expect(typeof result.close).toBe("function");
    await result.close();
  });

  it("serves generated routes behind CORS, origin and API key checks", async () => {
    const provider = new MockEmbeddingProvider();
    const server = await startApiServer(
      { db, provider, config: testConfig() },
      { port: 0, host: "127.0.0.1", enableScheduler: false, corsOrigins: ["http://app.example"] },
    );
    const base = `http://127.0.0.1:${server.port}/api/v1`;
    try {
      const health = await fetch(`${base}/health`, { headers: { Origin: "http://app.example" } });
      expect(health.status).toBe(200);
      expect(health.headers.get("access-control-allow-origin")).toBe("http://app.example");
      expect(health.headers.get("content-security-policy")).toContain("default-src 'self'");

      const foreign = await fetch(`${base}/topics`, {
        method: "POST",
        headers: { Origin: "http://evil.example", "Content-Type": "text/plain" },
        body: JSON.stringify({ name: "x" }),
      });
      expect(foreign.status).toBe(403);

      process.env["LIBSCOPE_API_KEY"] = "k";
      expect((await fetch(`${base}/overview`)).status).toBe(401);
      const authed = await fetch(`${base}/overview`, { headers: { Authorization: "Bearer k" } });
      expect(authed.status).toBe(200);
    } finally {
      delete process.env["LIBSCOPE_API_KEY"];
      await server.close();
    }
  });
});
