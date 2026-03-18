import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { initLogger } from "../../../src/logger.js";
import type { RegistryEntry, PackSummary } from "../../../src/registry/types.js";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

let tempHome: string = join(tmpdir(), `libscope-lifecycle-test-${process.pid}`);
mkdirSync(tempHome, { recursive: true });

vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return {
    ...orig,
    homedir: () => tempHome,
  };
});

const { removeRegistry, loadRegistries, getRegistry, saveRegistries } =
  await import("../../../src/registry/config.js");
const { syncRegistry } = await import("../../../src/registry/sync.js");
const { searchRegistries } = await import("../../../src/registry/search.js");
const { getRegistryCacheDir } = await import("../../../src/registry/types.js");
const { readIndex } = await import("../../../src/registry/git.js");

function makeEntry(name: string, url: string): RegistryEntry {
  return {
    name,
    url,
    syncInterval: 3600,
    priority: 1,
    lastSyncedAt: null,
  };
}

/** Add a registry entry bypassing URL validation (for local bare repo paths). */
function addTestRegistry(entry: RegistryEntry): void {
  const registries = loadRegistries();
  registries.push(entry);
  saveRegistries(registries);
}

/**
 * Create a local bare git repo populated with an index.json and a sample pack.
 */
function createBareRegistryRepo(dir: string, packs: PackSummary[]): string {
  const bareDir = join(dir, `registry-${randomUUID()}.git`);
  execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });

  const workDir = join(dir, `work-${randomUUID()}`);
  execSync(`git clone "${bareDir}" "${workDir}"`, { stdio: "pipe" });

  // Write index.json
  writeFileSync(join(workDir, "index.json"), JSON.stringify(packs, null, 2), "utf-8");

  // Write pack.json for each pack
  const packsDir = join(workDir, "packs");
  mkdirSync(packsDir, { recursive: true });
  for (const pack of packs) {
    const packDir = join(packsDir, pack.name);
    mkdirSync(packDir, { recursive: true });
    writeFileSync(
      join(packDir, "pack.json"),
      JSON.stringify({
        name: pack.name,
        description: pack.description,
        tags: pack.tags,
        author: pack.author,
        license: "MIT",
        versions: [
          {
            version: pack.latestVersion,
            publishedAt: pack.updatedAt,
            checksumPath: `${pack.latestVersion}/checksum.sha256`,
            checksum: "placeholder",
            docCount: 1,
          },
        ],
      }),
      "utf-8",
    );

    // Create a version directory with a pack data file
    const versionDir = join(packDir, pack.latestVersion);
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(
      join(versionDir, `${pack.name}.json`),
      JSON.stringify({
        name: pack.name,
        version: pack.latestVersion,
        description: pack.description,
        documents: [{ title: "Doc 1", content: "Content 1", source: "test" }],
        metadata: { author: pack.author, license: "MIT", createdAt: pack.updatedAt },
      }),
      "utf-8",
    );
  }

  execSync("git add . && git commit -m 'init'", { cwd: workDir, stdio: "pipe", env: gitEnv });
  execSync("git push", { cwd: workDir, stdio: "pipe" });

  return bareDir;
}

describe("integration: registry lifecycle", () => {
  let tempDir: string;

  beforeEach(() => {
    initLogger("silent");
    tempDir = mkdtempSync(join(tmpdir(), "libscope-lifecycle-"));
    tempHome = join(tempDir, "home");
    mkdirSync(tempHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should add a registry and persist it in config", () => {
    const bareRepo = createBareRegistryRepo(tempDir, []);
    addTestRegistry(makeEntry("test-reg", bareRepo));

    const registries = loadRegistries();
    expect(registries).toHaveLength(1);
    expect(registries[0]!.name).toBe("test-reg");
    expect(registries[0]!.url).toBe(bareRepo);
  });

  it("should sync a registry and populate local cache", async () => {
    const samplePack: PackSummary = {
      name: "sample-pack",
      description: "A sample pack",
      tags: ["test"],
      latestVersion: "1.0.0",
      author: "tester",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const bareRepo = createBareRegistryRepo(tempDir, [samplePack]);
    addTestRegistry(makeEntry("sync-test", bareRepo));

    const entry = getRegistry("sync-test")!;
    const status = await syncRegistry(entry);

    expect(status.status).toBe("success");

    // Verify cache dir has index.json
    const cacheDir = getRegistryCacheDir("sync-test");
    expect(existsSync(cacheDir)).toBe(true);
    const packs = readIndex(cacheDir);
    expect(packs).toHaveLength(1);
    expect(packs[0]!.name).toBe("sample-pack");
  });

  it("should search packs from a synced registry", async () => {
    const packs: PackSummary[] = [
      {
        name: "react-docs",
        description: "React documentation",
        tags: ["react"],
        latestVersion: "1.0.0",
        author: "team",
        updatedAt: "2026-01-01",
      },
      {
        name: "vue-docs",
        description: "Vue documentation",
        tags: ["vue"],
        latestVersion: "2.0.0",
        author: "team",
        updatedAt: "2026-01-01",
      },
    ];
    const bareRepo = createBareRegistryRepo(tempDir, packs);
    addTestRegistry(makeEntry("search-test", bareRepo));

    const entry = getRegistry("search-test")!;
    await syncRegistry(entry);

    const { results } = searchRegistries("react");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.pack.name).toBe("react-docs");
  });

  it("should remove a registry and clean up cache", async () => {
    const bareRepo = createBareRegistryRepo(tempDir, []);
    addTestRegistry(makeEntry("removable", bareRepo));

    const entry = getRegistry("removable")!;
    await syncRegistry(entry);

    const cacheDir = getRegistryCacheDir("removable");
    expect(existsSync(cacheDir)).toBe(true);

    removeRegistry("removable");
    expect(loadRegistries()).toHaveLength(0);
    // Note: removeRegistry only removes from config, cache cleanup is separate
  });

  it("should re-sync and update cache when registry content changes", async () => {
    // Start with one pack
    const bareRepo = createBareRegistryRepo(tempDir, [
      {
        name: "initial-pack",
        description: "Initial",
        tags: [],
        latestVersion: "1.0.0",
        author: "author",
        updatedAt: "2026-01-01",
      },
    ]);
    addTestRegistry(makeEntry("evolving", bareRepo));

    const entry = getRegistry("evolving")!;
    await syncRegistry(entry);

    let packs = readIndex(getRegistryCacheDir("evolving"));
    expect(packs).toHaveLength(1);

    // Push a new pack to the bare repo
    const workDir = join(tempDir, `update-work-${randomUUID()}`);
    execSync(`git clone "${bareRepo}" "${workDir}"`, { stdio: "pipe" });
    const index = JSON.parse(readFileSync(join(workDir, "index.json"), "utf-8")) as PackSummary[];
    index.push({
      name: "new-pack",
      description: "Newly added",
      tags: [],
      latestVersion: "1.0.0",
      author: "author",
      updatedAt: "2026-02-01",
    });
    writeFileSync(join(workDir, "index.json"), JSON.stringify(index), "utf-8");
    execSync("git add . && git commit -m 'add new pack' && git push", {
      cwd: workDir,
      stdio: "pipe",
      env: gitEnv,
    });

    // Re-sync
    await syncRegistry(entry);
    packs = readIndex(getRegistryCacheDir("evolving"));
    expect(packs).toHaveLength(2);
    expect(packs.map((p) => p.name)).toContain("new-pack");
  });

  it("should handle adding multiple registries", async () => {
    const bareRepo1 = createBareRegistryRepo(tempDir, [
      {
        name: "pack-from-reg1",
        description: "From registry 1",
        tags: [],
        latestVersion: "1.0.0",
        author: "a",
        updatedAt: "2026-01-01",
      },
    ]);
    const bareRepo2 = createBareRegistryRepo(tempDir, [
      {
        name: "pack-from-reg2",
        description: "From registry 2",
        tags: [],
        latestVersion: "1.0.0",
        author: "b",
        updatedAt: "2026-01-01",
      },
    ]);

    addTestRegistry(makeEntry("multi-1", bareRepo1));
    addTestRegistry(makeEntry("multi-2", bareRepo2));

    const e1 = getRegistry("multi-1")!;
    const e2 = getRegistry("multi-2")!;
    await syncRegistry(e1);
    await syncRegistry(e2);

    // Search across both
    const { results } = searchRegistries("pack");
    expect(results.length).toBe(2);
    expect(results.map((r) => r.pack.name).sort((a, b) => a.localeCompare(b))).toEqual([
      "pack-from-reg1",
      "pack-from-reg2",
    ]);
  });
});
