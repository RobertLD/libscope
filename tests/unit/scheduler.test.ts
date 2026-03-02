import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConnectorScheduler, loadScheduleEntries } from "../../src/core/scheduler.js";
import { createTestDb } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../../src/providers/embedding.js";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("ConnectorScheduler", () => {
  let db: Database.Database;
  let provider: EmbeddingProvider;

  beforeEach(() => {
    db = createTestDb();
    provider = new MockEmbeddingProvider();
  });

  afterEach(() => {
    db.close();
  });

  it("starts with no jobs when given empty entries", () => {
    const scheduler = new ConnectorScheduler(db, provider);
    scheduler.start([]);
    const status = scheduler.getStatus();
    expect(status.running).toBe(true);
    expect(status.jobs).toHaveLength(0);
    scheduler.stop();
  });

  it("registers a valid cron job", () => {
    const scheduler = new ConnectorScheduler(db, provider);
    scheduler.start([
      { connectorType: "notion", connectorName: "my-notion", cronExpression: "0 */6 * * *" },
    ]);
    const status = scheduler.getStatus();
    expect(status.running).toBe(true);
    expect(status.jobs).toHaveLength(1);
    expect(status.jobs[0]!.connectorType).toBe("notion");
    expect(status.jobs[0]!.connectorName).toBe("my-notion");
    expect(status.jobs[0]!.cronExpression).toBe("0 */6 * * *");
    expect(status.jobs[0]!.running).toBe(false);
    scheduler.stop();
  });

  it("skips invalid cron expressions", () => {
    const scheduler = new ConnectorScheduler(db, provider);
    scheduler.start([
      { connectorType: "notion", connectorName: "bad-cron", cronExpression: "not a cron" },
    ]);
    const status = scheduler.getStatus();
    expect(status.running).toBe(true);
    expect(status.jobs).toHaveLength(0);
    scheduler.stop();
  });

  it("registers multiple jobs", () => {
    const scheduler = new ConnectorScheduler(db, provider);
    scheduler.start([
      { connectorType: "notion", connectorName: "my-notion", cronExpression: "0 */6 * * *" },
      { connectorType: "slack", connectorName: "my-slack", cronExpression: "0 0 * * *" },
    ]);
    const status = scheduler.getStatus();
    expect(status.jobs).toHaveLength(2);
    scheduler.stop();
  });

  it("stop clears all jobs", () => {
    const scheduler = new ConnectorScheduler(db, provider);
    scheduler.start([
      { connectorType: "notion", connectorName: "my-notion", cronExpression: "0 */6 * * *" },
    ]);
    expect(scheduler.getStatus().running).toBe(true);
    scheduler.stop();
    expect(scheduler.getStatus().running).toBe(false);
    expect(scheduler.getStatus().jobs).toHaveLength(0);
  });

  it("warns when starting an already-started scheduler", () => {
    const scheduler = new ConnectorScheduler(db, provider);
    scheduler.start([]);
    // Second start should not throw
    scheduler.start([
      { connectorType: "notion", connectorName: "my-notion", cronExpression: "0 */6 * * *" },
    ]);
    // Should still have 0 jobs from first start
    expect(scheduler.getStatus().jobs).toHaveLength(0);
    scheduler.stop();
  });
});

describe("loadScheduleEntries", () => {
  const testDir = join(tmpdir(), `libscope-test-schedules-${Date.now()}`);
  const connectorsDir = join(testDir, ".libscope", "connectors");
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env["HOME"];
    process.env["HOME"] = testDir;
    mkdirSync(connectorsDir, { recursive: true });
  });

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env["HOME"] = originalHome;
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  it("returns empty array when no connectors dir exists", () => {
    rmSync(connectorsDir, { recursive: true });
    const entries = loadScheduleEntries();
    expect(entries).toEqual([]);
  });

  it("returns empty array when no configs have schedules", () => {
    writeFileSync(
      join(connectorsDir, "notion.json"),
      JSON.stringify({ type: "notion", token: "secret_test" }),
    );
    const entries = loadScheduleEntries();
    expect(entries).toEqual([]);
  });

  it("loads schedule entries from config files", () => {
    writeFileSync(
      join(connectorsDir, "my-notion.json"),
      JSON.stringify({
        type: "notion",
        token: "secret_test",
        schedule: { cronExpression: "0 */6 * * *" },
      }),
    );
    const entries = loadScheduleEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      connectorType: "notion",
      connectorName: "my-notion",
      cronExpression: "0 */6 * * *",
    });
  });

  it("loads multiple schedule entries", () => {
    writeFileSync(
      join(connectorsDir, "my-notion.json"),
      JSON.stringify({
        type: "notion",
        token: "secret_test",
        schedule: { cronExpression: "0 */6 * * *" },
      }),
    );
    writeFileSync(
      join(connectorsDir, "my-slack.json"),
      JSON.stringify({
        type: "slack",
        token: "xoxb-test",
        schedule: { cronExpression: "0 0 * * *" },
      }),
    );
    const entries = loadScheduleEntries();
    expect(entries).toHaveLength(2);
  });

  it("uses connector name as type when type field is missing", () => {
    writeFileSync(
      join(connectorsDir, "notion.json"),
      JSON.stringify({
        token: "secret_test",
        schedule: { cronExpression: "0 0 * * *" },
      }),
    );
    const entries = loadScheduleEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.connectorType).toBe("notion");
    expect(entries[0]!.connectorName).toBe("notion");
  });

  it("skips files with invalid JSON gracefully", () => {
    writeFileSync(join(connectorsDir, "bad.json"), "not json");
    writeFileSync(
      join(connectorsDir, "good.json"),
      JSON.stringify({
        type: "notion",
        token: "secret_test",
        schedule: { cronExpression: "0 0 * * *" },
      }),
    );
    const entries = loadScheduleEntries();
    expect(entries).toHaveLength(1);
  });
});
