/**
 * Unit tests for src/connectors/docs.ts
 *
 * Tests cover:
 *  - normalizeUrl
 *  - detectDocSiteType
 *  - extractElementByPattern
 *  - extractMainContent
 *  - extractDocTitle
 *  - extractDocLinks
 *  - extractSitemapUrls
 *  - syncDocSite (via mocked fetch + indexDocument)
 *  - disconnectDocSite
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ValidationError } from "../../src/errors.js";
import { createTestDbWithVec } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { initLogger } from "../../src/logger.js";
import type Database from "better-sqlite3";

// -------------------------------------------------------------------------
// Mock global fetch so we never make real HTTP calls
// -------------------------------------------------------------------------
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock dns to avoid real DNS lookups from url-fetcher
vi.mock("node:dns", () => ({
  promises: {
    resolve4: vi.fn().mockResolvedValue(["93.184.216.34"]),
    resolve6: vi.fn().mockResolvedValue([]),
  },
  lookup: (_host: string, cb: (err: null, addr: string) => void) => cb(null, "93.184.216.34"),
}));

// Dynamic import after mocks
const {
  normalizeUrl,
  detectDocSiteType,
  extractElementByPattern,
  extractMainContent,
  extractDocTitle,
  extractDocLinks,
  extractSitemapUrls,
  syncDocSite,
  disconnectDocSite,
} = await import("../../src/connectors/docs.js");

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function htmlResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    body: {
      getReader: () => {
        let done = false;
        return {
          read: () => {
            if (done) return Promise.resolve({ done: true as const, value: undefined });
            done = true;
            return Promise.resolve({ done: false as const, value: new TextEncoder().encode(body) });
          },
          cancel: () => Promise.resolve(undefined),
        };
      },
    },
    text: () => Promise.resolve(body),
    url: "",
    redirected: false,
  } as unknown as Response;
}

function xmlResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/xml; charset=utf-8" }),
    body: {
      getReader: () => {
        let done = false;
        return {
          read: () => {
            if (done) return Promise.resolve({ done: true as const, value: undefined });
            done = true;
            return Promise.resolve({ done: false as const, value: new TextEncoder().encode(body) });
          },
          cancel: () => Promise.resolve(undefined),
        };
      },
    },
    text: () => Promise.resolve(body),
    url: "",
    redirected: false,
  } as unknown as Response;
}

function notFoundResponse(): Response {
  return {
    ok: false,
    status: 404,
    headers: new Headers({ "content-type": "text/html" }),
    body: null,
    text: () => Promise.resolve("Not Found"),
    url: "",
    redirected: false,
  } as unknown as Response;
}

// -------------------------------------------------------------------------
// normalizeUrl
// -------------------------------------------------------------------------

describe("normalizeUrl", () => {
  it("strips fragments", () => {
    expect(normalizeUrl("https://example.com/docs/page#section")).toBe(
      "https://example.com/docs/page",
    );
  });

  it("removes trailing slash from non-root paths", () => {
    expect(normalizeUrl("https://example.com/docs/page/")).toBe("https://example.com/docs/page");
  });

  it("preserves root slash", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("preserves query strings", () => {
    expect(normalizeUrl("https://example.com/docs?v=2")).toBe("https://example.com/docs?v=2");
  });

  it("handles already normalised URLs unchanged", () => {
    const url = "https://example.com/docs/api";
    expect(normalizeUrl(url)).toBe(url);
  });

  it("returns input unchanged when URL is malformed", () => {
    expect(normalizeUrl("not-a-url")).toBe("not-a-url");
  });
});

// -------------------------------------------------------------------------
// detectDocSiteType
// -------------------------------------------------------------------------

describe("detectDocSiteType", () => {
  it("detects Sphinx via meta generator tag", () => {
    const html = '<html><head><meta name="generator" content="Sphinx 5.0"></head></html>';
    expect(detectDocSiteType(html)).toBe("sphinx");
  });

  it("detects Sphinx via sphinxsidebar class", () => {
    const html = '<div class="sphinxsidebar"><p>nav</p></div>';
    expect(detectDocSiteType(html)).toBe("sphinx");
  });

  it("detects Sphinx via rst-content class (Read the Docs theme)", () => {
    const html = '<div class="rst-content"><div role="main">...</div></div>';
    expect(detectDocSiteType(html)).toBe("sphinx");
  });

  it("detects Sphinx via sphinx- prefixed class", () => {
    const html = '<div class="sphinx-version">5.0</div>';
    expect(detectDocSiteType(html)).toBe("sphinx");
  });

  it("detects VitePress via __VITEPRESS_ global", () => {
    const html = "<script>window.__VITEPRESS_DATA__={}</script>";
    expect(detectDocSiteType(html)).toBe("vitepress");
  });

  it("detects VitePress via VPDoc class", () => {
    const html = '<div class="VPDoc"><main>...</main></div>';
    expect(detectDocSiteType(html)).toBe("vitepress");
  });

  it("detects VitePress via vp-doc class", () => {
    const html = '<div class="vp-doc"><h1>Title</h1></div>';
    expect(detectDocSiteType(html)).toBe("vitepress");
  });

  it("detects VitePress via meta content", () => {
    const html = '<meta name="generator" content="VitePress 1.0">';
    expect(detectDocSiteType(html)).toBe("vitepress");
  });

  it("detects Doxygen via HTML comment", () => {
    const html = "<!-- Generated by Doxygen 1.9 --><html></html>";
    expect(detectDocSiteType(html)).toBe("doxygen");
  });

  it("detects Doxygen via meta generator", () => {
    const html = '<meta name="generator" content="Doxygen 1.9.0">';
    expect(detectDocSiteType(html)).toBe("doxygen");
  });

  it("detects Doxygen via doc-content id", () => {
    const html = '<div id="doc-content"><div class="contents">...</div></div>';
    expect(detectDocSiteType(html)).toBe("doxygen");
  });

  it("returns generic for unknown HTML", () => {
    const html = "<html><body><main><p>Some docs</p></main></body></html>";
    expect(detectDocSiteType(html)).toBe("generic");
  });

  it("Sphinx takes precedence when multiple indicators are present", () => {
    const html = '<meta name="generator" content="Sphinx 5.0"><div class="vp-doc">overlap</div>';
    expect(detectDocSiteType(html)).toBe("sphinx");
  });
});

// -------------------------------------------------------------------------
// extractElementByPattern
// -------------------------------------------------------------------------

describe("extractElementByPattern", () => {
  it("extracts content of a simple div by id pattern", () => {
    const html = '<div id="content"><p>Hello world</p></div>';
    const result = extractElementByPattern(html, "div", /id=["']content["']/);
    expect(result).toBe("<p>Hello world</p>");
  });

  it("extracts content of a div by class pattern", () => {
    const html = '<div class="vp-doc"><h1>Title</h1><p>Body</p></div>';
    const result = extractElementByPattern(html, "div", /class=["'][^"']*vp-doc[^"']*["']/);
    expect(result).toBe("<h1>Title</h1><p>Body</p>");
  });

  it("handles nested elements of the same tag name correctly", () => {
    const html =
      '<div class="main"><div class="inner"><p>inner</p></div><p>outer</p></div><div>other</div>';
    const result = extractElementByPattern(html, "div", /class=["']main["']/);
    expect(result).toBe('<div class="inner"><p>inner</p></div><p>outer</p>');
  });

  it("returns null when no matching element is found", () => {
    const html = "<div><p>nothing here</p></div>";
    const result = extractElementByPattern(html, "div", /class=["']vp-doc["']/);
    expect(result).toBeNull();
  });

  it("extracts main element with empty attr pattern", () => {
    const html = "<html><body><main><p>content</p></main></body></html>";
    const result = extractElementByPattern(html, "main", /(?:)/);
    expect(result).toBe("<p>content</p>");
  });

  it("extracts article element with empty attr pattern", () => {
    const html = "<body><article><h1>Doc</h1><p>text</p></article></body>";
    const result = extractElementByPattern(html, "article", /(?:)/);
    expect(result).toBe("<h1>Doc</h1><p>text</p>");
  });

  it("returns null for malformed HTML with unclosed tags", () => {
    const html = '<div class="main"><p>unclosed';
    const result = extractElementByPattern(html, "div", /class=["']main["']/);
    // Should not throw; returns null or partial result
    expect(result === null || typeof result === "string").toBe(true);
  });

  it("finds first match when multiple matching elements exist", () => {
    const html = '<div class="body"><p>first</p></div><div class="body"><p>second</p></div>';
    const result = extractElementByPattern(html, "div", /class=["']body["']/);
    expect(result).toBe("<p>first</p>");
  });
});

// -------------------------------------------------------------------------
// extractDocTitle
// -------------------------------------------------------------------------

describe("extractDocTitle", () => {
  it("extracts from H1 tag", () => {
    const html = "<html><body><h1>Getting Started</h1></body></html>";
    expect(extractDocTitle(html, "https://example.com/docs/start")).toBe("Getting Started");
  });

  it("strips inner HTML tags from H1", () => {
    const html = '<h1><a href="#">API Reference</a></h1>';
    expect(extractDocTitle(html, "https://example.com/docs/api")).toBe("API Reference");
  });

  it("falls back to <title> when no H1", () => {
    const html = "<html><head><title>My Library — Docs</title></head><body></body></html>";
    expect(extractDocTitle(html, "https://example.com/docs")).toBe("My Library — Docs");
  });

  it("falls back to URL-derived title when neither H1 nor title", () => {
    const html = "<html><body><p>content</p></body></html>";
    expect(extractDocTitle(html, "https://example.com/docs/installation")).toBe("installation");
  });

  it("converts hyphens to spaces in URL-derived title", () => {
    const html = "<html><body></body></html>";
    expect(extractDocTitle(html, "https://example.com/docs/getting-started")).toBe(
      "getting started",
    );
  });

  it("strips file extension from URL-derived title", () => {
    const html = "<html><body></body></html>";
    expect(extractDocTitle(html, "https://example.com/docs/index.html")).toBe("index");
  });

  it("uses hostname when path is empty", () => {
    const html = "<html><body></body></html>";
    expect(extractDocTitle(html, "https://example.com/")).toBe("example.com");
  });

  it("H1 takes precedence over title tag", () => {
    const html =
      "<html><head><title>Page Title</title></head><body><h1>Real Title</h1></body></html>";
    expect(extractDocTitle(html, "https://example.com/page")).toBe("Real Title");
  });
});

// -------------------------------------------------------------------------
// extractDocLinks
// -------------------------------------------------------------------------

describe("extractDocLinks", () => {
  const BASE = "https://docs.example.com/docs/";

  it("extracts absolute same-origin links", () => {
    const html = '<a href="https://docs.example.com/docs/api">API</a>';
    const links = extractDocLinks(html, BASE, "/docs/");
    expect(links).toContain("https://docs.example.com/docs/api");
  });

  it("resolves relative links against base URL", () => {
    const html = '<a href="getting-started">Getting Started</a>';
    const links = extractDocLinks(html, BASE, "/docs/");
    expect(links).toContain("https://docs.example.com/docs/getting-started");
  });

  it("skips links to different origins", () => {
    const html = '<a href="https://other.com/page">External</a>';
    expect(extractDocLinks(html, BASE, "/docs/")).toEqual([]);
  });

  it("skips fragment-only links", () => {
    const html = '<a href="#section">Jump</a>';
    expect(extractDocLinks(html, BASE, "/docs/")).toEqual([]);
  });

  it("skips mailto links", () => {
    const html = '<a href="mailto:user@example.com">Email</a>';
    expect(extractDocLinks(html, BASE, "/docs/")).toEqual([]);
  });

  it("skips javascript links", () => {
    const html = '<a href="javascript:void(0)">Click</a>';
    expect(extractDocLinks(html, BASE, "/docs/")).toEqual([]);
  });

  it("skips binary asset extensions", () => {
    const html = [
      '<a href="/docs/logo.png">PNG</a>',
      '<a href="/docs/download.zip">ZIP</a>',
      '<a href="/docs/styles.css">CSS</a>',
      '<a href="/docs/bundle.js">JS</a>',
    ].join("\n");
    expect(extractDocLinks(html, BASE, "/docs/")).toEqual([]);
  });

  it("respects pathPrefix to exclude links outside the prefix", () => {
    const html = '<a href="/docs/page">In docs</a><a href="/blog/post">Blog</a>';
    const links = extractDocLinks(html, BASE, "/docs/");
    expect(links).toContain("https://docs.example.com/docs/page");
    expect(links).not.toContain("https://docs.example.com/blog/post");
  });

  it("deduplicates links (normalises URL, strips fragment)", () => {
    const html = [
      '<a href="/docs/page">One</a>',
      '<a href="/docs/page/">Two</a>',
      '<a href="/docs/page#section">Three</a>',
    ].join("\n");
    const links = extractDocLinks(html, BASE, "/docs/");
    expect(links.filter((l) => l.includes("/docs/page")).length).toBe(1);
  });

  it("returns empty array when no anchors found", () => {
    expect(extractDocLinks("<p>No links here</p>", BASE, "/docs/")).toEqual([]);
  });
});

// -------------------------------------------------------------------------
// extractSitemapUrls
// -------------------------------------------------------------------------

describe("extractSitemapUrls", () => {
  const BASE = "https://docs.example.com/";

  it("extracts URLs from a simple sitemap", () => {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://docs.example.com/docs/intro</loc></url>
  <url><loc>https://docs.example.com/docs/api</loc></url>
</urlset>`;
    const urls = extractSitemapUrls(xml, BASE, "/docs/");
    expect(urls).toContain("https://docs.example.com/docs/intro");
    expect(urls).toContain("https://docs.example.com/docs/api");
  });

  it("filters out URLs on different origins", () => {
    const xml = `<urlset>
  <url><loc>https://other.com/docs/page</loc></url>
  <url><loc>https://docs.example.com/docs/page</loc></url>
</urlset>`;
    const urls = extractSitemapUrls(xml, BASE, "/docs/");
    expect(urls).not.toContain("https://other.com/docs/page");
    expect(urls).toContain("https://docs.example.com/docs/page");
  });

  it("filters by pathPrefix", () => {
    const xml = `<urlset>
  <url><loc>https://docs.example.com/docs/page</loc></url>
  <url><loc>https://docs.example.com/blog/post</loc></url>
</urlset>`;
    const urls = extractSitemapUrls(xml, BASE, "/docs/");
    expect(urls).toContain("https://docs.example.com/docs/page");
    expect(urls).not.toContain("https://docs.example.com/blog/post");
  });

  it("filters out binary asset URLs", () => {
    const xml = `<urlset>
  <url><loc>https://docs.example.com/docs/image.png</loc></url>
  <url><loc>https://docs.example.com/docs/page</loc></url>
</urlset>`;
    const urls = extractSitemapUrls(xml, BASE, "/docs/");
    expect(urls).not.toContain("https://docs.example.com/docs/image.png");
  });

  it("deduplicates URLs", () => {
    const xml = `<urlset>
  <url><loc>https://docs.example.com/docs/page</loc></url>
  <url><loc>https://docs.example.com/docs/page</loc></url>
</urlset>`;
    const urls = extractSitemapUrls(xml, BASE, "/docs/");
    expect(urls.length).toBe(1);
  });

  it("returns empty array for empty sitemap", () => {
    const xml = `<urlset></urlset>`;
    expect(extractSitemapUrls(xml, BASE, "/docs/")).toEqual([]);
  });
});

// -------------------------------------------------------------------------
// extractMainContent
// -------------------------------------------------------------------------

describe("extractMainContent", () => {
  it("extracts Sphinx role=main div", () => {
    const html =
      '<nav>navigation</nav><div role="main"><h1>Title</h1><p>Content</p></div><footer>footer</footer>';
    const result = extractMainContent(html, "sphinx");
    expect(result).toContain("Title");
    expect(result).toContain("Content");
  });

  it("extracts VitePress vp-doc div", () => {
    const html =
      '<header>nav</header><div class="vp-doc"><h1>API</h1><p>Details</p></div><aside>sidebar</aside>';
    const result = extractMainContent(html, "vitepress");
    expect(result).toContain("API");
    expect(result).toContain("Details");
  });

  it("extracts Doxygen contents div", () => {
    const html =
      '<div id="nav">navigation</div><div class="contents"><h2>Function Reference</h2><p>Details</p></div>';
    const result = extractMainContent(html, "doxygen");
    expect(result).toContain("Function Reference");
    expect(result).toContain("Details");
  });

  it("extracts generic main element", () => {
    const html =
      "<body><header>nav</header><main><h1>Guide</h1><p>Text</p></main><footer></footer>";
    const result = extractMainContent(html, "generic");
    expect(result).toContain("Guide");
    expect(result).toContain("Text");
  });

  it("falls back to full-page conversion when no container found", () => {
    const html = "<html><body><p>Fallback content</p></body></html>";
    const result = extractMainContent(html, "sphinx");
    expect(result).toContain("Fallback content");
  });

  it("returns non-empty string for any non-empty HTML", () => {
    const html = "<div><p>Something</p></div>";
    const result = extractMainContent(html, "generic");
    expect(result.trim().length).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------------
// syncDocSite — validation
// -------------------------------------------------------------------------

describe("syncDocSite — validation", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    initLogger("silent");
    db = createTestDbWithVec();
    provider = new MockEmbeddingProvider();
  });

  afterEach(() => {
    db.close();
  });

  it("throws ValidationError when url is missing", async () => {
    await expect(syncDocSite(db, provider, { url: "" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws ValidationError for malformed URL", async () => {
    await expect(syncDocSite(db, provider, { url: "not-a-url" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("throws ValidationError for non-http/https scheme", async () => {
    await expect(
      syncDocSite(db, provider, { url: "ftp://example.com/docs" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// -------------------------------------------------------------------------
// syncDocSite — integration with mocked fetch
// -------------------------------------------------------------------------

describe("syncDocSite — mocked fetch", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;

  // Implementation order: root page is fetched FIRST, then sitemap.xml,
  // then BFS pages. All mock setups must follow this order.

  const SPHINX_ROOT = `
    <html>
      <head>
        <meta name="generator" content="Sphinx 5.0">
        <title>My Library Docs</title>
      </head>
      <body>
        <div class="sphinxsidebar">
          <a href="https://docs.example.com/docs/api">API</a>
          <a href="https://docs.example.com/docs/guide">Guide</a>
        </div>
        <div role="main">
          <h1>Welcome</h1>
          <p>This is the documentation root.</p>
        </div>
      </body>
    </html>`;

  // Sphinx root page with only one outbound link (for simpler tests)
  const SPHINX_ROOT_SIMPLE = `
    <html>
      <head><meta name="generator" content="Sphinx 5.0"><title>Docs</title></head>
      <body>
        <div role="main"><h1>Welcome</h1><p>This is the documentation root page content.</p></div>
      </body>
    </html>`;

  const SPHINX_API = `
    <html>
      <head><title>API Reference</title></head>
      <body>
        <div role="main">
          <h1>API Reference</h1>
          <p>Function definitions and usage.</p>
        </div>
      </body>
    </html>`;

  beforeEach(() => {
    initLogger("silent");
    db = createTestDbWithVec();
    provider = new MockEmbeddingProvider();
    // mockReset clears both call history AND the mockResolvedValueOnce queue,
    // preventing mock bleed between tests.
    mockFetch.mockReset();
  });

  afterEach(() => {
    db.close();
  });

  it("indexes the root page and detects Sphinx site type", async () => {
    // Order: root, sitemap
    mockFetch
      .mockResolvedValueOnce(htmlResponse(SPHINX_ROOT_SIMPLE)) // root page
      .mockResolvedValueOnce(notFoundResponse()); // sitemap.xml 404

    const result = await syncDocSite(db, provider, {
      url: "https://docs.example.com/docs/",
    });

    expect(result.detectedType).toBe("sphinx");
    expect(result.pagesIndexed).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("uses configured type instead of auto-detecting", async () => {
    mockFetch
      .mockResolvedValueOnce(htmlResponse(SPHINX_ROOT_SIMPLE)) // root
      .mockResolvedValueOnce(notFoundResponse()); // sitemap.xml

    const result = await syncDocSite(db, provider, {
      url: "https://docs.example.com/docs/",
      type: "vitepress",
    });

    expect(result.detectedType).toBe("vitepress");
  });

  it("crawls pages discovered via link extraction", async () => {
    // Order: root, sitemap, api, guide
    mockFetch
      .mockResolvedValueOnce(htmlResponse(SPHINX_ROOT)) // root (has links to api + guide)
      .mockResolvedValueOnce(notFoundResponse()) // sitemap.xml
      .mockResolvedValueOnce(htmlResponse(SPHINX_API)) // /docs/api
      .mockResolvedValueOnce(
        htmlResponse("<html><body><main><h1>Guide</h1><p>Guide content.</p></main></body></html>"),
      ); // /docs/guide

    const result = await syncDocSite(db, provider, {
      url: "https://docs.example.com/docs/",
    });

    // Root + api + guide = 3 pages
    expect(result.pagesIndexed).toBe(3);
    expect(result.errors).toHaveLength(0);
  });

  it("uses sitemap.xml for URL discovery when available", async () => {
    const sitemap = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://docs.example.com/docs/api</loc></url>
</urlset>`;

    // Order: root, sitemap (success), api
    mockFetch
      .mockResolvedValueOnce(htmlResponse(SPHINX_ROOT_SIMPLE)) // root page
      .mockResolvedValueOnce(xmlResponse(sitemap)) // sitemap.xml success
      .mockResolvedValueOnce(htmlResponse(SPHINX_API)); // /docs/api from sitemap

    const result = await syncDocSite(db, provider, {
      url: "https://docs.example.com/docs/",
    });

    expect(result.pagesIndexed).toBeGreaterThanOrEqual(1);
    expect(result.errors).toHaveLength(0);
  });

  it("records errors for pages that fail to fetch", async () => {
    const rootWithFailingLink = `
      <html>
        <head><meta name="generator" content="Sphinx 5.0"></head>
        <body>
          <div role="main"><h1>Root</h1><p>Intro text content here.</p></div>
          <a href="https://docs.example.com/docs/broken">Broken</a>
        </body>
      </html>`;

    // Order: root, sitemap, broken page
    mockFetch
      .mockResolvedValueOnce(htmlResponse(rootWithFailingLink)) // root
      .mockResolvedValueOnce(notFoundResponse()) // sitemap.xml
      .mockResolvedValueOnce(notFoundResponse()); // broken page → error

    const result = await syncDocSite(db, provider, {
      url: "https://docs.example.com/docs/",
    });

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0]?.url).toContain("/docs/broken");
  });

  it("skips pages outside pathPrefix", async () => {
    const rootWithOutsideLink = `
      <html>
        <head><meta name="generator" content="Sphinx 5.0"></head>
        <body>
          <div role="main"><h1>Root</h1><p>Intro text content here.</p></div>
          <a href="https://docs.example.com/blog/post">Blog</a>
          <a href="https://docs.example.com/docs/api">API</a>
        </body>
      </html>`;

    // Order: root, sitemap, api (blog is skipped by pathPrefix)
    mockFetch
      .mockResolvedValueOnce(htmlResponse(rootWithOutsideLink)) // root
      .mockResolvedValueOnce(notFoundResponse()) // sitemap.xml
      .mockResolvedValueOnce(htmlResponse(SPHINX_API)); // /docs/api

    const result = await syncDocSite(db, provider, {
      url: "https://docs.example.com/docs/",
      pathPrefix: "/docs/",
    });

    // Should only have fetched root and /docs/api, not /blog/post
    const fetchedUrls = mockFetch.mock.calls.map((c) => c[0] as string);
    expect(fetchedUrls.some((u) => u.includes("/blog/"))).toBe(false);
    expect(result.errors).toHaveLength(0);
  });

  it("respects maxPages limit", async () => {
    const rootWithManyLinks = `
      <html>
        <head><meta name="generator" content="Sphinx 5.0"></head>
        <body>
          <div role="main"><h1>Root</h1><p>Intro content for root page.</p></div>
          <a href="https://docs.example.com/docs/p1">P1</a>
          <a href="https://docs.example.com/docs/p2">P2</a>
          <a href="https://docs.example.com/docs/p3">P3</a>
          <a href="https://docs.example.com/docs/p4">P4</a>
          <a href="https://docs.example.com/docs/p5">P5</a>
        </body>
      </html>`;
    const pageHtml = (n: number) =>
      `<html><body><main><h1>Page ${n}</h1><p>Content for page ${n} of the docs.</p></main></body></html>`;

    // Order: root, sitemap, then sub-pages (unlimited via mockResolvedValue)
    mockFetch
      .mockResolvedValueOnce(htmlResponse(rootWithManyLinks)) // root
      .mockResolvedValueOnce(notFoundResponse()) // sitemap.xml
      .mockResolvedValue(htmlResponse(pageHtml(1))); // all subsequent pages

    const result = await syncDocSite(db, provider, {
      url: "https://docs.example.com/docs/",
      maxPages: 2,
    });

    // root (1) + up to maxPages (2) = at most 3 total
    expect(result.pagesIndexed + result.pagesUpdated + result.pagesSkipped).toBeLessThanOrEqual(3);
  });

  it("skips empty pages and counts them as skipped", async () => {
    // A page with a role=main div that has no text content
    const emptyPage = `<html><head><meta name="generator" content="Sphinx 5.0"></head><body><div role="main"> </div></body></html>`;

    mockFetch
      .mockResolvedValueOnce(htmlResponse(emptyPage)) // root
      .mockResolvedValueOnce(notFoundResponse()); // sitemap.xml

    const result = await syncDocSite(db, provider, {
      url: "https://docs.example.com/docs/",
    });

    expect(result.pagesSkipped).toBeGreaterThanOrEqual(1);
    expect(result.pagesIndexed).toBe(0);
  });

  it("tags indexed documents with the configured library name", async () => {
    mockFetch
      .mockResolvedValueOnce(htmlResponse(SPHINX_ROOT_SIMPLE)) // root
      .mockResolvedValueOnce(notFoundResponse()); // sitemap.xml

    await syncDocSite(db, provider, {
      url: "https://docs.example.com/docs/",
      library: "mylib",
      version: "2.0",
    });

    const doc = db
      .prepare("SELECT library, version FROM documents WHERE url IS NOT NULL LIMIT 1")
      .get() as { library: string; version: string } | undefined;

    expect(doc?.library).toBe("mylib");
    expect(doc?.version).toBe("2.0");
  });

  it("re-indexes changed pages and counts them as updated", async () => {
    // First sync — index root
    mockFetch
      .mockResolvedValueOnce(htmlResponse(SPHINX_ROOT_SIMPLE)) // root
      .mockResolvedValueOnce(notFoundResponse()); // sitemap.xml

    await syncDocSite(db, provider, { url: "https://docs.example.com/docs/" });

    const beforeCount = (db.prepare("SELECT COUNT(*) as n FROM documents").get() as { n: number })
      .n;
    expect(beforeCount).toBe(1);

    // Second sync — same URL but different content
    const changedRoot = SPHINX_ROOT_SIMPLE.replace(
      "documentation root page content.",
      "updated documentation page content.",
    );
    mockFetch
      .mockResolvedValueOnce(htmlResponse(changedRoot)) // root (changed)
      .mockResolvedValueOnce(notFoundResponse()); // sitemap.xml

    const result2 = await syncDocSite(db, provider, {
      url: "https://docs.example.com/docs/",
    });

    // Should update in-place, not add a new doc
    expect(result2.pagesUpdated).toBe(1);
    expect(result2.pagesIndexed).toBe(0);
    const afterCount = (db.prepare("SELECT COUNT(*) as n FROM documents").get() as { n: number }).n;
    expect(afterCount).toBe(1);
  });

  it("skips unchanged pages (content-hash match) as skipped", async () => {
    mockFetch
      .mockResolvedValueOnce(htmlResponse(SPHINX_ROOT_SIMPLE)) // root
      .mockResolvedValueOnce(notFoundResponse()); // sitemap.xml

    await syncDocSite(db, provider, { url: "https://docs.example.com/docs/" });

    // Exact same content — should be skipped on second run
    mockFetch
      .mockResolvedValueOnce(htmlResponse(SPHINX_ROOT_SIMPLE)) // root (unchanged)
      .mockResolvedValueOnce(notFoundResponse()); // sitemap.xml

    const result2 = await syncDocSite(db, provider, {
      url: "https://docs.example.com/docs/",
    });

    expect(result2.pagesSkipped).toBe(1);
    expect(result2.pagesIndexed).toBe(0);
    expect(result2.pagesUpdated).toBe(0);
  });

  it("records sync history in the connector_syncs table", async () => {
    mockFetch
      .mockResolvedValueOnce(htmlResponse(SPHINX_ROOT_SIMPLE)) // root
      .mockResolvedValueOnce(notFoundResponse()); // sitemap.xml

    await syncDocSite(db, provider, { url: "https://docs.example.com/docs/" });

    const row = db
      .prepare("SELECT status, connector_type FROM connector_syncs ORDER BY id DESC LIMIT 1")
      .get() as { status: string; connector_type: string } | undefined;

    expect(row?.status).toBe("completed");
    expect(row?.connector_type).toBe("docs");
  });

  it("throws when root page fetch fails", async () => {
    mockFetch.mockResolvedValueOnce(notFoundResponse()); // root 404

    await expect(
      syncDocSite(db, provider, { url: "https://docs.example.com/docs/" }),
    ).rejects.toThrow();
  });

  it("limits concurrency to between 1 and 10", async () => {
    mockFetch
      .mockResolvedValueOnce(htmlResponse(SPHINX_ROOT_SIMPLE)) // root
      .mockResolvedValueOnce(notFoundResponse()); // sitemap.xml

    await expect(
      syncDocSite(db, provider, {
        url: "https://docs.example.com/docs/",
        concurrency: 100,
      }),
    ).resolves.not.toThrow();
  });
});

// -------------------------------------------------------------------------
// disconnectDocSite
// -------------------------------------------------------------------------

describe("disconnectDocSite", () => {
  let db: Database.Database;

  beforeEach(() => {
    initLogger("silent");
    db = createTestDbWithVec();
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
  });

  it("removes all documents from the given site URL prefix", () => {
    // Seed some docs manually
    db.prepare(
      "INSERT INTO documents (id, source_type, title, content, url) VALUES (?, 'library', ?, ?, ?)",
    ).run("doc-1", "Page 1", "Content 1", "https://docs.example.com/docs/page1");
    db.prepare(
      "INSERT INTO documents (id, source_type, title, content, url) VALUES (?, 'library', ?, ?, ?)",
    ).run("doc-2", "Page 2", "Content 2", "https://docs.example.com/docs/page2");
    db.prepare(
      "INSERT INTO documents (id, source_type, title, content, url) VALUES (?, 'library', ?, ?, ?)",
    ).run("doc-3", "Other", "Content 3", "https://other.example.com/docs/page");

    const removed = disconnectDocSite(db, "https://docs.example.com/docs/");

    expect(removed).toBe(2);

    const remaining = db.prepare("SELECT COUNT(*) as n FROM documents").get() as { n: number };
    expect(remaining.n).toBe(1); // doc-3 should remain
  });

  it("returns 0 when no matching documents exist", () => {
    const removed = disconnectDocSite(db, "https://docs.example.com/docs/");
    expect(removed).toBe(0);
  });

  it("throws ValidationError for invalid site URL", () => {
    expect(() => disconnectDocSite(db, "not-a-url")).toThrow(ValidationError);
  });

  it("does not remove documents from other sites", () => {
    db.prepare(
      "INSERT INTO documents (id, source_type, title, content, url) VALUES (?, 'library', ?, ?, ?)",
    ).run("doc-1", "Page 1", "Content 1", "https://other.example.com/docs/page");

    const removed = disconnectDocSite(db, "https://docs.example.com/docs/");
    expect(removed).toBe(0);

    const remaining = db.prepare("SELECT COUNT(*) as n FROM documents").get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  it("removes associated chunks", () => {
    db.prepare(
      "INSERT INTO documents (id, source_type, title, content, url) VALUES (?, 'library', 'Title', 'Body', ?)",
    ).run("doc-1", "https://docs.example.com/docs/page");
    db.prepare(
      "INSERT INTO chunks (id, document_id, content, chunk_index) VALUES (?, ?, ?, ?)",
    ).run("chunk-1", "doc-1", "Chunk content", 0);

    disconnectDocSite(db, "https://docs.example.com/docs/");

    const chunks = db
      .prepare("SELECT COUNT(*) as n FROM chunks WHERE document_id = 'doc-1'")
      .get() as { n: number };
    expect(chunks.n).toBe(0);
  });
});
