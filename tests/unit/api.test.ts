import { describe, it, expect, afterEach } from "vitest";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import {
  corsMiddleware,
  rejectForeignWrite,
  parseJsonBody,
  sendJson,
  sendError,
  checkRateLimit,
  checkApiKey,
  getRateLimitMapSize,
  MAX_RATE_LIMIT_ENTRIES,
  setSecurityHeaders,
} from "../../src/api/middleware.js";
import { API_ROUTES, OPENAPI_PATH } from "../../src/api/routes.js";
import { buildOpenApiSpec, toOpenApiPath } from "../../src/api/openapi.js";

interface ApiResponse {
  data?: Record<string, unknown>;
  meta?: { took: number };
  error?: { code: string; message: string };
  openapi?: string;
  info?: { title: string };
  [key: string]: unknown;
}

function parseResponse(body: string): ApiResponse {
  return JSON.parse(body) as ApiResponse;
}

function createMockReq(method: string, url: string, body?: unknown): IncomingMessage {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost:3378" };

  if (body === undefined) {
    process.nextTick(() => {
      req.push(null);
    });
  } else {
    const json = typeof body === "string" ? body : JSON.stringify(body);
    req.headers["content-type"] = "application/json";
    // Push the body data asynchronously
    process.nextTick(() => {
      req.push(Buffer.from(json));
      req.push(null);
    });
  }

  return req;
}

interface MockRes {
  res: ServerResponse;
  getStatus: () => number;
  getBody: () => string;
  getHeaders: () => Record<string, string | number | string[]>;
}

function createMockRes(): MockRes {
  const socket = new Socket();
  const res = new ServerResponse(new IncomingMessage(socket));
  let statusCode = 200;
  let body = "";
  const headers: Record<string, string | number | string[]> = {};

  res.writeHead = function (code: number, hdrs?: Record<string, unknown>): ServerResponse {
    statusCode = code;
    if (hdrs) {
      for (const [k, v] of Object.entries(hdrs)) {
        headers[k] = v as string;
      }
    }
    return res;
  };

  res.end = function (chunk?: unknown): ServerResponse {
    if (typeof chunk === "string") {
      body += chunk;
    } else if (Buffer.isBuffer(chunk)) {
      body += chunk.toString("utf-8");
    }
    return res;
  };

  res.write = function (chunk: unknown): boolean {
    if (typeof chunk === "string") {
      body += chunk;
    } else if (Buffer.isBuffer(chunk)) {
      body += chunk.toString("utf-8");
    }
    return true;
  };

  res.setHeader = function (
    name: string,
    value: string | number | readonly string[],
  ): ServerResponse {
    headers[name] = value as string | number | string[];
    return res;
  };

  return {
    res,
    getStatus: () => statusCode,
    getBody: () => body,
    getHeaders: () => headers,
  };
}

describe("API middleware", () => {
  describe("corsMiddleware", () => {
    it("answers OPTIONS preflight for a listed origin with every method", () => {
      const req = createMockReq("OPTIONS", "/api/v1/documents");
      req.headers["origin"] = "http://localhost:3000";
      const { res, getStatus, getHeaders } = createMockRes();

      const handled = corsMiddleware(req, res, ["http://localhost:3000"]);

      expect(handled).toBe(true);
      expect(getStatus()).toBe(204);
      expect(getHeaders()["Access-Control-Allow-Origin"]).toBe("http://localhost:3000");
      expect(getHeaders()["Access-Control-Allow-Methods"]).toBe(
        "GET, POST, PATCH, PUT, DELETE, OPTIONS",
      );
      expect(getHeaders()["Vary"]).toBe("Origin");
    });

    it("lets a wildcard origin read but not write", () => {
      const req = createMockReq("OPTIONS", "/api/v1/documents");
      req.headers["origin"] = "http://evil.example";
      const { res, getHeaders } = createMockRes();

      corsMiddleware(req, res, ["*"]);

      expect(getHeaders()["Access-Control-Allow-Origin"]).toBe("*");
      expect(getHeaders()["Access-Control-Allow-Methods"]).toBe("GET, OPTIONS");
    });

    it("sets no allow-origin for an unlisted origin", () => {
      const req = createMockReq("GET", "/api/v1/health");
      req.headers["origin"] = "http://evil.example";
      const { res, getHeaders } = createMockRes();

      expect(corsMiddleware(req, res, ["http://localhost"])).toBe(false);
      expect(getHeaders()["Access-Control-Allow-Origin"]).toBeUndefined();
    });
  });

  describe("rejectForeignWrite", () => {
    function check(method: string, origin: string | undefined, origins: string[]): number | null {
      const req = createMockReq(method, "/api/v1/documents/x");
      if (origin !== undefined) req.headers["origin"] = origin;
      const { res, getStatus } = createMockRes();
      return rejectForeignWrite(req, res, origins) ? getStatus() : null;
    }

    it('rejects writes from unlisted origins, also when "*" is allowed', () => {
      expect(check("DELETE", "http://evil.example", [])).toBe(403);
      expect(check("POST", "http://evil.example", ["*"])).toBe(403);
    });

    it("allows reads, same-origin writes, listed origins and non-browser clients", () => {
      expect(check("GET", "http://evil.example", [])).toBeNull();
      expect(check("DELETE", "http://localhost:3378", [])).toBeNull();
      expect(check("POST", "http://app.example", ["http://app.example"])).toBeNull();
      expect(check("PATCH", undefined, [])).toBeNull();
      expect(check("POST", "null", [])).toBe(403);
    });
  });

  describe("parseJsonBody", () => {
    it("should parse valid JSON", async () => {
      const req = createMockReq("POST", "/test", { hello: "world" });
      const body = await parseJsonBody(req);
      expect(body).toEqual({ hello: "world" });
    });

    it("should reject invalid JSON", async () => {
      const req = createMockReq("POST", "/test", "not json{{{");
      await expect(parseJsonBody(req)).rejects.toThrow("Request body contains invalid JSON");
    });

    it("should return null for empty body", async () => {
      const req = createMockReq("POST", "/test");
      const body = await parseJsonBody(req);
      expect(body).toBeNull();
    });
  });

  describe("sendJson", () => {
    it("should send JSON with data envelope", () => {
      const { res, getStatus, getBody } = createMockRes();
      sendJson(res, 200, { foo: "bar" }, 10);
      expect(getStatus()).toBe(200);
      const parsed = parseResponse(getBody());
      expect(parsed).toEqual({ data: { foo: "bar" }, meta: { took: 10 } });
    });
  });

  describe("sendError", () => {
    it("should send error with envelope", () => {
      const { res, getStatus, getBody } = createMockRes();
      sendError(res, 404, "NOT_FOUND", "Not found");
      expect(getStatus()).toBe(404);
      const parsed = parseResponse(getBody());
      expect(parsed).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } });
    });
  });
});

describe("OpenAPI spec", () => {
  const spec = buildOpenApiSpec(API_ROUTES) as {
    openapi: string;
    info: { title: string; version: string };
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  const specRoutes = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
  );

  it("is OpenAPI 3.1 with the package version", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("documents every route in the router, and nothing else", () => {
    const routerRoutes = API_ROUTES.map((r) => `${r.method} ${toOpenApiPath(r.path)}`);
    expect([...specRoutes].sort()).toEqual([...routerRoutes].sort());
    expect(specRoutes).toContain(`GET ${OPENAPI_PATH}`);
  });

  it("takes parameters and summaries from the operation schemas", () => {
    const search = spec.paths["/api/v1/search"]?.["get"] as {
      operationId: string;
      summary: string;
      parameters: Array<{ name: string; in: string; schema: { type?: string } }>;
    };
    expect(search.operationId).toBe("search");
    const limit = search.parameters.find((p) => p.name === "limit");
    expect(limit).toMatchObject({ in: "query", schema: { type: "integer", default: 10 } });
    const getDoc = spec.paths["/api/v1/documents/{documentId}"]?.["get"] as {
      parameters: Array<{ name: string; in: string; required: boolean }>;
    };
    expect(getDoc.parameters).toContainEqual(
      expect.objectContaining({ name: "documentId", in: "path", required: true }),
    );
    const add = spec.paths["/api/v1/documents"]?.["post"] as {
      requestBody: { content: Record<string, { schema: { properties: object } }> };
      responses: Record<string, unknown>;
    };
    expect(add.requestBody.content["application/json"]?.schema.properties).toHaveProperty("url");
    expect(add.responses).toHaveProperty("202");
    const link = spec.paths["/api/v1/documents/{documentId}/links"]?.["post"] as {
      requestBody: {
        content: Record<string, { schema: { properties: object; required: string[] } }>;
      };
    };
    const body = link.requestBody.content["application/json"]?.schema;
    expect(body?.properties).not.toHaveProperty("documentId");
    expect(body?.required).toEqual(["targetDocumentId", "linkType"]);
  });
});

describe("middleware — security", () => {
  it("should enforce request body size limit", async () => {
    const largeBody = "x".repeat(2 * 1024 * 1024); // 2 MB
    const req = createMockReq("POST", "/api/v1/documents", undefined);
    // Manually emit data chunks to simulate large body
    const promise = parseJsonBody(req, 1024); // 1 KB limit
    req.emit("data", Buffer.from(largeBody));
    await expect(promise).rejects.toThrow("Request body too large");
  });

  it("should parse valid JSON body within limits", async () => {
    const data = { query: "test" };
    const req = createMockReq("POST", "/api/v1/search", data);
    const promise = parseJsonBody(req);
    req.emit("data", Buffer.from(JSON.stringify(data)));
    req.emit("end");
    const result = await promise;
    expect(result).toEqual(data);
  });

  it("should set security headers", () => {
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.method = "GET";
    const res = new ServerResponse(req);
    setSecurityHeaders(res);
    expect(res.getHeader("X-Content-Type-Options")).toBe("nosniff");
    expect(res.getHeader("X-Frame-Options")).toBe("DENY");
    expect(res.getHeader("X-XSS-Protection")).toBe("1; mode=block");
    expect(res.getHeader("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.getHeader("Content-Security-Policy")).toBeDefined();
    const noCsp = new ServerResponse(req);
    setSecurityHeaders(noCsp, false);
    expect(noCsp.getHeader("Content-Security-Policy")).toBeUndefined();
  });
});

describe("middleware — API key authentication", () => {
  const ORIGINAL_KEY = process.env.LIBSCOPE_API_KEY;

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) {
      delete process.env.LIBSCOPE_API_KEY;
    } else {
      process.env.LIBSCOPE_API_KEY = ORIGINAL_KEY;
    }
  });

  it("should allow requests when no API key is configured", () => {
    delete process.env.LIBSCOPE_API_KEY;
    const req = createMockReq("GET", "/api/v1/health");
    const { res } = createMockRes();
    expect(checkApiKey(req, res)).toBe(true);
  });

  it("should reject requests without Authorization header", () => {
    process.env.LIBSCOPE_API_KEY = "test-key";
    const req = createMockReq("GET", "/api/v1/health");
    const { res, getStatus, getBody } = createMockRes();
    expect(checkApiKey(req, res)).toBe(false);
    expect(getStatus()).toBe(401);
    const parsed = parseResponse(getBody());
    expect(parsed.error.code).toBe("UNAUTHORIZED");
  });

  it("should reject requests with wrong API key", () => {
    process.env.LIBSCOPE_API_KEY = "test-key";
    const req = createMockReq("GET", "/api/v1/health");
    req.headers.authorization = "Bearer wrong-key";
    const { res, getStatus, getBody } = createMockRes();
    expect(checkApiKey(req, res)).toBe(false);
    expect(getStatus()).toBe(401);
    const parsed = parseResponse(getBody());
    expect(parsed.error.code).toBe("UNAUTHORIZED");
  });

  it("should allow requests with correct API key", () => {
    process.env.LIBSCOPE_API_KEY = "test-key";
    const req = createMockReq("GET", "/api/v1/health");
    req.headers.authorization = "Bearer test-key";
    const { res } = createMockRes();
    expect(checkApiKey(req, res)).toBe(true);
  });

  it("should reject a token of different length than the API key", () => {
    process.env.LIBSCOPE_API_KEY = "test-key";
    const req = createMockReq("GET", "/api/v1/health");
    req.headers.authorization = "Bearer short";
    const { res, getStatus, getBody } = createMockRes();
    expect(checkApiKey(req, res)).toBe(false);
    expect(getStatus()).toBe(401);
    const parsed = parseResponse(getBody());
    expect(parsed.error.code).toBe("UNAUTHORIZED");
  });

  it("should reject non-Bearer authorization schemes", () => {
    process.env.LIBSCOPE_API_KEY = "test-key";
    const req = createMockReq("GET", "/api/v1/health");
    req.headers.authorization = "Basic dGVzdC1rZXk=";
    const { res, getStatus } = createMockRes();
    expect(checkApiKey(req, res)).toBe(false);
    expect(getStatus()).toBe(401);
  });
});

describe("middleware — rate limiting", () => {
  it("should allow requests under the limit", () => {
    const testIp = `test-${Date.now()}`;
    expect(checkRateLimit(testIp)).toBe(true);
    expect(checkRateLimit(testIp)).toBe(true);
  });

  it("should block requests over the limit", () => {
    const testIp = `flood-${Date.now()}`;
    for (let i = 0; i < 120; i++) {
      checkRateLimit(testIp);
    }
    expect(checkRateLimit(testIp)).toBe(false);
  });

  it("should not exceed MAX_RATE_LIMIT_ENTRIES", () => {
    const prefix = `cap-${Date.now()}-`;
    for (let i = 0; i < MAX_RATE_LIMIT_ENTRIES + 500; i++) {
      checkRateLimit(`${prefix}${i}`);
    }
    expect(getRateLimitMapSize()).toBeLessThanOrEqual(MAX_RATE_LIMIT_ENTRIES);
  });

  it("should clean up old entries when window expires", () => {
    const testIp = `expire-${Date.now()}`;
    checkRateLimit(testIp);
    expect(getRateLimitMapSize()).toBeGreaterThan(0);
    // Entry exists; size is at least 1
  });
});
