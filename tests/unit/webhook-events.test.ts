import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type Database from "better-sqlite3";
import { createTestDbWithVec } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { initLogger } from "../../src/logger.js";
import { ValidationError } from "../../src/errors.js";
import { testConfig } from "./operations/helpers.js";

const resolve4 = vi.fn();
vi.mock("node:dns", async (importOriginal) => {
  const actual: typeof import("node:dns") = await importOriginal();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      resolve4: (host: string): Promise<string[]> => resolve4(host) as Promise<string[]>,
      resolve6: vi.fn().mockResolvedValue([]),
    },
  };
});

const { emitEvent, onEvent } = await import("../../src/core/events.js");
const { createWebhook, deliverWebhook, signPayload } = await import("../../src/core/webhooks.js");
const { indexDocument } = await import("../../src/core/indexing.js");
const { updateDocument, deleteDocument } = await import("../../src/core/documents.js");
const { rateDocument } = await import("../../src/core/ratings.js");
const { searchDocuments } = await import("../../src/core/search.js");
const { handleRequest } = await import("../../src/api/routes.js");
const { createOperationContext } = await import("../../src/core/operations/index.js");

interface SentPayload {
  event: string;
  data: Record<string, unknown>;
}

function sentPayloads(mockFetch: ReturnType<typeof vi.fn>): SentPayload[] {
  return mockFetch.mock.calls.map((c) => {
    const init = c[1] as RequestInit;
    return JSON.parse(init.body as string) as SentPayload;
  });
}

describe("core events", () => {
  beforeEach(() => {
    initLogger("silent");
  });

  it("delivers events to listeners until unsubscribed", () => {
    const db = createTestDbWithVec();
    const listener = vi.fn();
    const off = onEvent(listener);
    emitEvent(db, "document.deleted", { documentId: "d1" });
    off();
    emitEvent(db, "document.deleted", { documentId: "d2" });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(db, "document.deleted", { documentId: "d1" });
    db.close();
  });

  it("never throws into the caller when a listener throws or rejects", async () => {
    const db = createTestDbWithVec();
    const offThrow = onEvent(() => {
      throw new Error("sync boom");
    });
    const rejected = vi.fn().mockRejectedValue(new Error("async boom"));
    const offReject = onEvent(rejected);
    const after = vi.fn();
    const offAfter = onEvent(after);
    expect(() => emitEvent(db, "search.executed", { query: "q" })).not.toThrow();
    await Promise.resolve();
    expect(rejected).toHaveBeenCalledOnce();
    expect(after).toHaveBeenCalledOnce();
    offThrow();
    offReject();
    offAfter();
    db.close();
  });
});

describe("webhook delivery wiring", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    initLogger("silent");
    resolve4.mockResolvedValue(["93.184.216.34"]);
    db = createTestDbWithVec();
    provider = new MockEmbeddingProvider();
    mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["LIBSCOPE_SECRET_KEY"];
    db.close();
  });

  it("fires document.created, updated, rated, deleted and search.executed", async () => {
    await createWebhook(db, "https://example.com/hook", [
      "document.created",
      "document.updated",
      "document.deleted",
      "document.rated",
      "search.executed",
    ]);

    const doc = await indexDocument(db, provider, {
      title: "Webhook Doc",
      content: "Some content about webhooks firing.",
      sourceType: "manual",
      library: "lib",
    });
    await updateDocument(db, provider, doc.id, { title: "Webhook Doc v2" });
    rateDocument(db, { documentId: doc.id, rating: 4, feedback: "good" });
    await searchDocuments(db, provider, { query: "webhooks" });
    deleteDocument(db, doc.id);

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(5));
    const byEvent = new Map(sentPayloads(mockFetch).map((p) => [p.event, p.data]));
    expect(byEvent.get("document.created")).toEqual({
      documentId: doc.id,
      title: "Webhook Doc",
      library: "lib",
    });
    expect(byEvent.get("document.updated")).toMatchObject({
      documentId: doc.id,
      title: "Webhook Doc v2",
    });
    expect(byEvent.get("document.rated")).toEqual({
      documentId: doc.id,
      rating: 4,
      feedback: "good",
    });
    expect(byEvent.get("search.executed")).toMatchObject({ query: "webhooks" });
    expect(byEvent.get("document.deleted")).toEqual({ documentId: doc.id });
  });

  it("only delivers subscribed events and does not block or fail the mutation", async () => {
    await createWebhook(db, "https://example.com/hook", ["document.deleted"]);
    mockFetch.mockRejectedValue(new Error("network down"));

    const doc = await indexDocument(db, provider, {
      title: "Quiet",
      content: "No created hook for this one.",
      sourceType: "manual",
    });
    expect(mockFetch).not.toHaveBeenCalled();

    expect(() => deleteDocument(db, doc.id)).not.toThrow();
    await vi.waitFor(() => {
      const row = db.prepare("SELECT failure_count FROM webhooks").get() as {
        failure_count: number;
      };
      expect(row.failure_count).toBe(1);
    });
    expect(sentPayloads(mockFetch)[0]!.event).toBe("document.deleted");
  });

  it("does not throw into the mutation when the webhooks table is missing", async () => {
    db.exec("DROP TABLE webhooks");
    await expect(
      indexDocument(db, provider, { title: "T", content: "Body text", sourceType: "manual" }),
    ).resolves.toMatchObject({ chunkCount: 1 });
  });
});

describe("deliverWebhook", () => {
  let db: Database.Database;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    initLogger("silent");
    resolve4.mockResolvedValue(["93.184.216.34"]);
    db = createTestDbWithVec();
    mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 202, statusText: "Accepted" });
    vi.stubGlobal("fetch", mockFetch);
    process.env["LIBSCOPE_SECRET_KEY"] = "test-master-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["LIBSCOPE_SECRET_KEY"];
    db.close();
  });

  it("signs with the decrypted secret and refuses redirects", async () => {
    const hook = await createWebhook(
      db,
      "https://example.com/hook",
      ["document.created"],
      "s3cr3t",
    );
    expect(hook.secret).not.toBe("s3cr3t");

    const resp = await deliverWebhook(hook, "document.created", { test: true });
    expect(resp.status).toBe(202);

    const init = mockFetch.mock.calls[0]![1] as RequestInit & { headers: Record<string, string> };
    expect(init.redirect).toBe("error");
    expect(init.headers["X-LibScope-Signature"]).toBe(signPayload(init.body as string, "s3cr3t"));
  });

  it("rejects URLs that now resolve to a private IP without sending", async () => {
    const hook = await createWebhook(db, "https://example.com/hook", ["document.created"]);
    resolve4.mockResolvedValue(["10.0.0.5"]);
    await expect(deliverWebhook(hook, "document.created", {})).rejects.toThrow(ValidationError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("REST test route signs with the decrypted secret and checks SSRF", async () => {
    const hook = await createWebhook(
      db,
      "https://example.com/hook",
      ["document.created"],
      "s3cr3t",
    );

    const send = async (): Promise<{ status: number; body: string }> => {
      const req = new IncomingMessage(new Socket());
      req.method = "POST";
      req.url = `/api/v1/webhooks/${hook.id}/test`;
      req.headers = { host: "localhost:3378" };
      process.nextTick(() => {
        req.push(null);
      });
      const res = new ServerResponse(new IncomingMessage(new Socket()));
      let body = "";
      res.end = ((chunk?: unknown) => {
        if (typeof chunk === "string") body = chunk;
        return res;
      }) as typeof res.end;
      await handleRequest(
        req,
        res,
        createOperationContext({
          db,
          provider: new MockEmbeddingProvider(),
          config: testConfig(),
          surface: "api",
        }),
      );
      return { status: res.statusCode, body };
    };

    const ok = await send();
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ data: { status: 202 } });
    const init = mockFetch.mock.calls[0]![1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers["X-LibScope-Signature"]).toBe(signPayload(init.body as string, "s3cr3t"));
    expect(JSON.parse(init.body as string)).toMatchObject({
      event: "document.created",
      data: { test: true },
    });

    resolve4.mockResolvedValue(["127.0.0.1"]);
    const blocked = await send();
    expect(blocked.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});
