import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
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

let tempHome: string = join(tmpdir(), `libscope-offline-test-${process.pid}`);
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
const { syncRegistry, getRegistryIndex } = await import("../../../src/registry/sync.js");
const { searchRegistries } = await import("../../../src/registry/search.js");
const { getRegistryCacheDir } = await import("../../../src/registry/types.js");

function makeEntry(name: string, url: string): RegistryEntry {
  return { name, url, syncInterval: 3600, priority: 1, lastSyncedAt: null };
}

function addTestRegistry(entry: RegistryEntry): void {
  const registries = loadRegistries();
  registries.push(entry);
  saveRegistries(registries);
}

function createBareRepo(dir: string, packs: PackSummary[] = []): string {
  const bareDir = join(dir, `registry-${randomUUID()}.git`);
  execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });

  const workDir = join(dir, `work-${randomUUID()}`);
  execSync(`git clone "${bareDir}" "${workDir}"`, { stdio: "pipe" });
  writeFileSync(join(workDir, "index.json"), JSON.stringify(packs), "utf-8");
  execSync("git add . && git commit -m 'init'", { cwd: workDir, stdio: "pipe", env: gitEnv });
  execSync("git push", { cwd: workDir, stdio: "pipe" });
  return bareDir;
}

describe("integration: registry offline / unreachable remote", () => {
  let tempDir: string;

  beforeEach(() => {
    initLogger("silent");
    tempDir = mkdtempSync(join(tmpdir(), "libscope-offline-"));
    tempHome = join(tempDir, "home");
    mkdirSync(tempHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should return error status when syncing an unreachable remote", async () => {
    const nonexistentUrl = join(tempDir, "does-not-exist.git");
    addTestRegistry(makeEntry("unreachable", nonexistentUrl));

    const entry = getRegistry("unreachable")!;
    const status = await syncRegistry(entry);

    expect(status.status).toBe("error");
    expect(status.error).toBeTruthy();
  });

  it("should fall back to stale cache when remote becomes unreachable", async () => {
    const packs: PackSummary[] = [
      {
        name: "cached-pack",
        description: "A pack that was cached",
        tags: [],
        latestVersion: "1.0.0",
        author: "author",
        updatedAt: "2026-01-01",
      },
    ];
    const bareRepo = createBareRepo(tempDir, packs);
    addTestRegistry(makeEntry("fallback", bareRepo));

    // Sync successfully first
    const entry = getRegistry("fallback")!;
    const firstSync = await syncRegistry(entry);
    expect(firstSync.status).toBe("success");

    // Break the remote by renaming it
    const brokenPath = bareRepo + ".broken";
    renameSync(bareRepo, brokenPath);

    // Re-sync — should fall back to cached
    const updatedEntry = getRegistry("fallback")!;
    const secondSync = await syncRegistry(updatedEntry);
    expect(secondSync.status).toBe("offline");
    expect(secondSync.error).toBeTruthy();

    // Verify cache still usable
    const cacheDir = getRegistryCacheDir("fallback");
    expect(existsSync(cacheDir)).toBe(true);
  });

  it("should include registry name in offline error message", async () => {
    const nonexistentUrl = join(tempDir, "no-such-repo.git");
    addTestRegistry(makeEntry("named-error", nonexistentUrl));

    const entry = getRegistry("named-error")!;
    const status = await syncRegistry(entry);

    expect(status.registryName).toBe("named-error");
    expect(status.status).toBe("error");
  });

  it("should allow search against stale cache after sync failure", async () => {
    const packs: PackSummary[] = [
      {
        name: "stale-searchable",
        description: "Can still be searched",
        tags: ["test"],
        latestVersion: "1.0.0",
        author: "author",
        updatedAt: "2026-01-01",
      },
    ];
    const bareRepo = createBareRepo(tempDir, packs);
    addTestRegistry(makeEntry("stale-search", bareRepo));

    // Sync successfully
    await syncRegistry(getRegistry("stale-search")!);

    // Break remote
    renameSync(bareRepo, bareRepo + ".gone");

    // Search should still return results from cache
    const { results } = searchRegistries("stale");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.pack.name).toBe("stale-searchable");
  });

  it("should fail clearly when no cache exists and remote is unreachable", async () => {
    addTestRegistry(makeEntry("no-cache", join(tempDir, "nonexistent.git")));

    const entry = getRegistry("no-cache")!;
    const status = await syncRegistry(entry);

    expect(status.status).toBe("error");
    expect(status.error).toBeTruthy();
    // No cache should have been created
    expect(existsSync(getRegistryCacheDir("no-cache"))).toBe(false);
  });

  it("should return error with getRegistryIndex when never synced and unreachable", async () => {
    addTestRegistry(makeEntry("never-synced", join(tempDir, "ghost.git")));

    const entry = getRegistry("never-synced")!;
    const { packs, warning } = await getRegistryIndex(entry);

    expect(packs).toEqual([]);
    expect(warning).toBeTruthy();
  });
});
