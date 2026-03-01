import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ValidationError, FetchError } from "../../src/errors.js";
import { createTestDbWithVec } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import type Database from "better-sqlite3";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { syncNotion, convertNotionBlocks, disconnectNotion } =
  await import("../../src/connectors/notion.js");

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as Response;
}

describe("convertNotionBlocks", () => {
  it("should convert paragraph blocks", () => {
    const blocks = [
      { id: "1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Hello world" }] } },
    ];
    expect(convertNotionBlocks(blocks)).toBe("Hello world");
  });

  it("should convert heading blocks", () => {
    const blocks = [
      { id: "1", type: "heading_1", heading_1: { rich_text: [{ plain_text: "Title" }] } },
      { id: "2", type: "heading_2", heading_2: { rich_text: [{ plain_text: "Subtitle" }] } },
      { id: "3", type: "heading_3", heading_3: { rich_text: [{ plain_text: "Section" }] } },
    ];
    expect(convertNotionBlocks(blocks)).toBe("# Title\n## Subtitle\n### Section");
  });

  it("should convert bulleted and numbered list items", () => {
    const blocks = [
      {
        id: "1",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ plain_text: "Bullet" }] },
      },
      {
        id: "2",
        type: "numbered_list_item",
        numbered_list_item: { rich_text: [{ plain_text: "Number" }] },
      },
    ];
    expect(convertNotionBlocks(blocks)).toBe("- Bullet\n1. Number");
  });

  it("should convert to_do blocks with checked and unchecked states", () => {
    const blocks = [
      {
        id: "1",
        type: "to_do",
        to_do: { rich_text: [{ plain_text: "Done" }], checked: true },
      },
      {
        id: "2",
        type: "to_do",
        to_do: { rich_text: [{ plain_text: "Pending" }], checked: false },
      },
    ];
    expect(convertNotionBlocks(blocks)).toBe("- [x] Done\n- [ ] Pending");
  });

  it("should convert code blocks with language", () => {
    const blocks = [
      {
        id: "1",
        type: "code",
        code: { rich_text: [{ plain_text: "const x = 1;" }], language: "typescript" },
      },
    ];
    expect(convertNotionBlocks(blocks)).toBe("```typescript\nconst x = 1;\n```");
  });

  it("should convert quote blocks", () => {
    const blocks = [
      { id: "1", type: "quote", quote: { rich_text: [{ plain_text: "A wise quote" }] } },
    ];
    expect(convertNotionBlocks(blocks)).toBe("> A wise quote");
  });

  it("should convert callout blocks with emoji", () => {
    const blocks = [
      {
        id: "1",
        type: "callout",
        callout: { rich_text: [{ plain_text: "Important note" }], icon: { emoji: "⚠️" } },
      },
    ];
    expect(convertNotionBlocks(blocks)).toBe("> ⚠️ Important note");
  });

  it("should convert divider blocks", () => {
    const blocks = [{ id: "1", type: "divider" }];
    expect(convertNotionBlocks(blocks)).toBe("---");
  });

  it("should convert image blocks", () => {
    const blocks = [
      {
        id: "1",
        type: "image",
        image: {
          type: "external",
          external: { url: "https://example.com/img.png" },
          caption: [{ plain_text: "My image" }],
        },
      },
    ];
    expect(convertNotionBlocks(blocks)).toBe("![My image](https://example.com/img.png)");
  });

  it("should convert image blocks without URL", () => {
    const blocks = [
      {
        id: "1",
        type: "image",
        image: { type: "file", file: {} },
      },
    ];
    expect(convertNotionBlocks(blocks)).toBe("[image]");
  });

  it("should convert bookmark blocks", () => {
    const blocks = [
      {
        id: "1",
        type: "bookmark",
        bookmark: { url: "https://example.com", caption: [{ plain_text: "Example" }] },
      },
    ];
    expect(convertNotionBlocks(blocks)).toBe("[Example](https://example.com)");
  });

  it("should convert child_page blocks", () => {
    const blocks = [{ id: "abc-123", type: "child_page", child_page: { title: "Sub Page" } }];
    expect(convertNotionBlocks(blocks)).toBe("[Sub Page](notion://page/abc-123)");
  });

  it("should convert toggle blocks", () => {
    const blocks = [
      { id: "1", type: "toggle", toggle: { rich_text: [{ plain_text: "Toggle content" }] } },
    ];
    expect(convertNotionBlocks(blocks)).toBe("Toggle content");
  });

  it("should convert table blocks with rows", () => {
    const blocks = [
      {
        id: "1",
        type: "table",
        children: [
          {
            id: "r1",
            type: "table_row",
            table_row: { cells: [[{ plain_text: "A" }], [{ plain_text: "B" }]] },
          },
          {
            id: "r2",
            type: "table_row",
            table_row: { cells: [[{ plain_text: "1" }], [{ plain_text: "2" }]] },
          },
        ],
      },
    ];
    expect(convertNotionBlocks(blocks)).toBe("| A | B |\n| 1 | 2 |");
  });

  it("should handle nested blocks (children)", () => {
    const blocks = [
      {
        id: "1",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ plain_text: "Parent" }] },
        children: [
          {
            id: "2",
            type: "bulleted_list_item",
            bulleted_list_item: { rich_text: [{ plain_text: "Child" }] },
          },
        ],
      },
    ];
    const result = convertNotionBlocks(blocks);
    expect(result).toContain("- Parent");
    expect(result).toContain("  - Child");
  });

  it("should handle blocks with no rich_text gracefully", () => {
    const blocks = [{ id: "1", type: "paragraph", paragraph: {} }];
    expect(convertNotionBlocks(blocks)).toBe("");
  });

  it("should handle unknown block types with text", () => {
    const blocks = [
      {
        id: "1",
        type: "embed",
        embed: { rich_text: [{ plain_text: "embedded content" }] },
      },
    ];
    expect(convertNotionBlocks(blocks)).toBe("embedded content");
  });
});

describe("syncNotion", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    db = createTestDbWithVec();
    provider = new MockEmbeddingProvider();
    mockFetch.mockReset();
  });

  afterEach(() => {
    db.close();
  });

  it("should reject invalid tokens", async () => {
    await expect(syncNotion(db, provider, { token: "bad-token" })).rejects.toThrow(ValidationError);
  });

  it("should index pages from search results", async () => {
    // Search returns one page
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            object: "page",
            id: "page-1",
            last_edited_time: "2024-01-01T00:00:00Z",
            properties: {
              title: { type: "title", title: [{ plain_text: "Test Page" }] },
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    );
    // Fetch blocks for the page
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            id: "b1",
            type: "paragraph",
            paragraph: { rich_text: [{ plain_text: "Page content here" }] },
            has_children: false,
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    );

    const result = await syncNotion(db, provider, { token: "secret_test123" });

    expect(result.pagesIndexed).toBe(1);
    expect(result.databasesIndexed).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify the document was indexed
    const docs = db.prepare("SELECT * FROM documents WHERE url = ?").all("notion://page/page-1");
    expect(docs).toHaveLength(1);
  });

  it("should index database entries", async () => {
    // Search returns one database
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            object: "database",
            id: "db-1",
            last_edited_time: "2024-01-01T00:00:00Z",
            title: [{ plain_text: "My Database" }],
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    );
    // Query database returns rows
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            object: "page",
            id: "row-1",
            last_edited_time: "2024-01-01T00:00:00Z",
            properties: {
              Name: { type: "title", title: [{ plain_text: "Row 1" }] },
              Status: { type: "select", select: { name: "Active" } },
              Tags: { type: "multi_select", multi_select: [{ name: "tag1" }, { name: "tag2" }] },
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    );
    // Fetch blocks for the row
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            id: "rb1",
            type: "paragraph",
            paragraph: { rich_text: [{ plain_text: "Row content" }] },
            has_children: false,
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    );

    const result = await syncNotion(db, provider, { token: "secret_test123" });

    expect(result.databasesIndexed).toBe(1);
    expect(result.errors).toHaveLength(0);

    const docs = db.prepare("SELECT * FROM documents WHERE url = ?").all("notion://page/row-1");
    expect(docs).toHaveLength(1);
  });

  it("should skip excluded pages", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            object: "page",
            id: "excluded-page",
            last_edited_time: "2024-01-01T00:00:00Z",
            properties: {
              title: { type: "title", title: [{ plain_text: "Excluded" }] },
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    );

    const result = await syncNotion(db, provider, {
      token: "secret_test123",
      excludePages: ["excluded-page"],
    });

    expect(result.pagesIndexed).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1); // Only the search call
  });

  it("should use lastSync for incremental sync", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ results: [], has_more: false, next_cursor: null }),
    );

    await syncNotion(db, provider, {
      token: "secret_test123",
      lastSync: "2024-01-01T00:00:00Z",
    });

    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit] | undefined;
    const callBody = JSON.parse(callArgs?.[1]?.body as string) as Record<string, unknown>;
    expect(callBody).toHaveProperty("filter");
    const filter = callBody["filter"] as Record<string, unknown>;
    expect(filter).toHaveProperty("timestamp", "last_edited_time");
  });

  it("should handle auth failure (401)", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401));

    await expect(syncNotion(db, provider, { token: "secret_bad" })).rejects.toThrow(
      ValidationError,
    );
  });

  it("should handle rate limiting (429)", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ message: "Rate limited" }, 429));

    await expect(syncNotion(db, provider, { token: "secret_test123" })).rejects.toThrow(FetchError);
  });

  it("should collect errors for individual pages", async () => {
    // Search returns one page
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            object: "page",
            id: "err-page",
            last_edited_time: "2024-01-01T00:00:00Z",
            properties: {
              title: { type: "title", title: [{ plain_text: "Error Page" }] },
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    );
    // Fetching blocks fails
    mockFetch.mockResolvedValueOnce(jsonResponse({ message: "Not found" }, 404));

    const result = await syncNotion(db, provider, { token: "secret_test123" });

    expect(result.pagesIndexed).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.page).toBe("Error Page");
  });

  it("should skip empty pages", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            object: "page",
            id: "empty-page",
            last_edited_time: "2024-01-01T00:00:00Z",
            properties: {
              title: { type: "title", title: [{ plain_text: "Empty" }] },
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    );
    // Blocks returns empty
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ results: [], has_more: false, next_cursor: null }),
    );

    const result = await syncNotion(db, provider, { token: "secret_test123" });
    expect(result.pagesIndexed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("should skip database row pages", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            object: "page",
            id: "db-row-page",
            last_edited_time: "2024-01-01T00:00:00Z",
            parent: { type: "database_id", database_id: "parent-db" },
            properties: {
              title: { type: "title", title: [{ plain_text: "DB Row" }] },
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    );

    const result = await syncNotion(db, provider, { token: "secret_test123" });
    expect(result.pagesIndexed).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should handle pagination in search results", async () => {
    // First page
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            object: "page",
            id: "page-a",
            last_edited_time: "2024-01-01T00:00:00Z",
            properties: { title: { type: "title", title: [{ plain_text: "Page A" }] } },
          },
        ],
        has_more: true,
        next_cursor: "cursor-1",
      }),
    );
    // Second page of search
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ results: [], has_more: false, next_cursor: null }),
    );
    // Blocks for page-a
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            id: "b1",
            type: "paragraph",
            paragraph: { rich_text: [{ plain_text: "Content" }] },
            has_children: false,
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    );

    const result = await syncNotion(db, provider, { token: "secret_test123" });
    expect(result.pagesIndexed).toBe(1);
    // Two search calls + one blocks call
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

describe("disconnectNotion", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDbWithVec();
  });

  afterEach(() => {
    db.close();
  });

  it("should remove Notion documents", async () => {
    // Insert some Notion documents
    db.prepare(
      `INSERT INTO documents (id, source_type, title, content, url, content_hash, submitted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("d1", "manual", "Notion Page", "content", "notion://page/p1", "hash1", "crawler");
    db.prepare(
      `INSERT INTO documents (id, source_type, title, content, url, content_hash, submitted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("d2", "manual", "Regular Doc", "content", "https://example.com", "hash2", "manual");
    db.prepare(
      `INSERT INTO documents (id, source_type, title, content, url, content_hash, submitted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("d3", "manual", "Another Notion", "content", "notion://page/p2", "hash3", "crawler");

    const removed = await disconnectNotion(db);
    expect(removed).toBe(2);

    // Regular doc should remain
    const remaining = db.prepare("SELECT * FROM documents").all();
    expect(remaining).toHaveLength(1);
  });

  it("should return 0 when no Notion documents exist", async () => {
    const removed = await disconnectNotion(db);
    expect(removed).toBe(0);
  });
});
