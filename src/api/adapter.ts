/**
 * HTTP adapter over the operation layer, shared by the REST API and the dashboard server:
 * build an operation's input from a request, run it, and map errors to HTTP statuses.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  runOperation,
  startOperationTask,
  type Operation,
  type OperationContext,
} from "../core/operations/index.js";
import { ConfigError, FetchError, NotFoundError, ValidationError } from "../errors.js";
import { getLogger } from "../logger.js";
import { HttpError, parseJsonBody, sendError } from "./middleware.js";

/** The subset of JSON Schema the adapter and the OpenAPI generator read. */
export interface JsonSchema {
  type?: string | string[];
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  [key: string]: unknown;
}

const schemaCache = new WeakMap<Operation, JsonSchema>();

/** JSON Schema of an operation's input (what callers send), without the `$schema` key. */
export function inputJsonSchema(op: Operation): JsonSchema {
  let schema = schemaCache.get(op);
  if (!schema) {
    schema = {
      ...(z.toJSONSchema(op.input, { io: "input", unrepresentable: "any" }) as JsonSchema),
    };
    delete schema["$schema"];
    schemaCache.set(op, schema);
  }
  return schema;
}

/** The non-null branch of a nullable schema (zod writes `anyOf: [T, {type: "null"}]`). */
function nonNull(schema: JsonSchema | undefined): JsonSchema | undefined {
  if (!schema?.anyOf) return schema;
  return schema.anyOf.find((alt) => alt.type !== "null");
}

function coerceScalar(raw: string, schema: JsonSchema | undefined): unknown {
  const type = nonNull(schema)?.type;
  if (type === "integer" || type === "number") {
    const n = Number(raw);
    return raw.trim() !== "" && Number.isFinite(n) ? n : raw;
  }
  if (type === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
  }
  return raw;
}

/**
 * Operation input from URL values (query string or path parameters). Each value is converted
 * to the type the operation's schema expects: numbers and booleans are parsed, and array
 * fields take repeated parameters and/or comma-separated values (`tags=a,b` or `tags=a&tags=b`).
 * Values that do not convert are passed through so validation reports them.
 */
export function inputFromParams(
  op: Operation,
  params: URLSearchParams | Record<string, string>,
): Record<string, unknown> {
  const search = params instanceof URLSearchParams ? params : new URLSearchParams(params);
  const properties = inputJsonSchema(op).properties ?? {};
  const input: Record<string, unknown> = {};
  for (const name of new Set(search.keys())) {
    const schema = nonNull(properties[name]);
    if (schema?.type === "array") {
      input[name] = search
        .getAll(name)
        .flatMap((v) => v.split(","))
        .map((v) => v.trim())
        .filter((v) => v !== "")
        .map((v) => coerceScalar(v, schema.items));
    } else {
      input[name] = coerceScalar(search.get(name) ?? "", schema);
    }
  }
  return input;
}

/** A decoded URL path segment; a malformed escape is a 400. */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "VALIDATION_ERROR", "Malformed URL path");
  }
}

/** The JSON request body as an object ({} when empty). */
export async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await parseJsonBody(req);
  if (body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION_ERROR", "Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export interface OperationResponse {
  status: number;
  data: unknown;
  /** Set for a background task: where to poll it. */
  location?: string | undefined;
}

/**
 * Run an operation for an HTTP request. A long-running operation starts as a background task
 * and answers 202 with the task ID; poll `GET {tasksPath}/{taskId}`.
 */
export async function respondWithOperation(
  op: Operation,
  ctx: OperationContext,
  input: Record<string, unknown>,
  tasksPath: string,
): Promise<OperationResponse> {
  if (op.annotations?.longRunning) {
    const task = startOperationTask(op, ctx, input);
    return {
      status: 202,
      data: { taskId: task.id, operation: op.name, status: task.status },
      location: `${tasksPath}/${task.id}`,
    };
  }
  return { status: 200, data: await runOperation(op, ctx, input) };
}

/** HTTP status, code and client-safe message for an error thrown while handling a request. */
export function describeError(err: unknown): { status: number; code: string; message: string } {
  if (err instanceof HttpError) return { status: err.status, code: err.code, message: err.message };
  if (err instanceof ValidationError) return { status: 400, code: err.code, message: err.message };
  if (err instanceof NotFoundError) return { status: 404, code: err.code, message: err.message };
  if (err instanceof FetchError) return { status: 502, code: err.code, message: err.message };
  // Config problems (e.g. no LLM for ask) carry a hint the caller needs; other errors may leak
  // internals, so they get a generic message.
  if (err instanceof ConfigError) return { status: 500, code: err.code, message: err.message };
  return { status: 500, code: "INTERNAL_ERROR", message: "Internal server error" };
}

/** Log an error and send it as `{ error: { code, message } }`. */
export function sendRequestError(
  res: ServerResponse,
  err: unknown,
  request: { method: string; pathname: string },
): void {
  const { status, code, message } = describeError(err);
  const log = getLogger();
  if (status >= 500) log.error({ err, ...request }, "API request failed");
  else log.debug({ err, ...request }, "API request rejected");
  if (res.headersSent) {
    res.end();
    return;
  }
  sendError(res, status, code, message);
}
