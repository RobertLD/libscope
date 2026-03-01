import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createTestDbWithVec } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import {
  installPack,
  removePack,
  listInstalledPacks,
  createPack,
  listAvailablePacks,
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
});
