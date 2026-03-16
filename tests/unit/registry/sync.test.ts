import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { initLogger } from "../../../src/logger.js";
import type { RegistryEntry, PackSummary } from "../../../src/registry/types.js";

let tempHome: string = join(tmpdir(), `libscope-sync-test-${process.pid}`);
mkdirSync(tempHome, { recursive: true });

vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return {
    ...orig,
    homedir: () => tempHome,
  };
});

const {
  syncRegistry,
  syncAllRegistries,
  syncStaleRegistries,
  syncRegistryByName,
  getRegistryIndex,
} = await import("../../../src/registry/sync.js");
const { loadRegistries, saveRegistries } = await import("../../../src/registry/config.js");

function makeEntry(
  name: string,
  url: string,
  overrides: Partial<RegistryEntry> = {},
): RegistryEntry {
  return {
    name,
    url,
    syncInterval: 3600,
    priority: 1,
    lastSyncedAt: null,
    ...overrides,
  };
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
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@test.com",
  };
  execSync("git add . && git commit -m 'init'", { cwd: workDir, stdio: "pipe", env: gitEnv });
  execSync("git push", { cwd: workDir, stdio: "pipe" });
  return bareDir;
}

describe("registry sync functions", () => {
  let tempDir: string;

  beforeEach(() => {
    initLogger("silent");
    tempDir = mkdtempSync(join(tmpdir(), "libscope-sync-"));
    tempHome = join(tempDir, "home");
    mkdirSync(tempHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("syncRegistryByName", () => {
    it("should return error for non-existent registry name", async () => {
      const status = await syncRegistryByName("nonexistent");
      expect(status.status).toBe("error");
      expect(status.error).toContain("not found");
    });

    it("should sync an existing registry by name", async () => {
      const bareRepo = createBareRepo(tempDir);
      addTestRegistry(makeEntry("by-name", bareRepo));
      const status = await syncRegistryByName("by-name");
      expect(status.status).toBe("success");
    });
  });

  describe("syncAllRegistries", () => {
    it("should return empty array when no registries configured", async () => {
      const results = await syncAllRegistries();
      expect(results).toEqual([]);
    });

    it("should sync all configured registries", async () => {
      const repo1 = createBareRepo(tempDir);
      const repo2 = createBareRepo(tempDir);
      addTestRegistry(makeEntry("all-1", repo1));
      addTestRegistry(makeEntry("all-2", repo2));

      const results = await syncAllRegistries();
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.status === "success")).toBe(true);
    });
  });

  describe("syncStaleRegistries", () => {
    it("should return empty array when no registries are stale", async () => {
      const repo = createBareRepo(tempDir);
      addTestRegistry(
        makeEntry("fresh", repo, {
          syncInterval: 99999,
          lastSyncedAt: new Date().toISOString(),
        }),
      );
      const results = await syncStaleRegistries();
      expect(results).toEqual([]);
    });

    it("should sync registries that are stale", async () => {
      const repo = createBareRepo(tempDir);
      addTestRegistry(
        makeEntry("stale-one", repo, {
          syncInterval: 1,
          lastSyncedAt: "2020-01-01T00:00:00.000Z", // very old
        }),
      );
      const results = await syncStaleRegistries();
      expect(results).toHaveLength(1);
      expect(results[0]!.status).toBe("success");
    });

    it("should return empty when all registries have syncInterval=0 (manual)", async () => {
      const repo = createBareRepo(tempDir);
      addTestRegistry(makeEntry("manual", repo, { syncInterval: 0 }));
      const results = await syncStaleRegistries();
      expect(results).toEqual([]);
    });
  });

  describe("getRegistryIndex", () => {
    it("should return packs from a synced registry", async () => {
      const packs: PackSummary[] = [
        {
          name: "test-pack",
          description: "Test",
          tags: [],
          latestVersion: "1.0.0",
          author: "a",
          updatedAt: "2026-01-01",
        },
      ];
      const repo = createBareRepo(tempDir, packs);
      addTestRegistry(makeEntry("idx-test", repo));
      await syncRegistry(makeEntry("idx-test", repo));

      const entry = makeEntry("idx-test", repo, {
        syncInterval: 0, // manual, won't auto-sync
        lastSyncedAt: new Date().toISOString(),
      });
      const { packs: result, warning } = await getRegistryIndex(entry);
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe("test-pack");
      expect(warning).toBeUndefined();
    });

    it("should return warning when remote unreachable and has stale cache", async () => {
      const packs: PackSummary[] = [
        {
          name: "offline-pack",
          description: "Offline",
          tags: [],
          latestVersion: "1.0.0",
          author: "a",
          updatedAt: "2026-01-01",
        },
      ];
      const repo = createBareRepo(tempDir, packs);
      const entry = makeEntry("offline-idx", repo, {
        syncInterval: 1,
        lastSyncedAt: "2020-01-01T00:00:00.000Z",
      });
      addTestRegistry(entry);

      // Sync once to populate cache
      await syncRegistry(entry);

      // Break the remote
      const { renameSync } = await import("node:fs");
      renameSync(repo, repo + ".broken");

      // getRegistryIndex should fall back to cache with warning
      const staleEntry = makeEntry("offline-idx", repo, {
        syncInterval: 1,
        lastSyncedAt: "2020-01-01T00:00:00.000Z",
      });
      const { packs: result, warning } = await getRegistryIndex(staleEntry);
      expect(result).toHaveLength(1);
      expect(warning).toContain("unreachable");
    });
  });

  // Robustness fix: sync locking prevents concurrent syncs
  describe("sync locking", () => {
    it("should create a lock file during sync and remove it when done", async () => {
      const { getRegistryCacheDir } = await import("../../../src/registry/types.js");
      const repo = createBareRepo(tempDir);
      const regName = `lock-test-${randomUUID()}`;
      addTestRegistry(makeEntry(regName, repo));

      const cacheDir = getRegistryCacheDir(regName);
      const lockPath = cacheDir + ".lock";

      // Lock file should not exist before sync
      expect(existsSync(lockPath)).toBe(false);

      const status = await syncRegistry(makeEntry(regName, repo));
      expect(status.status).toBe("success");

      // Lock file should be removed after successful sync
      expect(existsSync(lockPath)).toBe(false);
    });

    it("should skip sync and return error status when a live lock is held", async () => {
      const { getRegistryCacheDir } = await import("../../../src/registry/types.js");
      const repo = createBareRepo(tempDir);
      const regName = `live-lock-${randomUUID()}`;
      addTestRegistry(makeEntry(regName, repo));

      const cacheDir = getRegistryCacheDir(regName);
      const lockPath = cacheDir + ".lock";

      // Create parent dir so we can write lock file
      mkdirSync(join(cacheDir, ".."), { recursive: true });

      // Write a lock file claiming OUR process PID (which is definitely alive)
      writeFileSync(lockPath, String(process.pid), "utf-8");

      try {
        const status = await syncRegistry(makeEntry(regName, repo));
        expect(status.status).toBe("error");
        expect(status.error).toMatch(/already in progress/);
      } finally {
        // Clean up lock file
        try {
          rmSync(lockPath);
        } catch {
          // ignore
        }
      }
    });

    it("should clean up a stale lock from a dead PID and proceed with sync", async () => {
      const { getRegistryCacheDir } = await import("../../../src/registry/types.js");
      const repo = createBareRepo(tempDir);
      const regName = `stale-lock-${randomUUID()}`;
      addTestRegistry(makeEntry(regName, repo));

      const cacheDir = getRegistryCacheDir(regName);
      const lockPath = cacheDir + ".lock";

      // Create parent dir
      mkdirSync(join(cacheDir, ".."), { recursive: true });

      // Write a lock file with a PID that is guaranteed not to exist
      // PID 99999999 is well above Linux's max PID (usually 4194304)
      const deadPid = 99999999;
      writeFileSync(lockPath, String(deadPid), "utf-8");

      // Sync should succeed — it should detect the dead PID, remove the stale lock, and proceed
      const status = await syncRegistry(makeEntry(regName, repo));
      expect(status.status).toBe("success");

      // Lock file should be cleaned up
      expect(existsSync(lockPath)).toBe(false);
    });

    it("should remove lock even when sync fails (lock released in finally)", async () => {
      const { getRegistryCacheDir } = await import("../../../src/registry/types.js");
      const regName = `fail-lock-${randomUUID()}`;
      // Use a non-existent URL — sync will fail immediately (no network call on local)
      // We need the lock file to be released regardless. Use an invalid local path.
      const entry = makeEntry(regName, "/nonexistent/path/that/does/not/exist.git");
      addTestRegistry(entry);

      const cacheDir = getRegistryCacheDir(regName);
      const lockPath = cacheDir + ".lock";

      const status = await syncRegistry(entry);
      // Sync should fail (bad URL)
      expect(["error", "offline"]).toContain(status.status);

      // Lock file should still be removed
      expect(existsSync(lockPath)).toBe(false);
    });
  });
});
