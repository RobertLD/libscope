import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { initLogger } from "../../../src/logger.js";
import type { RegistryEntry, PackSummary } from "../../../src/registry/types.js";

let tempHome: string = join(tmpdir(), `libscope-conflict-test-${process.pid}`);
mkdirSync(tempHome, { recursive: true });

vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return {
    ...orig,
    homedir: () => tempHome,
  };
});

const { findPackInRegistries, resolvePackFromRegistries, parsePackSpecifier, verifyResolvedPackChecksum } =
  await import("../../../src/registry/resolve.js");
const { saveRegistries } = await import("../../../src/registry/config.js");
const { getRegistryCacheDir, getPackDataPath, getPackManifestPath } = await import("../../../src/registry/types.js");
const { clearIndexCache } = await import("../../../src/registry/git.js");

function makeEntry(name: string, overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    name,
    url: "https://github.com/org/registry.git",
    syncInterval: 3600,
    priority: 1,
    lastSyncedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makePack(name: string, overrides: Partial<PackSummary> = {}): PackSummary {
  return {
    name,
    description: `The ${name} pack`,
    tags: [],
    latestVersion: "1.0.0",
    author: "author",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function setupRegistry(regName: string, packs: PackSummary[]): void {
  const cacheDir = getRegistryCacheDir(regName);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, "index.json"), JSON.stringify(packs), "utf-8");
}

function setupPackDataFile(regName: string, packName: string, version: string): void {
  const dataPath = getPackDataPath(regName, packName, version);
  mkdirSync(join(dataPath, ".."), { recursive: true });
  writeFileSync(
    dataPath,
    JSON.stringify({
      name: packName,
      version,
      description: "test",
      documents: [],
      metadata: { author: "test", license: "MIT", createdAt: "2026-01-01" },
    }),
    "utf-8",
  );
}

/**
 * Set up a pack data file with a matching manifest that includes a real checksum.
 * Returns the checksum that was written.
 */
function setupPackDataFileWithManifest(
  regName: string,
  packName: string,
  version: string,
  content?: string,
): string {
  const dataPath = getPackDataPath(regName, packName, version);
  mkdirSync(join(dataPath, ".."), { recursive: true });

  const packContent =
    content ??
    JSON.stringify({
      name: packName,
      version,
      description: "test",
      documents: [],
      metadata: { author: "test", license: "MIT", createdAt: "2026-01-01" },
    });
  writeFileSync(dataPath, packContent, "utf-8");

  const checksum = createHash("sha256").update(packContent, "utf-8").digest("hex");

  const manifestPath = getPackManifestPath(regName, packName);
  mkdirSync(join(manifestPath, ".."), { recursive: true });
  writeFileSync(
    manifestPath,
    JSON.stringify({
      name: packName,
      description: "test",
      tags: [],
      author: "test",
      license: "MIT",
      versions: [
        {
          version,
          publishedAt: "2026-01-01T00:00:00.000Z",
          checksumPath: `${version}/checksum.sha256`,
          checksum,
          docCount: 0,
        },
      ],
    }),
    "utf-8",
  );

  return checksum;
}

describe("registry conflict resolution", () => {
  beforeEach(() => {
    initLogger("silent");
    clearIndexCache();
    tempHome = join(tmpdir(), `libscope-conflict-${randomUUID()}`);
    mkdirSync(tempHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  describe("parsePackSpecifier", () => {
    it("should parse 'name' as name only", () => {
      expect(parsePackSpecifier("react-docs")).toEqual({ name: "react-docs" });
    });

    it("should parse 'name@version' into name and version", () => {
      expect(parsePackSpecifier("react-docs@1.2.0")).toEqual({
        name: "react-docs",
        version: "1.2.0",
      });
    });

    it("should handle scoped-like names with @ at the start", () => {
      // Last @ is the version delimiter
      expect(parsePackSpecifier("@org/pack@2.0.0")).toEqual({
        name: "@org/pack",
        version: "2.0.0",
      });
    });

    it("should return just name when no @ after first character", () => {
      expect(parsePackSpecifier("simple-pack")).toEqual({ name: "simple-pack" });
    });
  });

  describe("findPackInRegistries", () => {
    it("should return empty matches when no registries configured", () => {
      const { matches } = findPackInRegistries("anything");
      expect(matches).toEqual([]);
    });

    it("should find pack in single registry", () => {
      saveRegistries([makeEntry("reg1")]);
      setupRegistry("reg1", [makePack("react-docs")]);

      const { matches } = findPackInRegistries("react-docs");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.entry.name).toBe("reg1");
      expect(matches[0]!.pack.name).toBe("react-docs");
    });

    it("should find pack in multiple registries", () => {
      saveRegistries([makeEntry("reg1"), makeEntry("reg2")]);
      setupRegistry("reg1", [makePack("shared-pack")]);
      setupRegistry("reg2", [makePack("shared-pack")]);

      const { matches } = findPackInRegistries("shared-pack");
      expect(matches).toHaveLength(2);
    });

    it("should warn for unsynced registries", () => {
      saveRegistries([makeEntry("unsynced")]);
      // No cache dir created

      const { matches, warnings } = findPackInRegistries("anything");
      expect(matches).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("never been synced");
    });

    it("should return empty matches when pack not found", () => {
      saveRegistries([makeEntry("reg1")]);
      setupRegistry("reg1", [makePack("other-pack")]);

      const { matches } = findPackInRegistries("nonexistent");
      expect(matches).toEqual([]);
    });
  });

  describe("resolvePackFromRegistries", () => {
    it("should resolve pack from single registry", () => {
      saveRegistries([makeEntry("reg1")]);
      setupRegistry("reg1", [makePack("test-pack")]);
      setupPackDataFile("reg1", "test-pack", "1.0.0");

      const { resolved } = resolvePackFromRegistries("test-pack");
      expect(resolved).not.toBeNull();
      expect(resolved!.registryName).toBe("reg1");
      expect(resolved!.packName).toBe("test-pack");
      expect(resolved!.version).toBe("1.0.0");
    });

    it("should return null when pack not found anywhere", () => {
      saveRegistries([makeEntry("reg1")]);
      setupRegistry("reg1", [makePack("other-pack")]);

      const { resolved } = resolvePackFromRegistries("nonexistent");
      expect(resolved).toBeNull();
    });

    it("should detect conflict when pack exists in multiple registries", () => {
      saveRegistries([makeEntry("reg1", { priority: 2 }), makeEntry("reg2", { priority: 1 })]);
      setupRegistry("reg1", [makePack("shared-pack")]);
      setupRegistry("reg2", [makePack("shared-pack")]);
      setupPackDataFile("reg2", "shared-pack", "1.0.0");

      // Default resolution is "priority" — reg2 has lower priority (wins)
      const { resolved } = resolvePackFromRegistries("shared-pack");
      expect(resolved).not.toBeNull();
      expect(resolved!.registryName).toBe("reg2");
    });

    it("should resolve conflict by priority (lower wins)", () => {
      saveRegistries([makeEntry("reg-a", { priority: 10 }), makeEntry("reg-b", { priority: 1 })]);
      setupRegistry("reg-a", [makePack("shared-pack")]);
      setupRegistry("reg-b", [makePack("shared-pack")]);
      setupPackDataFile("reg-b", "shared-pack", "1.0.0");

      const { resolved } = resolvePackFromRegistries("shared-pack", {
        conflictResolution: { strategy: "priority" },
      });
      expect(resolved!.registryName).toBe("reg-b");
    });

    it("should resolve conflict with explicit registry", () => {
      saveRegistries([makeEntry("reg1"), makeEntry("reg2")]);
      setupRegistry("reg1", [makePack("shared-pack")]);
      setupRegistry("reg2", [makePack("shared-pack")]);
      setupPackDataFile("reg1", "shared-pack", "1.0.0");

      const { resolved } = resolvePackFromRegistries("shared-pack", {
        conflictResolution: { strategy: "explicit", registryName: "reg1" },
      });
      expect(resolved!.registryName).toBe("reg1");
    });

    it("should return conflict for interactive strategy without resolving", () => {
      saveRegistries([makeEntry("reg1"), makeEntry("reg2")]);
      setupRegistry("reg1", [makePack("shared-pack")]);
      setupRegistry("reg2", [makePack("shared-pack")]);

      const { resolved, conflict } = resolvePackFromRegistries("shared-pack", {
        conflictResolution: { strategy: "interactive" },
      });
      expect(resolved).toBeNull();
      expect(conflict).toBeDefined();
      expect(conflict!.sources).toHaveLength(2);
      expect(conflict!.packName).toBe("shared-pack");
    });

    it("should return null when explicit registry doesn't have the pack", () => {
      saveRegistries([makeEntry("reg1"), makeEntry("reg2")]);
      setupRegistry("reg1", [makePack("shared-pack")]);
      setupRegistry("reg2", [makePack("shared-pack")]);

      const { resolved } = resolvePackFromRegistries("shared-pack", {
        registryName: "reg3",
      });
      expect(resolved).toBeNull();
    });

    it("should filter to specified registryName option", () => {
      saveRegistries([makeEntry("reg1"), makeEntry("reg2")]);
      setupRegistry("reg1", [makePack("shared-pack")]);
      setupRegistry("reg2", [makePack("shared-pack")]);
      setupPackDataFile("reg1", "shared-pack", "1.0.0");

      const { resolved } = resolvePackFromRegistries("shared-pack", {
        registryName: "reg1",
      });
      expect(resolved!.registryName).toBe("reg1");
    });

    it("should use specified version", () => {
      saveRegistries([makeEntry("reg1")]);
      setupRegistry("reg1", [makePack("test-pack", { latestVersion: "2.0.0" })]);
      setupPackDataFile("reg1", "test-pack", "1.0.0");

      const { resolved } = resolvePackFromRegistries("test-pack", { version: "1.0.0" });
      expect(resolved!.version).toBe("1.0.0");
    });

    it("should include all candidate registries in conflict", () => {
      saveRegistries([makeEntry("reg1"), makeEntry("reg2"), makeEntry("reg3")]);
      setupRegistry("reg1", [makePack("shared")]);
      setupRegistry("reg2", [makePack("shared")]);
      setupRegistry("reg3", [makePack("shared")]);

      const { conflict } = resolvePackFromRegistries("shared", {
        conflictResolution: { strategy: "interactive" },
      });
      expect(conflict!.sources).toHaveLength(3);
    });

    it("should not conflict when packs have different names", () => {
      saveRegistries([makeEntry("reg1"), makeEntry("reg2")]);
      setupRegistry("reg1", [makePack("pack-a")]);
      setupRegistry("reg2", [makePack("pack-b")]);
      setupPackDataFile("reg1", "pack-a", "1.0.0");

      const { resolved, conflict } = resolvePackFromRegistries("pack-a");
      expect(resolved).not.toBeNull();
      expect(conflict).toBeUndefined();
    });
  });

  describe("verifyResolvedPackChecksum", () => {
    it("should pass when file matches recorded checksum", async () => {
      saveRegistries([makeEntry("reg1")]);
      setupRegistry("reg1", [makePack("test-pack")]);
      setupPackDataFileWithManifest("reg1", "test-pack", "1.0.0");

      const { resolved } = resolvePackFromRegistries("test-pack");
      expect(resolved).not.toBeNull();

      await expect(verifyResolvedPackChecksum(resolved!)).resolves.toBeUndefined();
    });

    it("should throw when file has been tampered with", async () => {
      saveRegistries([makeEntry("reg1")]);
      setupRegistry("reg1", [makePack("test-pack")]);
      setupPackDataFileWithManifest("reg1", "test-pack", "1.0.0");

      const { resolved } = resolvePackFromRegistries("test-pack");
      expect(resolved).not.toBeNull();

      // Tamper with the pack data file after checksum was recorded
      writeFileSync(resolved!.dataPath, '{"tampered":true}', "utf-8");

      await expect(verifyResolvedPackChecksum(resolved!)).rejects.toThrow(
        /Checksum verification failed/,
      );
    });

    it("should skip verification and warn when no manifest exists", async () => {
      saveRegistries([makeEntry("reg1")]);
      setupRegistry("reg1", [makePack("no-manifest-pack")]);
      setupPackDataFile("reg1", "no-manifest-pack", "1.0.0");

      const { resolved } = resolvePackFromRegistries("no-manifest-pack");
      expect(resolved).not.toBeNull();

      // Should not throw — manifest is missing, logs a warning and skips
      await expect(verifyResolvedPackChecksum(resolved!)).resolves.toBeUndefined();
    });

    it("should throw when manifest has no checksum for the version", async () => {
      saveRegistries([makeEntry("reg1")]);
      setupRegistry("reg1", [makePack("zero-checksum-pack")]);
      setupPackDataFile("reg1", "zero-checksum-pack", "1.0.0");

      // Write a manifest with an empty checksum
      const manifestPath = getPackManifestPath("reg1", "zero-checksum-pack");
      mkdirSync(join(manifestPath, ".."), { recursive: true });
      writeFileSync(
        manifestPath,
        JSON.stringify({
          name: "zero-checksum-pack",
          description: "test",
          tags: [],
          author: "test",
          license: "MIT",
          versions: [
            {
              version: "1.0.0",
              publishedAt: "2026-01-01T00:00:00.000Z",
              checksumPath: "1.0.0/checksum.sha256",
              checksum: "",
              docCount: 0,
            },
          ],
        }),
        "utf-8",
      );

      const { resolved } = resolvePackFromRegistries("zero-checksum-pack");
      expect(resolved).not.toBeNull();

      await expect(verifyResolvedPackChecksum(resolved!)).rejects.toThrow(
        /has no checksum recorded/,
      );
    });

    it("should skip verification when version entry not found in manifest", async () => {
      saveRegistries([makeEntry("reg1")]);
      setupRegistry("reg1", [makePack("version-mismatch-pack")]);
      setupPackDataFile("reg1", "version-mismatch-pack", "1.0.0");

      // Manifest only records version 2.0.0, not 1.0.0
      const manifestPath = getPackManifestPath("reg1", "version-mismatch-pack");
      mkdirSync(join(manifestPath, ".."), { recursive: true });
      writeFileSync(
        manifestPath,
        JSON.stringify({
          name: "version-mismatch-pack",
          description: "test",
          tags: [],
          author: "test",
          license: "MIT",
          versions: [
            {
              version: "2.0.0",
              publishedAt: "2026-01-01T00:00:00.000Z",
              checksumPath: "2.0.0/checksum.sha256",
              checksum: "abc123",
              docCount: 0,
            },
          ],
        }),
        "utf-8",
      );

      const { resolved } = resolvePackFromRegistries("version-mismatch-pack");
      expect(resolved).not.toBeNull();

      // Should not throw — version entry missing, logs a warning and skips
      await expect(verifyResolvedPackChecksum(resolved!)).resolves.toBeUndefined();
    });
  });
});
