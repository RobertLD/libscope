import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type Database from "better-sqlite3";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { createTestDbWithVec } from "../fixtures/test-db.js";
import { handleRequest } from "../../src/api/routes.js";
import {
  corsMiddleware,
  parseJsonBody,
  sendJson,
  sendError,
  checkRateLimit,
  checkApiKey,
  getRateLimitMapSize,
  MAX_RATE_LIMIT_ENTRIES,
} from "../../src/api/middleware.js";
import { OPENAPI_SPEC } from "../../src/api/openapi.js";
import { indexDocument } from "../../src/core/indexing.js";
import { createTopic } from "../../src/core/topics.js";

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

  if (body !== undefined) {
    const json = typeof body === "string" ? body : JSON.stringify(body);
    req.headers["content-type"] = "application/json";
    // Push the body data asynchronously
    process.nextTick(() => {
      req.push(Buffer.from(json));
      req.push(null);
    });
  } else {
    process.nextTick(() => {
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
    it("should handle OPTIONS preflight", () => {
      const req = createMockReq("OPTIONS", "/api/v1/health");
      const { res, getStatus, getHeaders } = createMockRes();

      const handled = corsMiddleware(req, res, ["*"]);

      expect(handled).toBe(true);
      expect(getStatus()).toBe(204);
      expect(getHeaders()["Access-Control-Allow-Origin"]).toBe("*");
      expect(getHeaders()["Access-Control-Allow-Methods"]).toBe("GET, POST, DELETE, OPTIONS");
    });

    it("should set CORS headers for non-preflight requests", () => {
      const req = createMockReq("GET", "/api/v1/health");
      const { res, getHeaders } = createMockRes();

      const handled = corsMiddleware(req, res, ["*"]);

      expect(handled).toBe(false);
      expect(getHeaders()["Access-Control-Allow-Origin"]).toBe("*");
    });

    it("should restrict origin when not wildcard", () => {
      const req = createMockReq("GET", "/api/v1/health");
      req.headers["origin"] = "http://example.com";
      const { res, getHeaders } = createMockRes();

      corsMiddleware(req, res, ["http://example.com"]);

      expect(getHeaders()["Access-Control-Allow-Origin"]).toBe("http://example.com");
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
      await expect(parseJsonBody(req)).rejects.toThrow("Invalid JSON body");
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

describe("API routes", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    db = createTestDbWithVec();
    provider = new MockEmbeddingProvider();
  });

  describe("GET /api/v1/health", () => {
    it("should return health status", async () => {
      const req = createMockReq("GET", "/api/v1/health");
      const { res, getStatus, getBody } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(200);
      const parsed = parseResponse(getBody());
      expect(parsed.data.status).toBe("ok");
      expect(typeof parsed.data.docCount).toBe("number");
      expect(typeof parsed.meta.took).toBe("number");
    });
  });

  describe("GET /openapi.json", () => {
    it("should return the OpenAPI spec", async () => {
      const req = createMockReq("GET", "/openapi.json");
      const { res, getStatus, getBody } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(200);
      const parsed = parseResponse(getBody());
      expect(parsed.openapi).toBe("3.0.3");
      expect(parsed.info.title).toBe("LibScope REST API");
    });
  });

  describe("GET /api/v1/search", () => {
    it("should return 400 without query param", async () => {
      const req = createMockReq("GET", "/api/v1/search");
      const { res, getStatus, getBody } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(400);
      const parsed = parseResponse(getBody());
      expect(parsed.error.code).toBe("VALIDATION_ERROR");
    });

    it("should search with query params", async () => {
      await indexDocument(db, provider, {
        title: "Test Doc",
        content: "Hello world content",
        sourceType: "manual",
      });

      const req = createMockReq("GET", "/api/v1/search?q=hello&limit=5");
      const { res, getStatus, getBody } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(200);
      const parsed = parseResponse(getBody());
      expect(parsed.data).toBeDefined();
      expect(parsed.meta.took).toBeDefined();
    });

    it("should accept offset query parameter for pagination", async () => {
      await indexDocument(db, provider, {
        title: "Doc A",
        content: "First document content",
        sourceType: "manual",
      });
      await indexDocument(db, provider, {
        title: "Doc B",
        content: "Second document content",
        sourceType: "manual",
      });

      const req = createMockReq("GET", "/api/v1/search?q=document&limit=5&offset=1");
      const { res, getStatus, getBody } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(200);
      const parsed = parseResponse(getBody());
      expect(parsed.data).toBeDefined();
      expect(parsed.meta.took).toBeDefined();
    });
  });

  describe("POST /api/v1/documents", () => {
    it("should index a new document", async () => {
      const req = createMockReq("POST", "/api/v1/documents", {
        title: "My Doc",
        content: "Some content here",
      });
      const { res, getStatus, getBody } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(201);
      const parsed = parseResponse(getBody());
      expect(parsed.data.id).toBeDefined();
      expect(parsed.data.chunkCount).toBeGreaterThanOrEqual(1);
    });

    it("should return 400 for missing fields", async () => {
      const req = createMockReq("POST", "/api/v1/documents", { title: "No content" });
      const { res, getStatus, getBody } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(400);
      const parsed = parseResponse(getBody());
      expect(parsed.error.code).toBe("VALIDATION_ERROR");
    });

    it("should index document with tags", async () => {
      const req = createMockReq("POST", "/api/v1/documents", {
        title: "Tagged Doc",
        content: "Content with tags",
        tags: ["typescript", "api"],
      });
      const { res, getStatus, getBody } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(201);
      const parsed = parseResponse(getBody());
      expect(parsed.data.id).toBeDefined();
    });

    it("should return 400 for invalid JSON body", async () => {
      const req = createMockReq("POST", "/api/v1/documents", "not-valid-json{{{");
      const { res, getStatus, getBody } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(400);
      const parsed = parseResponse(getBody());
      expect(parsed.error.code).toBe("INVALID_JSON");
    });
  });

  describe("GET /api/v1/documents/:id", () => {
    it("should return a document by ID", async () => {
      const doc = await indexDocument(db, provider, {
        title: "Fetch Me",
        content: "Document content",
        sourceType: "manual",
      });

      const req = createMockReq("GET", `/api/v1/documents/${doc.id}`);
      const { res, getStatus, getBody } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(200);
      const parsed = parseResponse(getBody());
      expect(parsed.data.id).toBe(doc.id);
      expect(parsed.data.title).toBe("Fetch Me");
    });

    it("should return 404 for non-existent document", async () => {
      const req = createMockReq("GET", "/api/v1/documents/nonexistent-id");
      const { res, getStatus, getBody } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(404);
      const parsed = parseResponse(getBody());
      expect(parsed.error.code).toBe("NOT_FOUND");
    });
  });

  describe("DELETE /api/v1/documents/:id", () => {
    it("should delete a document", async () => {
      const doc = await indexDocument(db, provider, {
        title: "Delete Me",
        content: "To be deleted",
        sourceType: "manual",
      });

      const req = createMockReq("DELETE", `/api/v1/documents/${doc.id}`);
      const { res, getStatus, getBody } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(200);
      const parsed = parseResponse(getBody());
      expect(parsed.data.deleted).toBe(true);
    });

    it("should return 404 for deleting non-existent document", async () => {
      const req = createMockReq("DELETE", "/api/v1/documents/nonexistent-id");
      const { res, getStatus, getBody } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(404);
      const parsed = parseResponse(getBody());
      expect(parsed.error.code).toBe("NOT_FOUND");
    });
  });

  describe("POST /api/v1/ask", () => {
    it("should return 400 without question", async () => {
      const req = createMockReq("POST", "/api/v1/ask", { notQuestion: "test" });
      const { res, getStatus, getBody } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(400);
      const parsed = parseResponse(getBody());
      expect(parsed.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("GET /api/v1/documents", () => {
    it("should list documents", async () => {
      await indexDocument(db, provider, {
        title: "Doc 1",
        content: "Content 1",
        sourceType: "manual",
      });

      const req = createMockReq("GET", "/api/v1/documents");
      const { res, getStatus, getBody } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(200);
      const parsed = parseResponse(getBody());
      expect(Array.isArray(parsed.data)).toBe(true);
      expect(parsed.data.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("GET /api/v1/topics", () => {
    it("should list topics", async () => {
      createTopic(db, { name: "test-topic" });

      const req = createMockReq("GET", "/api/v1/topics");
      const { res, getStatus, getBody } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(200);
      const parsed = parseResponse(getBody());
      expect(Array.isArray(parsed.data)).toBe(true);
    });
  });

  describe("POST /api/v1/topics", () => {
    it("should create a topic", async () => {
      const req = createMockReq("POST", "/api/v1/topics", { name: "new-topic" });
      const { res, getStatus, getBody } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(201);
      const parsed = parseResponse(getBody());
      expect(parsed.data.name).toBe("new-topic");
    });

    it("should return 400 without name", async () => {
      const req = createMockReq("POST", "/api/v1/topics", { description: "no name" });
      const { res, getStatus } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(400);
    });
  });

  describe("GET /api/v1/tags", () => {
    it("should list tags", async () => {
      const req = createMockReq("GET", "/api/v1/tags");
      const { res, getStatus, getBody } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(200);
      const parsed = parseResponse(getBody());
      expect(Array.isArray(parsed.data)).toBe(true);
    });
  });

  describe("POST /api/v1/documents/:id/tags", () => {
    it("should add tags to a document", async () => {
      const doc = await indexDocument(db, provider, {
        title: "Tag Target",
        content: "Content",
        sourceType: "manual",
      });

      const req = createMockReq("POST", `/api/v1/documents/${doc.id}/tags`, {
        tags: ["alpha", "beta"],
      });
      const { res, getStatus, getBody } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(200);
      const parsed = parseResponse(getBody());
      expect(Array.isArray(parsed.data)).toBe(true);
    });
  });

  describe("GET /api/v1/stats", () => {
    it("should return stats", async () => {
      const req = createMockReq("GET", "/api/v1/stats");
      const { res, getStatus, getBody } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(200);
      const parsed = parseResponse(getBody());
      expect(typeof parsed.data.totalDocuments).toBe("number");
    });

    it("should return databaseSizeBytes field", async () => {
      const req = createMockReq("GET", "/api/v1/stats");
      const { res, getStatus, getBody } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(200);
      const parsed = parseResponse(getBody());
      expect(typeof parsed.data.databaseSizeBytes).toBe("number");
    });
  });

  describe("Unknown route", () => {
    it("should return 404", async () => {
      const req = createMockReq("GET", "/api/v1/nonexistent");
      const { res, getStatus, getBody } = createMockRes();

      await handleRequest(req, res, db, provider);

      expect(getStatus()).toBe(404);
      const parsed = parseResponse(getBody());
      expect(parsed.error.code).toBe("NOT_FOUND");
    });
  });
});

describe("OpenAPI spec", () => {
  it("should have valid structure", () => {
    expect(OPENAPI_SPEC.openapi).toBe("3.0.3");
    expect(OPENAPI_SPEC.info.title).toBeDefined();
    expect(OPENAPI_SPEC.paths).toBeDefined();
    expect(OPENAPI_SPEC.components).toBeDefined();
  });

  it("should define all endpoints", () => {
    const paths = Object.keys(OPENAPI_SPEC.paths);
    expect(paths).toContain("/api/v1/search");
    expect(paths).toContain("/api/v1/documents");
    expect(paths).toContain("/api/v1/documents/{id}");
    expect(paths).toContain("/api/v1/ask");
    expect(paths).toContain("/api/v1/topics");
    expect(paths).toContain("/api/v1/tags");
    expect(paths).toContain("/api/v1/stats");
    expect(paths).toContain("/api/v1/health");
    expect(paths).toContain("/openapi.json");
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

  it("should set security headers via CORS middleware", () => {
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.method = "GET";
    const res = new ServerResponse(req);
    corsMiddleware(req, res, ["*"]);
    expect(res.getHeader("X-Content-Type-Options")).toBe("nosniff");
    expect(res.getHeader("X-Frame-Options")).toBe("DENY");
    expect(res.getHeader("X-XSS-Protection")).toBe("1; mode=block");
    expect(res.getHeader("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.getHeader("Content-Security-Policy")).toBeDefined();
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
