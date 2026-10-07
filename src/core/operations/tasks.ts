import { z } from "zod";
import { NotFoundError } from "../../errors.js";
import { taskRegistry, type Task } from "../tasks.js";
import { defineOperation } from "./types.js";

const taskId = z.string().min(1).describe("Task ID returned when a background task started");

function requireTask(id: string): Task {
  const task = taskRegistry.get(id);
  if (!task) {
    throw new NotFoundError(
      `Task ${id} not found or expired (finished tasks are kept for 1 hour)`,
      "TASK_NOT_FOUND",
    );
  }
  return task;
}

export const getTaskOperation = defineOperation({
  name: "get-task",
  group: "tasks",
  summary: "Status, progress and result of a background task",
  input: z.object({ taskId }),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/tasks/:taskId" },
  handler: (_ctx, input) => requireTask(input.taskId),
});

export const cancelTaskOperation = defineOperation({
  name: "cancel-task",
  group: "tasks",
  summary: "Request cancellation of a pending or running background task",
  input: z.object({ taskId }),
  annotations: { idempotent: true },
  http: { method: "POST", path: "/tasks/:taskId/cancel" },
  handler(_ctx, input) {
    const outcome = taskRegistry.cancel(input.taskId);
    const task = requireTask(input.taskId);
    return { taskId: input.taskId, cancelRequested: outcome === "cancelled", status: task.status };
  },
});

export const listTasksOperation = defineOperation({
  name: "list-tasks",
  group: "tasks",
  summary: "List background tasks from the last hour, newest first",
  input: z.object({}),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/tasks" },
  handler: () => ({ items: taskRegistry.list() }),
});

export const taskOperations = [getTaskOperation, cancelTaskOperation, listTasksOperation] as const;
