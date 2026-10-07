import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync, renameSync } from "node:fs";
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

const { syncRegistry, syncAllRegistries, localPackCount } =
  await import("../../../src/registry/sync.js");
const { loadRegistries, saveRegistries } = await import("../../../src/registry/config.js");

function makeEntry(
  name: string,
  url: string,
  overrides: Partial<RegistryEntry> = {},
): RegistryEntry {
  return { name, url, lastSyncedAt: null, ...overrides };
}

const PACK: PackSummary = {
  name: "test-pack",
  description: "Test",
  tags: [],
  latestVersion: "1.0.0",
  author: "a",
  updatedAt: "2026-01-01",
};

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

  describe("syncRegistry", () => {
    it("clones the registry and reports its pack count", async () => {
      const bareRepo = createBareRepo(tempDir, [PACK]);
      addTestRegistry(makeEntry("by-name", bareRepo));
      expect(localPackCount("by-name")).toBeNull();

      const status = await syncRegistry(makeEntry("by-name", bareRepo));
      expect(status).toMatchObject({ registry: "by-name", status: "success", packs: 1 });
      expect(loadRegistries()[0]!.lastSyncedAt).not.toBeNull();
    });

    it("keeps the local copy when the remote is unreachable (offline)", async () => {
      const repo = createBareRepo(tempDir, [PACK]);
      const entry = makeEntry("offline-idx", repo);
      addTestRegistry(entry);
      await syncRegistry(entry);

      renameSync(repo, repo + ".broken");
      const status = await syncRegistry(entry);
      expect(status).toMatchObject({ status: "offline", packs: 1 });
      expect(status.error).toBeTruthy();
    });

    it("reports error when the registry was never cloned and cannot be reached", async () => {
      const entry = makeEntry("never", join(tempDir, "missing.git"));
      addTestRegistry(entry);
      expect(await syncRegistry(entry)).toMatchObject({ status: "error", packs: null });
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
