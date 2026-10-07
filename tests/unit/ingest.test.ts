import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createTestDb } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { initLogger } from "../../src/logger.js";
import { ValidationError } from "../../src/errors.js";

vi.mock("../../src/core/url-fetcher.js", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    fetchAndConvert: vi.fn((url: string) =>
      Promise.resolve({ title: `Page ${url}`, content: `Fetched content of ${url}` }),
    ),
  };
});

vi.mock("../../src/core/spider.js", () => ({
  // eslint-disable-next-line @typescript-eslint/require-await
  spiderUrl: async function* (
    url: string,
  ): AsyncGenerator<
    { url: string; title: string; content: string; depth: number },
    { pagesFetched: number; pagesCrawled: number; pagesSkipped: number; errors: never[] }
  > {
    yield { url, title: "Seed", content: "Seed page content", depth: 0 };
    yield { url: `${url}/empty`, title: "Empty", content: "   ", depth: 1 };
    return { pagesFetched: 2, pagesCrawled: 2, pagesSkipped: 1, errors: [] };
  },
}));

vi.mock("../../src/core/repo.js", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    indexRepository: vi.fn(() =>
      Promise.resolve({
        indexed: 1,
        skipped: 2,
        errors: ["bad.md: HTTP 404"],
        documents: [{ documentId: "repo-doc", title: "README", chunkCount: 3, path: "README.md" }],
      }),
    ),
  };
});

const { detectIngestKind, ingest, listDirectoryFiles } = await import("../../src/core/ingest.js");
const { resolveSourceType } = await import("../../src/core/indexing.js");
const { isRepoUrl, indexRepository } = await import("../../src/core/repo.js");
const { getDocumentTags } = await import("../../src/core/tags.js");

initLogger("silent");

describe("resolveSourceType", () => {
  it("prefers explicit, then library, then topic, then manual", () => {
    expect(resolveSourceType({ sourceType: "model-generated", library: "x" })).toBe(
      "model-generated",
    );
    expect(resolveSourceType({ library: "x", topic: "t" })).toBe("library");
    expect(resolveSourceType({ topic: "t" })).toBe("topic");
    expect(resolveSourceType({})).toBe("manual");
  });
});

describe("isRepoUrl", () => {
  it("recognises repository and tree URLs only", () => {
    expect(isRepoUrl("https://github.com/owner/repo")).toBe(true);
    expect(isRepoUrl("https://github.com/owner/repo.git")).toBe(true);
    expect(isRepoUrl("https://github.com/owner/repo/tree/main/docs")).toBe(true);
    expect(isRepoUrl("https://gitlab.com/owner/repo/-/tree/main")).toBe(true);
    expect(isRepoUrl("https://github.com/owner/repo/blob/main/README.md")).toBe(false);
    expect(isRepoUrl("https://github.com/owner")).toBe(false);
    expect(isRepoUrl("https://example.com/owner/repo")).toBe(false);
    expect(isRepoUrl("not a url")).toBe(false);
  });
});

describe("ingest", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;
  let dir: string;

  beforeEach(() => {
    db = createTestDb();
    provider = new MockEmbeddingProvider();
    dir = mkdtempSync(join(tmpdir(), "libscope-ingest-"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects the kind of input", () => {
    writeFileSync(join(dir, "a.md"), "# A");
    expect(detectIngestKind({ content: "x" })).toBe("content");
    expect(detectIngestKind({ source: "https://github.com/o/r" })).toBe("repo");
    expect(detectIngestKind({ source: "https://github.com/o/r", spider: true })).toBe("url");
    expect(detectIngestKind({ source: "https://example.com/docs" })).toBe("url");
    expect(detectIngestKind({ source: dir })).toBe("directory");
    expect(detectIngestKind({ source: join(dir, "a.md") })).toBe("file");
    expect(() => detectIngestKind({ source: join(dir, "missing.md") })).toThrow(ValidationError);
    expect(() => detectIngestKind({})).toThrow(ValidationError);
  });

  it("lists directory files with include/exclude globs and skips hidden entries", () => {
    mkdirSync(join(dir, "docs", "api"), { recursive: true });
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "README.md"), "x");
    writeFileSync(join(dir, "docs", "guide.md"), "x");
    writeFileSync(join(dir, "docs", "api", "ref.md"), "x");
    writeFileSync(join(dir, "docs", "app.min.js"), "x");
    writeFileSync(join(dir, ".git", "HEAD.md"), "x");
    writeFileSync(join(dir, ".hidden.md"), "x");

    const rel = (files: string[]): string[] => files.map((f) => f.slice(dir.length + 1));
    expect(rel(listDirectoryFiles(dir))).toEqual([
      join("docs", "api", "ref.md"),
      join("docs", "app.min.js"),
      join("docs", "guide.md"),
      "README.md",
    ]);
    expect(
      rel(listDirectoryFiles(dir, { include: ["docs/**/*.md"], exclude: ["api/**"] })),
    ).toEqual([join("docs", "api", "ref.md"), join("docs", "guide.md")]);
    expect(rel(listDirectoryFiles(dir, { exclude: ["*.min.js", "docs/api/**"] }))).toEqual([
      join("docs", "guide.md"),
      "README.md",
    ]);
  });

  it("indexes a directory, skipping unsupported files, and applies tags", async () => {
    writeFileSync(join(dir, "a.md"), "# A\n\nAlpha");
    writeFileSync(join(dir, "b.txt"), "Bravo text");
    writeFileSync(join(dir, "c.bin"), "binary");
    const progress: number[] = [];
    const result = await ingest(
      { db, provider, onProgress: (p) => progress.push(p.done) },
      { source: dir, library: "lib", tags: ["imported"] },
    );
    expect(result.kind).toBe("directory");
    expect(result.documents.map((d) => d.title)).toEqual(["a", "b"]);
    expect(result.skipped).toEqual([
      { source: join(dir, "c.bin"), reason: "unsupported file format" },
    ]);
    expect(progress).toEqual([1, 2]);
    const id = result.documents[0]!.documentId;
    expect(getDocumentTags(db, id).map((t) => t.name)).toEqual(["imported"]);
    const row = db.prepare("SELECT source_type, library FROM documents WHERE id = ?").get(id);
    expect(row).toEqual({ source_type: "library", library: "lib" });
  });

  it("plans without indexing on a dry run", async () => {
    writeFileSync(join(dir, "a.md"), "# A");
    const result = await ingest({ db, provider }, { source: dir, dryRun: true });
    expect(result.planned).toEqual([join(dir, "a.md")]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM documents").get()).toEqual({ n: 0 });
  });

  it("requires a title for inline content", async () => {
    await expect(ingest({ db, provider }, { content: "body" })).rejects.toThrow(ValidationError);
    const result = await ingest(
      { db, provider },
      { content: "body", title: "T", url: "https://x.dev" },
    );
    expect(result.documents[0]).toMatchObject({ title: "T", source: "https://x.dev" });
  });

  it("fetches a single URL and records who submitted it", async () => {
    const result = await ingest(
      { db, provider, submittedBy: "model" },
      { source: "https://example.com/page" },
    );
    expect(result.documents[0]?.title).toBe("Page https://example.com/page");
    const row = db.prepare("SELECT submitted_by, url FROM documents").get();
    expect(row).toEqual({ submitted_by: "model", url: "https://example.com/page" });
  });

  it("crawls a URL, recording per-page errors and crawl stats", async () => {
    const result = await ingest(
      { db, provider },
      { source: "https://example.com/docs", spider: true },
    );
    expect(result.documents.map((d) => d.title)).toEqual(["Seed"]);
    expect(result.errors.map((e) => e.source)).toEqual(["https://example.com/docs/empty"]);
    expect(result.errors[0]?.error).toContain("content");
    expect(result.crawl).toEqual({ pagesCrawled: 2, pagesSkipped: 1 });
  });

  it("indexes a repository as library docs and reports skipped files and errors", async () => {
    const result = await ingest(
      { db, provider },
      { source: "https://github.com/o/r", extensions: ["md"], topic: "t1" },
    );
    expect(vi.mocked(indexRepository)).toHaveBeenCalledWith(
      db,
      provider,
      expect.objectContaining({ extensions: [".md"], topicId: "t1", sourceType: "library" }),
      expect.any(Function),
    );
    expect(result.documents).toEqual([
      {
        documentId: "repo-doc",
        title: "README",
        chunkCount: 3,
        source: "https://github.com/o/r#README.md",
      },
    ]);
    expect(result.errors).toEqual([
      { source: "https://github.com/o/r", error: "bad.md: HTTP 404" },
    ]);
    expect(result.skipped).toEqual([
      { source: "https://github.com/o/r", reason: "2 unchanged file(s)" },
    ]);
  });

  it("stops between files when aborted", async () => {
    writeFileSync(join(dir, "a.md"), "# A");
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      ingest({ db, provider, signal: controller.signal }, { source: dir }),
    ).rejects.toThrow("stop");
  });
});
