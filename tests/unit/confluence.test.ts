import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDbWithVec } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import {
  syncConfluence,
  convertConfluenceStorage,
  disconnectConfluence,
  buildAuthHeader,
} from "../../src/connectors/confluence.js";
import type { ConfluenceConfig } from "../../src/connectors/confluence.js";
import type Database from "better-sqlite3";

function makeSpacesResponse(spaces: Array<{ id: string; key: string; name: string }>) {
  return { results: spaces, _links: {} };
}

function makePagesResponse(
  pages: Array<{
    id: string;
    title: string;
    spaceId: string;
    version?: { number: number };
  }>,
  nextLink?: string,
) {
  return {
    results: pages.map((p) => ({
      ...p,
      version: p.version ?? { number: 1 },
    })),
    _links: nextLink ? { next: nextLink } : {},
  };
}

function makePageDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: "page-1",
    title: "Test Page",
    spaceId: "space-1",
    version: { number: 1 },
    body: { storage: { value: "<p>Hello world</p>" } },
    labels: { results: [{ name: "docs" }, { name: "api" }] },
    _links: { webui: "/wiki/spaces/ENG/pages/page-1" },
    ...overrides,
  };
}

describe("Confluence connector", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createTestDbWithVec();
    provider = new MockEmbeddingProvider();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  function mockFetchResponse(body: unknown, ok = true, status = 200): Response {
    return {
      ok,
      status,
      statusText: ok ? "OK" : "Error",
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
      headers: new Headers(),
      redirected: false,
      type: "basic",
      url: "",
      clone: () => mockFetchResponse(body, ok, status),
      body: null,
      bodyUsed: false,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      blob: () => Promise.resolve(new Blob()),
      formData: () => Promise.resolve(new FormData()),
    } as Response;
  }

  const baseConfig: ConfluenceConfig = {
    baseUrl: "https://acme.atlassian.net",
    email: "user@example.com",
    token: "test-token",
    spaces: ["ENG"],
  };

  describe("buildAuthHeader", () => {
    it("should encode email:token as base64", () => {
      const header = buildAuthHeader("user@co.com", "mytoken");
      const expected = Buffer.from("user@co.com:mytoken").toString("base64");
      expect(header).toBe(`Basic ${expected}`);
    });
  });

  describe("convertConfluenceStorage", () => {
    it("should convert basic HTML to markdown", () => {
      const result = convertConfluenceStorage("<h1>Title</h1><p>Hello world</p>");
      expect(result).toContain("Title");
      expect(result).toContain("Hello world");
    });

    it("should convert code macros to fenced code blocks", () => {
      const html = `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">javascript</ac:parameter><ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body></ac:structured-macro>`;
      const result = convertConfluenceStorage(html);
      expect(result).toContain("```javascript");
      expect(result).toContain("const x = 1;");
      expect(result).toContain("```");
    });

    it("should convert info/note/warning/tip macros to blockquotes", () => {
      const html = `<ac:structured-macro ac:name="info"><ac:rich-text-body>This is info</ac:rich-text-body></ac:structured-macro>`;
      const result = convertConfluenceStorage(html);
      expect(result).toContain("Info:");
      expect(result).toContain("This is info");
    });

    it("should convert warning macros", () => {
      const html = `<ac:structured-macro ac:name="warning"><ac:rich-text-body>Danger!</ac:rich-text-body></ac:structured-macro>`;
      const result = convertConfluenceStorage(html);
      expect(result).toContain("Warning:");
      expect(result).toContain("Danger!");
    });

    it("should convert panel macros to blockquotes", () => {
      const html = `<ac:structured-macro ac:name="panel"><ac:rich-text-body>Panel content</ac:rich-text-body></ac:structured-macro>`;
      const result = convertConfluenceStorage(html);
      expect(result).toContain("Panel content");
    });

    it("should handle expand macros", () => {
      const html = `<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">More info</ac:parameter><ac:rich-text-body>Expanded content</ac:rich-text-body></ac:structured-macro>`;
      const result = convertConfluenceStorage(html);
      expect(result).toContain("More info");
      expect(result).toContain("Expanded content");
    });

    it("should strip toc macros", () => {
      const html = `<ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter></ac:structured-macro><p>Content</p>`;
      const result = convertConfluenceStorage(html);
      expect(result).not.toContain("toc");
      expect(result).toContain("Content");
    });

    it("should convert jira macros to JIRA references", () => {
      const html = `<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">PROJ-123</ac:parameter></ac:structured-macro>`;
      const result = convertConfluenceStorage(html);
      expect(result).toContain("[JIRA: PROJ-123]");
    });

    it("should convert ac:image to [image]", () => {
      const html = `<ac:image><ri:attachment ri:filename="diagram.png"/></ac:image>`;
      const result = convertConfluenceStorage(html);
      expect(result).toContain("[image]");
    });

    it("should convert ac:link to markdown links", () => {
      const html = `<ac:link><ri:page ri:content-title="Other Page"/><ac:link-body>Other Page</ac:link-body></ac:link>`;
      const result = convertConfluenceStorage(html);
      expect(result).toContain("Other Page");
    });

    it("should convert ri:attachment to attached reference", () => {
      const html = `<ri:attachment ri:filename="report.pdf"/>`;
      const result = convertConfluenceStorage(html);
      expect(result).toContain("[attached: report.pdf]");
    });

    it("should convert tables to markdown", () => {
      const html = `<table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table>`;
      const result = convertConfluenceStorage(html);
      expect(result).toContain("Name");
      expect(result).toContain("Value");
    });

    it("should strip ac:parameter tags", () => {
      const html = `<ac:parameter ac:name="foo">bar</ac:parameter><p>Content</p>`;
      const result = convertConfluenceStorage(html);
      expect(result).not.toContain("ac:parameter");
      expect(result).toContain("Content");
    });
  });

  describe("syncConfluence", () => {
    it("should validate required config fields", async () => {
      await expect(syncConfluence(db, provider, { ...baseConfig, baseUrl: "" })).rejects.toThrow(
        "baseUrl is required",
      );
      await expect(syncConfluence(db, provider, { ...baseConfig, email: "" })).rejects.toThrow(
        "email is required",
      );
      await expect(syncConfluence(db, provider, { ...baseConfig, token: "" })).rejects.toThrow(
        "token is required",
      );
    });

    it("should list spaces and index pages", async () => {
      fetchMock
        .mockResolvedValueOnce(
          mockFetchResponse(
            makeSpacesResponse([{ id: "space-1", key: "ENG", name: "Engineering" }]),
          ),
        )
        .mockResolvedValueOnce(
          mockFetchResponse(
            makePagesResponse([{ id: "page-1", title: "Getting Started", spaceId: "space-1" }]),
          ),
        )
        .mockResolvedValueOnce(mockFetchResponse(makePageDetail()));

      const result = await syncConfluence(db, provider, baseConfig);

      expect(result.spaces).toBe(1);
      expect(result.pagesIndexed).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it("should handle pagination", async () => {
      fetchMock
        .mockResolvedValueOnce(
          mockFetchResponse(
            makeSpacesResponse([{ id: "space-1", key: "ENG", name: "Engineering" }]),
          ),
        )
        // First page of pages with next link
        .mockResolvedValueOnce(
          mockFetchResponse(
            makePagesResponse(
              [{ id: "page-1", title: "Page 1", spaceId: "space-1" }],
              "/wiki/api/v2/spaces/space-1/pages?cursor=abc",
            ),
          ),
        )
        // Second page of pages (no next link)
        .mockResolvedValueOnce(
          mockFetchResponse(
            makePagesResponse([{ id: "page-2", title: "Page 2", spaceId: "space-1" }]),
          ),
        )
        // Page detail for page-1
        .mockResolvedValueOnce(
          mockFetchResponse(
            makePageDetail({
              id: "page-1",
              title: "Page 1",
              _links: { webui: "/wiki/spaces/ENG/pages/page-1" },
            }),
          ),
        )
        // Page detail for page-2
        .mockResolvedValueOnce(
          mockFetchResponse(
            makePageDetail({
              id: "page-2",
              title: "Page 2",
              body: { storage: { value: "<p>Different content for page two</p>" } },
              _links: { webui: "/wiki/spaces/ENG/pages/page-2" },
            }),
          ),
        );

      const result = await syncConfluence(db, provider, baseConfig);

      expect(result.pagesIndexed).toBe(2);
    });

    it("should extract labels as tags", async () => {
      fetchMock
        .mockResolvedValueOnce(
          mockFetchResponse(
            makeSpacesResponse([{ id: "space-1", key: "ENG", name: "Engineering" }]),
          ),
        )
        .mockResolvedValueOnce(
          mockFetchResponse(
            makePagesResponse([{ id: "page-1", title: "Test Page", spaceId: "space-1" }]),
          ),
        )
        .mockResolvedValueOnce(
          mockFetchResponse(
            makePageDetail({
              labels: { results: [{ name: "api" }, { name: "internal" }] },
            }),
          ),
        );

      await syncConfluence(db, provider, baseConfig);

      // Check tags were created
      const tags = db.prepare("SELECT name FROM tags ORDER BY name").all() as Array<{
        name: string;
      }>;
      const tagNames = tags.map((t) => t.name);
      expect(tagNames).toContain("api");
      expect(tagNames).toContain("internal");
      expect(tagNames).toContain("confluence-space:eng");
    });

    it("should skip unchanged pages on incremental sync", async () => {
      // First sync
      fetchMock
        .mockResolvedValueOnce(
          mockFetchResponse(
            makeSpacesResponse([{ id: "space-1", key: "ENG", name: "Engineering" }]),
          ),
        )
        .mockResolvedValueOnce(
          mockFetchResponse(
            makePagesResponse([{ id: "page-1", title: "Test", spaceId: "space-1" }]),
          ),
        )
        .mockResolvedValueOnce(mockFetchResponse(makePageDetail()));

      await syncConfluence(db, provider, baseConfig);

      // Second sync — same version
      fetchMock
        .mockResolvedValueOnce(
          mockFetchResponse(
            makeSpacesResponse([{ id: "space-1", key: "ENG", name: "Engineering" }]),
          ),
        )
        .mockResolvedValueOnce(
          mockFetchResponse(
            makePagesResponse([{ id: "page-1", title: "Test", spaceId: "space-1" }]),
          ),
        )
        .mockResolvedValueOnce(mockFetchResponse(makePageDetail()));

      const result = await syncConfluence(db, provider, baseConfig);

      expect(result.pagesIndexed).toBe(0);
      expect(result.pagesUpdated).toBe(0);
    });

    it("should update pages when version changes", async () => {
      // First sync
      fetchMock
        .mockResolvedValueOnce(
          mockFetchResponse(
            makeSpacesResponse([{ id: "space-1", key: "ENG", name: "Engineering" }]),
          ),
        )
        .mockResolvedValueOnce(
          mockFetchResponse(
            makePagesResponse([{ id: "page-1", title: "Test", spaceId: "space-1" }]),
          ),
        )
        .mockResolvedValueOnce(mockFetchResponse(makePageDetail()));

      await syncConfluence(db, provider, baseConfig);

      // Second sync — new version
      fetchMock
        .mockResolvedValueOnce(
          mockFetchResponse(
            makeSpacesResponse([{ id: "space-1", key: "ENG", name: "Engineering" }]),
          ),
        )
        .mockResolvedValueOnce(
          mockFetchResponse(
            makePagesResponse([
              { id: "page-1", title: "Test", spaceId: "space-1", version: { number: 2 } },
            ]),
          ),
        )
        .mockResolvedValueOnce(
          mockFetchResponse(
            makePageDetail({
              version: { number: 2 },
              body: { storage: { value: "<p>Updated</p>" } },
            }),
          ),
        );

      const result = await syncConfluence(db, provider, baseConfig);

      expect(result.pagesUpdated).toBe(1);
      expect(result.pagesIndexed).toBe(1);
    });

    it("should handle API errors gracefully", async () => {
      fetchMock
        .mockResolvedValueOnce(
          mockFetchResponse(
            makeSpacesResponse([{ id: "space-1", key: "ENG", name: "Engineering" }]),
          ),
        )
        .mockResolvedValueOnce(
          mockFetchResponse(
            makePagesResponse([{ id: "page-1", title: "Fail Page", spaceId: "space-1" }]),
          ),
        )
        .mockResolvedValueOnce(mockFetchResponse({ error: "Not found" }, false, 404));

      const result = await syncConfluence(db, provider, baseConfig);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.page).toBe("Fail Page");
    });

    it("should filter spaces by config", async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse(
          makeSpacesResponse([
            { id: "space-1", key: "ENG", name: "Engineering" },
            { id: "space-2", key: "HR", name: "Human Resources" },
          ]),
        ),
      );

      // Only ENG pages
      fetchMock.mockResolvedValueOnce(mockFetchResponse(makePagesResponse([])));

      const result = await syncConfluence(db, provider, {
        ...baseConfig,
        spaces: ["ENG"],
      });

      expect(result.spaces).toBe(1);
    });

    it("should exclude spaces", async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse(
          makeSpacesResponse([
            { id: "space-1", key: "ENG", name: "Engineering" },
            { id: "space-2", key: "HR", name: "Human Resources" },
          ]),
        ),
      );

      // Only HR pages (ENG excluded)
      fetchMock.mockResolvedValueOnce(mockFetchResponse(makePagesResponse([])));

      const result = await syncConfluence(db, provider, {
        ...baseConfig,
        spaces: ["all"],
        excludeSpaces: ["ENG"],
      });

      expect(result.spaces).toBe(1);
    });

    it("should use correct auth header in requests", async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse(makeSpacesResponse([])));

      await syncConfluence(db, provider, baseConfig);

      const expectedAuth = buildAuthHeader(baseConfig.email, baseConfig.token);
      const firstCall = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = firstCall[1].headers as Record<string, string>;
      expect(headers["Authorization"]).toBe(expectedAuth);
      expect(firstCall[0]).toContain("/wiki/api/v2/spaces");
    });
  });

  describe("disconnectConfluence", () => {
    it("should remove all confluence documents", async () => {
      // First sync some pages
      fetchMock
        .mockResolvedValueOnce(
          mockFetchResponse(
            makeSpacesResponse([{ id: "space-1", key: "ENG", name: "Engineering" }]),
          ),
        )
        .mockResolvedValueOnce(
          mockFetchResponse(
            makePagesResponse([{ id: "page-1", title: "Page 1", spaceId: "space-1" }]),
          ),
        )
        .mockResolvedValueOnce(mockFetchResponse(makePageDetail()));

      await syncConfluence(db, provider, baseConfig);

      const docsBefore = db.prepare("SELECT COUNT(*) as count FROM documents").get() as {
        count: number;
      };
      expect(docsBefore.count).toBeGreaterThan(0);

      const removed = disconnectConfluence(db);
      expect(removed).toBeGreaterThan(0);
      const docsAfter = db.prepare("SELECT COUNT(*) as count FROM documents").get() as {
        count: number;
      };
      expect(docsAfter.count).toBe(0);
    });

    it("should return 0 when no confluence docs exist", () => {
      const removed = disconnectConfluence(db);
      expect(removed).toBe(0);
    });
  });
});
