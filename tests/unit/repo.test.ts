import { describe, it, expect, vi, beforeEach } from "vitest";
import { ValidationError } from "../../src/errors.js";

// Mock dns.promises so validateHost does not do real DNS lookups
vi.mock("node:dns", () => ({
  promises: {
    resolve4: vi.fn().mockResolvedValue(["140.82.121.3"]),
    resolve6: vi.fn().mockRejectedValue(new Error("no AAAA")),
  },
}));

const { parseRepoUrl, shouldIncludeFile, fetchRepoContents } =
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
});
