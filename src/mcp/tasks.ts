import { randomUUID } from "node:crypto";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type TaskType = "index_document" | "reindex_library" | "sync_connector" | "install_pack";

export interface TaskProgress {
  current: number;
  total: number;
  message?: string | undefined;
}

export interface Task {
  id: string;
  type: TaskType;
  status: TaskStatus;
  progress?: TaskProgress | undefined;
  result?: string | undefined;
  error?: string | undefined;
  createdAt: Date;
  startedAt?: Date | undefined;
  completedAt?: Date | undefined;
}

/** TTL for completed/failed/cancelled tasks before they are pruned (1 hour). */
const TASK_TTL_MS = 60 * 60 * 1000;

export class TaskRegistry {
  private readonly tasks = new Map<string, Task>();
  private readonly controllers = new Map<string, AbortController>();

  /** Create a new task and return it along with its AbortSignal. */
  create(type: TaskType): { task: Task; signal: AbortSignal } {
    const id = randomUUID();
    const task: Task = {
      id,
      type,
      status: "pending",
      createdAt: new Date(),
    };
    const controller = new AbortController();
    this.tasks.set(id, task);
    this.controllers.set(id, controller);
    return { task, signal: controller.signal };
  }

  /** Retrieve a task by ID. Returns undefined if not found or expired. */
  get(id: string): Task | undefined {
    this.prune();
    return this.tasks.get(id);
  }

  /** Apply partial updates to a task. No-op if task not found. */
  update(id: string, updates: Partial<Task>): void {
    const task = this.tasks.get(id);
    if (task) {
      Object.assign(task, updates);
    }
  }

  /**
   * Attempt to cancel a task.
   * Returns:
   *   "cancelled"        — cancellation was requested
   *   "not_found"        — task ID unknown or expired
   *   "already_terminal" — task already completed, failed, or cancelled
   */
  cancel(id: string): "cancelled" | "not_found" | "already_terminal" {
    this.prune();
    const task = this.tasks.get(id);
    if (!task) return "not_found";
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
      return "already_terminal";
    }
    this.controllers.get(id)?.abort();
    if (task.status === "pending") {
      task.status = "cancelled";
      task.completedAt = new Date();
    }
    // Running tasks detect abort via signal and update their own status.
    return "cancelled";
  }

  /** Remove expired completed/failed/cancelled tasks. */
  private prune(): void {
    const cutoff = Date.now() - TASK_TTL_MS;
    for (const [id, task] of this.tasks) {
      if (task.completedAt && task.completedAt.getTime() < cutoff) {
        this.tasks.delete(id);
        this.controllers.delete(id);
      }
    }
  }
}

/** Module-level singleton task registry used by the MCP server. */
export const taskRegistry = new TaskRegistry();
