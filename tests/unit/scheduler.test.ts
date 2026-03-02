import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../../src/providers/embedding.js";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Capture cron callbacks so we can trigger them manually in tests
const cronCallbacks = new Map<string, () => void>();
vi.mock("node-cron", () => ({
  default: {
    validate: (expr: string) =>
      /^[\d*/, -]+( [\d*/, -]+){4}$/.test(expr) ||
      expr === "0 */6 * * *" ||
      expr === "0 0 * * *" ||
      expr === "*/5 * * * *",
    schedule: vi.fn((expr: string, callback: () => void) => {
      cronCallbacks.set(expr, callback);
      return { stop: vi.fn() };
    }),
  },
}));

vi.mock("../../src/connectors/index.js", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    loadNamedConnectorConfig: vi.fn().mockReturnValue({ token: "test-token" }),
    saveNamedConnectorConfig: vi.fn(),
    startSync: vi.fn().mockReturnValue("sync-id-1"),
    completeSync: vi.fn(),
    failSync: vi.fn(),
  };
});

vi.mock("../../src/connectors/notion.js", () => ({
  syncNotion: vi.fn().mockResolvedValue({ pagesIndexed: 5, errors: [] }),
}));

vi.mock("../../src/connectors/slack.js", () => ({
  syncSlack: vi.fn().mockResolvedValue({ messagesIndexed: 10, threadsIndexed: 2, errors: [] }),
}));

vi.mock("../../src/connectors/confluence.js", () => ({
  syncConfluence: vi.fn().mockResolvedValue({ pagesIndexed: 3, pagesUpdated: 1, errors: [] }),
}));

vi.mock("../../src/connectors/obsidian.js", () => ({
  syncObsidianVault: vi.fn().mockResolvedValue({ added: 4, updated: 2, deleted: 1, errors: [] }),
}));

vi.mock("../../src/connectors/onenote.js", () => ({
  syncOneNote: vi.fn().mockResolvedValue({ pagesAdded: 6, pagesUpdated: 0, errors: [] }),
}));

// Import after mocks are set up
const { ConnectorScheduler, loadScheduleEntries } = await import("../../src/core/scheduler.js");
const { startSync, completeSync, failSync } = await import("../../src/connectors/index.js");
const { syncNotion } = await import("../../src/connectors/notion.js");
const { syncSlack } = await import("../../src/connectors/slack.js");
const { syncConfluence } = await import("../../src/connectors/confluence.js");
const { syncObsidianVault } = await import("../../src/connectors/obsidian.js");
const { syncOneNote } = await import("../../src/connectors/onenote.js");

describe("ConnectorScheduler", () => {
  let db: Database.Database;
  let provider: EmbeddingProvider;

  beforeEach(() => {
    db = createTestDb();
    provider = new MockEmbeddingProvider();
    cronCallbacks.clear();
    vi.clearAllMocks();
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

  describe("runSync via cron callback", () => {
    it("runs a notion sync successfully", async () => {
      const scheduler = new ConnectorScheduler(db, provider);
      scheduler.start([
        { connectorType: "notion", connectorName: "my-notion", cronExpression: "0 */6 * * *" },
      ]);

      const callback = cronCallbacks.get("0 */6 * * *");
      expect(callback).toBeDefined();
      callback!();
      // Allow async runSync to complete
      await vi.waitFor(() => {
        expect(completeSync).toHaveBeenCalled();
      });

      expect(startSync).toHaveBeenCalledWith(db, "notion", "my-notion");
      expect(syncNotion).toHaveBeenCalled();
      expect(completeSync).toHaveBeenCalledWith(db, "sync-id-1", {
        added: 5,
        updated: 0,
        deleted: 0,
        errored: 0,
      });

      const status = scheduler.getStatus();
      expect(status.jobs[0]!.lastRun).toBeDefined();
      expect(status.jobs[0]!.running).toBe(false);
      scheduler.stop();
    });

    it("runs a slack sync successfully", async () => {
      const scheduler = new ConnectorScheduler(db, provider);
      scheduler.start([
        { connectorType: "slack", connectorName: "my-slack", cronExpression: "0 0 * * *" },
      ]);

      cronCallbacks.get("0 0 * * *")!();
      await vi.waitFor(() => {
        expect(completeSync).toHaveBeenCalled();
      });

      expect(syncSlack).toHaveBeenCalled();
      expect(completeSync).toHaveBeenCalledWith(db, "sync-id-1", {
        added: 12,
        updated: 0,
        deleted: 0,
        errored: 0,
      });
      scheduler.stop();
    });

    it("runs a confluence sync successfully", async () => {
      const scheduler = new ConnectorScheduler(db, provider);
      scheduler.start([
        {
          connectorType: "confluence",
          connectorName: "my-confluence",
          cronExpression: "0 */6 * * *",
        },
      ]);

      cronCallbacks.get("0 */6 * * *")!();
      await vi.waitFor(() => {
        expect(completeSync).toHaveBeenCalled();
      });

      expect(syncConfluence).toHaveBeenCalled();
      expect(completeSync).toHaveBeenCalledWith(db, "sync-id-1", {
        added: 3,
        updated: 1,
        deleted: 0,
        errored: 0,
      });
      scheduler.stop();
    });

    it("runs an obsidian sync successfully", async () => {
      const scheduler = new ConnectorScheduler(db, provider);
      scheduler.start([
        {
          connectorType: "obsidian",
          connectorName: "my-obsidian",
          cronExpression: "0 */6 * * *",
        },
      ]);

      cronCallbacks.get("0 */6 * * *")!();
      await vi.waitFor(() => {
        expect(completeSync).toHaveBeenCalled();
      });

      expect(syncObsidianVault).toHaveBeenCalled();
      expect(completeSync).toHaveBeenCalledWith(db, "sync-id-1", {
        added: 4,
        updated: 2,
        deleted: 1,
        errored: 0,
      });
      scheduler.stop();
    });

    it("runs a onenote sync successfully", async () => {
      const scheduler = new ConnectorScheduler(db, provider);
      scheduler.start([
        {
          connectorType: "onenote",
          connectorName: "my-onenote",
          cronExpression: "0 */6 * * *",
        },
      ]);

      cronCallbacks.get("0 */6 * * *")!();
      await vi.waitFor(() => {
        expect(completeSync).toHaveBeenCalled();
      });

      expect(syncOneNote).toHaveBeenCalled();
      expect(completeSync).toHaveBeenCalledWith(db, "sync-id-1", {
        added: 6,
        updated: 0,
        deleted: 0,
        errored: 0,
      });
      scheduler.stop();
    });

    it("handles sync failure and calls failSync", async () => {
      vi.mocked(syncNotion).mockRejectedValueOnce(new Error("Network error"));

      const scheduler = new ConnectorScheduler(db, provider);
      scheduler.start([
        { connectorType: "notion", connectorName: "fail-notion", cronExpression: "*/5 * * * *" },
      ]);

      cronCallbacks.get("*/5 * * * *")!();
      await vi.waitFor(() => {
        expect(failSync).toHaveBeenCalled();
      });

      expect(failSync).toHaveBeenCalledWith(db, "sync-id-1", "Network error");
      const status = scheduler.getStatus();
      expect(status.jobs[0]!.running).toBe(false);
      expect(status.jobs[0]!.lastRun).toBeDefined();
      scheduler.stop();
    });

    it("handles unknown connector type", async () => {
      const scheduler = new ConnectorScheduler(db, provider);
      scheduler.start([
        {
          connectorType: "unknown-type",
          connectorName: "my-unknown",
          cronExpression: "0 */6 * * *",
        },
      ]);

      cronCallbacks.get("0 */6 * * *")!();
      await vi.waitFor(() => {
        expect(failSync).toHaveBeenCalled();
      });

      expect(failSync).toHaveBeenCalledWith(
        db,
        "sync-id-1",
        "Unknown connector type: unknown-type",
      );
      scheduler.stop();
    });

    it("skips sync when job is already running", async () => {
      // Make syncNotion hang so the job stays "running"
      let resolveSync: (() => void) | undefined;
      vi.mocked(syncNotion).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSync = () => resolve({ pagesIndexed: 1, errors: [] });
          }),
      );

      const scheduler = new ConnectorScheduler(db, provider);
      scheduler.start([
        { connectorType: "notion", connectorName: "busy-notion", cronExpression: "0 */6 * * *" },
      ]);

      // Trigger first run (will hang)
      const callback = cronCallbacks.get("0 */6 * * *")!;
      callback();

      // Wait for it to be marked as running
      await vi.waitFor(() => {
        expect(scheduler.getStatus().jobs[0]!.running).toBe(true);
      });

      // Trigger second run — should be skipped
      callback();

      // Resolve the first sync
      resolveSync!();
      await vi.waitFor(() => {
        expect(scheduler.getStatus().jobs[0]!.running).toBe(false);
      });

      // syncNotion should only have been called once (second was skipped)
      expect(syncNotion).toHaveBeenCalledTimes(1);
      scheduler.stop();
    });

    it("handles non-Error thrown values in sync", async () => {
      vi.mocked(syncNotion).mockRejectedValueOnce("string error");

      const scheduler = new ConnectorScheduler(db, provider);
      scheduler.start([
        { connectorType: "notion", connectorName: "str-err", cronExpression: "0 */6 * * *" },
      ]);

      cronCallbacks.get("0 */6 * * *")!();
      await vi.waitFor(() => {
        expect(failSync).toHaveBeenCalled();
      });

      expect(failSync).toHaveBeenCalledWith(db, "sync-id-1", "string error");
      scheduler.stop();
    });
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
