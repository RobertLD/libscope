import { describe, it, expect } from "vitest";
import {
  INDEX_FILE,
  PACKS_DIR,
  PACK_MANIFEST_FILE,
  CHECKSUM_FILE,
  getRegistryCacheDir,
  getRegistryIndexPath,
  getPackManifestPath,
  getPackVersionDir,
  getPackDataPath,
  getChecksumPath,
} from "../../../src/registry/types.js";
import type {
  RegistryEntry,
  PackSummary,
  PackManifest,
  RegistryConfigBlock,
  ConflictResolution,
  RegistrySyncStatus,
} from "../../../src/registry/types.js";

describe("registry types — constants", () => {
  it("should export correct file name constants", () => {
    expect(INDEX_FILE).toBe("index.json");
    expect(PACK_MANIFEST_FILE).toBe("pack.json");
    expect(CHECKSUM_FILE).toBe("checksum.sha256");
    expect(PACKS_DIR).toBe("packs");
  });
});

describe("registry types — path helpers", () => {
  it("getRegistryCacheDir should return path under ~/.libscope/registries/<name>", () => {
    const dir = getRegistryCacheDir("official");
    expect(dir).toContain("registries");
    expect(dir).toContain("official");
  });

  it("getRegistryIndexPath should end with index.json", () => {
    const p = getRegistryIndexPath("my-reg");
    expect(p).toMatch(/my-reg[/\\]index\.json$/);
  });

  it("getPackManifestPath should include packs/<name>/pack.json", () => {
    const p = getPackManifestPath("my-reg", "react-pack");
    expect(p).toContain("packs");
    expect(p).toContain("react-pack");
    expect(p).toMatch(/pack\.json$/);
  });

  it("getPackVersionDir should include packs/<name>/<version>", () => {
    const p = getPackVersionDir("my-reg", "react-pack", "1.2.0");
    expect(p).toContain("react-pack");
    expect(p).toContain("1.2.0");
  });

  it("getPackDataPath should return <version>/<packName>.json", () => {
    const p = getPackDataPath("my-reg", "react-pack", "1.0.0");
    expect(p).toMatch(/1\.0\.0[/\\]react-pack\.json$/);
  });

  it("getChecksumPath should return <version>/checksum.sha256", () => {
    const p = getChecksumPath("my-reg", "react-pack", "2.0.0");
    expect(p).toMatch(/2\.0\.0[/\\]checksum\.sha256$/);
  });
});

describe("registry types — type shape validation", () => {
  // These tests verify that objects conforming to the interfaces compile and have expected structure.
  // Parsing/validation functions will be tested once implemented in Tasks 2-6.

  it("RegistryEntry should have all required fields", () => {
    const entry: RegistryEntry = {
      name: "official",
      url: "https://github.com/org/registry.git",
      syncInterval: 3600,
      priority: 1,
      lastSyncedAt: null,
    };
    expect(entry.name).toBe("official");
    expect(entry.syncInterval).toBe(3600);
    expect(entry.lastSyncedAt).toBeNull();
  });

  it("PackSummary should have name, description, tags, latestVersion, author, updatedAt", () => {
    const summary: PackSummary = {
      name: "react-docs",
      description: "React documentation pack",
      tags: ["react", "frontend"],
      latestVersion: "1.0.0",
      author: "team",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(summary.tags).toHaveLength(2);
    expect(summary.latestVersion).toBe("1.0.0");
  });

  it("PackManifest should include versions array with PackVersionEntry items", () => {
    const manifest: PackManifest = {
      name: "react-docs",
      description: "React documentation",
      tags: ["react"],
      author: "team",
      license: "MIT",
      versions: [
        {
          version: "1.0.0",
          publishedAt: "2026-01-01T00:00:00.000Z",
          checksumPath: "1.0.0/checksum.sha256",
          checksum: "abc123",
          docCount: 5,
        },
      ],
    };
    expect(manifest.versions).toHaveLength(1);
    expect(manifest.versions[0]!.docCount).toBe(5);
  });

  it("RegistryConfigBlock should wrap registries array", () => {
    const block: RegistryConfigBlock = {
      registries: [],
    };
    expect(block.registries).toEqual([]);
  });

  it("ConflictResolution should support 'priority', 'interactive', and 'explicit' strategies", () => {
    const byPriority: ConflictResolution = { strategy: "priority" };
    const interactive: ConflictResolution = { strategy: "interactive" };
    const explicit: ConflictResolution = { strategy: "explicit", registryName: "official" };
    expect(byPriority.strategy).toBe("priority");
    expect(interactive.strategy).toBe("interactive");
    expect(explicit.strategy).toBe("explicit");
  });

  it("RegistrySyncStatus should support all status values", () => {
    const statuses: RegistrySyncStatus["status"][] = ["syncing", "success", "error", "offline"];
    expect(statuses).toHaveLength(4);
  });
});

// TODO: Once parse/validate functions are implemented (Tasks 2-6), add:
// describe("parseRegistryIndex") — validate index.json shape, reject malformed input
// describe("parsePackManifest") — validate pack.json shape, reject missing fields
// describe("validateRegistryEntry") — reject empty name, invalid URL, etc.
