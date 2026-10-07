import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { createTestDbWithVec } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { testConfig } from "./operations/helpers.js";
import { initLogger } from "../../src/logger.js";

// Saved connections live under a temp HOME, never the real ~/.libscope.
let tempHome = join(tmpdir(), `libscope-api-routes-${process.pid}`);
vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: (): string => tempHome };
});
// Webhook URLs resolve to a public address without network access.
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

const { API_ROUTES, handleRequest } = await import("../../src/api/routes.js");
const { createOperationContext } = await import("../../src/core/operations/index.js");
const { indexDocument } = await import("../../src/core/indexing.js");
const { updateDocument } = await import("../../src/core/documents.js");
const { createTopic } = await import("../../src/core/topics.js");
const { createLink } = await import("../../src/core/links.js");
const { createSavedSearch } = await import("../../src/core/saved-searches.js");
const { createWebhook } = await import("../../src/core/webhooks.js");
const { taskRegistry } = await import("../../src/core/tasks.js");
const { saveConnectorSettings } = await import("../../src/connectors/saved-config.js");

initLogger("silent");

interface Fixtures {
  docA: string;
  docB: string;
  linkId: string;
  webhookId: string;
  taskId: string;
}

interface Case {
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

interface RouteCases {
  ok: (f: Fixtures) => Case;
  /** Expected success status when not 200 (202 for background tasks). */
  okStatus?: number;
  /** A request that fails validation (400). Absent when no input can be invalid. */
  bad?: (f: Fixtures) => Case;
  /** A request naming a missing resource (404). */
  missing?: (f: Fixtures) => Case;
}

const V = "/api/v1";
const doc = (f: Fixtures, rest = ""): string => `${V}/documents/${f.docA}${rest}`;

/** One entry per route; the test below fails when a route has no entry. */
const CASES: Record<string, RouteCases> = {
  "GET /openapi.json": { ok: () => ({ path: "/openapi.json" }) },
  "GET /api/v1/health": { ok: () => ({ path: `${V}/health` }) },

  "POST /api/v1/documents": {
    ok: () => ({ path: `${V}/documents`, body: { title: "New", content: "New body text" } }),
    okStatus: 202,
    bad: () => ({ path: `${V}/documents`, body: { kind: "bogus" } }),
  },
  "GET /api/v1/documents/:documentId": {
    ok: (f) => ({ path: doc(f), query: { maxLength: "5" } }),
    bad: (f) => ({ path: doc(f), query: { offset: "-1" } }),
    missing: () => ({ path: `${V}/documents/nope` }),
  },
  "GET /api/v1/documents": {
    ok: () => ({ path: `${V}/documents`, query: { topic: "Guides", limit: "5" } }),
    bad: () => ({ path: `${V}/documents`, query: { limit: "0" } }),
  },
  "PATCH /api/v1/documents/:documentId": {
    ok: (f) => ({ path: doc(f), body: { title: "Renamed", tags: ["a", "b"] } }),
    bad: (f) => ({ path: doc(f), body: {} }),
    missing: () => ({ path: `${V}/documents/nope`, body: { title: "x" } }),
  },
  "DELETE /api/v1/documents/:documentId": {
    ok: (f) => ({ path: doc(f) }),
    missing: () => ({ path: `${V}/documents/nope` }),
  },
  "POST /api/v1/documents/:documentId/ratings": {
    ok: (f) => ({ path: doc(f, "/ratings"), body: { rating: 5 } }),
    bad: (f) => ({ path: doc(f, "/ratings"), body: { rating: 9 } }),
    missing: () => ({ path: `${V}/documents/nope/ratings`, body: { rating: 3 } }),
  },
  "GET /api/v1/documents/:documentId/versions": {
    ok: (f) => ({ path: doc(f, "/versions") }),
    missing: () => ({ path: `${V}/documents/nope/versions` }),
  },
  "POST /api/v1/documents/:documentId/rollback": {
    ok: (f) => ({ path: doc(f, "/rollback"), body: { version: 1 } }),
    bad: (f) => ({ path: doc(f, "/rollback"), body: { version: 0 } }),
    missing: () => ({ path: `${V}/documents/nope/rollback`, body: { version: 1 } }),
  },

  "GET /api/v1/search": {
    ok: () => ({ path: `${V}/search`, query: { query: "typescript", tags: "intro,guide" } }),
    bad: () => ({ path: `${V}/search` }),
  },
  "POST /api/v1/ask": {
    ok: () => ({ path: `${V}/ask`, body: { question: "What is TypeScript?" } }),
    bad: () => ({ path: `${V}/ask`, body: {} }),
  },

  "POST /api/v1/documents/:documentId/links": {
    ok: (f) => ({
      path: doc(f, "/links"),
      body: { targetDocumentId: f.docB, linkType: "references" },
    }),
    bad: (f) => ({ path: doc(f, "/links"), body: { targetDocumentId: f.docB, linkType: "x" } }),
    missing: (f) => ({
      path: `${V}/documents/nope/links`,
      body: { targetDocumentId: f.docB, linkType: "related" },
    }),
  },
  "DELETE /api/v1/links/:linkId": {
    ok: (f) => ({ path: `${V}/links/${f.linkId}` }),
    missing: () => ({ path: `${V}/links/nope` }),
  },
  "GET /api/v1/links": {
    ok: (f) => ({ path: `${V}/links`, query: { documentId: f.docA } }),
    bad: () => ({ path: `${V}/links`, query: { linkType: "bogus" } }),
    missing: () => ({ path: `${V}/links`, query: { documentId: "nope" } }),
  },
  "GET /api/v1/documents/:documentId/prerequisites": {
    ok: (f) => ({ path: doc(f, "/prerequisites") }),
    missing: () => ({ path: `${V}/documents/nope/prerequisites` }),
  },
  "GET /api/v1/graph": {
    ok: () => ({ path: `${V}/graph`, query: { threshold: "0.5", topic: "Guides" } }),
    bad: () => ({ path: `${V}/graph`, query: { threshold: "high" } }),
  },

  "POST /api/v1/documents/:documentId/tags": {
    ok: (f) => ({ path: doc(f, "/tags"), body: { tags: ["new"] } }),
    bad: (f) => ({ path: doc(f, "/tags"), body: { tags: [] } }),
    missing: () => ({ path: `${V}/documents/nope/tags`, body: { tags: ["x"] } }),
  },
  "DELETE /api/v1/documents/:documentId/tags": {
    ok: (f) => ({ path: doc(f, "/tags"), query: { tags: "intro" } }),
    bad: (f) => ({ path: doc(f, "/tags") }),
    missing: () => ({ path: `${V}/documents/nope/tags`, query: { tags: "intro" } }),
  },
  "GET /api/v1/tags": { ok: () => ({ path: `${V}/tags` }) },
  "GET /api/v1/documents/:documentId/suggested-tags": {
    ok: (f) => ({ path: doc(f, "/suggested-tags") }),
    bad: (f) => ({ path: doc(f, "/suggested-tags"), query: { limit: "0" } }),
    missing: () => ({ path: `${V}/documents/nope/suggested-tags` }),
  },

  "GET /api/v1/topics": {
    ok: () => ({ path: `${V}/topics` }),
    missing: () => ({ path: `${V}/topics`, query: { parent: "nope" } }),
  },
  "POST /api/v1/topics": {
    ok: () => ({ path: `${V}/topics`, body: { name: "Recipes" } }),
    bad: () => ({ path: `${V}/topics`, body: {} }),
  },
  "DELETE /api/v1/topics/:topic": {
    ok: () => ({ path: `${V}/topics/Guides` }),
    bad: () => ({ path: `${V}/topics/Guides`, query: { deleteDocuments: "maybe" } }),
    missing: () => ({ path: `${V}/topics/nope` }),
  },

  "POST /api/v1/searches": {
    ok: () => ({ path: `${V}/searches`, body: { name: "ts", query: "typescript" } }),
    bad: () => ({ path: `${V}/searches`, body: { name: "no query" } }),
  },
  "GET /api/v1/searches": {
    ok: () => ({ path: `${V}/searches` }),
    bad: () => ({ path: `${V}/searches`, query: { offset: "-1" } }),
  },
  "POST /api/v1/searches/:search/run": {
    ok: () => ({ path: `${V}/searches/saved/run` }),
    missing: () => ({ path: `${V}/searches/nope/run` }),
  },
  "DELETE /api/v1/searches/:search": {
    ok: () => ({ path: `${V}/searches/saved` }),
    missing: () => ({ path: `${V}/searches/nope` }),
  },

  "POST /api/v1/packs": {
    ok: () => ({ path: `${V}/packs`, body: { pack: "some-pack" } }),
    okStatus: 202,
    bad: () => ({ path: `${V}/packs`, body: { pack: "p", concurrency: 99 } }),
  },
  "DELETE /api/v1/packs/:pack": {
    ok: () => ({ path: `${V}/packs/demo-pack` }),
    missing: () => ({ path: `${V}/packs/nope` }),
  },
  "GET /api/v1/packs": {
    ok: () => ({ path: `${V}/packs` }),
    bad: () => ({ path: `${V}/packs`, query: { available: "maybe" } }),
    missing: () => ({ path: `${V}/packs`, query: { available: "true", registry: "nope" } }),
  },
  "GET /api/v1/registries": {
    ok: () => ({ path: `${V}/registries` }),
  },
  "GET /api/v1/registries/search": {
    ok: () => ({ path: `${V}/registries/search`, query: { query: "react" } }),
    bad: () => ({ path: `${V}/registries/search` }),
    missing: () => ({ path: `${V}/registries/search`, query: { query: "x", registry: "nope" } }),
  },

  "GET /api/v1/connections": { ok: () => ({ path: `${V}/connections` }) },
  "POST /api/v1/sync": {
    ok: () => ({ path: `${V}/sync`, body: { all: true } }),
    okStatus: 202,
    bad: () => ({ path: `${V}/sync`, body: { name: "bad name!" } }),
    missing: () => ({ path: `${V}/sync`, body: { name: "nope" } }),
  },
  "DELETE /api/v1/connections/:name": {
    ok: () => ({ path: `${V}/connections/notes` }),
    bad: () => ({ path: `${V}/connections/notes`, query: { type: "nope" } }),
    missing: () => ({ path: `${V}/connections/nope` }),
  },

  "GET /api/v1/overview": { ok: () => ({ path: `${V}/overview` }) },
  "POST /api/v1/admin/reindex": {
    ok: () => ({ path: `${V}/admin/reindex`, body: {} }),
    okStatus: 202,
    bad: () => ({ path: `${V}/admin/reindex`, body: { batchSize: 0 } }),
  },
  "GET /api/v1/admin/duplicates": {
    ok: () => ({ path: `${V}/admin/duplicates`, query: { strategy: "exact" } }),
    okStatus: 202,
    bad: () => ({ path: `${V}/admin/duplicates`, query: { threshold: "5" } }),
  },
  "POST /api/v1/admin/prune-expired": { ok: () => ({ path: `${V}/admin/prune-expired` }) },
  "POST /api/v1/bulk/delete": {
    ok: () => ({ path: `${V}/bulk/delete`, body: { topic: "Guides", dryRun: true } }),
    bad: () => ({ path: `${V}/bulk/delete`, body: { topic: "Guides", dryRun: "yes" } }),
    missing: () => ({ path: `${V}/bulk/delete`, body: { topic: "nope" } }),
  },
  "POST /api/v1/bulk/retag": {
    ok: () => ({ path: `${V}/bulk/retag`, body: { topic: "Guides", addTags: ["x"] } }),
    bad: () => ({ path: `${V}/bulk/retag`, body: { topic: "Guides", addTags: "x" } }),
    missing: () => ({ path: `${V}/bulk/retag`, body: { topic: "nope", addTags: ["x"] } }),
  },
  "POST /api/v1/bulk/move": {
    ok: () => ({ path: `${V}/bulk/move`, body: { library: "ts", targetTopic: "Guides" } }),
    bad: () => ({ path: `${V}/bulk/move`, body: { library: "ts" } }),
    missing: () => ({ path: `${V}/bulk/move`, body: { library: "ts", targetTopic: "nope" } }),
  },

  "GET /api/v1/analytics/popular": {
    ok: () => ({ path: `${V}/analytics/popular` }),
    bad: () => ({ path: `${V}/analytics/popular`, query: { limit: "many" } }),
  },
  "GET /api/v1/analytics/stale": {
    ok: () => ({ path: `${V}/analytics/stale`, query: { days: "7" } }),
    bad: () => ({ path: `${V}/analytics/stale`, query: { days: "0" } }),
  },
  "GET /api/v1/analytics/top-queries": {
    ok: () => ({ path: `${V}/analytics/top-queries` }),
    bad: () => ({ path: `${V}/analytics/top-queries`, query: { limit: "1000" } }),
  },
  "GET /api/v1/analytics/searches": {
    ok: () => ({ path: `${V}/analytics/searches` }),
    bad: () => ({ path: `${V}/analytics/searches`, query: { days: "-3" } }),
  },

  "POST /api/v1/webhooks": {
    ok: () => ({
      path: `${V}/webhooks`,
      body: { url: "https://hooks.example.com/x", events: ["document.created"] },
    }),
    bad: () => ({ path: `${V}/webhooks`, body: { url: "https://hooks.example.com/x" } }),
  },
  "GET /api/v1/webhooks": {
    ok: () => ({ path: `${V}/webhooks` }),
    bad: () => ({ path: `${V}/webhooks`, query: { limit: "0" } }),
  },
  "DELETE /api/v1/webhooks/:webhookId": {
    ok: (f) => ({ path: `${V}/webhooks/${f.webhookId}` }),
    missing: () => ({ path: `${V}/webhooks/nope` }),
  },
  "POST /api/v1/webhooks/:webhookId/test": {
    ok: (f) => ({ path: `${V}/webhooks/${f.webhookId}/test` }),
    missing: () => ({ path: `${V}/webhooks/nope/test` }),
  },

  "GET /api/v1/tasks/:taskId": {
    ok: (f) => ({ path: `${V}/tasks/${f.taskId}` }),
    missing: () => ({ path: `${V}/tasks/nope` }),
  },
  "POST /api/v1/tasks/:taskId/cancel": {
    ok: (f) => ({ path: `${V}/tasks/${f.taskId}/cancel` }),
    missing: () => ({ path: `${V}/tasks/nope/cancel` }),
  },
  "GET /api/v1/tasks": { ok: () => ({ path: `${V}/tasks` }) },
};

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: { data?: unknown; error?: { code: string; message: string }; [key: string]: unknown };
}

let server: Server;
let port: number;
let db: Database.Database;
let fixtures: Fixtures;

/** Send a request with node:http (global fetch is stubbed by the webhook test). */
function send(method: string, c: Case, headers: Record<string, string> = {}): Promise<Reply> {
  const qs = c.query ? `?${new URLSearchParams(c.query).toString()}` : "";
  const payload = c.body === undefined ? undefined : JSON.stringify(c.body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: c.path + qs,
        headers: { ...(payload ? { "Content-Type": "application/json" } : {}), ...headers },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (raw += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: raw ? (JSON.parse(raw) as Reply["body"]) : {},
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const fakeLlm = {
  model: "fake",
  complete: (): Promise<{ text: string }> => Promise.resolve({ text: "An answer." }),
};

async function seed(): Promise<Fixtures> {
  const provider = new MockEmbeddingProvider();
  const topic = createTopic(db, { name: "Guides" });
  const a = await indexDocument(db, provider, {
    title: "TypeScript intro",
    content: "TypeScript is a typed superset of JavaScript.",
    sourceType: "manual",
    topicId: topic.id,
  });
  const b = await indexDocument(db, provider, {
    title: "Node guide",
    content: "Node.js runs JavaScript on the server.",
    sourceType: "library",
    library: "ts",
  });
  db.prepare("INSERT INTO tags (id, name) VALUES ('t1', 'intro')").run();
  db.prepare("INSERT INTO document_tags (document_id, tag_id) VALUES (?, 't1')").run(a.id);
  await updateDocument(db, provider, a.id, { content: "TypeScript adds static types." });
  const link = createLink(db, a.id, b.id, "related");
  createSavedSearch(db, "saved", "typescript");
  const hook = await createWebhook(db, "https://hooks.example.com/libscope", ["document.created"]);
  db.prepare("INSERT INTO packs (name, version) VALUES ('demo-pack', '1.0.0')").run();
  saveConnectorSettings("obsidian", "notes", {
    vaultPath: join(tempHome, "vault"),
    topicMapping: "folder",
    excludePatterns: [],
  });
  const { task } = taskRegistry.create("operation", "test");
  return { docA: a.id, docB: b.id, linkId: link.id, webhookId: hook.id, taskId: task.id };
}

describe("REST routes generated from operations", () => {
  let ctxRef: ReturnType<typeof createOperationContext>;

  beforeAll(async () => {
    server = createServer((req, res) => void handleRequest(req, res, ctxRef));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    tempHome = join(tmpdir(), `libscope-api-routes-${randomUUID()}`);
    mkdirSync(join(tempHome, "vault"), { recursive: true });
    db = createTestDbWithVec();
    ctxRef = createOperationContext({
      db,
      provider: new MockEmbeddingProvider(),
      config: testConfig(),
      surface: "api",
      llm: fakeLlm,
    });
    fixtures = await seed();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204, statusText: "No Content" })),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    // Let background tasks started by 202 routes settle before the database closes.
    await new Promise((resolve) => setTimeout(resolve, 20));
    db.close();
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("has a contract case for every route, and every case names a route", () => {
    const routes = API_ROUTES.map((r) => `${r.method} ${r.path}`).sort();
    expect(Object.keys(CASES).sort()).toEqual(routes);
  });

  for (const [key, cases] of Object.entries(CASES)) {
    const [method = "GET"] = key.split(" ");

    it(`${key} succeeds`, async () => {
      const reply = await send(method, cases.ok(fixtures));
      expect(reply.body.error, JSON.stringify(reply.body.error)).toBeUndefined();
      expect(reply.status).toBe(cases.okStatus ?? 200);
    });

    const { bad, missing } = cases;
    if (bad) {
      it(`${key} answers 400 for invalid input`, async () => {
        const reply = await send(method, bad(fixtures));
        expect(reply.status, JSON.stringify(reply.body)).toBe(400);
        expect(reply.body.error?.code).toMatch(/VALIDATION_ERROR|INVALID_JSON/);
      });
    }
    if (missing) {
      it(`${key} answers 404 for a missing resource`, async () => {
        const reply = await send(method, missing(fixtures));
        expect(reply.status, JSON.stringify(reply.body)).toBe(404);
        expect(reply.body.error?.code).toMatch(/NOT_FOUND$/);
      });
    }
  }

  it("wraps results as { data, meta } with ids in the result", async () => {
    const reply = await send("GET", { path: `${V}/documents/${fixtures.docA}` });
    expect(reply.body).toMatchObject({
      data: { document: { documentId: fixtures.docA, title: "TypeScript intro" } },
      meta: { took: expect.any(Number) as number },
    });
  });

  it("runs a long-running operation as a task and reports its result", async () => {
    const started = await send("POST", {
      path: `${V}/documents`,
      body: { title: "Queued", content: "Queued document body" },
    });
    expect(started.status).toBe(202);
    const data = started.body.data as { taskId: string; operation: string };
    expect(data.operation).toBe("add");
    expect(started.headers["location"]).toBe(`${V}/tasks/${data.taskId}`);

    let task: { status: string; result?: string } = { status: "running" };
    await vi.waitFor(async () => {
      const polled = await send("GET", { path: `${V}/tasks/${data.taskId}` });
      task = polled.body.data as typeof task;
      expect(task.status).toBe("completed");
    });
    const result = JSON.parse(task.result ?? "null") as { documents: Array<{ title: string }> };
    expect(JSON.stringify(result)).toContain("Queued");
  });

  it("coerces query values by the operation schema (numbers, booleans, arrays)", async () => {
    const reply = await send("GET", {
      path: `${V}/documents`,
      query: { limit: "1", offset: "1" },
    });
    expect(reply.body.data).toMatchObject({ limit: 1, offset: 1, total: 2 });
    const tagged = await send("GET", { path: `${V}/documents`, query: { tags: "intro" } });
    expect((tagged.body.data as { total: number }).total).toBe(1);
  });

  it("refuses local paths over REST with 400 before any task starts", async () => {
    const tasksBefore = taskRegistry.list().length;
    for (const source of ["/etc/hosts", "/no/such/path"]) {
      const reply = await send("POST", { path: `${V}/documents`, body: { source } });
      expect(reply.status).toBe(400);
      expect(reply.body.error?.message).toContain("only available from the CLI");
    }
    const noTopic = await send("POST", {
      path: `${V}/documents`,
      body: { title: "T", content: "C", topic: "nope" },
    });
    expect(noTopic.status).toBe(404);
    expect(taskRegistry.list()).toHaveLength(tasksBefore);
  });

  it("answers 400 for a malformed JSON body and a non-object body", async () => {
    const bad = await new Promise<Reply>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, method: "POST", path: `${V}/topics` },
        (res) => {
          let raw = "";
          res.on("data", (c: Buffer) => (raw += c.toString()));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: JSON.parse(raw) as Reply["body"],
            }),
          );
        },
      );
      req.on("error", reject);
      req.end("{not json");
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.code).toBe("INVALID_JSON");
    const array = await send("POST", { path: `${V}/topics`, body: ["x"] });
    expect(array.status).toBe(400);
  });

  it("answers 404 for unknown routes and wrong methods", async () => {
    expect((await send("GET", { path: `${V}/nope` })).status).toBe(404);
    expect((await send("PUT", { path: `${V}/documents` })).status).toBe(404);
    expect((await send("GET", { path: `${V}/documents/url/extra/more` })).status).toBe(404);
  });

  it("answers 400 for a malformed path escape", async () => {
    const reply = await send("GET", { path: `${V}/documents/%E0%A4%A` });
    expect(reply.status).toBe(400);
  });

  it("answers 500 with the config hint when ask has no LLM", async () => {
    ctxRef = createOperationContext({
      db,
      provider: new MockEmbeddingProvider(),
      config: testConfig(),
      surface: "api",
      llm: null,
    });
    const reply = await send("POST", { path: `${V}/ask`, body: { question: "Why?" } });
    expect(reply.status).toBe(500);
    expect(reply.body.error?.code).toBe("CONFIG_ERROR");
  });
});
