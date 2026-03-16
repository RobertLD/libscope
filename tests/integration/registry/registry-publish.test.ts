import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { initLogger } from "../../../src/logger.js";
import type { RegistryEntry, PackSummary, PackManifest } from "../../../src/registry/types.js";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

let tempHome: string = join(tmpdir(), `libscope-publish-test-${process.pid}`);
mkdirSync(tempHome, { recursive: true });

vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return {
    ...orig,
    homedir: () => tempHome,
  };
});

const { loadRegistries, saveRegistries, getRegistry } =
  await import("../../../src/registry/config.js");
const { syncRegistry } = await import("../../../src/registry/sync.js");
const { publishPack, unpublishPack } = await import("../../../src/registry/publish.js");
const { verifyChecksum } = await import("../../../src/registry/checksum.js");
const { getRegistryCacheDir } = await import("../../../src/registry/types.js");

function makeEntry(name: string, url: string): RegistryEntry {
  return { name, url, syncInterval: 3600, priority: 1, lastSyncedAt: null };
}

function addTestRegistry(entry: RegistryEntry): void {
  const registries = loadRegistries();
  registries.push(entry);
  saveRegistries(registries);
}

/**
 * Create a bare git repo with an initial commit (empty index + packs dir).
 */
function createBareRepo(dir: string): string {
  const bareDir = join(dir, `registry-${randomUUID()}.git`);
  execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });

  const workDir = join(dir, `work-${randomUUID()}`);
  execSync(`git clone "${bareDir}" "${workDir}"`, { stdio: "pipe" });
  writeFileSync(join(workDir, "index.json"), "[]", "utf-8");
  mkdirSync(join(workDir, "packs"), { recursive: true });
  writeFileSync(join(workDir, "packs", ".gitkeep"), "", "utf-8");
  execSync("git add . && git commit -m 'init'", { cwd: workDir, stdio: "pipe", env: gitEnv });
  execSync("git push", { cwd: workDir, stdio: "pipe" });
  return bareDir;
}

/** Create a valid pack JSON file */
function createPackFile(dir: string, name: string, version = "1.0.0"): string {
  const filePath = join(dir, `${name}.json`);
  writeFileSync(
    filePath,
    JSON.stringify({
      name,
      version,
      description: `The ${name} knowledge pack`,
      documents: [
        { title: "Getting Started", content: "# Guide\n\nIntro content.", source: "test" },
        { title: "API Ref", content: "# API\n\nEndpoints.", source: "test" },
      ],
      metadata: { author: "test-author", license: "MIT", createdAt: "2026-01-01T00:00:00.000Z" },
    }),
    "utf-8",
  );
  return filePath;
}

describe("integration: registry publish", () => {
  let tempDir: string;

  beforeEach(() => {
    initLogger("silent");
    tempDir = mkdtempSync(join(tmpdir(), "libscope-publish-"));
    tempHome = join(tempDir, "home");
    mkdirSync(tempHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should publish a pack to the registry and update index + manifest", async () => {
    const bareRepo = createBareRepo(tempDir);
    addTestRegistry(makeEntry("pub-reg", bareRepo));
    const entry = getRegistry("pub-reg")!;
    await syncRegistry(entry);

    const packFile = createPackFile(tempDir, "my-pack");
    const result = await publishPack({
      registryName: "pub-reg",
      packFilePath: packFile,
      version: "1.0.0",
    });

    expect(result.packName).toBe("my-pack");
    expect(result.version).toBe("1.0.0");
    expect(result.checksum).toHaveLength(64);
    expect(result.registryName).toBe("pub-reg");

    // Verify index.json updated
    const cacheDir = getRegistryCacheDir("pub-reg");
    const index = JSON.parse(readFileSync(join(cacheDir, "index.json"), "utf-8")) as PackSummary[];
    expect(index).toHaveLength(1);
    expect(index[0]!.name).toBe("my-pack");
    expect(index[0]!.latestVersion).toBe("1.0.0");

    // Verify manifest
    const manifest = JSON.parse(
      readFileSync(join(cacheDir, "packs", "my-pack", "pack.json"), "utf-8"),
    ) as PackManifest;
    expect(manifest.versions).toHaveLength(1);
    expect(manifest.versions[0]!.version).toBe("1.0.0");
    expect(manifest.versions[0]!.checksum).toBe(result.checksum);
  });

  it("should generate and store checksum on publish", async () => {
    const bareRepo = createBareRepo(tempDir);
    addTestRegistry(makeEntry("cs-reg", bareRepo));
    await syncRegistry(getRegistry("cs-reg")!);

    const packFile = createPackFile(tempDir, "cs-pack");
    const result = await publishPack({
      registryName: "cs-reg",
      packFilePath: packFile,
      version: "1.0.0",
    });

    // Verify checksum file
    const cacheDir = getRegistryCacheDir("cs-reg");
    const checksumPath = join(cacheDir, "packs", "cs-pack", "1.0.0", "checksum.sha256");
    expect(existsSync(checksumPath)).toBe(true);
    const storedChecksum = readFileSync(checksumPath, "utf-8").trim();
    expect(storedChecksum).toBe(result.checksum);
  });

  it("should verify checksum round-trip (publish then verify)", async () => {
    const bareRepo = createBareRepo(tempDir);
    addTestRegistry(makeEntry("rt-reg", bareRepo));
    await syncRegistry(getRegistry("rt-reg")!);

    const packFile = createPackFile(tempDir, "rt-pack");
    const result = await publishPack({
      registryName: "rt-reg",
      packFilePath: packFile,
      version: "1.0.0",
    });

    // Verify the published file passes checksum
    const cacheDir = getRegistryCacheDir("rt-reg");
    const publishedFile = join(cacheDir, "packs", "rt-pack", "1.0.0", "rt-pack.json");
    expect(await verifyChecksum(publishedFile, result.checksum)).toBe(true);
  });

  it("should unpublish a pack version", async () => {
    const bareRepo = createBareRepo(tempDir);
    addTestRegistry(makeEntry("unpub-reg", bareRepo));
    await syncRegistry(getRegistry("unpub-reg")!);

    const packFile = createPackFile(tempDir, "unpub-pack");
    await publishPack({
      registryName: "unpub-reg",
      packFilePath: packFile,
      version: "1.0.0",
    });

    await unpublishPack({
      registryName: "unpub-reg",
      packName: "unpub-pack",
      version: "1.0.0",
    });

    // Verify removed from index
    const cacheDir = getRegistryCacheDir("unpub-reg");
    const index = JSON.parse(readFileSync(join(cacheDir, "index.json"), "utf-8")) as PackSummary[];
    expect(index.find((p) => p.name === "unpub-pack")).toBeUndefined();
  });

  it("should reject publish with non-existent pack file", async () => {
    const bareRepo = createBareRepo(tempDir);
    addTestRegistry(makeEntry("err-reg", bareRepo));
    await syncRegistry(getRegistry("err-reg")!);

    await expect(
      publishPack({
        registryName: "err-reg",
        packFilePath: join(tempDir, "nonexistent.json"),
      }),
    ).rejects.toThrow(/not found/);
  });

  it("should reject publish to non-existent registry", async () => {
    const packFile = createPackFile(tempDir, "orphan");
    await expect(
      publishPack({ registryName: "nonexistent", packFilePath: packFile }),
    ).rejects.toThrow(/not found/);
  });

  it("should reject duplicate version publish", async () => {
    const bareRepo = createBareRepo(tempDir);
    addTestRegistry(makeEntry("dup-reg", bareRepo));
    await syncRegistry(getRegistry("dup-reg")!);

    const packFile = createPackFile(tempDir, "dup-pack");
    await publishPack({
      registryName: "dup-reg",
      packFilePath: packFile,
      version: "1.0.0",
    });

    await expect(
      publishPack({
        registryName: "dup-reg",
        packFilePath: packFile,
        version: "1.0.0",
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("should update existing pack version on re-publish with different version", async () => {
    const bareRepo = createBareRepo(tempDir);
    addTestRegistry(makeEntry("multi-ver-reg", bareRepo));
    await syncRegistry(getRegistry("multi-ver-reg")!);

    const packFile = createPackFile(tempDir, "multi-ver");
    await publishPack({
      registryName: "multi-ver-reg",
      packFilePath: packFile,
      version: "1.0.0",
    });
    await publishPack({
      registryName: "multi-ver-reg",
      packFilePath: packFile,
      version: "1.1.0",
    });

    const cacheDir = getRegistryCacheDir("multi-ver-reg");
    const manifest = JSON.parse(
      readFileSync(join(cacheDir, "packs", "multi-ver", "pack.json"), "utf-8"),
    ) as PackManifest;
    expect(manifest.versions).toHaveLength(2);
    // Newest first
    expect(manifest.versions[0]!.version).toBe("1.1.0");
    expect(manifest.versions[1]!.version).toBe("1.0.0");
  });

  it("should unpublish one version while keeping others", async () => {
    const bareRepo = createBareRepo(tempDir);
    addTestRegistry(makeEntry("partial-unpub", bareRepo));
    await syncRegistry(getRegistry("partial-unpub")!);

    const packFile = createPackFile(tempDir, "multi-ver-unpub");
    await publishPack({
      registryName: "partial-unpub",
      packFilePath: packFile,
      version: "1.0.0",
    });
    await publishPack({
      registryName: "partial-unpub",
      packFilePath: packFile,
      version: "2.0.0",
    });

    // Unpublish only v1.0.0
    await unpublishPack({
      registryName: "partial-unpub",
      packName: "multi-ver-unpub",
      version: "1.0.0",
    });

    const cacheDir = getRegistryCacheDir("partial-unpub");
    const manifest = JSON.parse(
      readFileSync(join(cacheDir, "packs", "multi-ver-unpub", "pack.json"), "utf-8"),
    ) as PackManifest;
    expect(manifest.versions).toHaveLength(1);
    expect(manifest.versions[0]!.version).toBe("2.0.0");

    // Index should still list the pack with updated latestVersion
    const index = JSON.parse(readFileSync(join(cacheDir, "index.json"), "utf-8")) as PackSummary[];
    const entry = index.find((p) => p.name === "multi-ver-unpub");
    expect(entry).toBeDefined();
    expect(entry!.latestVersion).toBe("2.0.0");
  });

  it("should reject unpublish for non-existent version", async () => {
    const bareRepo = createBareRepo(tempDir);
    addTestRegistry(makeEntry("bad-unpub", bareRepo));
    await syncRegistry(getRegistry("bad-unpub")!);

    const packFile = createPackFile(tempDir, "unpub-err");
    await publishPack({
      registryName: "bad-unpub",
      packFilePath: packFile,
      version: "1.0.0",
    });

    await expect(
      unpublishPack({
        registryName: "bad-unpub",
        packName: "unpub-err",
        version: "9.9.9",
      }),
    ).rejects.toThrow(/not found/);
  });

  it("should reject unpublish for non-existent pack", async () => {
    const bareRepo = createBareRepo(tempDir);
    addTestRegistry(makeEntry("no-pack-unpub", bareRepo));
    await syncRegistry(getRegistry("no-pack-unpub")!);

    await expect(
      unpublishPack({
        registryName: "no-pack-unpub",
        packName: "nonexistent",
        version: "1.0.0",
      }),
    ).rejects.toThrow(/not found/);
  });
});
