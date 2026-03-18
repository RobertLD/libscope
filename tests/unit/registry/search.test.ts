import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { initLogger } from "../../../src/logger.js";
import type { RegistryEntry, PackSummary } from "../../../src/registry/types.js";

// Mock homedir before importing any registry modules — REGISTRIES_DIR is module-level
let tempHome: string = join(tmpdir(), `libscope-search-test-${process.pid}`);
mkdirSync(tempHome, { recursive: true });

vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return {
    ...orig,
    homedir: () => tempHome,
  };
});

// Import AFTER mock is set up — getRegistryCacheDir picks up mocked homedir
const { searchRegistries } = await import("../../../src/registry/search.js");
const { saveRegistries } = await import("../../../src/registry/config.js");
const { getRegistryCacheDir } = await import("../../../src/registry/types.js");
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

/** Helper: set up a fake registry cache with given packs in index.json */
function setupRegistry(name: string, packs: PackSummary[]): void {
  const cacheDir = getRegistryCacheDir(name);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, "index.json"), JSON.stringify(packs), "utf-8");
}

describe("registry search", () => {
  beforeEach(() => {
    initLogger("silent");
    clearIndexCache();
    tempHome = join(tmpdir(), `libscope-search-${randomUUID()}`);
    mkdirSync(tempHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("should return empty results when no registries configured", () => {
    const { results, warnings } = searchRegistries("anything");
    expect(results).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("should warn when a registry has never been synced", () => {
    saveRegistries([makeEntry("unsynced")]);
    // Don't create cache dir

    const { results, warnings } = searchRegistries("test");
    expect(results).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("never been synced");
  });

  it("should find pack by exact name match", () => {
    saveRegistries([makeEntry("reg1")]);
    setupRegistry("reg1", [makePack("react-docs")]);

    const { results } = searchRegistries("react-docs");
    expect(results).toHaveLength(1);
    expect(results[0]!.pack.name).toBe("react-docs");
    // 100 (exact name) + 20 (description contains "react-docs" via default desc)
    expect(results[0]!.score).toBeGreaterThanOrEqual(100);
  });

  it("should find pack by partial name match", () => {
    saveRegistries([makeEntry("reg1")]);
    setupRegistry("reg1", [makePack("react-docs")]);

    const { results } = searchRegistries("react");
    expect(results).toHaveLength(1);
    expect(results[0]!.score).toBeGreaterThanOrEqual(50); // partial name match
  });

  it("should find pack by description match", () => {
    saveRegistries([makeEntry("reg1")]);
    setupRegistry("reg1", [makePack("my-pack", { description: "React documentation pack" })]);

    const { results } = searchRegistries("documentation");
    expect(results).toHaveLength(1);
    expect(results[0]!.score).toBeGreaterThanOrEqual(20);
  });

  it("should find pack by tag exact match", () => {
    saveRegistries([makeEntry("reg1")]);
    setupRegistry("reg1", [makePack("my-pack", { tags: ["react", "frontend"] })]);

    const { results } = searchRegistries("react");
    expect(results).toHaveLength(1);
    expect(results[0]!.score).toBeGreaterThanOrEqual(30);
  });

  it("should find pack by author match", () => {
    saveRegistries([makeEntry("reg1")]);
    setupRegistry("reg1", [makePack("some-pack", { author: "john-doe" })]);

    const { results } = searchRegistries("john");
    expect(results).toHaveLength(1);
    expect(results[0]!.score).toBeGreaterThanOrEqual(10);
  });

  it("should return no results for non-matching query", () => {
    saveRegistries([makeEntry("reg1")]);
    setupRegistry("reg1", [makePack("react-docs")]);

    const { results } = searchRegistries("completely-unrelated-xyz");
    expect(results).toEqual([]);
  });

  it("should search across multiple registries", () => {
    saveRegistries([makeEntry("reg1"), makeEntry("reg2")]);
    setupRegistry("reg1", [makePack("react-docs")]);
    setupRegistry("reg2", [makePack("vue-docs")]);

    const { results } = searchRegistries("docs");
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.pack.name).sort((a, b) => a.localeCompare(b))).toEqual([
      "react-docs",
      "vue-docs",
    ]);
  });

  it("should sort results by score descending", () => {
    saveRegistries([makeEntry("reg1")]);
    setupRegistry("reg1", [
      makePack("react", { description: "React framework", tags: ["react"] }),
      makePack("react-docs", { description: "Docs for React" }),
    ]);

    const { results } = searchRegistries("react");
    // "react" has exact name match (100) + more → higher score
    // "react-docs" has partial name match (50) + less
    expect(results[0]!.pack.name).toBe("react");
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it("should be case-insensitive", () => {
    saveRegistries([makeEntry("reg1")]);
    setupRegistry("reg1", [makePack("React-Docs")]);

    const { results } = searchRegistries("REACT");
    expect(results).toHaveLength(1);
  });

  it("should filter by specific registry when registryName option is provided", () => {
    saveRegistries([makeEntry("reg1"), makeEntry("reg2")]);
    setupRegistry("reg1", [makePack("react-docs")]);
    setupRegistry("reg2", [makePack("vue-docs")]);

    const { results } = searchRegistries("docs", { registryName: "reg1" });
    expect(results).toHaveLength(1);
    expect(results[0]!.registryName).toBe("reg1");
  });

  it("should warn when specified registryName does not exist", () => {
    const { results, warnings } = searchRegistries("test", { registryName: "nonexistent" });
    expect(results).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not found");
  });

  it("should include registryName in results", () => {
    saveRegistries([makeEntry("my-registry")]);
    setupRegistry("my-registry", [makePack("test-pack")]);

    const { results } = searchRegistries("test");
    expect(results[0]!.registryName).toBe("my-registry");
  });

  it("should handle corrupted index.json gracefully", () => {
    saveRegistries([makeEntry("bad-reg")]);
    const cacheDir = getRegistryCacheDir("bad-reg");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "index.json"), "invalid json!", "utf-8");

    const { results, warnings } = searchRegistries("test");
    expect(results).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Failed to read");
  });
});
