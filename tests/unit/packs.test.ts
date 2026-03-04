import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";
import type Database from "better-sqlite3";
import { createTestDbWithVec } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import {
  installPack,
  removePack,
  listInstalledPacks,
  createPack,
  listAvailablePacks,
  createPackFromSource,
} from "../../src/core/packs.js";
import type { KnowledgePack } from "../../src/core/packs.js";
import { indexDocument } from "../../src/core/indexing.js";

function makeSamplePack(overrides?: Partial<KnowledgePack>): KnowledgePack {
  return {
    name: "test-pack",
    version: "1.0.0",
    description: "A test knowledge pack",
    documents: [
      {
        title: "Getting Started",
        content: "# Getting Started\n\nThis is the getting started guide.",
        source: "https://example.com/docs/getting-started",
      },
      {
        title: "API Reference",
        content: "# API Reference\n\nThe API has the following endpoints.",
        source: "https://example.com/docs/api",
        topics: ["api"],
        tags: ["reference"],
      },
    ],
    metadata: {
      author: "test-author",
      license: "MIT",
      createdAt: "2024-01-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

describe("knowledge packs", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;
  let tempDir: string;

  beforeEach(() => {
    db = createTestDbWithVec();
    provider = new MockEmbeddingProvider();
    tempDir = mkdtempSync(join(tmpdir(), "libscope-packs-test-"));
  });

  afterEach(() => {
    db.close();
  });

  describe("installPack", () => {
    it("should install a pack from a local JSON file", async () => {
      const pack = makeSamplePack();
      const packPath = join(tempDir, "test-pack.json");
      writeFileSync(packPath, JSON.stringify(pack), "utf-8");

      const result = await installPack(db, provider, packPath);

      expect(result.packName).toBe("test-pack");
      expect(result.documentsInstalled).toBe(2);
      expect(result.alreadyInstalled).toBe(false);

      // Verify documents are tagged with pack_name
      const docs = db
        .prepare("SELECT id, pack_name FROM documents WHERE pack_name = ?")
        .all("test-pack") as Array<{ id: string; pack_name: string }>;
      expect(docs.length).toBe(2);

      // Verify pack is recorded
      const packs = db.prepare("SELECT * FROM packs WHERE name = ?").all("test-pack") as Array<{
        name: string;
        version: string;
        doc_count: number;
      }>;
      expect(packs.length).toBe(1);
      expect(packs[0]!.version).toBe("1.0.0");
      expect(packs[0]!.doc_count).toBe(2);
    });

    it("should handle duplicate pack installation", async () => {
      const pack = makeSamplePack();
      const packPath = join(tempDir, "test-pack.json");
      writeFileSync(packPath, JSON.stringify(pack), "utf-8");

      await installPack(db, provider, packPath);
      const result = await installPack(db, provider, packPath);

      expect(result.alreadyInstalled).toBe(true);
      expect(result.documentsInstalled).toBe(0);
    });

    it("should reject invalid pack format", async () => {
      const packPath = join(tempDir, "bad-pack.json");
      writeFileSync(packPath, JSON.stringify({ invalid: true }), "utf-8");

      await expect(installPack(db, provider, packPath)).rejects.toThrow(/Invalid pack format/);
    });

    it("should reject pack with missing document fields", async () => {
      const badPack = {
        name: "bad",
        version: "1.0.0",
        description: "bad pack",
        documents: [{ title: "No content" }],
        metadata: { author: "x", license: "MIT", createdAt: "2024-01-01" },
      };
      const packPath = join(tempDir, "bad-docs.json");
      writeFileSync(packPath, JSON.stringify(badPack), "utf-8");

      await expect(installPack(db, provider, packPath)).rejects.toThrow(
        /missing or invalid 'content'/,
      );
    });
  });

  describe("removePack", () => {
    it("should remove a pack and its associated documents", async () => {
      const pack = makeSamplePack();
      const packPath = join(tempDir, "test-pack.json");
      writeFileSync(packPath, JSON.stringify(pack), "utf-8");

      await installPack(db, provider, packPath);

      // Verify docs exist
      const docsBefore = db
        .prepare("SELECT id FROM documents WHERE pack_name = ?")
        .all("test-pack");
      expect(docsBefore.length).toBe(2);

      removePack(db, "test-pack");

      // Verify docs removed
      const docsAfter = db.prepare("SELECT id FROM documents WHERE pack_name = ?").all("test-pack");
      expect(docsAfter.length).toBe(0);

      // Verify pack record removed
      const packRecord = db.prepare("SELECT * FROM packs WHERE name = ?").all("test-pack");
      expect(packRecord.length).toBe(0);
    });

    it("should throw when removing a non-existent pack", () => {
      expect(() => removePack(db, "nonexistent")).toThrow(/not installed/);
    });
  });

  describe("listInstalledPacks", () => {
    it("should return empty array when no packs installed", () => {
      const packs = listInstalledPacks(db);
      expect(packs).toEqual([]);
    });

    it("should list all installed packs", async () => {
      const pack1 = makeSamplePack({ name: "pack-a", description: "First pack" });
      const pack2 = makeSamplePack({ name: "pack-b", description: "Second pack" });
      const path1 = join(tempDir, "pack-a.json");
      const path2 = join(tempDir, "pack-b.json");
      writeFileSync(path1, JSON.stringify(pack1), "utf-8");
      writeFileSync(path2, JSON.stringify(pack2), "utf-8");

      await installPack(db, provider, path1);
      await installPack(db, provider, path2);

      const packs = listInstalledPacks(db);
      expect(packs.length).toBe(2);
      expect(packs.map((p) => p.name)).toEqual(["pack-a", "pack-b"]);
      expect(packs[0]!.version).toBe("1.0.0");
      expect(packs[0]!.docCount).toBe(2);
    });
  });

  describe("createPack", () => {
    it("should create a pack from existing documents", async () => {
      await indexDocument(db, provider, {
        title: "Doc One",
        content: "# Doc One\n\nContent for doc one.",
        sourceType: "manual",
        url: "https://example.com/one",
      });
      await indexDocument(db, provider, {
        title: "Doc Two",
        content: "# Doc Two\n\nContent for doc two.",
        sourceType: "manual",
      });

      const outputPath = join(tempDir, "exported-pack.json");
      const pack = createPack(db, {
        name: "exported",
        outputPath,
      });

      expect(pack.name).toBe("exported");
      expect(pack.documents.length).toBe(2);
      expect(pack.version).toBe("1.0.0");
      expect(pack.metadata.author).toBe("libscope");

      // Verify file was written
      expect(existsSync(outputPath)).toBe(true);
    });

    it("should throw when no documents match criteria", () => {
      expect(() => createPack(db, { name: "empty", topic: "nonexistent-topic" })).toThrow(
        /No documents found/,
      );
    });

    it("should throw for empty pack name", () => {
      expect(() => createPack(db, { name: "  " })).toThrow(/Pack name is required/);
    });
  });

  describe("pack format validation", () => {
    it("should reject non-object input", async () => {
      const packPath = join(tempDir, "bad.json");
      writeFileSync(packPath, '"just a string"', "utf-8");

      await expect(installPack(db, provider, packPath)).rejects.toThrow(/expected an object/);
    });

    it("should reject missing metadata", async () => {
      const bad = {
        name: "x",
        version: "1.0.0",
        description: "y",
        documents: [],
      };
      const packPath = join(tempDir, "no-meta.json");
      writeFileSync(packPath, JSON.stringify(bad), "utf-8");

      await expect(installPack(db, provider, packPath)).rejects.toThrow(
        /missing or invalid 'metadata'/,
      );
    });

    it("should reject empty pack name", async () => {
      const bad = {
        name: "",
        version: "1.0.0",
        description: "y",
        documents: [],
        metadata: { author: "a", license: "MIT", createdAt: "2024-01-01" },
      };
      const packPath = join(tempDir, "empty-name.json");
      writeFileSync(packPath, JSON.stringify(bad), "utf-8");

      await expect(installPack(db, provider, packPath)).rejects.toThrow(
        /missing or invalid 'name'/,
      );
    });

    it("should reject documents that are not objects", async () => {
      const bad = {
        name: "x",
        version: "1.0.0",
        description: "y",
        documents: ["not an object"],
        metadata: { author: "a", license: "MIT", createdAt: "2024-01-01" },
      };
      const packPath = join(tempDir, "bad-doc.json");
      writeFileSync(packPath, JSON.stringify(bad), "utf-8");

      await expect(installPack(db, provider, packPath)).rejects.toThrow(/not an object/);
    });

    it("should reject missing version", async () => {
      const bad = {
        name: "x",
        version: "",
        description: "y",
        documents: [],
        metadata: { author: "a", license: "MIT", createdAt: "2024-01-01" },
      };
      const packPath = join(tempDir, "no-version.json");
      writeFileSync(packPath, JSON.stringify(bad), "utf-8");

      await expect(installPack(db, provider, packPath)).rejects.toThrow(
        /missing or invalid 'version'/,
      );
    });

    it("should reject non-string description", async () => {
      const bad = {
        name: "x",
        version: "1.0.0",
        description: 42,
        documents: [],
        metadata: { author: "a", license: "MIT", createdAt: "2024-01-01" },
      };
      const packPath = join(tempDir, "bad-desc.json");
      writeFileSync(packPath, JSON.stringify(bad), "utf-8");

      await expect(installPack(db, provider, packPath)).rejects.toThrow(
        /missing or invalid 'description'/,
      );
    });

    it("should reject non-array documents", async () => {
      const bad = {
        name: "x",
        version: "1.0.0",
        description: "y",
        documents: "not-array",
        metadata: { author: "a", license: "MIT", createdAt: "2024-01-01" },
      };
      const packPath = join(tempDir, "bad-docs-type.json");
      writeFileSync(packPath, JSON.stringify(bad), "utf-8");

      await expect(installPack(db, provider, packPath)).rejects.toThrow(
        /'documents' must be an array/,
      );
    });

    it("should reject document missing source", async () => {
      const bad = {
        name: "x",
        version: "1.0.0",
        description: "y",
        documents: [{ title: "t", content: "c" }],
        metadata: { author: "a", license: "MIT", createdAt: "2024-01-01" },
      };
      const packPath = join(tempDir, "no-source.json");
      writeFileSync(packPath, JSON.stringify(bad), "utf-8");

      await expect(installPack(db, provider, packPath)).rejects.toThrow(
        /missing or invalid 'source'/,
      );
    });

    it("should reject metadata missing license", async () => {
      const bad = {
        name: "x",
        version: "1.0.0",
        description: "y",
        documents: [],
        metadata: { author: "a", createdAt: "2024-01-01" },
      };
      const packPath = join(tempDir, "no-license.json");
      writeFileSync(packPath, JSON.stringify(bad), "utf-8");

      await expect(installPack(db, provider, packPath)).rejects.toThrow(
        /metadata missing 'license'/,
      );
    });

    it("should reject metadata missing createdAt", async () => {
      const bad = {
        name: "x",
        version: "1.0.0",
        description: "y",
        documents: [],
        metadata: { author: "a", license: "MIT" },
      };
      const packPath = join(tempDir, "no-created.json");
      writeFileSync(packPath, JSON.stringify(bad), "utf-8");

      await expect(installPack(db, provider, packPath)).rejects.toThrow(
        /metadata missing 'createdAt'/,
      );
    });

    it("should reject metadata missing author", async () => {
      const bad = {
        name: "x",
        version: "1.0.0",
        description: "y",
        documents: [],
        metadata: { license: "MIT", createdAt: "2024-01-01" },
      };
      const packPath = join(tempDir, "no-author.json");
      writeFileSync(packPath, JSON.stringify(bad), "utf-8");

      await expect(installPack(db, provider, packPath)).rejects.toThrow(
        /metadata missing 'author'/,
      );
    });

    it("should reject null metadata", async () => {
      const bad = {
        name: "x",
        version: "1.0.0",
        description: "y",
        documents: [],
        metadata: null,
      };
      const packPath = join(tempDir, "null-meta.json");
      writeFileSync(packPath, JSON.stringify(bad), "utf-8");

      await expect(installPack(db, provider, packPath)).rejects.toThrow(
        /missing or invalid 'metadata'/,
      );
    });
  });

  describe("security validations", () => {
    it("should reject relative path traversal", async () => {
      await expect(installPack(db, provider, "../../etc/passwd.json")).rejects.toThrow(
        /must be within the current working directory/,
      );
    });

    it("should reject http registry URLs", async () => {
      await expect(
        installPack(db, provider, "some-pack", {
          registryUrl: "http://evil.com/registry.json",
        }),
      ).rejects.toThrow(/must use https/);
    });

    it("should reject private IP registry URLs", async () => {
      await expect(
        installPack(db, provider, "some-pack", {
          registryUrl: "https://127.0.0.1/registry.json",
        }),
      ).rejects.toThrow(/private/);
    });

    it("should reject localhost registry URLs", async () => {
      await expect(
        installPack(db, provider, "some-pack", {
          registryUrl: "https://localhost/registry.json",
        }),
      ).rejects.toThrow(/private/);
    });

    it("should reject http registry URL in listAvailablePacks", async () => {
      await expect(listAvailablePacks("http://evil.com/registry.json")).rejects.toThrow(
        /must use https/,
      );
    });

    it("should reject private IP in listAvailablePacks", async () => {
      await expect(listAvailablePacks("https://192.168.1.1/registry.json")).rejects.toThrow(
        /private/,
      );
    });
  });

  describe("createPackFromSource", () => {
    let sourceDir: string;

    beforeEach(() => {
      sourceDir = mkdtempSync(join(tmpdir(), "libscope-pack-source-"));
    });

    it("should create a pack from a folder of markdown files", async () => {
      writeFileSync(join(sourceDir, "guide.md"), "# Guide\n\nThis is a guide.");
      writeFileSync(join(sourceDir, "api.md"), "# API\n\nEndpoint reference.");

      const pack = await createPackFromSource({
        name: "test-from-folder",
        from: [sourceDir],
      });

      expect(pack.name).toBe("test-from-folder");
      expect(pack.documents).toHaveLength(2);
      expect(pack.documents.map((d) => d.title).sort()).toEqual(["api", "guide"]);
      expect(pack.documents[0]!.content).toBeTruthy();
      expect(pack.documents[0]!.source).toMatch(/^file:\/\//);
      expect(pack.version).toBe("1.0.0");
      expect(pack.metadata.author).toBe("libscope");
    });

    it("should write pack to outputPath", async () => {
      writeFileSync(join(sourceDir, "doc.md"), "# Doc\n\nContent here.");
      const outputPath = join(tempDir, "output-pack.json");

      const pack = await createPackFromSource({
        name: "output-test",
        from: [sourceDir],
        outputPath,
      });

      expect(existsSync(outputPath)).toBe(true);
      const written = JSON.parse(readFileSync(outputPath, "utf-8")) as KnowledgePack;
      expect(written.name).toBe("output-test");
      expect(written.documents).toHaveLength(1);
      expect(pack.documents).toHaveLength(1);
    });

    it("should filter by extensions", async () => {
      writeFileSync(join(sourceDir, "readme.md"), "# Readme");
      writeFileSync(join(sourceDir, "page.html"), "<h1>Page</h1><p>Content</p>");
      writeFileSync(join(sourceDir, "data.json"), '{"key": "value"}');

      const pack = await createPackFromSource({
        name: "ext-filter",
        from: [sourceDir],
        extensions: [".md"],
      });

      expect(pack.documents).toHaveLength(1);
      expect(pack.documents[0]!.title).toBe("readme");
    });

    it("should handle extensions without leading dot", async () => {
      writeFileSync(join(sourceDir, "readme.md"), "# Readme\n\nContent");

      const pack = await createPackFromSource({
        name: "ext-no-dot",
        from: [sourceDir],
        extensions: ["md"],
      });

      expect(pack.documents).toHaveLength(1);
    });

    it("should exclude files matching patterns", async () => {
      writeFileSync(join(sourceDir, "guide.md"), "# Guide\n\nContent");
      writeFileSync(join(sourceDir, "draft.md"), "# Draft\n\nNot ready");

      const pack = await createPackFromSource({
        name: "exclude-test",
        from: [sourceDir],
        exclude: ["draft.md"],
      });

      expect(pack.documents).toHaveLength(1);
      expect(pack.documents[0]!.title).toBe("guide");
    });

    it("should recurse into subdirectories by default", async () => {
      const { mkdirSync } = await import("node:fs");
      const subDir = join(sourceDir, "sub");
      mkdirSync(subDir);
      writeFileSync(join(sourceDir, "root.md"), "# Root");
      writeFileSync(join(subDir, "nested.md"), "# Nested\n\nDeep content");

      const pack = await createPackFromSource({
        name: "recursive-test",
        from: [sourceDir],
      });

      expect(pack.documents).toHaveLength(2);
      expect(pack.documents.map((d) => d.title).sort()).toEqual(["nested", "root"]);
    });

    it("should not recurse when recursive is false", async () => {
      const { mkdirSync } = await import("node:fs");
      const subDir = join(sourceDir, "sub");
      mkdirSync(subDir);
      writeFileSync(join(sourceDir, "root.md"), "# Root");
      writeFileSync(join(subDir, "nested.md"), "# Nested");

      const pack = await createPackFromSource({
        name: "no-recurse",
        from: [sourceDir],
        recursive: false,
      });

      expect(pack.documents).toHaveLength(1);
      expect(pack.documents[0]!.title).toBe("root");
    });

    it("should throw for empty pack name", async () => {
      await expect(createPackFromSource({ name: "  ", from: [sourceDir] })).rejects.toThrow(
        /Pack name is required/,
      );
    });

    it("should throw for empty from array", async () => {
      await expect(createPackFromSource({ name: "test", from: [] })).rejects.toThrow(
        /At least one --from source is required/,
      );
    });

    it("should throw for non-existent source path", async () => {
      await expect(
        createPackFromSource({ name: "test", from: ["/nonexistent/path/xyz"] }),
      ).rejects.toThrow(/does not exist/);
    });

    it("should throw when no documents could be created", async () => {
      // Empty directory — no parseable files
      await expect(createPackFromSource({ name: "empty", from: [sourceDir] })).rejects.toThrow(
        /No documents could be created/,
      );
    });

    it("should skip files without a parser", async () => {
      writeFileSync(join(sourceDir, "data.bin"), "binary stuff");
      writeFileSync(join(sourceDir, "readme.md"), "# Readme\n\nContent");

      const pack = await createPackFromSource({
        name: "skip-unsupported",
        from: [sourceDir],
      });

      expect(pack.documents).toHaveLength(1);
      expect(pack.documents[0]!.title).toBe("readme");
    });

    it("should skip files with empty content after parsing", async () => {
      writeFileSync(join(sourceDir, "empty.md"), "   ");
      writeFileSync(join(sourceDir, "real.md"), "# Real\n\nActual content");

      const pack = await createPackFromSource({
        name: "skip-empty",
        from: [sourceDir],
      });

      expect(pack.documents).toHaveLength(1);
      expect(pack.documents[0]!.title).toBe("real");
    });

    it("should accept a single file as source", async () => {
      const filePath = join(sourceDir, "single.md");
      writeFileSync(filePath, "# Single File\n\nJust one file.");

      const pack = await createPackFromSource({
        name: "single-file",
        from: [filePath],
      });

      expect(pack.documents).toHaveLength(1);
      expect(pack.documents[0]!.title).toBe("single");
    });

    it("should accept multiple sources", async () => {
      const dir2 = mkdtempSync(join(tmpdir(), "libscope-pack-source2-"));
      writeFileSync(join(sourceDir, "a.md"), "# A\n\nFrom dir 1");
      writeFileSync(join(dir2, "b.md"), "# B\n\nFrom dir 2");

      const pack = await createPackFromSource({
        name: "multi-source",
        from: [sourceDir, dir2],
      });

      expect(pack.documents).toHaveLength(2);
    });

    it("should call onProgress callback", async () => {
      writeFileSync(join(sourceDir, "a.md"), "# A");
      writeFileSync(join(sourceDir, "b.md"), "# B");

      const progress: Array<{ file: string; index: number; total: number }> = [];

      await createPackFromSource({
        name: "progress-test",
        from: [sourceDir],
        onProgress: (info) => progress.push(info),
      });

      expect(progress).toHaveLength(2);
      expect(progress[0]!.index).toBe(0);
      expect(progress[0]!.total).toBe(2);
      expect(progress[1]!.index).toBe(1);
    });

    it("should set custom version, description, author", async () => {
      writeFileSync(join(sourceDir, "doc.md"), "# Doc\n\nContent");

      const pack = await createPackFromSource({
        name: "custom-meta",
        from: [sourceDir],
        version: "2.0.0",
        description: "Custom desc",
        author: "Test Author",
      });

      expect(pack.version).toBe("2.0.0");
      expect(pack.description).toBe("Custom desc");
      expect(pack.metadata.author).toBe("Test Author");
    });

    it("should produce a valid pack that passes validatePack", async () => {
      writeFileSync(join(sourceDir, "doc.md"), "# Doc\n\nSome content here");
      const outputPath = join(tempDir, "validate-test.json");

      await createPackFromSource({
        name: "validate-test",
        from: [sourceDir],
        outputPath,
      });

      // Read and re-validate through installPack (which calls validatePack internally)
      const result = await installPack(db, provider, outputPath);
      expect(result.packName).toBe("validate-test");
      expect(result.documentsInstalled).toBe(1);
    });

    it("should handle HTML files", async () => {
      writeFileSync(
        join(sourceDir, "page.html"),
        "<html><head><title>Test</title></head><body><h1>Hello</h1><p>World</p></body></html>",
      );

      const pack = await createPackFromSource({
        name: "html-test",
        from: [sourceDir],
      });

      expect(pack.documents).toHaveLength(1);
      expect(pack.documents[0]!.title).toBe("page");
      expect(pack.documents[0]!.content).toContain("Hello");
      expect(pack.documents[0]!.content).toContain("World");
    });

    it("should exclude with wildcard patterns", async () => {
      const { mkdirSync } = await import("node:fs");
      const assetsDir = join(sourceDir, "assets");
      mkdirSync(assetsDir);
      writeFileSync(join(sourceDir, "readme.md"), "# Readme\n\nContent");
      writeFileSync(join(assetsDir, "data.md"), "# Asset data");

      const pack = await createPackFromSource({
        name: "wildcard-exclude",
        from: [sourceDir],
        exclude: ["assets/**"],
      });

      expect(pack.documents).toHaveLength(1);
      expect(pack.documents[0]!.title).toBe("readme");
    });

    it("should write gzipped pack when output ends in .gz", async () => {
      writeFileSync(join(sourceDir, "doc.md"), "# Doc\n\nContent here.");
      const outputPath = join(tempDir, "test.json.gz");

      await createPackFromSource({
        name: "gzip-test",
        from: [sourceDir],
        outputPath,
      });

      expect(existsSync(outputPath)).toBe(true);
      const raw = readFileSync(outputPath);
      // Verify gzip magic bytes
      expect(raw[0]).toBe(0x1f);
      expect(raw[1]).toBe(0x8b);
      // Decompress and verify JSON
      const json = gunzipSync(raw).toString("utf-8");
      const parsed = JSON.parse(json) as KnowledgePack;
      expect(parsed.name).toBe("gzip-test");
      expect(parsed.documents).toHaveLength(1);
    });

    it("should write plain JSON when output ends in .json", async () => {
      writeFileSync(join(sourceDir, "doc.md"), "# Doc\n\nContent here.");
      const outputPath = join(tempDir, "test.json");

      await createPackFromSource({
        name: "json-test",
        from: [sourceDir],
        outputPath,
      });

      const raw = readFileSync(outputPath, "utf-8");
      const parsed = JSON.parse(raw) as KnowledgePack;
      expect(parsed.name).toBe("json-test");
    });
  });

  describe("gzip pack install", () => {
    it("should install a gzipped pack file", async () => {
      const pack = makeSamplePack({ name: "gz-pack" });
      const packPath = join(tempDir, "gz-pack.json.gz");
      writeFileSync(packPath, gzipSync(Buffer.from(JSON.stringify(pack), "utf-8")));

      const result = await installPack(db, provider, packPath);

      expect(result.packName).toBe("gz-pack");
      expect(result.documentsInstalled).toBe(2);
      expect(result.alreadyInstalled).toBe(false);
    });

    it("should auto-detect gzip by magic bytes even with .json extension", async () => {
      const pack = makeSamplePack({ name: "magic-detect" });
      const packPath = join(tempDir, "magic-detect.json");
      // Write gzipped content but with .json extension
      writeFileSync(packPath, gzipSync(Buffer.from(JSON.stringify(pack), "utf-8")));

      const result = await installPack(db, provider, packPath);

      expect(result.packName).toBe("magic-detect");
      expect(result.documentsInstalled).toBe(2);
    });

    it("should round-trip: create gzipped pack from source then install it", async () => {
      const rtDir = mkdtempSync(join(tmpdir(), "libscope-pack-rt-"));
      writeFileSync(join(rtDir, "guide.md"), "# Guide\n\nThis is a guide.");
      const packPath = join(tempDir, "roundtrip.json.gz");

      await createPackFromSource({
        name: "roundtrip-pack",
        from: [rtDir],
        outputPath: packPath,
      });

      const result = await installPack(db, provider, packPath);
      expect(result.packName).toBe("roundtrip-pack");
      expect(result.documentsInstalled).toBe(1);
    });
  });

  describe("installPack — batch & progress options", () => {
    it("should report progress via onProgress callback", async () => {
      const pack = makeSamplePack();
      const packPath = join(tempDir, "progress-pack.json");
      writeFileSync(packPath, JSON.stringify(pack), "utf-8");

      const calls: Array<{ current: number; total: number; label: string }> = [];
      await installPack(db, provider, packPath, {
        onProgress: (current, total, label) => {
          calls.push({ current, total, label });
        },
      });

      // Should have called onProgress at least once (one batch covering both docs)
      expect(calls.length).toBeGreaterThan(0);
      // Last call should report all docs processed
      const last = calls[calls.length - 1]!;
      expect(last.current).toBe(2);
      expect(last.total).toBe(2);
    });

    it("should process in smaller batches when batchSize=1", async () => {
      const pack = makeSamplePack();
      const packPath = join(tempDir, "batch1-pack.json");
      writeFileSync(packPath, JSON.stringify(pack), "utf-8");

      const calls: number[] = [];
      await installPack(db, provider, packPath, {
        batchSize: 1,
        onProgress: (current) => calls.push(current),
      });

      // With batchSize=1 and 2 docs, should get 2 progress calls
      expect(calls).toEqual([1, 2]);
    });

    it("should skip documents when resumeFrom is set", async () => {
      const pack = makeSamplePack({
        name: "resume-pack",
        documents: [
          { title: "Doc 1", content: "Content one", source: "" },
          { title: "Doc 2", content: "Content two", source: "" },
          { title: "Doc 3", content: "Content three", source: "" },
        ],
      });
      const packPath = join(tempDir, "resume-pack.json");
      writeFileSync(packPath, JSON.stringify(pack), "utf-8");

      const result = await installPack(db, provider, packPath, { resumeFrom: 2 });

      // Should only install doc 3 (skipped first 2)
      expect(result.documentsInstalled).toBe(1);
      expect(result.packName).toBe("resume-pack");
    });

    it("should count errors when embedBatch fails", async () => {
      const pack = makeSamplePack({ name: "err-pack" });
      const packPath = join(tempDir, "err-pack.json");
      writeFileSync(packPath, JSON.stringify(pack), "utf-8");

      const failProvider = new MockEmbeddingProvider();
      failProvider.embedBatch = vi.fn().mockRejectedValue(new Error("embed failed"));

      const result = await installPack(db, failProvider, packPath);

      // embedBatch failure means documents in that batch are skipped
      expect(result.errors).toBeGreaterThan(0);
      expect(result.documentsInstalled).toBe(0);
    });

    it("should include errors=0 on successful install", async () => {
      const pack = makeSamplePack({ name: "ok-pack" });
      const packPath = join(tempDir, "ok-pack.json");
      writeFileSync(packPath, JSON.stringify(pack), "utf-8");

      const result = await installPack(db, provider, packPath);

      expect(result.errors).toBe(0);
      expect(result.documentsInstalled).toBe(2);
    });

    it("should use a single embedBatch call per batch for efficiency", async () => {
      const pack = makeSamplePack({ name: "batch-efficiency" });
      const packPath = join(tempDir, "batch-eff.json");
      writeFileSync(packPath, JSON.stringify(pack), "utf-8");

      await installPack(db, provider, packPath, { batchSize: 10 });

      // 2 docs in one batch → 1 embedBatch call
      expect(provider.embedBatchCallCount).toBe(1);
    });

    it("should return errors=0 for already-installed pack", async () => {
      const pack = makeSamplePack({ name: "already-pack" });
      const packPath = join(tempDir, "already-pack.json");
      writeFileSync(packPath, JSON.stringify(pack), "utf-8");

      await installPack(db, provider, packPath);
      const result = await installPack(db, provider, packPath);

      expect(result.alreadyInstalled).toBe(true);
      expect(result.errors).toBe(0);
    });
  });
});
