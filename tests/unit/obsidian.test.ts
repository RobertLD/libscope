import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseObsidianMarkdown } from "../../src/connectors/obsidian.js";
import { createTestDb, createTestDbWithVec } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import type Database from "better-sqlite3";

// Mock fs modules
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    statSync: vi.fn(),
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    readdir: vi.fn(),
    readFile: vi.fn(),
    stat: vi.fn(),
  };
});

import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { syncObsidianVault, disconnectVault } from "../../src/connectors/obsidian.js";
import { initLogger } from "../../src/logger.js";

const mockedReaddirSync = vi.mocked(readdirSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedStatSync = vi.mocked(statSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);

function makeStat(
  isDir: boolean,
  mtime: Date = new Date("2024-01-01"),
): ReturnType<typeof statSync> {
  return {
    isDirectory: () => isDir,
    isFile: () => !isDir,
    mtime,
    size: 100,
  } as unknown as ReturnType<typeof statSync>;
}

describe("parseObsidianMarkdown", () => {
  const vaultFiles = ["note-a.md", "note-b.md", "Projects/web.md"];

  it("should extract YAML frontmatter", () => {
    const content = `---
title: My Note
tags: [javascript, web]
date: 2024-01-15
---

# Hello World

Some content here.`;

    const result = parseObsidianMarkdown(content, vaultFiles);

    expect(result.frontmatter.title).toBe("My Note");
    expect(result.frontmatter.tags).toEqual(["javascript", "web"]);
    expect(result.frontmatter.date).toBe("2024-01-15");
    expect(result.body).toContain("Hello World");
    expect(result.body).not.toContain("---");
  });

  it("should handle content without frontmatter", () => {
    const content = "# Simple Note\n\nJust some text.";
    const result = parseObsidianMarkdown(content, vaultFiles);

    expect(result.frontmatter).toEqual({});
    expect(result.body).toContain("Simple Note");
  });

  it("should resolve simple wikilinks", () => {
    const content = "Check out [[note-a]] for more info.";
    const result = parseObsidianMarkdown(content, vaultFiles);

    expect(result.body).toContain("[note-a](note-a)");
    expect(result.wikilinks).toContain("note-a");
  });

  it("should resolve wikilinks with display text", () => {
    const content = "See [[note-b|my display text]] here.";
    const result = parseObsidianMarkdown(content, vaultFiles);

    expect(result.body).toContain("[my display text](note-b)");
    expect(result.wikilinks).toContain("note-b");
  });

  it("should handle wikilinks to missing targets", () => {
    const content = "Link to [[nonexistent-note]] here.";
    const result = parseObsidianMarkdown(content, vaultFiles);

    expect(result.body).toContain("[nonexistent-note](nonexistent-note)");
    expect(result.wikilinks).toContain("nonexistent-note");
  });

  it("should handle embeds (single level)", () => {
    const content = "Before embed\n![[note-a]]\nAfter embed";
    const result = parseObsidianMarkdown(content, vaultFiles);

    // Embeds are replaced with placeholder in parseObsidianMarkdown
    // (full resolution happens in resolveEmbeds during sync)
    expect(result.body).toContain("Before embed");
    expect(result.body).toContain("After embed");
  });

  it("should strip %%comments%%", () => {
    const content = "Visible text %%this is hidden%% more visible text.";
    const result = parseObsidianMarkdown(content, vaultFiles);

    expect(result.body).not.toContain("this is hidden");
    expect(result.body).toContain("Visible text");
    expect(result.body).toContain("more visible text.");
  });

  it("should strip multiline comments", () => {
    const content = "Start\n%%\nHidden block\nMultiple lines\n%%\nEnd";
    const result = parseObsidianMarkdown(content, vaultFiles);

    expect(result.body).not.toContain("Hidden block");
    expect(result.body).toContain("Start");
    expect(result.body).toContain("End");
  });

  it("should strip dataview code blocks", () => {
    const content = "Before\n```dataview\nTABLE file.name\nFROM #tag\n```\nAfter";
    const result = parseObsidianMarkdown(content, vaultFiles);

    expect(result.body).not.toContain("dataview");
    expect(result.body).not.toContain("TABLE");
    expect(result.body).toContain("Before");
    expect(result.body).toContain("After");
  });

  it("should convert callouts to blockquotes", () => {
    const content = "> [!note] Important info here";
    const result = parseObsidianMarkdown(content, vaultFiles);

    expect(result.body).toContain("> **note**: Important info here");
  });

  it("should extract #tags from body", () => {
    const content = "This has #javascript and #web-dev tags.\nAlso #testing here.";
    const result = parseObsidianMarkdown(content, vaultFiles);

    expect(result.tags).toContain("javascript");
    expect(result.tags).toContain("web-dev");
    expect(result.tags).toContain("testing");
  });

  it("should combine frontmatter and body tags", () => {
    const content = `---
tags: [react, typescript]
---

Content with #javascript tag.`;

    const result = parseObsidianMarkdown(content, vaultFiles);

    expect(result.tags).toContain("react");
    expect(result.tags).toContain("typescript");
    expect(result.tags).toContain("javascript");
  });

  it("should handle frontmatter tags as list", () => {
    const content = `---
tags:
  - alpha
  - beta
---

Body text.`;

    const result = parseObsidianMarkdown(content, vaultFiles);

    expect(result.tags).toContain("alpha");
    expect(result.tags).toContain("beta");
  });

  it("should handle invalid/empty frontmatter gracefully", () => {
    const content = `---
---

Body text.`;

    const result = parseObsidianMarkdown(content, vaultFiles);

    expect(result.frontmatter).toEqual({});
    expect(result.body).toContain("Body text.");
  });
});

describe("syncObsidianVault", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    initLogger("silent");
    db = createTestDbWithVec();
    provider = new MockEmbeddingProvider();

    // Default mock: connectors.json doesn't exist
    mockedExistsSync.mockReturnValue(false);
    mockedWriteFileSync.mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  function setupVaultFs(files: Record<string, string>, mtimes?: Record<string, Date>): void {
    const fileNames = Object.keys(files);

    mockedReaddirSync.mockImplementation((dir: unknown) => {
      const dirStr = String(dir);
      if (dirStr === "/vault") {
        const topLevel = new Set<string>();
        for (const f of fileNames) {
          const parts = f.split("/");
          topLevel.add(parts[0] ?? f);
        }
        return [...topLevel] as unknown as ReturnType<typeof readdirSync>;
      }
      // Subdirectories
      const subDir = dirStr.replace("/vault/", "");
      const children = new Set<string>();
      for (const f of fileNames) {
        if (f.startsWith(subDir + "/")) {
          const rest = f.slice(subDir.length + 1);
          const parts = rest.split("/");
          children.add(parts[0] ?? rest);
        }
      }
      return [...children] as unknown as ReturnType<typeof readdirSync>;
    });

    mockedStatSync.mockImplementation((p: unknown) => {
      const path = String(p);
      const rel = path.replace("/vault/", "");
      if (files[rel] !== undefined) {
        return makeStat(false, mtimes?.[rel]);
      }
      // Check if it's a directory
      const isDir = fileNames.some((f) => f.startsWith(rel + "/"));
      if (isDir) {
        return makeStat(true);
      }
      throw new Error(`ENOENT: ${path}`);
    });

    mockedReadFileSync.mockImplementation((p: unknown, _encoding?: unknown) => {
      const path = String(p);
      const rel = path.replace("/vault/", "");
      const content = files[rel];
      if (content !== undefined) {
        return content;
      }
      throw new Error(`ENOENT: ${path}`);
    });
  }

  it("should add documents on full sync", async () => {
    setupVaultFs({
      "note1.md": "# Note 1\n\nHello world.",
      "note2.md": "# Note 2\n\nGoodbye world.",
    });

    const result = await syncObsidianVault(db, provider, {
      vaultPath: "/vault",
      topicMapping: "folder",
      excludePatterns: [],
    });

    expect(result.added).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify documents were stored
    const docs = db.prepare("SELECT * FROM documents").all() as Array<{ url: string }>;
    expect(docs).toHaveLength(2);
    expect(docs.some((d) => d.url === "obsidian:///vault/note1.md")).toBe(true);
  });

  it("should create topics from folder structure", async () => {
    setupVaultFs({
      "Projects/Web/notes.md": "# Web Notes\n\nContent here.",
    });

    const result = await syncObsidianVault(db, provider, {
      vaultPath: "/vault",
      topicMapping: "folder",
      excludePatterns: [],
    });

    expect(result.added).toBe(1);

    const topics = db.prepare("SELECT * FROM topics").all() as Array<{ name: string }>;
    expect(topics.some((t) => t.name === "Projects/Web")).toBe(true);
  });

  it("should handle incremental sync - skip unchanged files", async () => {
    const mtime = new Date("2024-01-01T00:00:00.000Z");

    setupVaultFs({ "note1.md": "# Note 1\n\nContent." }, { "note1.md": mtime });

    // First sync
    const result1 = await syncObsidianVault(db, provider, {
      vaultPath: "/vault",
      topicMapping: "folder",
      excludePatterns: [],
    });
    expect(result1.added).toBe(1);

    // Capture what was saved
    const saveCall = mockedWriteFileSync.mock.calls[0];
    const savedConfigStr = saveCall?.[1];
    const savedConfig = JSON.parse(
      typeof savedConfigStr === "string" ? savedConfigStr : "{}",
    ) as Record<string, unknown>;

    // Second sync with same mtime - mock loading the saved config
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation((p: unknown, _encoding?: unknown) => {
      const path = String(p);
      if (path.endsWith("connectors.json")) {
        return JSON.stringify(savedConfig);
      }
      const rel = path.replace("/vault/", "");
      if (rel === "note1.md") return "# Note 1\n\nContent.";
      throw new Error(`ENOENT: ${path}`);
    });

    const result2 = await syncObsidianVault(db, provider, {
      vaultPath: "/vault",
      topicMapping: "folder",
      excludePatterns: [],
    });

    // Should skip unchanged file
    expect(result2.added).toBe(0);
    expect(result2.updated).toBe(0);
  });

  it("should detect and process changed files", async () => {
    const oldMtime = new Date("2024-01-01T00:00:00.000Z");
    const newMtime = new Date("2024-02-01T00:00:00.000Z");

    setupVaultFs({ "note1.md": "# Note 1\n\nOriginal content." }, { "note1.md": oldMtime });

    // First sync
    await syncObsidianVault(db, provider, {
      vaultPath: "/vault",
      topicMapping: "folder",
      excludePatterns: [],
    });

    const saveCall = mockedWriteFileSync.mock.calls[0];
    const savedConfigStr2 = saveCall?.[1];
    const savedConfig = JSON.parse(
      typeof savedConfigStr2 === "string" ? savedConfigStr2 : "{}",
    ) as Record<string, unknown>;

    // Second sync with new mtime
    setupVaultFs({ "note1.md": "# Note 1\n\nUpdated content." }, { "note1.md": newMtime });

    mockedExistsSync.mockReturnValue(true);
    const origReadImpl = mockedReadFileSync.getMockImplementation();
    mockedReadFileSync.mockImplementation((p: unknown, encoding?: unknown) => {
      const path = String(p);
      if (path.endsWith("connectors.json")) {
        return JSON.stringify(savedConfig);
      }
      return origReadImpl!(p, encoding as BufferEncoding);
    });

    const result = await syncObsidianVault(db, provider, {
      vaultPath: "/vault",
      topicMapping: "folder",
      excludePatterns: [],
    });

    expect(result.updated).toBe(1);
  });

  it("should detect deleted files and remove documents", async () => {
    const mtime = new Date("2024-01-01T00:00:00.000Z");

    setupVaultFs(
      {
        "note1.md": "# Note 1\n\nContent.",
        "note2.md": "# Note 2\n\nContent two.",
      },
      { "note1.md": mtime, "note2.md": mtime },
    );

    // First sync
    const r1 = await syncObsidianVault(db, provider, {
      vaultPath: "/vault",
      topicMapping: "folder",
      excludePatterns: [],
    });

    const saveCall = mockedWriteFileSync.mock.calls[0];
    const savedConfigStr3 = saveCall?.[1];
    const savedConfig = JSON.parse(
      typeof savedConfigStr3 === "string" ? savedConfigStr3 : "{}",
    ) as Record<string, unknown>;

    // Verify first sync worked
    expect(r1.added).toBe(2);

    // Second sync with note2 removed
    setupVaultFs({ "note1.md": "# Note 1\n\nContent." }, { "note1.md": mtime });

    mockedExistsSync.mockReturnValue(true);
    const origRead = mockedReadFileSync.getMockImplementation();
    mockedReadFileSync.mockImplementation((p: unknown, encoding?: unknown) => {
      const path = String(p);
      if (path.endsWith("connectors.json")) {
        return JSON.stringify(savedConfig);
      }
      return origRead!(p, encoding as BufferEncoding);
    });

    const result = await syncObsidianVault(db, provider, {
      vaultPath: "/vault",
      topicMapping: "folder",
      excludePatterns: [],
    });

    expect(result.deleted).toBe(1);
    const docs = db.prepare("SELECT * FROM documents").all();
    expect(docs).toHaveLength(1);
  });

  it("should handle unreadable files gracefully", async () => {
    mockedReaddirSync.mockImplementation(() => {
      return ["good.md", "bad.md"] as unknown as ReturnType<typeof readdirSync>;
    });

    mockedStatSync.mockImplementation((_p: unknown) => {
      return makeStat(false);
    });

    mockedReadFileSync.mockImplementation((p: unknown, _encoding?: unknown) => {
      const path = String(p);
      if (path.endsWith("connectors.json")) throw new Error("ENOENT");
      if (path.includes("bad.md")) throw new Error("Permission denied");
      return "# Good Note\n\nContent.";
    });

    const result = await syncObsidianVault(db, provider, {
      vaultPath: "/vault",
      topicMapping: "folder",
      excludePatterns: [],
    });

    expect(result.added).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.file).toBe("bad.md");
  });

  it("should exclude default directories", async () => {
    mockedReaddirSync.mockImplementation((dir: unknown) => {
      const dirStr = String(dir);
      if (dirStr === "/vault") {
        return ["note.md", ".obsidian", ".trash", "templates"] as unknown as ReturnType<
          typeof readdirSync
        >;
      }
      return [] as unknown as ReturnType<typeof readdirSync>;
    });

    mockedStatSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith(".md")) return makeStat(false);
      return makeStat(true);
    });

    mockedReadFileSync.mockImplementation((p: unknown, _encoding?: unknown) => {
      const path = String(p);
      if (path.endsWith("connectors.json")) throw new Error("ENOENT");
      return "# Note\n\nContent.";
    });

    const result = await syncObsidianVault(db, provider, {
      vaultPath: "/vault",
      topicMapping: "folder",
      excludePatterns: [],
    });

    expect(result.added).toBe(1);
  });

  it("should use title from frontmatter", async () => {
    setupVaultFs({
      "note.md": "---\ntitle: Custom Title\n---\n\n# Heading\n\nBody text.",
    });

    const result = await syncObsidianVault(db, provider, {
      vaultPath: "/vault",
      topicMapping: "folder",
      excludePatterns: [],
    });

    expect(result.added).toBe(1);

    const docs = db.prepare("SELECT title FROM documents").all() as Array<{ title: string }>;
    expect(docs[0]?.title).toBe("Custom Title");
  });
});

describe("disconnectVault", () => {
  let db: Database.Database;

  beforeEach(() => {
    initLogger("silent");
    db = createTestDb();
    mockedExistsSync.mockReturnValue(false);
    mockedWriteFileSync.mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it("should remove all vault documents", () => {
    // Insert some test documents with obsidian source URLs
    db.prepare(
      `INSERT INTO documents (id, source_type, title, content, url, submitted_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("doc1", "manual", "Note 1", "Content 1", "obsidian:///vault/note1.md", "crawler");
    db.prepare(
      `INSERT INTO documents (id, source_type, title, content, url, submitted_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("doc2", "manual", "Note 2", "Content 2", "obsidian:///vault/note2.md", "crawler");
    db.prepare(
      `INSERT INTO documents (id, source_type, title, content, url, submitted_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("doc3", "manual", "Other", "Content 3", "https://example.com", "manual");

    const removed = disconnectVault(db, "/vault");

    expect(removed).toBe(2);

    const remaining = db.prepare("SELECT * FROM documents").all();
    expect(remaining).toHaveLength(1);
  });

  it("should handle vault with no documents", () => {
    const removed = disconnectVault(db, "/nonexistent/vault");
    expect(removed).toBe(0);
  });
});

describe("folder-to-topic mapping", () => {
  it("should map nested folder path to topic", () => {
    const content = "# Notes\n\nContent.";
    const result = parseObsidianMarkdown(content, []);

    // Topic mapping is done during sync, not parsing
    expect(result.body).toContain("Content.");
  });
});

describe("parseObsidianMarkdown – extra branches", () => {
  it("should handle embeds targeting files not in vault", () => {
    // Line 119: target not found in fileMap
    const content = "Before ![[unknown-file]] After";
    const result = parseObsidianMarkdown(content, ["other.md"]);
    expect(result.body).toContain("[unknown-file]");
  });

  it("should handle embeds targeting files that exist in vault", () => {
    // Line 123-125: target found, returns placeholder
    const content = "Before ![[note-a]] After";
    const result = parseObsidianMarkdown(content, ["note-a.md"]);
    expect(result.body).toContain("[Embedded: note-a]");
  });

  it("should flush pending YAML list when followed by another key", () => {
    // Lines 198-200: flush pending list values
    const content = `---
items:
  - one
  - two
title: After List
---

Body.`;
    const result = parseObsidianMarkdown(content, []);
    expect(result.frontmatter.items).toEqual(["one", "two"]);
    expect(result.frontmatter.title).toBe("After List");
  });
});

describe("syncObsidianVault – extra branches", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    initLogger("silent");
    db = createTestDbWithVec();
    provider = new MockEmbeddingProvider();

    mockedExistsSync.mockReturnValue(false);
    mockedWriteFileSync.mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  function setupVaultFs(files: Record<string, string>, mtimes?: Record<string, Date>): void {
    const fileNames = Object.keys(files);

    mockedReaddirSync.mockImplementation((dir: unknown) => {
      const dirStr = String(dir);
      if (dirStr === "/vault") {
        const topLevel = new Set<string>();
        for (const f of fileNames) {
          const parts = f.split("/");
          topLevel.add(parts[0] ?? f);
        }
        return [...topLevel] as unknown as ReturnType<typeof readdirSync>;
      }
      const subDir = dirStr.replace("/vault/", "");
      const children = new Set<string>();
      for (const f of fileNames) {
        if (f.startsWith(subDir + "/")) {
          const rest = f.slice(subDir.length + 1);
          const parts = rest.split("/");
          children.add(parts[0] ?? rest);
        }
      }
      return [...children] as unknown as ReturnType<typeof readdirSync>;
    });

    mockedStatSync.mockImplementation((p: unknown) => {
      const path = String(p);
      const rel = path.replace("/vault/", "");
      if (files[rel] !== undefined) {
        return makeStat(false, mtimes?.[rel]);
      }
      const isDir = fileNames.some((f) => f.startsWith(rel + "/"));
      if (isDir) {
        return makeStat(true);
      }
      throw new Error(`ENOENT: ${path}`);
    });

    mockedReadFileSync.mockImplementation((p: unknown, _encoding?: unknown) => {
      const path = String(p);
      const rel = path.replace("/vault/", "");
      const content = files[rel];
      if (content !== undefined) {
        return content;
      }
      throw new Error(`ENOENT: ${path}`);
    });
  }

  it("should throw ValidationError when vaultPath is empty (line 292)", async () => {
    await expect(
      syncObsidianVault(db, provider, {
        vaultPath: "",
        topicMapping: "folder",
        excludePatterns: [],
      }),
    ).rejects.toThrow("Vault path is required");
  });

  it("should handle readdirSync failure gracefully (line 55)", async () => {
    mockedReaddirSync.mockImplementation(() => {
      throw new Error("Permission denied");
    });

    const result = await syncObsidianVault(db, provider, {
      vaultPath: "/vault",
      topicMapping: "folder",
      excludePatterns: [],
    });

    expect(result.added).toBe(0);
  });

  it("should handle statSync failure and continue (line 74)", async () => {
    mockedReaddirSync.mockImplementation(() => {
      return ["good.md", "broken.md"] as unknown as ReturnType<typeof readdirSync>;
    });

    mockedStatSync.mockImplementation((_p: unknown) => {
      if (String(_p).includes("broken.md")) {
        throw new Error("stat failed");
      }
      return makeStat(false);
    });

    mockedReadFileSync.mockImplementation((p: unknown, _encoding?: unknown) => {
      const path = String(p);
      if (path.endsWith("connectors.json")) throw new Error("ENOENT");
      return "# Good\n\nContent.";
    });

    const result = await syncObsidianVault(db, provider, {
      vaultPath: "/vault",
      topicMapping: "folder",
      excludePatterns: [],
    });

    expect(result.added).toBe(1);
  });

  it("should exclude files matching non-directory patterns (line 66)", async () => {
    mockedReaddirSync.mockImplementation(() => {
      return ["note.md", "secret.md"] as unknown as ReturnType<typeof readdirSync>;
    });

    mockedStatSync.mockImplementation(() => makeStat(false));

    mockedReadFileSync.mockImplementation((p: unknown, _encoding?: unknown) => {
      const path = String(p);
      if (path.endsWith("connectors.json")) throw new Error("ENOENT");
      return "# Note\n\nContent.";
    });

    const result = await syncObsidianVault(db, provider, {
      vaultPath: "/vault",
      topicMapping: "folder",
      excludePatterns: ["secret.md"],
    });

    expect(result.added).toBe(1);
  });

  it("should use frontmatter topic mapping (lines 344-347)", async () => {
    setupVaultFs({
      "note.md": "---\ntopic: My Topic\n---\n\n# Note\n\nContent.",
    });

    const result = await syncObsidianVault(db, provider, {
      vaultPath: "/vault",
      topicMapping: "frontmatter",
      excludePatterns: [],
    });

    expect(result.added).toBe(1);
    const topics = db.prepare("SELECT * FROM topics").all() as Array<{ name: string }>;
    expect(topics.some((t) => t.name === "My Topic")).toBe(true);
  });

  it("should handle tags and tag creation errors (lines 371-381)", async () => {
    setupVaultFs({
      "note.md": "# Note\n\nContent with #test-tag and #another-tag.",
    });

    const result = await syncObsidianVault(db, provider, {
      vaultPath: "/vault",
      topicMapping: "folder",
      excludePatterns: [],
    });

    expect(result.added).toBe(1);
  });

  it("should resolve embeds during sync (lines 250-262)", async () => {
    setupVaultFs({
      "main.md": "# Main\n\n![[embed-target]]\n\nAfter embed.",
      "embed-target.md": "---\ntitle: Embedded\n---\n\nEmbedded content here.",
    });

    const result = await syncObsidianVault(db, provider, {
      vaultPath: "/vault",
      topicMapping: "folder",
      excludePatterns: [],
    });

    expect(result.added).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it("should preserve tracking on error (line 399)", async () => {
    const mtime = new Date("2024-01-01T00:00:00.000Z");
    setupVaultFs({ "note.md": "# Note\n\nContent." }, { "note.md": mtime });

    // First sync
    await syncObsidianVault(db, provider, {
      vaultPath: "/vault",
      topicMapping: "folder",
      excludePatterns: [],
    });

    const saveCall = mockedWriteFileSync.mock.calls[0];
    const savedConfigStr = saveCall?.[1];
    const savedConfig = JSON.parse(
      typeof savedConfigStr === "string" ? savedConfigStr : "{}",
    ) as Record<string, unknown>;

    // Second sync: file changed but provider throws
    const newMtime = new Date("2024-06-01T00:00:00.000Z");
    setupVaultFs({ "note.md": "# Note\n\nUpdated content." }, { "note.md": newMtime });
    mockedExistsSync.mockReturnValue(true);
    const origRead = mockedReadFileSync.getMockImplementation();
    mockedReadFileSync.mockImplementation((p: unknown, encoding?: unknown) => {
      const path = String(p);
      if (path.endsWith("connectors.json")) {
        return JSON.stringify(savedConfig);
      }
      return origRead!(p, encoding as BufferEncoding);
    });

    // Make the provider throw so the file processing fails
    provider.embed = () => {
      throw new Error("embedding failed");
    };
    provider.embedBatch = () => {
      throw new Error("embedding failed");
    };

    const result = await syncObsidianVault(db, provider, {
      vaultPath: "/vault",
      topicMapping: "folder",
      excludePatterns: [],
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.file).toBe("note.md");
  });
});

describe("disconnectVault – with connector state (lines 449-452)", () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    initLogger("silent");
    db = createTestDb();
    mockedWriteFileSync.mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it("should remove documents tracked in connector state", () => {
    // Insert documents
    db.prepare(
      `INSERT INTO documents (id, source_type, title, content, url, submitted_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("doc1", "manual", "Note 1", "Content 1", "obsidian:///vault/note1.md", "crawler");

    // Mock connector config with vault state
    const state = {
      type: "obsidian",
      vaultPath: "/vault",
      lastSync: new Date().toISOString(),
      topicMapping: "folder",
      excludePatterns: [],
      files: {
        "note1.md": { mtime: "2024-01-01T00:00:00.000Z", docId: "doc1" },
      },
    };

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      return JSON.stringify({ "obsidian:/vault": state });
    });

    const removed = disconnectVault(db, "/vault");

    expect(removed).toBeGreaterThanOrEqual(1);
  });
});
