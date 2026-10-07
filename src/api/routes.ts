/**
 * REST routes. Every route under /api/v1 is generated from an operation that declares `http`;
 * the only hand-written routes are the OpenAPI document and the health check.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import {
  OPERATIONS,
  type HttpMethod,
  type Operation,
  type OperationContext,
} from "../core/operations/index.js";
import { HttpError, sendJson } from "./middleware.js";
import {
  decodeSegment,
  inputFromParams,
  readJsonObject,
  respondWithOperation,
  sendRequestError,
} from "./adapter.js";
import { buildOpenApiSpec } from "./openapi.js";

export const API_PREFIX = "/api/v1";
export const OPENAPI_PATH = "/openapi.json";
const TASKS_PATH = `${API_PREFIX}/tasks`;

export interface ApiRoute {
  method: HttpMethod;
  /** Full path with `:name` parameters, e.g. "/api/v1/documents/:documentId". */
  path: string;
  summary: string;
  /** The operation this route runs; absent for the fixed routes (spec, health). */
  operation?: Operation | undefined;
  /** Response for a fixed route (no envelope for the OpenAPI document). */
  respond?: ((res: ServerResponse, start: number) => void) | undefined;
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

let spec: Record<string, unknown> | undefined;

const FIXED_ROUTES: ApiRoute[] = [
  {
    method: "GET",
    path: OPENAPI_PATH,
    summary: "This OpenAPI document",
    respond: (res): void => {
      spec ??= buildOpenApiSpec(API_ROUTES);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(spec));
    },
  },
  {
    method: "GET",
    path: `${API_PREFIX}/health`,
    summary: "Liveness check (use GET /api/v1/overview for counts and index health)",
    respond: (res, start): void => sendJson(res, 200, { status: "ok" }, elapsed(start)),
  },
];

/** Every REST route: the fixed routes, then one per operation with an `http` mapping. */
export const API_ROUTES: readonly ApiRoute[] = [
  ...FIXED_ROUTES,
  ...OPERATIONS.flatMap((op): ApiRoute[] =>
    op.http
      ? [
          {
            method: op.http.method,
            path: `${API_PREFIX}${op.http.path}`,
            summary: op.summary,
            operation: op,
          },
        ]
      : [],
  ),
];

interface CompiledRoute {
  route: ApiRoute;
  parts: string[];
  paramCount: number;
}

const COMPILED: CompiledRoute[] = API_ROUTES.map((route) => {
  const parts = route.path.split("/").filter(Boolean);
  return { route, parts, paramCount: parts.filter((p) => p.startsWith(":")).length };
});

/** Path parameters when `segments` match `parts`, else null. */
function matchParts(parts: string[], segments: string[]): Record<string, string> | null {
  if (parts.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (const [i, part] of parts.entries()) {
    const segment = segments[i] ?? "";
    if (part.startsWith(":")) params[part.slice(1)] = decodeSegment(segment);
    else if (part !== segment) return null;
  }
  return params;
}

/** The route for a request; literal segments win over parameters. */
export function matchRoute(
  method: string,
  pathname: string,
): { route: ApiRoute; params: Record<string, string> } | null {
  const segments = pathname.split("/").filter(Boolean);
  let best: { route: ApiRoute; params: Record<string, string>; paramCount: number } | null = null;
  for (const c of COMPILED) {
    if (c.route.method !== method || (best && best.paramCount <= c.paramCount)) continue;
    const params = matchParts(c.parts, segments);
    if (params) best = { route: c.route, params, paramCount: c.paramCount };
  }
  return best;
}

/** Input for an operation route: query string (GET, DELETE) or JSON body, plus path params. */
async function buildInput(
  op: Operation,
  req: IncomingMessage,
  url: URL,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const fromRequest =
    op.http?.method === "GET" || op.http?.method === "DELETE"
      ? inputFromParams(op, url.searchParams)
      : await readJsonObject(req);
  return { ...fromRequest, ...inputFromParams(op, params) };
}

/** Handle one REST request (after rate limiting, CORS and auth). */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: OperationContext,
): Promise<void> {
  const start = performance.now();
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  try {
    const match = matchRoute(method, url.pathname);
    // Same answer for unknown paths and wrong methods, so endpoints cannot be enumerated.
    if (!match) throw new HttpError(404, "NOT_FOUND", "Route not found");
    const { route, params } = match;
    if (route.respond) {
      route.respond(res, start);
      return;
    }
    const op = route.operation;
    if (!op) throw new HttpError(404, "NOT_FOUND", "Route not found");
    const input = await buildInput(op, req, url, params);
    const result = await respondWithOperation(op, ctx, input, TASKS_PATH);
    if (result.location) res.setHeader("Location", result.location);
    sendJson(res, result.status, result.data, elapsed(start));
  } catch (err) {
    sendRequestError(res, err, { method, pathname: url.pathname });
  }
}
