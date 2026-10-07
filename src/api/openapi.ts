/**
 * OpenAPI 3.1 document generated from the REST routes. Operation routes take their summary,
 * description and parameter schemas from the operation (zod -> JSON Schema), so the spec
 * cannot drift from what the server accepts.
 */
import { createRequire } from "node:module";
import { inputJsonSchema, type JsonSchema } from "./adapter.js";
import type { ApiRoute } from "./routes.js";

const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

const ref = (name: string): { $ref: string } => ({ $ref: `#/components/responses/${name}` });

const ERROR_RESPONSES = {
  "400": ref("BadRequest"),
  "401": ref("Unauthorized"),
  "404": ref("NotFound"),
  "429": ref("RateLimited"),
  "500": ref("InternalError"),
};

const json = (schema: unknown): { "application/json": { schema: unknown } } => ({
  "application/json": { schema },
});

const SUCCESS = {
  description: "Success. `data` holds the operation result.",
  content: json({ $ref: "#/components/schemas/Success" }),
};

const TASK_ACCEPTED = {
  description:
    "Started as a background task. Poll GET /api/v1/tasks/{taskId}; when it completes, `result` holds the JSON-encoded operation result.",
  headers: { Location: { description: "URL of the task", schema: { type: "string" } } },
  content: json({ $ref: "#/components/schemas/TaskAccepted" }),
};

function errorResponse(description: string): Record<string, unknown> {
  return { description, content: json({ $ref: "#/components/schemas/Error" }) };
}

const COMPONENTS = {
  schemas: {
    Success: {
      type: "object",
      required: ["data"],
      properties: {
        data: { description: "Operation result" },
        meta: {
          type: "object",
          properties: { took: { type: "integer", description: "Handling time in milliseconds" } },
        },
      },
    },
    TaskAccepted: {
      type: "object",
      required: ["data"],
      properties: {
        data: {
          type: "object",
          required: ["taskId", "operation", "status"],
          properties: {
            taskId: { type: "string" },
            operation: { type: "string" },
            status: { type: "string", enum: ["pending", "running", "completed", "failed"] },
          },
        },
        meta: { $ref: "#/components/schemas/Success/properties/meta" },
      },
    },
    Error: {
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["code", "message"],
          properties: { code: { type: "string" }, message: { type: "string" } },
        },
      },
    },
  },
  responses: {
    BadRequest: errorResponse("Invalid input (code VALIDATION_ERROR or INVALID_JSON)"),
    Unauthorized: errorResponse("Missing or wrong API key (only when LIBSCOPE_API_KEY is set)"),
    NotFound: errorResponse("Route or resource not found"),
    RateLimited: errorResponse("More than 120 requests per minute from this address"),
    InternalError: errorResponse("Server error"),
  },
  securitySchemes: {
    bearerAuth: {
      type: "http",
      scheme: "bearer",
      description: "Required only when the server has LIBSCOPE_API_KEY set",
    },
  },
};

/** "/api/v1/documents/:documentId" -> "/api/v1/documents/{documentId}" */
export function toOpenApiPath(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment.startsWith(":") ? `{${segment.slice(1)}}` : segment))
    .join("/");
}

/** "get-document" -> "getDocument" */
function camelCase(name: string): string {
  return name
    .split("-")
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

function pathParamNames(path: string): string[] {
  return path
    .split("/")
    .filter((s) => s.startsWith(":"))
    .map((s) => s.slice(1));
}

function parameter(
  name: string,
  location: "path" | "query",
  schema: JsonSchema | undefined,
  required: boolean,
): Record<string, unknown> {
  const isArray = schema?.type === "array";
  return {
    name,
    in: location,
    required,
    ...(typeof schema?.description === "string" ? { description: schema.description } : {}),
    schema: schema ?? { type: "string" },
    ...(isArray ? { style: "form", explode: true } : {}),
  };
}

/** The OpenAPI operation object for a route generated from an operation. */
function operationObject(route: ApiRoute, op: NonNullable<ApiRoute["operation"]>): unknown {
  const schema = inputJsonSchema(op);
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const inPath = pathParamNames(route.path);
  const parameters = inPath.map((name) => parameter(name, "path", properties[name], true));
  const rest = Object.keys(properties).filter((name) => !inPath.includes(name));

  let requestBody: unknown;
  if (route.method === "GET" || route.method === "DELETE") {
    for (const name of rest) {
      parameters.push(parameter(name, "query", properties[name], required.has(name)));
    }
  } else if (rest.length > 0) {
    const bodyRequired = rest.filter((name) => required.has(name));
    requestBody = {
      required: bodyRequired.length > 0,
      content: json({
        type: "object",
        properties: Object.fromEntries(rest.map((name) => [name, properties[name]])),
        ...(bodyRequired.length > 0 ? { required: bodyRequired } : {}),
      }),
    };
  }

  return {
    operationId: camelCase(op.name),
    tags: [op.group],
    summary: op.summary,
    ...(op.description ? { description: op.description } : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses: {
      ...(op.annotations?.longRunning ? { "202": TASK_ACCEPTED } : { "200": SUCCESS }),
      ...ERROR_RESPONSES,
    },
  };
}

function fixedRouteObject(route: ApiRoute): unknown {
  return {
    operationId: route.path.endsWith(".json") ? "getOpenApiSpec" : "health",
    tags: ["meta"],
    summary: route.summary,
    responses: { "200": SUCCESS, "429": ERROR_RESPONSES["429"] },
  };
}

/** Build the OpenAPI document for `routes`. */
export function buildOpenApiSpec(routes: readonly ApiRoute[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const path = toOpenApiPath(route.path);
    paths[path] ??= {};
    paths[path][route.method.toLowerCase()] = route.operation
      ? operationObject(route, route.operation)
      : fixedRouteObject(route);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "LibScope REST API",
      version: pkg.version,
      description:
        "Every /api/v1 route runs one LibScope operation (the same operations as the CLI, MCP server and SDK). Responses are `{ data, meta }`; errors are `{ error: { code, message } }`. Long-running operations answer 202 with a task ID.",
    },
    servers: [{ url: "http://localhost:3378", description: "Default `libscope serve --api`" }],
    security: [{}, { bearerAuth: [] }],
    paths,
    components: COMPONENTS,
  };
}
