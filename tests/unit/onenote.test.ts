import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDbWithVec } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import {
  convertOneNoteHtml,
  syncOneNote,
  disconnectOneNote,
  authenticateDeviceCode,
  refreshAccessToken,
  _resetRateLimiter,
} from "../../src/connectors/onenote.js";
import type { OneNoteConfig } from "../../src/connectors/onenote.js";
import type Database from "better-sqlite3";

// Mock connector config to avoid filesystem access
vi.mock("../../src/connectors/index.js", () => ({
  loadConnectorConfig: vi.fn(() => ({})),
  saveConnectorConfig: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Global fetch mock
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = vi.fn(handler) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
}

function makeConfig(overrides?: Partial<OneNoteConfig>): OneNoteConfig {
  return {
    clientId: "test-client-id",
    tenantId: "test-tenant",
    accessToken: "test-token",
    notebooks: ["all"],
    excludeSections: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OneNote Connector", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    db = createTestDbWithVec();
    provider = new MockEmbeddingProvider();
    _resetRateLimiter();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });

  // -------------------------------------------------------------------------
  // HTML → Markdown conversion
  // -------------------------------------------------------------------------

  describe("convertOneNoteHtml", () => {
    it("converts basic HTML to markdown", () => {
      const html = "<h1>Title</h1><p>Hello world</p>";
      const md = convertOneNoteHtml(html);
      expect(md).toContain("Title");
      expect(md).toContain("Hello world");
    });

    it("converts cite tags to blockquotes", () => {
      const html = "<cite>A quote</cite>";
      const md = convertOneNoteHtml(html);
      expect(md).toContain(">");
      expect(md).toContain("A quote");
    });

    it("converts uncompleted checkboxes", () => {
      const html = '<p data-tag="to-do">Buy milk</p>';
      const md = convertOneNoteHtml(html);
      expect(md).toContain("- [ ]");
      expect(md).toContain("Buy milk");
    });

    it("converts completed checkboxes", () => {
      const html = '<p data-tag="to-do:completed">Done task</p>';
      const md = convertOneNoteHtml(html);
      expect(md).toContain("- [x]");
      expect(md).toContain("Done task");
    });

    it("replaces images with placeholder", () => {
      const html = '<img src="https://example.com/img.png" alt="photo">';
      const md = convertOneNoteHtml(html);
      expect(md).toContain("[image]");
      expect(md).not.toContain("https://example.com");
    });

    it("replaces embedded files with attached placeholder", () => {
      const html = '<object data-attachment="report.pdf" data="...">content</object>';
      const md = convertOneNoteHtml(html);
      expect(md).toContain("[attached: report.pdf]");
    });

    it("replaces ink annotations with placeholder", () => {
      const html = "<ink>some ink data</ink>";
      const md = convertOneNoteHtml(html);
      expect(md).toContain("[handwritten content]");
    });

    it("removes style attributes", () => {
      const html = '<p style="color: red; font-size: 14px;">Styled text</p>';
      const md = convertOneNoteHtml(html);
      expect(md).not.toContain("style");
      expect(md).toContain("Styled text");
    });

    it("converts tables", () => {
      const html = "<table><tr><th>Name</th></tr><tr><td>Alice</td></tr></table>";
      const md = convertOneNoteHtml(html);
      expect(md).toContain("Name");
      expect(md).toContain("Alice");
    });

    it("handles empty/malformed HTML gracefully", () => {
      expect(convertOneNoteHtml("")).toBe("");
      expect(convertOneNoteHtml("<div></div>")).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Device code auth
  // -------------------------------------------------------------------------

  describe("authenticateDeviceCode", () => {
    it("completes device code flow", async () => {
      let pollCount = 0;
      mockFetch((url: string) => {
        if (url.includes("/devicecode")) {
          return jsonResponse({
            device_code: "dev123",
            user_code: "ABC-DEF",
            verification_uri: "https://microsoft.com/devicelogin",
            expires_in: 900,
            interval: 0,
          });
        }
        if (url.includes("/token")) {
          pollCount++;
          if (pollCount < 2) {
            return jsonResponse({ error: "authorization_pending" }, 400);
          }
          return jsonResponse({
            access_token: "access-123",
            refresh_token: "refresh-123",
            expires_in: 3600,
          });
        }
        return new Response("Not found", { status: 404 });
      });

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const result = await authenticateDeviceCode("client-id", "test-tenant");
      consoleSpy.mockRestore();

      expect(result.accessToken).toBe("access-123");
      expect(result.refreshToken).toBe("refresh-123");
      expect(result.expiresAt).toBeDefined();
    });

    it("throws on device code request failure", async () => {
      mockFetch(() => new Response("Bad request", { status: 400 }));

      await expect(authenticateDeviceCode("client-id")).rejects.toThrow(
        "Device code request failed",
      );
    });

    it("throws on auth error (not pending)", async () => {
      mockFetch((url: string) => {
        if (url.includes("/devicecode")) {
          return jsonResponse({
            device_code: "dev123",
            user_code: "ABC",
            verification_uri: "https://example.com",
            expires_in: 900,
            interval: 0,
          });
        }
        return jsonResponse({ error: "access_denied" }, 400);
      });

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await expect(authenticateDeviceCode("client-id")).rejects.toThrow(
        "Authentication failed: access_denied",
      );
      consoleSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Token refresh
  // -------------------------------------------------------------------------

  describe("refreshAccessToken", () => {
    it("refreshes token successfully", async () => {
      mockFetch(() =>
        jsonResponse({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
      );

      const result = await refreshAccessToken("client-id", "old-refresh", "tenant-id");
      expect(result.accessToken).toBe("new-access");
      expect(result.refreshToken).toBe("new-refresh");
    });

    it("throws on refresh failure", async () => {
      mockFetch(() => new Response("Unauthorized", { status: 401 }));

      await expect(refreshAccessToken("client-id", "bad-refresh")).rejects.toThrow(
        "Token refresh failed",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  describe("syncOneNote", () => {
    function setupGraphMocks(
      notebooks: Array<{ id: string; displayName: string }> = [
        { id: "nb1", displayName: "Work Notebook" },
      ],
      sections: Array<{ id: string; displayName: string }> = [
        { id: "sec1", displayName: "Project Notes" },
      ],
      pages: Array<{ id: string; title: string; lastModifiedDateTime: string }> = [
        { id: "pg1", title: "Meeting Notes", lastModifiedDateTime: "2024-01-15T10:00:00Z" },
      ],
      pageHtml: string = "<h1>Meeting Notes</h1><p>Discussion points</p>",
    ): void {
      mockFetch((url: string, init?: RequestInit) => {
        const accept = (init?.headers as Record<string, string>)?.Accept ?? "";

        if (url.includes("/me/onenote/notebooks") && !url.includes("/sections")) {
          return jsonResponse({ value: notebooks });
        }
        if (url.includes("/sections") && !url.includes("/pages")) {
          return jsonResponse({ value: sections });
        }
        if (url.includes("/pages") && !url.includes("/content")) {
          return jsonResponse({ value: pages });
        }
        if (url.includes("/content") || accept === "text/html") {
          return htmlResponse(pageHtml);
        }
        return new Response("Not found", { status: 404 });
      });
    }

    it("performs full sync creating topics and indexing pages", async () => {
      setupGraphMocks();

      const result = await syncOneNote(db, provider, makeConfig());

      expect(result.notebooks).toBe(1);
      expect(result.sections).toBe(1);
      expect(result.pagesAdded).toBe(1);
      expect(result.errors).toHaveLength(0);

      // Check topic was created
      const topics = db.prepare("SELECT * FROM topics").all() as Array<{
        name: string;
        parent_id: string | null;
      }>;
      expect(topics.length).toBeGreaterThanOrEqual(2);
      expect(topics.some((t) => t.name === "Work Notebook")).toBe(true);
      expect(topics.some((t) => t.name === "Project Notes")).toBe(true);

      // Check document was created
      const docs = db
        .prepare("SELECT * FROM documents WHERE url LIKE 'onenote://%'")
        .all() as Array<{
        title: string;
        url: string;
      }>;
      expect(docs).toHaveLength(1);
      expect(docs[0]?.url).toBe("onenote://Work Notebook/Project Notes/Meeting Notes");
    });

    it("filters notebooks by name", async () => {
      setupGraphMocks([
        { id: "nb1", displayName: "Work" },
        { id: "nb2", displayName: "Personal" },
      ]);

      const result = await syncOneNote(db, provider, makeConfig({ notebooks: ["Work"] }));
      expect(result.notebooks).toBe(1);
    });

    it("excludes specified sections", async () => {
      setupGraphMocks(
        [{ id: "nb1", displayName: "Notebook" }],
        [
          { id: "sec1", displayName: "Notes" },
          { id: "sec2", displayName: "Trash" },
        ],
      );

      const result = await syncOneNote(db, provider, makeConfig({ excludeSections: ["Trash"] }));
      expect(result.sections).toBe(1);
    });

    it("performs incremental sync skipping unchanged pages", async () => {
      setupGraphMocks(
        [{ id: "nb1", displayName: "NB" }],
        [{ id: "sec1", displayName: "Sec" }],
        [
          {
            id: "pg1",
            title: "Old Page",
            lastModifiedDateTime: "2024-01-01T00:00:00Z",
          },
          {
            id: "pg2",
            title: "New Page",
            lastModifiedDateTime: "2024-06-01T00:00:00Z",
          },
        ],
      );

      const result = await syncOneNote(
        db,
        provider,
        makeConfig({ lastSync: "2024-03-01T00:00:00Z" }),
      );

      // Only the new page should be added
      expect(result.pagesAdded).toBe(1);
    });

    it("updates existing pages on re-sync", async () => {
      // First sync
      setupGraphMocks();
      await syncOneNote(db, provider, makeConfig());

      // Second sync with same page (modified)
      _resetRateLimiter();
      setupGraphMocks(
        [{ id: "nb1", displayName: "Work Notebook" }],
        [{ id: "sec1", displayName: "Project Notes" }],
        [
          {
            id: "pg1",
            title: "Meeting Notes",
            lastModifiedDateTime: "2024-06-01T00:00:00Z",
          },
        ],
        "<h1>Updated</h1><p>New content</p>",
      );

      const result = await syncOneNote(db, provider, makeConfig());
      expect(result.pagesUpdated).toBe(1);
    });

    it("deletes pages no longer in OneNote", async () => {
      // First sync
      setupGraphMocks();
      await syncOneNote(db, provider, makeConfig());

      _resetRateLimiter();

      // Second sync with empty pages
      setupGraphMocks(
        [{ id: "nb1", displayName: "Work Notebook" }],
        [{ id: "sec1", displayName: "Project Notes" }],
        [],
      );

      const result = await syncOneNote(db, provider, makeConfig());
      expect(result.pagesDeleted).toBe(1);
    });

    it("throws when no access token provided", async () => {
      await expect(
        syncOneNote(db, provider, makeConfig({ accessToken: undefined })),
      ).rejects.toThrow("No access token");
    });

    it("collects errors for failed pages without stopping", async () => {
      let callCount = 0;
      mockFetch((url: string) => {
        if (url.includes("/notebooks") && !url.includes("/sections")) {
          return jsonResponse({
            value: [{ id: "nb1", displayName: "NB" }],
          });
        }
        if (url.includes("/sections") && !url.includes("/pages")) {
          return jsonResponse({
            value: [{ id: "sec1", displayName: "Sec" }],
          });
        }
        if (url.includes("/pages") && !url.includes("/content")) {
          return jsonResponse({
            value: [
              { id: "pg1", title: "Good", lastModifiedDateTime: "2024-01-01T00:00:00Z" },
              { id: "pg2", title: "Bad", lastModifiedDateTime: "2024-01-01T00:00:00Z" },
            ],
          });
        }
        if (url.includes("/content")) {
          callCount++;
          if (callCount === 2) {
            return new Response("Internal Server Error", { status: 500 });
          }
          return htmlResponse("<p>Content</p>");
        }
        return new Response("Not found", { status: 404 });
      });

      const result = await syncOneNote(db, provider, makeConfig());
      expect(result.pagesAdded).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.page).toBe("Bad");
    });
  });

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------

  describe("rate limiting", () => {
    it("retries on 429 with backoff", async () => {
      let callCount = 0;
      mockFetch((url: string) => {
        if (url.includes("/notebooks") && !url.includes("/sections")) {
          callCount++;
          if (callCount === 1) {
            return new Response("Too Many Requests", {
              status: 429,
              headers: { "Retry-After": "0" },
            });
          }
          return jsonResponse({ value: [] });
        }
        return new Response("Not found", { status: 404 });
      });

      const result = await syncOneNote(db, provider, makeConfig());
      expect(result.notebooks).toBe(0);
      expect(callCount).toBe(2);
    });

    it("falls back to exponential backoff when Retry-After is non-numeric", async () => {
      let callCount = 0;
      mockFetch((url: string) => {
        if (url.includes("/notebooks") && !url.includes("/sections")) {
          callCount++;
          if (callCount === 1) {
            return new Response("Too Many Requests", {
              status: 429,
              headers: { "Retry-After": "Wed, 21 Oct 2025 07:28:00 GMT" },
            });
          }
          return jsonResponse({ value: [] });
        }
        return new Response("Not found", { status: 404 });
      });

      const result = await syncOneNote(db, provider, makeConfig());
      expect(result.notebooks).toBe(0);
      expect(callCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Disconnect
  // -------------------------------------------------------------------------

  describe("disconnectOneNote", () => {
    it("removes all OneNote documents", () => {
      // Insert some onenote docs manually
      db.prepare(
        `INSERT INTO documents (id, source_type, title, content, url, submitted_by) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("doc1", "topic", "Page 1", "content", "onenote://NB/Sec/Page1", "crawler");
      db.prepare(
        `INSERT INTO documents (id, source_type, title, content, url, submitted_by) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("doc2", "topic", "Page 2", "content", "onenote://NB/Sec/Page2", "crawler");
      db.prepare(
        `INSERT INTO documents (id, source_type, title, content, url, submitted_by) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("doc3", "manual", "Other Doc", "content", "https://example.com", "manual");

      const removed = disconnectOneNote(db);
      expect(removed).toBe(2);

      const remaining = db.prepare("SELECT COUNT(*) as count FROM documents").get() as {
        count: number;
      };
      expect(remaining.count).toBe(1);
    });
  });
});
