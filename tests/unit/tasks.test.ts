import { describe, it, expect, beforeEach } from "vitest";
import { TaskRegistry } from "../../src/mcp/tasks.js";
import type { TaskType } from "../../src/mcp/tasks.js";

function makeRegistry(): TaskRegistry {
  return new TaskRegistry();
}

describe("TaskRegistry", () => {
  let registry: TaskRegistry;

  beforeEach(() => {
    registry = makeRegistry();
  });

  describe("create", () => {
    it("returns a task with pending status and a unique ID", () => {
      const { task } = registry.create("index_document");
      expect(task.id).toBeTruthy();
      expect(task.status).toBe("pending");
      expect(task.type).toBe("index_document");
      expect(task.createdAt).toBeInstanceOf(Date);
    });

    it("returns an AbortSignal that is not yet aborted", () => {
      const { signal } = registry.create("reindex_library");
      expect(signal.aborted).toBe(false);
    });

    it("assigns unique IDs to different tasks", () => {
      const { task: t1 } = registry.create("index_document");
      const { task: t2 } = registry.create("index_document");
      expect(t1.id).not.toBe(t2.id);
    });

    it("supports all task types", () => {
      const types: TaskType[] = [
        "index_document",
        "reindex_library",
        "sync_connector",
        "install_pack",
      ];
      for (const type of types) {
        const { task } = registry.create(type);
        expect(task.type).toBe(type);
      }
    });
  });

  describe("get", () => {
    it("returns the task after creation", () => {
      const { task } = registry.create("install_pack");
      const fetched = registry.get(task.id);
      expect(fetched).toBeDefined();
      expect(fetched?.id).toBe(task.id);
    });

    it("returns undefined for unknown ID", () => {
      expect(registry.get("nonexistent-id")).toBeUndefined();
    });

    it("prunes tasks whose completedAt is older than 1 hour", () => {
      const { task } = registry.create("reindex_library");
      registry.update(task.id, {
        status: "completed",
        completedAt: new Date(Date.now() - 61 * 60 * 1000), // 61 minutes ago
      });
      expect(registry.get(task.id)).toBeUndefined();
    });

    it("does not prune tasks that completed less than 1 hour ago", () => {
      const { task } = registry.create("sync_connector");
      registry.update(task.id, {
        status: "completed",
        completedAt: new Date(Date.now() - 30 * 60 * 1000), // 30 minutes ago
      });
      expect(registry.get(task.id)).toBeDefined();
    });
  });

  describe("update", () => {
    it("applies partial updates to a task", () => {
      const { task } = registry.create("index_document");
      registry.update(task.id, { status: "running", startedAt: new Date() });
      const updated = registry.get(task.id);
      expect(updated?.status).toBe("running");
      expect(updated?.startedAt).toBeInstanceOf(Date);
    });

    it("updates progress fields", () => {
      const { task } = registry.create("reindex_library");
      registry.update(task.id, { progress: { current: 10, total: 100 } });
      const updated = registry.get(task.id);
      expect(updated?.progress?.current).toBe(10);
      expect(updated?.progress?.total).toBe(100);
    });

    it("is a no-op for unknown ID", () => {
      expect(() => registry.update("nonexistent-id", { status: "completed" })).not.toThrow();
    });
  });

  describe("cancel", () => {
    it("returns not_found for unknown task ID", () => {
      expect(registry.cancel("nonexistent-id")).toBe("not_found");
    });

    it("cancels a pending task immediately", () => {
      const { task } = registry.create("index_document");
      const outcome = registry.cancel(task.id);
      expect(outcome).toBe("cancelled");
      const updated = registry.get(task.id);
      expect(updated?.status).toBe("cancelled");
      expect(updated?.completedAt).toBeInstanceOf(Date);
    });

    it("aborts the signal when cancelling a pending task", () => {
      const { task, signal } = registry.create("install_pack");
      registry.cancel(task.id);
      expect(signal.aborted).toBe(true);
    });

    it("returns already_terminal for a completed task", () => {
      const { task } = registry.create("sync_connector");
      registry.update(task.id, { status: "completed", completedAt: new Date() });
      expect(registry.cancel(task.id)).toBe("already_terminal");
    });

    it("returns already_terminal for a failed task", () => {
      const { task } = registry.create("reindex_library");
      registry.update(task.id, { status: "failed", completedAt: new Date() });
      expect(registry.cancel(task.id)).toBe("already_terminal");
    });

    it("returns already_terminal for an already cancelled task", () => {
      const { task } = registry.create("index_document");
      registry.cancel(task.id);
      expect(registry.cancel(task.id)).toBe("already_terminal");
    });

    it("aborts the signal when cancelling a running task", () => {
      const { task, signal } = registry.create("reindex_library");
      registry.update(task.id, { status: "running", startedAt: new Date() });
      const outcome = registry.cancel(task.id);
      expect(outcome).toBe("cancelled");
      expect(signal.aborted).toBe(true);
      // Running tasks update their own status asynchronously; status remains "running" until they detect abort
      expect(registry.get(task.id)?.status).toBe("running");
    });
  });

  describe("TTL pruning", () => {
    it("does not prune tasks without a completedAt", () => {
      const { task } = registry.create("index_document");
      registry.update(task.id, { status: "running", startedAt: new Date() });
      // Simulate passage of time beyond TTL without setting completedAt
      expect(registry.get(task.id)).toBeDefined();
    });

    it("prunes multiple expired tasks in one get call", () => {
      const { task: t1 } = registry.create("index_document");
      const { task: t2 } = registry.create("sync_connector");
      const expired = new Date(Date.now() - 61 * 60 * 1000);
      registry.update(t1.id, { status: "completed", completedAt: expired });
      registry.update(t2.id, { status: "failed", completedAt: expired });
      // Trigger prune via a get call
      registry.get("any-id");
      expect(registry.get(t1.id)).toBeUndefined();
      expect(registry.get(t2.id)).toBeUndefined();
    });
  });

  describe("async task lifecycle simulation", () => {
    it("transitions through pending -> running -> completed", () => {
      const { task, signal } = registry.create("reindex_library");
      expect(task.status).toBe("pending");

      registry.update(task.id, { status: "running", startedAt: new Date() });
      expect(registry.get(task.id)?.status).toBe("running");

      // Simulate progress updates
      registry.update(task.id, { progress: { current: 25, total: 100 } });
      expect(registry.get(task.id)?.progress?.current).toBe(25);

      registry.update(task.id, {
        status: "completed",
        completedAt: new Date(),
        result: "Reindex complete. Total: 100",
        progress: { current: 100, total: 100 },
      });

      const completed = registry.get(task.id);
      expect(completed?.status).toBe("completed");
      expect(completed?.result).toContain("Reindex complete");
      expect(signal.aborted).toBe(false);
    });

    it("transitions through pending -> running -> failed", () => {
      const { task } = registry.create("install_pack");
      registry.update(task.id, { status: "running", startedAt: new Date() });
      registry.update(task.id, {
        status: "failed",
        completedAt: new Date(),
        error: "Connection timeout",
      });
      const failed = registry.get(task.id);
      expect(failed?.status).toBe("failed");
      expect(failed?.error).toBe("Connection timeout");
    });

    it("running task detects cancellation via signal.aborted", async () => {
      const { task, signal } = registry.create("sync_connector");
      registry.update(task.id, { status: "running", startedAt: new Date() });

      let detectedAbort = false;
      const worker = new Promise<void>((resolve) => {
        // Simulate a worker that checks signal.aborted
        const interval = setInterval(() => {
          if (signal.aborted) {
            detectedAbort = true;
            clearInterval(interval);
            registry.update(task.id, { status: "cancelled", completedAt: new Date() });
            resolve();
          }
        }, 10);
      });

      registry.cancel(task.id);
      await worker;

      expect(detectedAbort).toBe(true);
      expect(registry.get(task.id)?.status).toBe("cancelled");
    });
  });
});

describe("taskRegistry singleton", () => {
  it("exports a module-level TaskRegistry instance", async () => {
    const { taskRegistry } = await import("../../src/mcp/tasks.js");
    expect(taskRegistry).toBeInstanceOf(TaskRegistry);
  });
});
