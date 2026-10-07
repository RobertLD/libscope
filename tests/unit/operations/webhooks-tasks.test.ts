import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import { NotFoundError } from "../../../src/errors.js";
import { initLogger } from "../../../src/logger.js";
import { addDoc, expectValidationError, makeContext, run, type TestContext } from "./helpers.js";

vi.mock("node:dns", async (importOriginal) => {
  const actual: typeof import("node:dns") = await importOriginal();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      resolve4: vi.fn().mockResolvedValue(["93.184.216.34"]),
      resolve6: vi.fn().mockResolvedValue([]),
    },
  };
});

const ops = await import("../../../src/core/operations/index.js");

initLogger("silent");

describe("webhook and task operations", () => {
  let t: TestContext;

  beforeEach(() => {
    t = makeContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    t.db.close();
  });

  describe("webhooks", () => {
    it("creates, lists, tests and deletes a webhook", async () => {
      const created = await run(ops.createWebhookOperation, t.ctx, {
        url: "https://hooks.example.com/libscope",
        events: ["document.created"],
      });
      expect(created).not.toHaveProperty("secret");
      const listed = await run(ops.listWebhooksOperation, t.ctx, {});
      expect(listed.items.map((w) => w.id)).toEqual([created.id]);

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(null, { status: 204, statusText: "No Content" })),
      );
      const tested = await run(ops.testWebhookOperation, t.ctx, { webhookId: created.id });
      expect(tested).toMatchObject({ status: 204 });

      await run(ops.deleteWebhookOperation, t.ctx, { webhookId: created.id });
      expect((await run(ops.listWebhooksOperation, t.ctx, {})).items).toEqual([]);
    });

    it("rejects unknown events and non-http URLs", async () => {
      await expectValidationError(
        run(ops.createWebhookOperation, t.ctx, {
          url: "https://hooks.example.com",
          events: ["document.exploded"],
        }),
      );
      await expectValidationError(
        run(ops.createWebhookOperation, t.ctx, {
          url: "ftp://hooks.example.com",
          events: ["document.created"],
        }),
      );
    });

    it("throws NotFoundError for an unknown webhook", async () => {
      await expect(
        run(ops.deleteWebhookOperation, t.ctx, { webhookId: "nope" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(ops.testWebhookOperation, t.ctx, { webhookId: "nope" }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("tasks", () => {
    it("runs an operation as a background task and reports its result", async () => {
      await addDoc(t, "Counted");
      const task = ops.startOperationTask(ops.overviewOperation, t.ctx, {});
      expect(task.operation).toBe("overview");
      await vi.waitFor(() => {
        expect(ops.getTaskOperation.handler(t.ctx, { taskId: task.id }).status).toBe("completed");
      });
      const done = await run(ops.getTaskOperation, t.ctx, { taskId: task.id });
      expect(JSON.parse(done.result ?? "{}")).toMatchObject({ stats: { totalDocuments: 1 } });
      const listed = await run(ops.listTasksOperation, t.ctx, {});
      expect(listed.items.some((x) => x.id === task.id)).toBe(true);
      const cancel = await run(ops.cancelTaskOperation, t.ctx, { taskId: task.id });
      expect(cancel).toMatchObject({ cancelRequested: false, status: "completed" });
    });

    it("cancels a running task", async () => {
      const slow = ops.defineOperation({
        name: "slow",
        group: "admin",
        summary: "Waits until cancelled",
        input: z.object({}),
        handler: (ctx) =>
          new Promise((_resolve, reject) => {
            ctx.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      });
      const task = ops.startOperationTask(slow, t.ctx, {});
      const cancel = await run(ops.cancelTaskOperation, t.ctx, { taskId: task.id });
      expect(cancel.cancelRequested).toBe(true);
      await vi.waitFor(() => {
        expect(ops.getTaskOperation.handler(t.ctx, { taskId: task.id }).status).toBe("cancelled");
      });
    });

    it("validates input before starting a task", () => {
      expect(() => ops.startOperationTask(ops.reindexOperation, t.ctx, { batchSize: 0 })).toThrow(
        "Invalid input for reindex",
      );
    });

    it("rejects an empty task id and throws NotFoundError for an unknown one", async () => {
      await expectValidationError(run(ops.getTaskOperation, t.ctx, { taskId: "" }));
      await expect(run(ops.getTaskOperation, t.ctx, { taskId: "nope" })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(run(ops.cancelTaskOperation, t.ctx, { taskId: "nope" })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });
});
