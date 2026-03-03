import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../fixtures/test-db.js";
import {
  createWebhook,
  listWebhooks,
  getWebhook,
  deleteWebhook,
  updateWebhook,
  signPayload,
  buildPayload,
  fireWebhooks,
  WEBHOOK_EVENTS,
} from "../../src/core/webhooks.js";
import type { WebhookEvent } from "../../src/core/webhooks.js";
import { ValidationError } from "../../src/errors.js";
import { initLogger } from "../../src/logger.js";

describe("webhooks", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  describe("createWebhook", () => {
    it("should create a webhook with valid inputs", () => {
      const webhook = createWebhook(db, "https://example.com/hook", ["document.created"]);
      expect(webhook.id).toBeTruthy();
      expect(webhook.url).toBe("https://example.com/hook");
      expect(webhook.events).toEqual(["document.created"]);
      expect(webhook.secret).toBeNull();
      expect(webhook.active).toBe(true);
      expect(webhook.failureCount).toBe(0);
      expect(webhook.lastTriggeredAt).toBeNull();
      expect(webhook.createdAt).toBeTruthy();
    });

    it("should create a webhook with a secret", () => {
      const webhook = createWebhook(
        db,
        "https://example.com/hook",
        ["document.created"],
        "my-secret",
      );
      expect(webhook.secret).toBe("my-secret");
    });

    it("should create a webhook with multiple events", () => {
      const events: WebhookEvent[] = ["document.created", "document.updated", "document.deleted"];
      const webhook = createWebhook(db, "https://example.com/hook", events);
      expect(webhook.events).toEqual(events);
    });

    it("should reject invalid URL", () => {
      expect(() => createWebhook(db, "ftp://example.com", ["document.created"])).toThrow(
        ValidationError,
      );
    });

    it("should reject malformed URL", () => {
      expect(() => createWebhook(db, "not-a-url", ["document.created"])).toThrow(ValidationError);
    });

    it("should reject URL with only scheme", () => {
      expect(() => createWebhook(db, "https://", ["document.created"])).toThrow(ValidationError);
    });

    it("should reject empty events array", () => {
      expect(() => createWebhook(db, "https://example.com/hook", [])).toThrow(ValidationError);
    });

    it("should reject invalid event type", () => {
      expect(() =>
        createWebhook(db, "https://example.com/hook", ["invalid.event" as WebhookEvent]),
      ).toThrow(ValidationError);
    });

    it("should accept http:// URLs", () => {
      const webhook = createWebhook(db, "http://localhost:3000/hook", ["document.created"]);
      expect(webhook.url).toBe("http://localhost:3000/hook");
    });
  });

  describe("listWebhooks", () => {
    it("should return empty array when no webhooks exist", () => {
      expect(listWebhooks(db)).toEqual([]);
    });

    it("should return all webhooks", () => {
      createWebhook(db, "https://example.com/hook1", ["document.created"]);
      createWebhook(db, "https://example.com/hook2", ["document.updated"]);
      const hooks = listWebhooks(db);
      expect(hooks).toHaveLength(2);
    });
  });

  describe("getWebhook", () => {
    it("should return a webhook by id", () => {
      const created = createWebhook(db, "https://example.com/hook", ["document.created"]);
      const fetched = getWebhook(db, created.id);
      expect(fetched.id).toBe(created.id);
      expect(fetched.url).toBe(created.url);
    });

    it("should throw ValidationError for non-existent id", () => {
      expect(() => getWebhook(db, "non-existent")).toThrow(ValidationError);
    });
  });

  describe("deleteWebhook", () => {
    it("should delete an existing webhook", () => {
      const webhook = createWebhook(db, "https://example.com/hook", ["document.created"]);
      deleteWebhook(db, webhook.id);
      expect(listWebhooks(db)).toHaveLength(0);
    });

    it("should throw ValidationError for non-existent id", () => {
      expect(() => deleteWebhook(db, "non-existent")).toThrow(ValidationError);
    });
  });

  describe("updateWebhook", () => {
    it("should update webhook URL", () => {
      const webhook = createWebhook(db, "https://example.com/hook", ["document.created"]);
      const updated = updateWebhook(db, webhook.id, { url: "https://example.com/new-hook" });
      expect(updated.url).toBe("https://example.com/new-hook");
    });

    it("should update webhook events", () => {
      const webhook = createWebhook(db, "https://example.com/hook", ["document.created"]);
      const updated = updateWebhook(db, webhook.id, {
        events: ["document.updated", "document.deleted"],
      });
      expect(updated.events).toEqual(["document.updated", "document.deleted"]);
    });

    it("should update webhook active status", () => {
      const webhook = createWebhook(db, "https://example.com/hook", ["document.created"]);
      const updated = updateWebhook(db, webhook.id, { active: false });
      expect(updated.active).toBe(false);
    });

    it("should update webhook secret", () => {
      const webhook = createWebhook(db, "https://example.com/hook", ["document.created"]);
      const updated = updateWebhook(db, webhook.id, { secret: "new-secret" });
      expect(updated.secret).toBe("new-secret");
    });

    it("should reject invalid URL on update", () => {
      const webhook = createWebhook(db, "https://example.com/hook", ["document.created"]);
      expect(() => updateWebhook(db, webhook.id, { url: "ftp://bad" })).toThrow(ValidationError);
    });

    it("should reject invalid events on update", () => {
      const webhook = createWebhook(db, "https://example.com/hook", ["document.created"]);
      expect(() => updateWebhook(db, webhook.id, { events: ["invalid" as WebhookEvent] })).toThrow(
        ValidationError,
      );
    });

    it("should throw ValidationError for non-existent id", () => {
      expect(() => updateWebhook(db, "non-existent", { url: "https://new.com" })).toThrow(
        ValidationError,
      );
    });
  });

  describe("signPayload", () => {
    it("should produce a consistent HMAC-SHA256 hex digest", () => {
      const body = '{"event":"document.created","timestamp":"2024-01-01T00:00:00.000Z","data":{}}';
      const sig1 = signPayload(body, "secret");
      const sig2 = signPayload(body, "secret");
      expect(sig1).toBe(sig2);
      expect(sig1).toMatch(/^[a-f0-9]{64}$/);
    });

    it("should produce different signatures for different secrets", () => {
      const body = '{"test":true}';
      const sig1 = signPayload(body, "secret-a");
      const sig2 = signPayload(body, "secret-b");
      expect(sig1).not.toBe(sig2);
    });
  });

  describe("buildPayload", () => {
    it("should build a valid JSON payload", () => {
      const body = buildPayload("document.created", { docId: "123" });
      const parsed = JSON.parse(body) as { event: string; timestamp: string; data: unknown };
      expect(parsed.event).toBe("document.created");
      expect(parsed.timestamp).toBeTruthy();
      expect(parsed.data).toEqual({ docId: "123" });
    });
  });

  describe("WEBHOOK_EVENTS", () => {
    it("should contain expected event types", () => {
      expect(WEBHOOK_EVENTS).toContain("document.created");
      expect(WEBHOOK_EVENTS).toContain("document.updated");
      expect(WEBHOOK_EVENTS).toContain("document.deleted");
      expect(WEBHOOK_EVENTS).toContain("document.rated");
      expect(WEBHOOK_EVENTS).toContain("search.executed");
    });
  });

  describe("failure tracking", () => {
    it("should track failure count in the database", () => {
      const webhook = createWebhook(db, "https://example.com/hook", ["document.created"]);
      db.prepare("UPDATE webhooks SET failure_count = 5 WHERE id = ?").run(webhook.id);
      const updated = getWebhook(db, webhook.id);
      expect(updated.failureCount).toBe(5);
    });

    it("should deactivate webhook when failure count reaches 10", () => {
      const webhook = createWebhook(db, "https://example.com/hook", ["document.created"]);
      db.prepare("UPDATE webhooks SET failure_count = 10, active = 0 WHERE id = ?").run(webhook.id);
      const updated = getWebhook(db, webhook.id);
      expect(updated.active).toBe(false);
      expect(updated.failureCount).toBe(10);
    });
  });

  describe("fireWebhooks", () => {
    beforeEach(() => {
      initLogger("silent");
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should send POST to matching webhook on success", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      createWebhook(db, "https://example.com/hook", ["document.created"]);
      fireWebhooks(db, "document.created", { docId: "123" });

      // Allow async fetch to resolve
      await vi.waitFor(() => {
        expect(mockFetch).toHaveBeenCalledOnce();
      });

      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toBe("https://example.com/hook");
      expect(call[1]).toMatchObject({ method: "POST" });
    });

    it("should not fire for non-matching events", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      createWebhook(db, "https://example.com/hook", ["document.updated"]);
      fireWebhooks(db, "document.created", { docId: "123" });

      // Give time for any async calls
      await new Promise((r) => setTimeout(r, 50));
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should include signature header when secret is set", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      createWebhook(db, "https://example.com/hook", ["document.created"], "my-secret");
      fireWebhooks(db, "document.created", { docId: "123" });

      await vi.waitFor(() => {
        expect(mockFetch).toHaveBeenCalledOnce();
      });

      const call = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
      const headers = call[1].headers;
      expect(headers["X-LibScope-Signature"]).toBeTruthy();
      expect(headers["X-LibScope-Signature"]).toMatch(/^[a-f0-9]{64}$/);
    });

    it("should reset failure count on successful delivery", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      const webhook = createWebhook(db, "https://example.com/hook", ["document.created"]);
      db.prepare("UPDATE webhooks SET failure_count = 3 WHERE id = ?").run(webhook.id);

      fireWebhooks(db, "document.created", { docId: "123" });

      await vi.waitFor(() => {
        const updated = getWebhook(db, webhook.id);
        expect(updated.failureCount).toBe(0);
      });
    });

    it("should increment failure count on non-2xx response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      vi.stubGlobal("fetch", mockFetch);

      const webhook = createWebhook(db, "https://example.com/hook", ["document.created"]);
      fireWebhooks(db, "document.created", { docId: "123" });

      await vi.waitFor(() => {
        const updated = getWebhook(db, webhook.id);
        expect(updated.failureCount).toBe(1);
      });
    });

    it("should increment failure count on network error", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
      vi.stubGlobal("fetch", mockFetch);

      const webhook = createWebhook(db, "https://example.com/hook", ["document.created"]);
      fireWebhooks(db, "document.created", { docId: "123" });

      await vi.waitFor(() => {
        const updated = getWebhook(db, webhook.id);
        expect(updated.failureCount).toBe(1);
      });
    });

    it("should deactivate webhook after MAX_FAILURES consecutive failures", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
      vi.stubGlobal("fetch", mockFetch);

      const webhook = createWebhook(db, "https://example.com/hook", ["document.created"]);
      // Set failure_count to 9 so the next failure (10th) triggers deactivation
      db.prepare("UPDATE webhooks SET failure_count = 9 WHERE id = ?").run(webhook.id);

      fireWebhooks(db, "document.created", { docId: "123" });

      await vi.waitFor(() => {
        const updated = getWebhook(db, webhook.id);
        expect(updated.failureCount).toBe(10);
        expect(updated.active).toBe(false);
      });
    });

    it("should skip inactive webhooks", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      const webhook = createWebhook(db, "https://example.com/hook", ["document.created"]);
      updateWebhook(db, webhook.id, { active: false });

      fireWebhooks(db, "document.created", { docId: "123" });

      await new Promise((r) => setTimeout(r, 50));
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
