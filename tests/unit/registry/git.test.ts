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
});
