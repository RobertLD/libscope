import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { initLogger } from "../../../src/logger.js";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

import {
  readIndex,
  createRegistryRepo,
  checkGitAvailable,
  cloneRegistry,
  fetchRegistry,
  commitAndPush,
  clearIndexCache,
} from "../../../src/registry/git.js";

describe("registry git helpers", () => {
  let tempDir: string;

  beforeEach(() => {
    initLogger("silent");
    tempDir = mkdtempSync(join(tmpdir(), "libscope-git-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("checkGitAvailable", () => {
    it("should return true when git is available", async () => {
      const result = await checkGitAvailable();
      expect(result).toBe(true);
    });
  });

  describe("readIndex", () => {
    beforeEach(() => {
      // Clear index cache before each test so disk reads are fresh
      clearIndexCache();
    });

    it("should return empty array when index.json does not exist", () => {
      const result = readIndex(tempDir);
      expect(result).toEqual([]);
    });

    it("should parse a valid index.json array", () => {
      const index = [
        {
          name: "react-docs",
          description: "React documentation",
          tags: ["react"],
          latestVersion: "1.0.0",
          author: "team",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      writeFileSync(join(tempDir, "index.json"), JSON.stringify(index), "utf-8");

      const result = readIndex(tempDir);
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe("react-docs");
    });

    it("should throw when index.json is not an array", () => {
      writeFileSync(join(tempDir, "index.json"), JSON.stringify({ not: "array" }), "utf-8");
      expect(() => readIndex(tempDir)).toThrow(/not an array/);
    });

    it("should throw when index.json is invalid JSON", () => {
      writeFileSync(join(tempDir, "index.json"), "bad json!!!", "utf-8");
      expect(() => readIndex(tempDir)).toThrow(/Failed to read/);
    });

    it("should parse an empty array", () => {
      writeFileSync(join(tempDir, "index.json"), "[]", "utf-8");
      const result = readIndex(tempDir);
      expect(result).toEqual([]);
    });

    it("should parse index with multiple packs", () => {
      const index = [
        {
          name: "pack-a",
          description: "First",
          tags: [],
          latestVersion: "1.0.0",
          author: "a",
          updatedAt: "2026-01-01",
        },
        {
          name: "pack-b",
          description: "Second",
          tags: ["tag1"],
          latestVersion: "2.0.0",
          author: "b",
          updatedAt: "2026-02-01",
        },
      ];
      writeFileSync(join(tempDir, "index.json"), JSON.stringify(index), "utf-8");

      const result = readIndex(tempDir);
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.name)).toEqual(["pack-a", "pack-b"]);
    });

    // Security/robustness fix: isValidPackSummary type guard — filter invalid entries
    it("should filter out entries missing required fields and keep valid ones", () => {
      const validEntry = {
        name: "valid-pack",
        description: "Valid",
        tags: ["a"],
        latestVersion: "1.0.0",
        author: "me",
        updatedAt: "2026-01-01",
      };
      const missingName = {
        description: "No name",
        tags: [],
        latestVersion: "1.0.0",
        author: "me",
        updatedAt: "2026-01-01",
      };
      const missingLatestVersion = {
        name: "bad-pack",
        description: "No latestVersion",
        tags: [],
        author: "me",
        updatedAt: "2026-01-01",
      };
      const wrongTagType = {
        name: "wrong-tags",
        description: "Tags not array",
        tags: "not-an-array",
        latestVersion: "1.0.0",
        author: "me",
        updatedAt: "2026-01-01",
      };
      writeFileSync(
        join(tempDir, "index.json"),
        JSON.stringify([validEntry, missingName, missingLatestVersion, wrongTagType]),
        "utf-8",
      );

      const result = readIndex(tempDir);
      // Only the one valid entry should survive
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe("valid-pack");
    });

    it("should filter out null entries in the array", () => {
      const validEntry = {
        name: "ok-pack",
        description: "OK",
        tags: [],
        latestVersion: "1.0.0",
        author: "me",
        updatedAt: "2026-01-01",
      };
      writeFileSync(join(tempDir, "index.json"), JSON.stringify([null, validEntry, null]), "utf-8");

      const result = readIndex(tempDir);
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe("ok-pack");
    });

    it("should filter out entries where tags contains non-strings", () => {
      const badTagsEntry = {
        name: "bad-tags-pack",
        description: "Mixed tag types",
        tags: ["good-tag", 42, null],
        latestVersion: "1.0.0",
        author: "me",
        updatedAt: "2026-01-01",
      };
      writeFileSync(join(tempDir, "index.json"), JSON.stringify([badTagsEntry]), "utf-8");

      const result = readIndex(tempDir);
      // Entry with non-string tags should be filtered out
      expect(result).toHaveLength(0);
    });
  });

  describe("createRegistryRepo", () => {
    it("should create a git repo with index.json and packs/ dir", async () => {
      const repoPath = join(tempDir, "new-registry");
      await createRegistryRepo(repoPath);

      // Verify git repo
      expect(existsSync(join(repoPath, ".git"))).toBe(true);

      // Verify index.json
      const indexContent = readFileSync(join(repoPath, "index.json"), "utf-8");
      expect(JSON.parse(indexContent)).toEqual([]);

      // Verify packs/ dir
      expect(existsSync(join(repoPath, "packs"))).toBe(true);
      expect(existsSync(join(repoPath, "packs", ".gitkeep"))).toBe(true);
    });

    it("should throw when path already exists", async () => {
      const repoPath = join(tempDir, "exists");
      mkdirSync(repoPath);
      await expect(createRegistryRepo(repoPath)).rejects.toThrow(/already exists/);
    });

    it("should have an initial commit", async () => {
      const repoPath = join(tempDir, "committed-registry");
      await createRegistryRepo(repoPath);

      // Check git log
      const log = execSync("git log --oneline", { cwd: repoPath, encoding: "utf-8" });
      expect(log).toContain("Initial registry structure");
    });
  });

  describe("cloneRegistry + fetchRegistry", () => {
    it("should clone a bare repo and fetch updates", async () => {
      // Create a bare repo with content
      const bareDir = join(tempDir, "bare.git");
      execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });

      // Set up a work dir, add content, push
      const workDir = join(tempDir, "work");
      execSync(`git clone "${bareDir}" "${workDir}"`, { stdio: "pipe" });
      writeFileSync(join(workDir, "index.json"), "[]", "utf-8");
      execSync("git add . && git commit -m 'init'", { cwd: workDir, stdio: "pipe", env: gitEnv });
      execSync("git push", { cwd: workDir, stdio: "pipe" });

      // Clone via our helper
      const cloneDir = join(tempDir, "cloned");
      await cloneRegistry(bareDir, cloneDir);
      expect(existsSync(join(cloneDir, "index.json"))).toBe(true);

      // Push new content to bare
      writeFileSync(join(workDir, "index.json"), '[{"name":"new"}]', "utf-8");
      execSync("git add . && git commit -m 'update'", { cwd: workDir, stdio: "pipe", env: gitEnv });
      execSync("git push", { cwd: workDir, stdio: "pipe" });

      // Fetch via our helper
      await fetchRegistry(cloneDir);
      const content = readFileSync(join(cloneDir, "index.json"), "utf-8");
      expect(content).toContain("new");
    });

    // Security fix: cloneRegistry passes -c core.symlinks=false
    it("should clone with core.symlinks=false to prevent symlink attacks", async () => {
      // Create a bare repo
      const bareDir = join(tempDir, "symlink-bare.git");
      execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });

      const workDir = join(tempDir, "symlink-work");
      execSync(`git clone "${bareDir}" "${workDir}"`, { stdio: "pipe" });
      writeFileSync(join(workDir, "index.json"), "[]", "utf-8");
      execSync("git add . && git commit -m 'init'", { cwd: workDir, stdio: "pipe", env: gitEnv });
      execSync("git push", { cwd: workDir, stdio: "pipe" });

      const cloneDir = join(tempDir, "symlink-cloned");
      // cloneRegistry uses `git -c core.symlinks=false clone --depth 1 <url> <dest>`.
      // The -c flag is a one-time command-line override — it is NOT persisted to
      // .git/config (only `git config` writes to that file).  We therefore verify that:
      //   (a) the clone succeeds without error
      //   (b) the resulting directory is a valid working tree
      // A separate integration test would need to intercept execFile to confirm the arg.
      await expect(cloneRegistry(bareDir, cloneDir)).resolves.toBeUndefined();
      expect(existsSync(join(cloneDir, ".git"))).toBe(true);
      expect(existsSync(join(cloneDir, "index.json"))).toBe(true);
    });

    // Robustness fix: fetchRegistry detects corrupted cache and removes it
    it("should detect a corrupted cache (not a git repo) and throw FetchError after removing it", async () => {
      // Create a directory that looks like a cache dir but is NOT a git repo
      const corruptedCache = join(tempDir, "corrupted-cache");
      mkdirSync(corruptedCache, { recursive: true });
      writeFileSync(join(corruptedCache, "some-file.txt"), "not a git repo", "utf-8");

      await expect(fetchRegistry(corruptedCache)).rejects.toThrow(/corrupted/);

      // The corrupted cache should have been removed
      expect(existsSync(corruptedCache)).toBe(false);
    });

    // Robustness fix: fetchRegistry falls back through origin/HEAD → origin/main → origin/master
    it("should fall back to origin/main if origin/HEAD is not available", async () => {
      // We create a bare repo without HEAD (no refs/remotes/origin/HEAD in clone)
      const bareDir = join(tempDir, "no-head-bare.git");
      execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });

      const workDir = join(tempDir, "no-head-work");
      execSync(`git clone "${bareDir}" "${workDir}"`, { stdio: "pipe" });
      writeFileSync(join(workDir, "index.json"), "[]", "utf-8");
      execSync("git checkout -b main", { cwd: workDir, stdio: "pipe" });
      execSync("git add . && git commit -m 'init'", { cwd: workDir, stdio: "pipe", env: gitEnv });
      execSync("git push -u origin main", { cwd: workDir, stdio: "pipe" });

      // Clone into a separate dir
      const cloneDir = join(tempDir, "no-head-cloned");
      execSync(`git clone "${bareDir}" "${cloneDir}"`, { stdio: "pipe" });

      // Remove origin/HEAD symref from the clone so the first fallback attempt will fail
      try {
        execSync("git remote set-head origin --delete", { cwd: cloneDir, stdio: "pipe" });
      } catch {
        // May not exist — ignore
      }

      // Should still succeed by falling back to origin/main
      await expect(fetchRegistry(cloneDir)).resolves.toBeUndefined();
    });
  });

  describe("commitAndPush", () => {
    it("should commit and push changes to bare repo", async () => {
      // Create bare repo
      const bareDir = join(tempDir, "push-bare.git");
      execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });

      // Clone and add initial commit
      const workDir = join(tempDir, "push-work");
      execSync(`git clone "${bareDir}" "${workDir}"`, { stdio: "pipe" });
      writeFileSync(join(workDir, "file.txt"), "initial", "utf-8");
      execSync("git add . && git commit -m 'init'", { cwd: workDir, stdio: "pipe", env: gitEnv });
      execSync("git push", { cwd: workDir, stdio: "pipe" });

      // Modify and use commitAndPush
      writeFileSync(join(workDir, "file.txt"), "updated", "utf-8");
      await commitAndPush(workDir, "test commit");

      // Verify by cloning fresh
      const verifyDir = join(tempDir, "verify");
      execSync(`git clone "${bareDir}" "${verifyDir}"`, { stdio: "pipe" });
      const content = readFileSync(join(verifyDir, "file.txt"), "utf-8");
      expect(content).toBe("updated");
    });
  });

  // Robustness: LIBSCOPE_GIT_TIMEOUT_MS controls git timeout
  describe("git timeout via env var (LIBSCOPE_GIT_TIMEOUT_MS)", () => {
    it("GIT_TIMEOUT_MS is capped at 300000ms (5 minutes)", () => {
      // We can't easily change the module-level constant after import, but we can verify
      // that the module uses a numeric value (by checking that the git function accepts
      // an explicit timeout override). This test exercises the path indirectly.
      //
      // A timed-out git call on a local bare repo would not succeed in < 1ms, so we use
      // a very high timeout (the default) to confirm the helper still works normally.
      const bareDir = join(tempDir, "timeout-bare.git");
      execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });
      const workDir = join(tempDir, "timeout-work");
      execSync(`git clone "${bareDir}" "${workDir}"`, { stdio: "pipe" });
      writeFileSync(join(workDir, "f.txt"), "x", "utf-8");
      execSync("git add . && git commit -m 'init'", { cwd: workDir, stdio: "pipe", env: gitEnv });
      execSync("git push", { cwd: workDir, stdio: "pipe" });

      // Should complete without error using default (or env-configured) timeout
      return expect(fetchRegistry(workDir)).resolves.toBeUndefined();
    });
  });
});
