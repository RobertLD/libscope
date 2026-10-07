import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import type Database from "better-sqlite3";
import { createTestDb } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { insertDoc, insertChunk } from "../fixtures/helpers.js";
import { startWebServer, stopWebServer } from "../../src/web/server.js";
import { testConfig } from "./operations/helpers.js";

let db: Database.Database;
let provider: MockEmbeddingProvider;
let server: Server;
let baseUrl: string;

async function fetchJson(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(`${baseUrl}${path}`, init);
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    headers: res.headers,
  };
}

describe("web server", () => {
  beforeAll(async () => {
    db = createTestDb();
    provider = new MockEmbeddingProvider();

    // Seed data
    db.prepare("INSERT INTO topics (id, name) VALUES (?, ?)").run("ts", "TypeScript");
    insertDoc(db, "doc-1", "TS Intro", { topicId: "ts" });
    insertChunk(db, "c1", "doc-1", "TypeScript is a typed superset of JavaScript");
    insertDoc(db, "doc-2", "Node Guide");
    insertChunk(db, "c2", "doc-2", "Node.js runtime for server-side JavaScript");

    server = await startWebServer(
      { db, provider, config: testConfig() },
      { port: 0, host: "127.0.0.1" },
    );
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 3377;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await stopWebServer();
    db.close();
  });

  it("GET / returns HTML dashboard", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("LibScope");
  });

  it("GET /api/stats returns document, topic, and chunk counts", async () => {
    const { status, body } = await fetchJson("/api/stats");
    expect(status).toBe(200);
    expect(body.documentCount).toBe(2);
    expect(body.topicCount).toBe(1);
    expect(body.chunkCount).toBe(2);
  });

  it("GET /api/documents returns document list", async () => {
    const { status, body } = await fetchJson("/api/documents?limit=10");
    expect(status).toBe(200);
    const docs = body as unknown as Array<{ title: string }>;
    expect(Array.isArray(docs)).toBe(true);
    expect(docs.length).toBe(2);
    expect(docs[0]!.title).toBeDefined();
  });

  it("GET /api/documents/:id returns a single document", async () => {
    const { status, body } = await fetchJson("/api/documents/doc-1");
    expect(status).toBe(200);
    expect(body.id).toBe("doc-1");
    expect(body.title).toBe("TS Intro");
  });

  it("GET /api/documents/:id returns 404 for missing document", async () => {
    const { status, body } = await fetchJson("/api/documents/nonexistent");
    expect(status).toBe(404);
    expect(body.error).toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
  });

  it("GET /api/topics returns topic list with stats", async () => {
    const { status, body } = await fetchJson("/api/topics");
    expect(status).toBe(200);
    const topics = body as unknown as Array<{ id: string; documentCount: number }>;
    expect(Array.isArray(topics)).toBe(true);
    expect(topics.length).toBe(1);
    expect(topics[0]!.id).toBe("ts");
    expect(topics[0]!.documentCount).toBe(1);
  });

  it("GET /api/search?q=TypeScript returns search results", async () => {
    const { status, body } = await fetchJson("/api/search?q=TypeScript");
    expect(status).toBe(200);
    const results = (body as { results: Array<{ content: string }> }).results;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.content).toContain("TypeScript");
  });

  it("GET /api/search without q returns 400", async () => {
    const { status, body } = await fetchJson("/api/search");
    expect(status).toBe(400);
    expect(body.error).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("returns 404 for unknown routes", async () => {
    const { status, body } = await fetchJson("/api/unknown");
    expect(status).toBe(404);
    expect(body.error).toMatchObject({ code: "NOT_FOUND" });
  });

  it("DELETE /api/documents/:id deletes a document", async () => {
    insertDoc(db, "doc-del", "To Delete");
    const { status, body } = await fetchJson("/api/documents/doc-del", { method: "DELETE" });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const { status: s2 } = await fetchJson("/api/documents/doc-del");
    expect(s2).toBe(404);
  });

  it("GET /graph returns the graph page and /api/graph its data", async () => {
    const page = await fetch(`${baseUrl}/graph`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const { status, body } = await fetchJson("/api/graph?threshold=0.85&maxNodes=200&topic=ts");
    expect(status).toBe(200);
    const nodes = (body as { nodes: Array<{ id: string; type: string }> }).nodes;
    expect(nodes.filter((n) => n.type === "document").map((n) => n.id)).toEqual(["doc-1"]);
  });

  it("pages and filters the document list the way the dashboard asks", async () => {
    const { body } = await fetchJson("/api/documents?limit=20&offset=0&topic=ts");
    const docs = body as unknown as Array<{ id: string; sourceType: string; updatedAt: string }>;
    expect(docs.map((d) => d.id)).toEqual(["doc-1"]);
    expect(docs[0]!.updatedAt).toBeDefined();
    const { body: page2 } = await fetchJson("/api/documents?limit=1&offset=1");
    expect(page2 as unknown as unknown[]).toHaveLength(1);
  });

  it("sends no CORS allow-origin to other origins and no CSP", async () => {
    const res = await fetch(`${baseUrl}/api/stats`, { headers: { Origin: "http://evil.example" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("rejects a cross-origin DELETE and its preflight grants nothing", async () => {
    insertDoc(db, "doc-keep", "Keep me");
    const preflight = await fetch(`${baseUrl}/api/documents/doc-keep`, {
      method: "OPTIONS",
      headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "DELETE" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();

    const { status, body } = await fetchJson("/api/documents/doc-keep", {
      method: "DELETE",
      headers: { Origin: "http://evil.example" },
    });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ code: "FORBIDDEN_ORIGIN" });
    expect((await fetchJson("/api/documents/doc-keep")).status).toBe(200);
  });

  it("allows a same-origin DELETE", async () => {
    insertDoc(db, "doc-same", "Same origin");
    const { status } = await fetchJson("/api/documents/doc-same", {
      method: "DELETE",
      headers: { Origin: baseUrl },
    });
    expect(status).toBe(200);
  });
});
