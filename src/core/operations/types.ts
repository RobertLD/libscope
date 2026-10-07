/**
 * The operation layer: every user-visible action is one Operation (name + zod input schema +
 * handler). The CLI, MCP server, REST API and SDK are thin adapters over these, so parameter
 * names, defaults, validation and docs are the same everywhere.
 */
import type Database from "better-sqlite3";
import { z } from "zod";
import type { LibScopeConfig } from "../../config.js";
import { ConfigError, ValidationError } from "../../errors.js";
import type { EmbeddingProvider } from "../../providers/embedding.js";
import type { Chunker } from "../indexing.js";
import { createLlmProvider, isPassthroughMode, type LlmProvider, type LlmSurface } from "../rag.js";
import { taskRegistry, type Task } from "../tasks.js";

export type Surface = LlmSurface;

export type OperationGroup =
  | "documents"
  | "search"
  | "links"
  | "tags"
  | "topics"
  | "searches"
  | "packs"
  | "connectors"
  | "admin"
  | "webhooks"
  | "tasks"
  | "analytics";

export interface ProgressEvent {
  done: number;
  total?: number | undefined;
  message?: string | undefined;
}

export interface OperationContext {
  db: Database.Database;
  provider: EmbeddingProvider;
  config: LibScopeConfig;
  surface: Surface;
  signal?: AbortSignal | undefined;
  onProgress?: ((p: ProgressEvent) => void) | undefined;
  /** Custom chunker used by `add` for inline content and local files (SDK only). */
  chunker?: Chunker | undefined;
  /** True when `ask` should return context for the caller to answer (passthrough). */
  isPassthrough(): boolean;
  /** The configured LLM provider, created on first use; null when none is configured. */
  getLlm(): LlmProvider | null;
}

export interface OperationAnnotations {
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  /** May take long enough that surfaces should offer to run it as a background task. */
  longRunning?: boolean;
}

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface Operation<S extends z.ZodObject = z.ZodObject, O = unknown> {
  /** kebab-case, unique, e.g. "get-document". */
  name: string;
  group: OperationGroup;
  /** One line, used by CLI help, MCP tool description and OpenAPI summary. */
  summary: string;
  description?: string;
  /** Input schema. Every field has .describe(); defaults live here only. */
  input: S;
  annotations?: OperationAnnotations;
  /** REST mapping; `:name` path segments are filled from input fields of the same name. */
  http?: { method: HttpMethod; path: string };
  handler(ctx: OperationContext, input: z.output<S>): Promise<O> | O;
}

/** Identity function that keeps the schema and result types of an operation. */
export function defineOperation<S extends z.ZodObject, O>(op: Operation<S, O>): Operation<S, O> {
  return op;
}

/** "field: message; field: message" for a failed parse. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/** Validate `rawInput` against the operation's schema. ZodError -> ValidationError. */
export function parseOperationInput<S extends z.ZodObject>(
  op: Operation<S, unknown>,
  rawInput: unknown,
): z.output<S> {
  const parsed = op.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw new ValidationError(`Invalid input for ${op.name}: ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

/** Validate `rawInput` against the operation's schema and run it. ZodError -> ValidationError. */
export async function runOperation<S extends z.ZodObject, O>(
  op: Operation<S, O>,
  ctx: OperationContext,
  rawInput: unknown,
): Promise<O> {
  const input = parseOperationInput(op, rawInput);
  ctx.signal?.throwIfAborted();
  return op.handler(ctx, input);
}

/**
 * Validate input now, then run the operation as a background task in the shared task
 * registry. The task's signal and progress replace any in `ctx`. Returns the task; its
 * `result` is the JSON-encoded operation result.
 */
export function startOperationTask<S extends z.ZodObject, O>(
  op: Operation<S, O>,
  ctx: OperationContext,
  rawInput: unknown,
): Task {
  const input = parseOperationInput(op, rawInput);
  const { task } = taskRegistry.run(
    "operation",
    async (signal, onProgress) => {
      const result = await op.handler(
        {
          ...ctx,
          signal,
          onProgress: (p) => onProgress(p.done, p.total ?? 0),
        },
        input,
      );
      return JSON.stringify(result ?? null);
    },
    op.name,
  );
  return task;
}

export interface CreateContextOptions {
  db: Database.Database;
  provider: EmbeddingProvider;
  config: LibScopeConfig;
  surface: Surface;
  signal?: AbortSignal | undefined;
  onProgress?: ((p: ProgressEvent) => void) | undefined;
  chunker?: Chunker | undefined;
  /** Use this LLM instead of the configured one (null: none). */
  llm?: LlmProvider | null | undefined;
}

/** Build an OperationContext. The LLM is created from config on first `getLlm()` call. */
export function createOperationContext(options: CreateContextOptions): OperationContext {
  const { llm: injected, ...rest } = options;
  let llm: LlmProvider | null | undefined = injected;
  return {
    ...rest,
    isPassthrough: (): boolean =>
      injected === undefined && isPassthroughMode(options.config, { surface: options.surface }),
    getLlm: (): LlmProvider | null => {
      if (llm !== undefined) return llm;
      try {
        llm = createLlmProvider(options.config, { surface: options.surface });
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
        llm = null;
      }
      return llm;
    },
  };
}

/** Result shape of every list operation. */
export interface ListResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
