import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { randomUUID, createHash } from "node:crypto";
import { initLogger } from "../../../src/logger.js";
import { NotFoundError, ValidationError } from "../../../src/errors.js";
import type { RegistryEntry, PackSummary } from "../../../src/registry/types.js";

let tempHome: string = join(tmpdir(), `libscope-resolve-test-${process.pid}`);

vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: (): string => tempHome };
});

const { findRegistryPack, resolveRegistryPack, parsePackSpecifier, verifyResolvedPackChecksum } =
  await import("../../../src/registry/resolve.js");
const { saveRegistries } = await import("../../../src/registry/config.js");
const { getRegistryCacheDir, getPackDataPath, getPackManifestPath } =
  await import("../../../src/registry/types.js");
const { clearIndexCache } = await import("../../../src/registry/git.js");

function makeEntry(name: string): RegistryEntry {
  return { name, url: "https://github.com/org/registry.git", lastSyncedAt: null };
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

function packJson(name: string, version: string): string {
  return JSON.stringify({
    name,
    version,
    description: "test",
    documents: [],
    metadata: { author: "test", license: "MIT", createdAt: "2026-01-01" },
  });
}

/** Write the pack data file and, unless `checksum` is null, a manifest recording it. */
function setupPackData(
  regName: string,
  packName: string,
  version: string,
  options: { data?: Buffer | string; checksum?: string | null; manifestVersion?: string } = {},
): string {
  const dataPath = getPackDataPath(regName, packName, version);
  mkdirSync(join(dataPath, ".."), { recursive: true });
  const data = options.data ?? packJson(packName, version);
  writeFileSync(dataPath, data);
  if (options.checksum === null) return dataPath;

  const manifestPath = getPackManifestPath(regName, packName);
  mkdirSync(join(manifestPath, ".."), { recursive: true });
  const checksum = options.checksum ?? createHash("sha256").update(data).digest("hex");
  const entryVersion = options.manifestVersion ?? version;
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
          version: entryVersion,
          publishedAt: "2026-01-01T00:00:00.000Z",
          checksumPath: `${entryVersion}/checksum.sha256`,
          checksum,
          docCount: 0,
        },
      ],
    }),
  );
  return dataPath;
}

describe("registry pack resolution", () => {
  beforeEach(() => {
    initLogger("silent");
    clearIndexCache();
    tempHome = join(tmpdir(), `libscope-resolve-${randomUUID()}`);
    mkdirSync(tempHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  describe("parsePackSpecifier", () => {
    it("parses 'name' and 'name@version'", () => {
      expect(parsePackSpecifier("react-docs")).toEqual({ name: "react-docs" });
      expect(parsePackSpecifier("react-docs@1.2.0")).toEqual({
        name: "react-docs",
        version: "1.2.0",
      });
    });

    it("does not treat a leading @ as a version separator", () => {
      expect(parsePackSpecifier("@scope")).toEqual({ name: "@scope" });
    });
  });

  describe("findRegistryPack", () => {
    it("finds the latest version in the single registry that has the pack", () => {
      saveRegistries([makeEntry("reg1")]);
      setupRegistry("reg1", [makePack("react", { latestVersion: "2.0.0" })]);
      const dataPath = setupPackData("reg1", "react", "2.0.0");

      expect(findRegistryPack("react")).toEqual({
        registry: "reg1",
        name: "react",
        version: "2.0.0",
        dataPath,
      });
    });

    it("installs the version given as name@version", () => {
      saveRegistries([makeEntry("reg1")]);
      setupRegistry("reg1", [makePack("react", { latestVersion: "2.0.0" })]);
      setupPackData("reg1", "react", "2.0.0");
      setupPackData("reg1", "react", "1.0.0");

      expect(findRegistryPack("react@1.0.0").version).toBe("1.0.0");
    });

    it("throws ValidationError naming every registry when several have the pack", () => {
      saveRegistries([makeEntry("reg1"), makeEntry("reg2")]);
      setupRegistry("reg1", [makePack("react")]);
      setupRegistry("reg2", [makePack("react")]);

      expect(() => findRegistryPack("react")).toThrow(ValidationError);
      expect(() => findRegistryPack("react")).toThrow(/several registries \(reg1, reg2\)/);
    });

    it("uses the named registry when several have the pack", () => {
      saveRegistries([makeEntry("reg1"), makeEntry("reg2")]);
      setupRegistry("reg1", [makePack("react")]);
      setupRegistry("reg2", [makePack("react")]);
      setupPackData("reg2", "react", "1.0.0");

      expect(findRegistryPack("react", "reg2").registry).toBe("reg2");
    });

    it("throws NotFoundError when no registry has the pack", () => {
      saveRegistries([makeEntry("reg1")]);
      setupRegistry("reg1", [makePack("other")]);

      expect(() => findRegistryPack("react")).toThrow(NotFoundError);
      expect(() => findRegistryPack("react", "reg1")).toThrow(/not found in registry "reg1"/);
    });

    it("throws NotFoundError when no registries are configured", () => {
      expect(() => findRegistryPack("react")).toThrow(/no pack registries are configured/);
    });

    it("throws NotFoundError for an unknown registry name", () => {
      saveRegistries([makeEntry("reg1")]);
      expect(() => findRegistryPack("react", "nope")).toThrow(NotFoundError);
    });

    it("throws NotFoundError when the version is not in the local copy", () => {
      saveRegistries([makeEntry("reg1")]);
      setupRegistry("reg1", [makePack("react")]);
      setupPackData("reg1", "react", "1.0.0");

      expect(() => findRegistryPack("react@9.9.9")).toThrow(NotFoundError);
    });

    it("mentions registries that were never synced", () => {
      saveRegistries([makeEntry("reg1"), makeEntry("unsynced")]);
      setupRegistry("reg1", []);

      expect(() => findRegistryPack("react")).toThrow(/"unsynced" has never been synced/);
    });

    it("rejects path traversal in names and versions", () => {
      saveRegistries([makeEntry("reg1")]);
      setupRegistry("reg1", [makePack("react", { latestVersion: "../../etc" })]);

      expect(() => findRegistryPack("../react")).toThrow(ValidationError);
      expect(() => findRegistryPack("react@../x")).toThrow(ValidationError);
      expect(() => findRegistryPack("react")).toThrow(ValidationError);
    });
  });

  describe("resolveRegistryPack (checksums)", () => {
    beforeEach(() => {
      saveRegistries([makeEntry("reg1")]);
      setupRegistry("reg1", [makePack("p")]);
    });

    it("resolves when the file matches the recorded checksum, also for gzip data", async () => {
      setupPackData("reg1", "p", "1.0.0", { data: gzipSync(packJson("p", "1.0.0")) });
      await expect(resolveRegistryPack("p")).resolves.toMatchObject({ name: "p" });
    });

    it("throws when the file was changed after publishing", async () => {
      const dataPath = setupPackData("reg1", "p", "1.0.0");
      writeFileSync(dataPath, '{"tampered":true}');
      await expect(resolveRegistryPack("p")).rejects.toThrow(/Checksum verification failed/);
    });

    it("throws when the manifest has no checksum for the version", async () => {
      setupPackData("reg1", "p", "1.0.0", { checksum: "" });
      await expect(resolveRegistryPack("p")).rejects.toThrow(/has no checksum recorded/);
    });

    it("skips verification without a manifest or a manifest entry for the version", async () => {
      setupPackData("reg1", "p", "1.0.0", { checksum: null });
      await expect(resolveRegistryPack("p")).resolves.toMatchObject({ version: "1.0.0" });

      setupPackData("reg1", "p", "1.0.0", { manifestVersion: "2.0.0", checksum: "abc" });
      await expect(verifyResolvedPackChecksum(findRegistryPack("p"))).resolves.toBeUndefined();
    });
  });
});
