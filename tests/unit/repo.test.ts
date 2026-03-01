import { describe, it, expect, vi, beforeEach } from "vitest";
import { FetchError, ValidationError } from "../../src/errors.js";
import { createTestDb, createTestDbWithVec } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";

// Mock dns.promises so validateHost does not do real DNS lookups
vi.mock("node:dns", () => ({
  promises: {
    resolve4: vi.fn().mockResolvedValue(["140.82.121.3"]),
    resolve6: vi.fn().mockRejectedValue(new Error("no AAAA")),
  },
}));

const { parseRepoUrl, shouldIncludeFile, fetchRepoContents, indexRepository } =
  await import("../../src/core/repo.js");

describe("parseRepoUrl", () => {
  it("should parse a basic GitHub URL", () => {
    const result = parseRepoUrl("https://github.com/facebook/react");
    expect(result).toEqual({
      host: "github",
      owner: "facebook",
      repo: "react",
      branch: undefined,
      path: undefined,
    });
  });

  it("should parse a GitHub URL with branch", () => {
    const result = parseRepoUrl("https://github.com/facebook/react/tree/main");
    expect(result).toEqual({
      host: "github",
      owner: "facebook",
      repo: "react",
      branch: "main",
      path: undefined,
    });
  });

  it("should parse a GitHub URL with branch and path", () => {
    const result = parseRepoUrl("https://github.com/facebook/react/tree/main/docs/guides");
    expect(result).toEqual({
      host: "github",
      owner: "facebook",
      repo: "react",
      branch: "main",
      path: "docs/guides",
    });
  });

  it("should parse a GitHub URL with .git suffix", () => {
    const result = parseRepoUrl("https://github.com/owner/repo.git");
    expect(result).toEqual({
      host: "github",
      owner: "owner",
      repo: "repo",
      branch: undefined,
      path: undefined,
    });
  });

  it("should parse a basic GitLab URL", () => {
    const result = parseRepoUrl("https://gitlab.com/inkscape/inkscape");
    expect(result).toEqual({
      host: "gitlab",
      owner: "inkscape",
      repo: "inkscape",
      branch: undefined,
      path: undefined,
    });
  });

  it("should parse a GitLab URL with branch and path", () => {
    const result = parseRepoUrl("https://gitlab.com/inkscape/inkscape/-/tree/master/docs");
    expect(result).toEqual({
      host: "gitlab",
      owner: "inkscape",
      repo: "inkscape",
      branch: "master",
      path: "docs",
    });
  });

  it("should throw on unsupported host", () => {
    expect(() => parseRepoUrl("https://bitbucket.org/owner/repo")).toThrow(ValidationError);
  });

  it("should throw on URL with missing repo", () => {
    expect(() => parseRepoUrl("https://github.com/owner")).toThrow(ValidationError);
  });

  it("should handle trailing slashes", () => {
    const result = parseRepoUrl("https://github.com/owner/repo/");
    expect(result).toEqual({
      host: "github",
      owner: "owner",
      repo: "repo",
      branch: undefined,
      path: undefined,
    });
  });
});

describe("shouldIncludeFile", () => {
  it("should include files with matching extensions", () => {
    expect(shouldIncludeFile("docs/README.md", [".md", ".txt"])).toBe(true);
  });

  it("should exclude files with non-matching extensions", () => {
    expect(shouldIncludeFile("src/main.ts", [".md", ".txt"])).toBe(false);
  });

  it("should be case-insensitive for extensions", () => {
    expect(shouldIncludeFile("docs/GUIDE.MD", [".md"])).toBe(true);
  });

  it("should filter by path prefix when provided", () => {
    expect(shouldIncludeFile("docs/guide.md", [".md"], ["docs"])).toBe(true);
    expect(shouldIncludeFile("src/readme.md", [".md"], ["docs"])).toBe(false);
  });

  it("should allow multiple path prefixes", () => {
    expect(shouldIncludeFile("docs/guide.md", [".md"], ["docs", "wiki"])).toBe(true);
    expect(shouldIncludeFile("wiki/page.md", [".md"], ["docs", "wiki"])).toBe(true);
    expect(shouldIncludeFile("src/readme.md", [".md"], ["docs", "wiki"])).toBe(false);
  });

  it("should include all paths when no prefix is specified", () => {
    expect(shouldIncludeFile("any/deep/path/file.md", [".md"])).toBe(true);
  });

  it("should handle files without extensions", () => {
    expect(shouldIncludeFile("Makefile", [".md", ".txt"])).toBe(false);
  });

  it("should handle .mdx and .rst extensions", () => {
    expect(shouldIncludeFile("docs/page.mdx", [".mdx"])).toBe(true);
    expect(shouldIncludeFile("docs/page.rst", [".rst"])).toBe(true);
  });
});

describe("fetchRepoContents", () => {
  const mockFetch = vi.fn();

  beforeEach(async () => {
    mockFetch.mockReset();
    globalThis.fetch = mockFetch;
    // Re-setup DNS mock after restoreAllMocks
    const dnsModule = await import("node:dns");
    vi.mocked(dnsModule.promises.resolve4).mockResolvedValue(["140.82.121.3"]);
    vi.mocked(dnsModule.promises.resolve6).mockRejectedValue(new Error("no AAAA"));
  });

  it("should fetch GitHub tree and file contents", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tree: [
            { path: "README.md", type: "blob", size: 100 },
            { path: "docs/guide.md", type: "blob", size: 200 },
            { path: "src/index.ts", type: "blob", size: 300 },
            { path: "src", type: "tree" },
          ],
          truncated: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    mockFetch.mockResolvedValueOnce(new Response("# README\nHello world", { status: 200 }));
    mockFetch.mockResolvedValueOnce(new Response("# Guide\nSome guide content", { status: 200 }));

    const files = await fetchRepoContents({
      url: "https://github.com/test/repo",
      extensions: [".md"],
    });

    expect(files).toHaveLength(2);
    expect(files[0]!.path).toBe("README.md");
    expect(files[0]!.content).toBe("# README\nHello world");
    expect(files[1]!.path).toBe("docs/guide.md");
  });

  it("should respect path prefix filtering", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tree: [
            { path: "README.md", type: "blob", size: 100 },
            { path: "docs/guide.md", type: "blob", size: 200 },
          ],
          truncated: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    mockFetch.mockResolvedValueOnce(new Response("# Guide", { status: 200 }));

    const files = await fetchRepoContents({
      url: "https://github.com/test/repo",
      paths: ["docs"],
      extensions: [".md"],
    });

    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("docs/guide.md");
  });

  it("should pass token as Authorization header", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ tree: [], truncated: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await fetchRepoContents({
      url: "https://github.com/test/repo",
      token: "ghp_testtoken123",
      extensions: [".md"],
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const callHeaders = mockFetch.mock.calls[0]![1]!.headers;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(callHeaders["Authorization"]).toBe("Bearer ghp_testtoken123");
  });

  it("should handle truncated GitHub tree", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tree: [{ path: "README.md", type: "blob", size: 100 }],
          truncated: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    mockFetch.mockResolvedValueOnce(new Response("# README", { status: 200 }));

    const files = await fetchRepoContents({
      url: "https://github.com/test/repo",
      extensions: [".md"],
    });

    expect(files).toHaveLength(1);
  });

  it("should skip files that fail to fetch content", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tree: [
            { path: "good.md", type: "blob", size: 100 },
            { path: "bad.md", type: "blob", size: 200 },
          ],
          truncated: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    // First file succeeds
    mockFetch.mockResolvedValueOnce(new Response("# Good", { status: 200 }));
    // Second file fails with a non-ok status
    mockFetch.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, statusText: "Not Found" }),
    );

    const files = await fetchRepoContents({
      url: "https://github.com/test/repo",
      extensions: [".md"],
    });

    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("good.md");
  });

  it("should throw FetchError on HTTP error response", async () => {
    mockFetch.mockResolvedValue(
      new Response("Server Error", { status: 500, statusText: "Internal Server Error" }),
    );

    await expect(
      fetchRepoContents({
        url: "https://github.com/test/repo",
        extensions: [".md"],
      }),
    ).rejects.toThrow(FetchError);
  });

  it("should throw FetchError when rate limit exceeded (403 + remaining=0)", async () => {
    mockFetch.mockResolvedValue(
      new Response("Rate limit exceeded", {
        status: 403,
        statusText: "Forbidden",
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" },
      }),
    );

    await expect(
      fetchRepoContents({
        url: "https://github.com/test/repo",
        extensions: [".md"],
      }),
    ).rejects.toThrow("rate limit exceeded");
  });

  it("should retry on 429 rate limit and continue", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // First call: 429 rate limited
    mockFetch.mockResolvedValueOnce(
      new Response("Too Many Requests", {
        status: 429,
        statusText: "Too Many Requests",
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 2),
        },
      }),
    );

    // Second call: success with tree
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ tree: [], truncated: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await fetchRepoContents({
      url: "https://github.com/test/repo",
      extensions: [".md"],
    });

    expect(result).toHaveLength(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("should back off when rate limit remaining is low", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ tree: [], truncated: false }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "5",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 2),
        },
      }),
    );

    const files = await fetchRepoContents({
      url: "https://github.com/test/repo",
      extensions: [".md"],
    });

    expect(files).toHaveLength(0);

    vi.useRealTimers();
  });

  it("should retry on network errors and eventually throw FetchError", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    mockFetch.mockRejectedValue(new TypeError("fetch failed"));

    await expect(
      fetchRepoContents({
        url: "https://github.com/test/repo",
        extensions: [".md"],
      }),
    ).rejects.toThrow(FetchError);

    expect(mockFetch.mock.calls.length).toBe(3); // MAX_RETRIES = 3

    vi.useRealTimers();
  });

  it("should throw FetchError when DNS resolution fails", async () => {
    const dnsModule = await import("node:dns");
    vi.mocked(dnsModule.promises.resolve4).mockRejectedValue(new Error("ENOTFOUND"));
    vi.mocked(dnsModule.promises.resolve6).mockRejectedValue(new Error("ENOTFOUND"));

    await expect(
      fetchRepoContents({
        url: "https://github.com/test/repo",
        extensions: [".md"],
      }),
    ).rejects.toThrow("DNS resolution failed");
  });

  it("should throw FetchError when hostname resolves to private IP", async () => {
    const dnsModule = await import("node:dns");
    vi.mocked(dnsModule.promises.resolve4).mockResolvedValue(["127.0.0.1"]);
    vi.mocked(dnsModule.promises.resolve6).mockRejectedValue(new Error("no AAAA"));

    await expect(
      fetchRepoContents({
        url: "https://github.com/test/repo",
        extensions: [".md"],
      }),
    ).rejects.toThrow("private/internal IP");
  });

  it("should fetch GitLab tree and file contents", async () => {
    // GitLab tree response
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { path: "README.md", type: "blob" },
          { path: "docs/guide.md", type: "blob" },
          { path: "src", type: "tree" },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    // File contents
    mockFetch.mockResolvedValueOnce(new Response("# GitLab README", { status: 200 }));
    mockFetch.mockResolvedValueOnce(new Response("# GitLab Guide", { status: 200 }));

    const files = await fetchRepoContents({
      url: "https://gitlab.com/owner/repo",
      extensions: [".md"],
    });

    expect(files).toHaveLength(2);
    expect(files[0]!.path).toBe("README.md");
    expect(files[0]!.content).toBe("# GitLab README");
    expect(files[1]!.path).toBe("docs/guide.md");
  });

  it("should use branch from URL for GitLab", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify([{ path: "doc.md", type: "blob" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    mockFetch.mockResolvedValueOnce(new Response("content", { status: 200 }));

    await fetchRepoContents({
      url: "https://gitlab.com/owner/repo/-/tree/develop",
      extensions: [".md"],
    });

    // Verify the tree URL contains the branch
    const treeCallUrl = mockFetch.mock.calls[0]![0] as string;
    expect(treeCallUrl).toContain("ref=develop");
  });

  it("should skip files that fail to fetch on GitLab", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { path: "good.md", type: "blob" },
          { path: "bad.md", type: "blob" },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    mockFetch.mockResolvedValueOnce(new Response("# Good", { status: 200 }));
    mockFetch.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, statusText: "Not Found" }),
    );

    const files = await fetchRepoContents({
      url: "https://gitlab.com/owner/repo",
      extensions: [".md"],
    });

    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("good.md");
  });

  it("should filter GitLab files by path prefix", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { path: "README.md", type: "blob" },
          { path: "docs/guide.md", type: "blob" },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    mockFetch.mockResolvedValueOnce(new Response("# Guide", { status: 200 }));

    const files = await fetchRepoContents({
      url: "https://gitlab.com/owner/repo",
      paths: ["docs"],
      extensions: [".md"],
    });

    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("docs/guide.md");
  });

  it("should report progress via onProgress callback", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tree: [{ path: "README.md", type: "blob", size: 100 }],
          truncated: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    mockFetch.mockResolvedValueOnce(new Response("# README", { status: 200 }));

    const progress: string[] = [];
    await fetchRepoContents({ url: "https://github.com/test/repo", extensions: [".md"] }, (msg) =>
      progress.push(msg),
    );

    expect(progress).toContain("Fetching tree...");
    expect(progress.some((m) => m.includes("Found 1 docs"))).toBe(true);
    expect(progress.some((m) => m.includes("README.md"))).toBe(true);
  });
});

describe("indexRepository", () => {
  const mockFetch = vi.fn();
  let db: ReturnType<typeof createTestDb>;
  let provider: MockEmbeddingProvider;

  beforeEach(async () => {
    mockFetch.mockReset();
    globalThis.fetch = mockFetch;
    db = createTestDbWithVec();
    provider = new MockEmbeddingProvider();

    const dnsModule = await import("node:dns");
    vi.mocked(dnsModule.promises.resolve4).mockResolvedValue(["140.82.121.3"]);
    vi.mocked(dnsModule.promises.resolve6).mockRejectedValue(new Error("no AAAA"));
  });

  function mockGitHubTree(files: Array<{ path: string }>) {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tree: files.map((f) => ({ path: f.path, type: "blob", size: 100 })),
          truncated: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }

  it("should index files from a repository", async () => {
    mockGitHubTree([{ path: "README.md" }, { path: "docs/guide.md" }]);
    mockFetch.mockResolvedValueOnce(new Response("# README content", { status: 200 }));
    mockFetch.mockResolvedValueOnce(new Response("# Guide content", { status: 200 }));

    const result = await indexRepository(db, provider, {
      url: "https://github.com/test/repo",
      extensions: [".md"],
    });

    expect(result.indexed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("should skip files with unchanged content hash", async () => {
    // First indexing
    mockGitHubTree([{ path: "README.md" }]);
    mockFetch.mockResolvedValueOnce(new Response("# README", { status: 200 }));

    await indexRepository(db, provider, {
      url: "https://github.com/test/repo",
      extensions: [".md"],
    });

    // Second indexing with same content
    mockGitHubTree([{ path: "README.md" }]);
    mockFetch.mockResolvedValueOnce(new Response("# README", { status: 200 }));

    const result = await indexRepository(db, provider, {
      url: "https://github.com/test/repo",
      extensions: [".md"],
    });

    expect(result.skipped).toBe(1);
    expect(result.indexed).toBe(0);
  });

  it("should re-index files with changed content hash", async () => {
    // First indexing
    mockGitHubTree([{ path: "README.md" }]);
    mockFetch.mockResolvedValueOnce(new Response("# Version 1", { status: 200 }));

    await indexRepository(db, provider, {
      url: "https://github.com/test/repo",
      extensions: [".md"],
    });

    // Second indexing with different content
    mockGitHubTree([{ path: "README.md" }]);
    mockFetch.mockResolvedValueOnce(new Response("# Version 2", { status: 200 }));

    const result = await indexRepository(db, provider, {
      url: "https://github.com/test/repo",
      extensions: [".md"],
    });

    expect(result.indexed).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("should record errors for files that fail to index", async () => {
    mockGitHubTree([{ path: "README.md" }]);
    mockFetch.mockResolvedValueOnce(new Response("# README", { status: 200 }));

    // Make indexDocument fail by closing the db
    const brokenDb = createTestDbWithVec();
    brokenDb.close();

    const result = await indexRepository(brokenDb, provider, {
      url: "https://github.com/test/repo",
      extensions: [".md"],
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("README.md");
  });

  it("should report progress during indexing", async () => {
    mockGitHubTree([{ path: "README.md" }]);
    mockFetch.mockResolvedValueOnce(new Response("# README", { status: 200 }));

    const progress: string[] = [];
    await indexRepository(
      db,
      provider,
      { url: "https://github.com/test/repo", extensions: [".md"] },
      (msg) => progress.push(msg),
    );

    expect(progress.some((m) => m.includes("Indexing"))).toBe(true);
  });

  it("should use branch from options over URL branch", async () => {
    mockGitHubTree([{ path: "doc.md" }]);
    mockFetch.mockResolvedValueOnce(new Response("content", { status: 200 }));

    await indexRepository(db, provider, {
      url: "https://github.com/test/repo/tree/main",
      branch: "develop",
      extensions: [".md"],
    });

    const treeCallUrl = mockFetch.mock.calls[0]![0] as string;
    expect(treeCallUrl).toContain("develop");
  });

  it("should default to main branch when none specified", async () => {
    mockGitHubTree([{ path: "doc.md" }]);
    mockFetch.mockResolvedValueOnce(new Response("content", { status: 200 }));

    await indexRepository(db, provider, {
      url: "https://github.com/test/repo",
      extensions: [".md"],
    });

    const treeCallUrl = mockFetch.mock.calls[0]![0] as string;
    expect(treeCallUrl).toContain("main");
  });

  it("should derive title from filename by stripping extension", async () => {
    mockGitHubTree([{ path: "docs/getting-started.md" }]);
    mockFetch.mockResolvedValueOnce(new Response("# Getting Started", { status: 200 }));

    await indexRepository(db, provider, {
      url: "https://github.com/test/repo",
      extensions: [".md"],
    });

    const doc = db.prepare("SELECT title FROM documents LIMIT 1").get() as { title: string };
    expect(doc.title).toBe("getting-started");
  });
});
