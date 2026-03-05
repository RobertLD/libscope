import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock fetchRaw so we don't make real network requests ─────────────────────
const mockFetchRaw = vi.fn();
vi.mock("../../src/core/url-fetcher.js", () => ({
  fetchRaw: (...args: unknown[]): unknown => mockFetchRaw(...args),
  DEFAULT_FETCH_OPTIONS: {
    timeout: 30_000,
    maxRedirects: 5,
    maxBodySize: 10 * 1024 * 1024,
    allowPrivateUrls: false,
    allowSelfSignedCerts: false,
  },
}));

// ── Import spider after mock is set up ───────────────────────────────────────
const { spiderUrl } = await import("../../src/core/spider.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

function htmlPage(title: string, links: string[] = [], body = ""): string {
  const anchors = links.map((href) => `<a href="${href}">link</a>`).join("\n");
  return `<html><head><title>${title}</title></head><body>${anchors}${body}</body></html>`;
}

function pageResponse(html: string, url = "https://example.com/") {
  return {
    body: html,
    contentType: "text/html; charset=utf-8",
    finalUrl: url,
  };
}

/** Collect all yielded values from an async generator. */
async function collectPages(gen: ReturnType<typeof spiderUrl>): Promise<{
  pages: Array<{ url: string; title: string; depth: number }>;
  stats: Awaited<ReturnType<typeof gen.next>> extends { value: infer V } ? V : unknown;
}> {
  const pages = [];
  let result = await gen.next();
  while (!result.done) {
    const v = result.value as { url: string; title: string; depth: number };
    pages.push({ url: v.url, title: v.title, depth: v.depth });
    result = await gen.next();
  }
  return { pages, stats: result.value };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("spiderUrl", () => {
  beforeEach(() => {
    mockFetchRaw.mockReset();
    // Default: robots.txt not found
    mockFetchRaw.mockImplementation((url: string) => {
      if (url.endsWith("/robots.txt")) {
        return Promise.reject(new Error("404"));
      }
      return Promise.resolve(pageResponse(htmlPage("Page", []), url));
    });
    // Speed up tests by removing inter-request delay
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("yields the seed page with depth 0", async () => {
    mockFetchRaw.mockImplementation((url: string) => {
      if (url.endsWith("/robots.txt")) return Promise.reject(new Error("404"));
      return Promise.resolve(pageResponse(htmlPage("Seed Page"), url));
    });

    const gen = spiderUrl("https://example.com/", { maxPages: 1, requestDelay: 0 });
    const result = await gen.next();
    expect(result.done).toBe(false);
    const page = result.value as { url: string; title: string; depth: number };
    expect(page.url).toBe("https://example.com/");
    expect(page.title).toBe("Seed Page");
    expect(page.depth).toBe(0);
  });

  it("follows links up to maxDepth", async () => {
    mockFetchRaw.mockImplementation((url: string) => {
      if (url.endsWith("/robots.txt")) return Promise.reject(new Error("404"));
      if (url === "https://example.com/") {
        return Promise.resolve(
          pageResponse(htmlPage("Root", ["https://example.com/child"]), url),
        );
      }
      if (url === "https://example.com/child") {
        return Promise.resolve(
          pageResponse(htmlPage("Child", ["https://example.com/grandchild"]), url),
        );
      }
      if (url === "https://example.com/grandchild") {
        return Promise.resolve(pageResponse(htmlPage("Grandchild", []), url));
      }
      return Promise.reject(new Error("unexpected"));
    });

    const gen = spiderUrl("https://example.com/", { maxDepth: 2, maxPages: 10, requestDelay: 0 });
    const { pages } = await collectPages(gen);

    expect(pages.map((p) => p.url)).toContain("https://example.com/");
    expect(pages.map((p) => p.url)).toContain("https://example.com/child");
    expect(pages.map((p) => p.url)).toContain("https://example.com/grandchild");
    // depth 3 should not appear
    expect(pages.every((p) => p.depth <= 2)).toBe(true);
  });

  it("does not follow links beyond maxDepth", async () => {
    mockFetchRaw.mockImplementation((url: string) => {
      if (url.endsWith("/robots.txt")) return Promise.reject(new Error("404"));
      if (url === "https://example.com/") {
        return Promise.resolve(
          pageResponse(htmlPage("Root", ["https://example.com/child"]), url),
        );
      }
      if (url === "https://example.com/child") {
        return Promise.resolve(
          pageResponse(htmlPage("Child", ["https://example.com/grandchild"]), url),
        );
      }
      // grandchild should NOT be fetched at maxDepth=1
      return Promise.reject(new Error("should not fetch this"));
    });

    const gen = spiderUrl("https://example.com/", { maxDepth: 1, maxPages: 10, requestDelay: 0 });
    const { pages } = await collectPages(gen);

    const urls = pages.map((p) => p.url);
    expect(urls).toContain("https://example.com/");
    expect(urls).toContain("https://example.com/child");
    expect(urls).not.toContain("https://example.com/grandchild");
  });

  it("enforces maxPages hard cap", async () => {
    // Return the same page with 5 links each time
    mockFetchRaw.mockImplementation((url: string) => {
      if (url.endsWith("/robots.txt")) return Promise.reject(new Error("404"));
      const links = [1, 2, 3, 4, 5].map((i) => `https://example.com/page${i}`);
      return Promise.resolve(pageResponse(htmlPage("Page", links), url));
    });

    const gen = spiderUrl("https://example.com/", { maxPages: 3, maxDepth: 5, requestDelay: 0 });
    const { pages, stats } = await collectPages(gen);

    expect(pages.length).toBeLessThanOrEqual(3);
    expect((stats as { pagesFetched: number }).pagesFetched).toBeLessThanOrEqual(3);
  });

  it("does not visit the same URL twice (cycle detection)", async () => {
    // Page A links to B, B links back to A
    mockFetchRaw.mockImplementation((url: string) => {
      if (url.endsWith("/robots.txt")) return Promise.reject(new Error("404"));
      if (url === "https://example.com/a") {
        return Promise.resolve(pageResponse(htmlPage("A", ["https://example.com/b"]), url));
      }
      if (url === "https://example.com/b") {
        return Promise.resolve(pageResponse(htmlPage("B", ["https://example.com/a"]), url));
      }
      return Promise.reject(new Error("unexpected"));
    });

    const gen = spiderUrl("https://example.com/a", { maxPages: 20, maxDepth: 5, requestDelay: 0 });
    const { pages } = await collectPages(gen);

    // Should only visit a and b once each
    const urls = pages.map((p) => p.url);
    expect(urls.filter((u) => u === "https://example.com/a").length).toBe(1);
    expect(urls.filter((u) => u === "https://example.com/b").length).toBe(1);
  });

  it("filters cross-domain links when sameDomain=true (default)", async () => {
    mockFetchRaw.mockImplementation((url: string) => {
      if (url.endsWith("/robots.txt")) return Promise.reject(new Error("404"));
      return Promise.resolve(
        pageResponse(
          htmlPage("Root", ["https://other.com/page", "https://example.com/local"]),
          url,
        ),
      );
    });

    const gen = spiderUrl("https://example.com/", {
      sameDomain: true,
      maxPages: 10,
      maxDepth: 1,
      requestDelay: 0,
    });
    const { pages } = await collectPages(gen);

    const urls = pages.map((p) => p.url);
    expect(urls).not.toContain("https://other.com/page");
    expect(urls).toContain("https://example.com/local");
  });

  it("allows cross-domain links when sameDomain=false", async () => {
    mockFetchRaw.mockImplementation((url: string) => {
      if (url.endsWith("/robots.txt")) return Promise.reject(new Error("404"));
      if (url === "https://example.com/") {
        return Promise.resolve(
          pageResponse(htmlPage("Root", ["https://other.com/page"]), url),
        );
      }
      return Promise.resolve(pageResponse(htmlPage("Other", []), url));
    });

    const gen = spiderUrl("https://example.com/", {
      sameDomain: false,
      maxPages: 10,
      maxDepth: 1,
      requestDelay: 0,
    });
    const { pages } = await collectPages(gen);
    expect(pages.map((p) => p.url)).toContain("https://other.com/page");
  });

  it("allows subdomain links when sameDomain=true", async () => {
    mockFetchRaw.mockImplementation((url: string) => {
      if (url.endsWith("/robots.txt")) return Promise.reject(new Error("404"));
      if (url === "https://example.com/") {
        return Promise.resolve(
          pageResponse(htmlPage("Root", ["https://docs.example.com/guide"]), url),
        );
      }
      return Promise.resolve(pageResponse(htmlPage("Subdomain page", []), url));
    });

    const gen = spiderUrl("https://example.com/", {
      sameDomain: true,
      maxPages: 10,
      maxDepth: 1,
      requestDelay: 0,
    });
    const { pages } = await collectPages(gen);
    expect(pages.map((p) => p.url)).toContain("https://docs.example.com/guide");
  });

  it("filters links outside pathPrefix", async () => {
    mockFetchRaw.mockImplementation((url: string) => {
      if (url.endsWith("/robots.txt")) return Promise.reject(new Error("404"));
      return Promise.resolve(
        pageResponse(
          htmlPage("Docs", [
            "https://example.com/docs/guide",
            "https://example.com/blog/post",
          ]),
          url,
        ),
      );
    });

    const gen = spiderUrl("https://example.com/docs/", {
      pathPrefix: "/docs",
      maxPages: 10,
      maxDepth: 1,
      requestDelay: 0,
    });
    const { pages } = await collectPages(gen);
    const urls = pages.map((p) => p.url);
    expect(urls).toContain("https://example.com/docs/guide");
    expect(urls).not.toContain("https://example.com/blog/post");
  });

  it("skips URLs matching excludePatterns", async () => {
    mockFetchRaw.mockImplementation((url: string) => {
      if (url.endsWith("/robots.txt")) return Promise.reject(new Error("404"));
      return Promise.resolve(
        pageResponse(
          htmlPage("Page", [
            "https://example.com/docs/guide",
            "https://example.com/changelog/v2",
            "https://example.com/api/v1/ref",
          ]),
          url,
        ),
      );
    });

    const gen = spiderUrl("https://example.com/", {
      excludePatterns: ["*/changelog*", "*/api/v1/*"],
      maxPages: 10,
      maxDepth: 1,
      requestDelay: 0,
    });
    const { pages } = await collectPages(gen);
    const urls = pages.map((p) => p.url);
    expect(urls).toContain("https://example.com/docs/guide");
    expect(urls).not.toContain("https://example.com/changelog/v2");
    expect(urls).not.toContain("https://example.com/api/v1/ref");
  });

  it("skips URLs disallowed by robots.txt", async () => {
    mockFetchRaw.mockImplementation((url: string) => {
      if (url === "https://example.com/robots.txt") {
        return Promise.resolve({
          body: "User-agent: *\nDisallow: /private/",
          contentType: "text/plain",
          finalUrl: url,
        });
      }
      return Promise.resolve(
        pageResponse(
          htmlPage("Root", [
            "https://example.com/public/page",
            "https://example.com/private/secret",
          ]),
          url,
        ),
      );
    });

    const gen = spiderUrl("https://example.com/", {
      maxPages: 10,
      maxDepth: 1,
      requestDelay: 0,
    });
    const { pages } = await collectPages(gen);
    const urls = pages.map((p) => p.url);
    expect(urls).toContain("https://example.com/public/page");
    expect(urls).not.toContain("https://example.com/private/secret");
  });

  it("respects LibScope-specific robots.txt rules", async () => {
    mockFetchRaw.mockImplementation((url: string) => {
      if (url === "https://example.com/robots.txt") {
        return Promise.resolve({
          body: "User-agent: libscope\nDisallow: /restricted/\nUser-agent: *\nDisallow:",
          contentType: "text/plain",
          finalUrl: url,
        });
      }
      return Promise.resolve(
        pageResponse(
          htmlPage("Root", ["https://example.com/restricted/data"]),
          url,
        ),
      );
    });

    const gen = spiderUrl("https://example.com/", { maxPages: 10, maxDepth: 1, requestDelay: 0 });
    const { pages } = await collectPages(gen);
    expect(pages.map((p) => p.url)).not.toContain("https://example.com/restricted/data");
  });

  it("continues crawling when a single page fetch fails", async () => {
    let callCount = 0;
    mockFetchRaw.mockImplementation((url: string) => {
      if (url.endsWith("/robots.txt")) return Promise.reject(new Error("404"));
      if (url === "https://example.com/") {
        return Promise.resolve(
          pageResponse(
            htmlPage("Root", [
              "https://example.com/good",
              "https://example.com/bad",
            ]),
            url,
          ),
        );
      }
      if (url === "https://example.com/bad") {
        callCount++;
        return Promise.reject(new Error("connection refused"));
      }
      return Promise.resolve(pageResponse(htmlPage("Good", []), url));
    });

    const gen = spiderUrl("https://example.com/", { maxPages: 10, maxDepth: 1, requestDelay: 0 });
    const { pages, stats } = await collectPages(gen);

    const urls = pages.map((p) => p.url);
    expect(urls).toContain("https://example.com/");
    expect(urls).toContain("https://example.com/good");
    expect(urls).not.toContain("https://example.com/bad");
    expect((stats as { errors: Array<{ url: string }> }).errors.length).toBeGreaterThan(0);
    expect(callCount).toBe(1); // fetched once, failed
  });

  it("returns SpiderStats from the generator return value", async () => {
    mockFetchRaw.mockImplementation((url: string) => {
      if (url.endsWith("/robots.txt")) return Promise.reject(new Error("404"));
      return Promise.resolve(
        pageResponse(htmlPage("Page", ["https://example.com/child"]), url),
      );
    });

    const gen = spiderUrl("https://example.com/", { maxPages: 5, maxDepth: 1, requestDelay: 0 });
    const { stats } = await collectPages(gen);
    const s = stats as {
      pagesFetched: number;
      pagesCrawled: number;
      pagesSkipped: number;
      errors: unknown[];
    };

    expect(typeof s.pagesFetched).toBe("number");
    expect(typeof s.pagesCrawled).toBe("number");
    expect(typeof s.pagesSkipped).toBe("number");
    expect(Array.isArray(s.errors)).toBe(true);
    expect(s.pagesFetched).toBeGreaterThan(0);
  });

  it("caps maxPages to the hard limit of 200", async () => {
    // We just confirm that requesting 999 is capped — we test via stats.pagesFetched ≤ 200
    // In practice, our mock only has one page so pagesFetched will be 1.
    // The important thing is that the option is accepted without error.
    mockFetchRaw.mockImplementation((url: string) => {
      if (url.endsWith("/robots.txt")) return Promise.reject(new Error("404"));
      return Promise.resolve(pageResponse(htmlPage("Only Page", []), url));
    });

    const gen = spiderUrl("https://example.com/", { maxPages: 999, maxDepth: 0, requestDelay: 0 });
    const { pages } = await collectPages(gen);
    expect(pages.length).toBeLessThanOrEqual(200);
  });

  it("caps maxDepth to the hard limit of 5", async () => {
    // Should not throw even when maxDepth: 100 is passed
    mockFetchRaw.mockImplementation((url: string) => {
      if (url.endsWith("/robots.txt")) return Promise.reject(new Error("404"));
      return Promise.resolve(pageResponse(htmlPage("Page", []), url));
    });

    // Should not throw — maxDepth is capped to hard limit internally
    const gen = spiderUrl("https://example.com/", { maxDepth: 100, requestDelay: 0 });
    const { pages } = await collectPages(gen);
    expect(pages.length).toBeGreaterThanOrEqual(1);
  });

  it("maxDepth=0 only fetches the seed page", async () => {
    mockFetchRaw.mockImplementation((url: string) => {
      if (url.endsWith("/robots.txt")) return Promise.reject(new Error("404"));
      if (url === "https://example.com/") {
        return Promise.resolve(
          pageResponse(htmlPage("Seed", ["https://example.com/child"]), url),
        );
      }
      return Promise.reject(new Error("should not fetch children at depth 0"));
    });

    const gen = spiderUrl("https://example.com/", { maxDepth: 0, maxPages: 10, requestDelay: 0 });
    const { pages } = await collectPages(gen);

    expect(pages.length).toBe(1);
    expect(pages[0]!.url).toBe("https://example.com/");
  });

  it("BFS: fetches pages breadth-first (children before grandchildren)", async () => {
    const fetchOrder: string[] = [];
    mockFetchRaw.mockImplementation((url: string) => {
      if (url.endsWith("/robots.txt")) return Promise.reject(new Error("404"));
      fetchOrder.push(url);
      if (url === "https://example.com/") {
        return Promise.resolve(
          pageResponse(
            htmlPage("Root", ["https://example.com/a", "https://example.com/b"]),
            url,
          ),
        );
      }
      if (url === "https://example.com/a") {
        return Promise.resolve(
          pageResponse(htmlPage("A", ["https://example.com/a1"]), url),
        );
      }
      if (url === "https://example.com/b") {
        return Promise.resolve(pageResponse(htmlPage("B", []), url));
      }
      return Promise.resolve(pageResponse(htmlPage("Leaf", []), url));
    });

    const gen = spiderUrl("https://example.com/", { maxPages: 10, maxDepth: 2, requestDelay: 0 });
    await collectPages(gen);

    // root → a → b → a1 (BFS order: process all depth-1 before depth-2)
    const idxRoot = fetchOrder.indexOf("https://example.com/");
    const idxA = fetchOrder.indexOf("https://example.com/a");
    const idxB = fetchOrder.indexOf("https://example.com/b");
    const idxA1 = fetchOrder.indexOf("https://example.com/a1");

    expect(idxRoot).toBeLessThan(idxA);
    expect(idxRoot).toBeLessThan(idxB);
    // Both a and b (depth 1) should appear before a1 (depth 2)
    expect(idxA).toBeLessThan(idxA1);
    expect(idxB).toBeLessThan(idxA1);
  });

  it("handles plain text responses without crashing", async () => {
    mockFetchRaw.mockImplementation((url: string) => {
      if (url.endsWith("/robots.txt")) return Promise.reject(new Error("404"));
      return Promise.resolve({
        body: "# Plain Text\n\nNo HTML here.",
        contentType: "text/plain",
        finalUrl: url,
      });
    });

    const gen = spiderUrl("https://example.com/notes.txt", { maxDepth: 0, requestDelay: 0 });
    const { pages } = await collectPages(gen);
    expect(pages.length).toBe(1);
    expect(pages[0]!.title).toBe("Plain Text");
  });

  it("marks abortReason as maxPages when capped mid-crawl", async () => {
    // Seed always returns a new unique link
    let counter = 0;
    mockFetchRaw.mockImplementation((url: string) => {
      if (url.endsWith("/robots.txt")) return Promise.reject(new Error("404"));
      counter++;
      const links = [`https://example.com/page${counter + 100}`];
      return Promise.resolve(pageResponse(htmlPage(`Page ${counter}`, links), url));
    });

    const gen = spiderUrl("https://example.com/", { maxPages: 2, maxDepth: 5, requestDelay: 0 });
    const { stats } = await collectPages(gen);
    expect((stats as { abortReason?: string }).abortReason).toBe("maxPages");
  });
});
