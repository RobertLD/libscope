import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
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

let tempHome: string = join(tmpdir(), `libscope-conflict-int-test-${process.pid}`);
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
const { resolvePackFromRegistries } = await import("../../../src/registry/resolve.js");

function makeEntry(name: string, url: string, priority = 1): RegistryEntry {
  return { name, url, syncInterval: 3600, priority, lastSyncedAt: null };
}

function addTestRegistry(entry: RegistryEntry): void {
  const registries = loadRegistries();
  registries.push(entry);
  saveRegistries(registries);
}

function createBareRepoWithPacks(dir: string, packs: PackSummary[]): string {
  const bareDir = join(dir, `registry-${randomUUID()}.git`);
  execSync(`git init --bare "${bareDir}"`, { stdio: "pipe" });

  const workDir = join(dir, `work-${randomUUID()}`);
  execSync(`git clone "${bareDir}" "${workDir}"`, { stdio: "pipe" });

  writeFileSync(join(workDir, "index.json"), JSON.stringify(packs, null, 2), "utf-8");

  for (const pack of packs) {
    const packDir = join(workDir, "packs", pack.name);
    mkdirSync(packDir, { recursive: true });

    const versionDir = join(packDir, pack.latestVersion);
    mkdirSync(versionDir, { recursive: true });

    // Write the pack data file and compute its real SHA-256 checksum
    const packDataContent = JSON.stringify({
      name: pack.name,
      version: pack.latestVersion,
      description: pack.description,
      documents: [{ title: "Doc", content: "Content from " + pack.author, source: "test" }],
      metadata: { author: pack.author, license: "MIT", createdAt: pack.updatedAt },
    });
    const dataFilePath = join(versionDir, `${pack.name}.json`);
    writeFileSync(dataFilePath, packDataContent, "utf-8");
    const checksum = createHash("sha256").update(packDataContent, "utf-8").digest("hex");

    writeFileSync(join(versionDir, "checksum.sha256"), checksum + "\n", "utf-8");

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
            checksum,
            docCount: 1,
          },
        ],
      }),
      "utf-8",
    );
  }

  execSync("git add . && git commit -m 'init'", { cwd: workDir, stdio: "pipe", env: gitEnv });
  execSync("git push", { cwd: workDir, stdio: "pipe" });
  return bareDir;
}

describe("integration: registry conflict resolution", () => {
  let tempDir: string;

  beforeEach(() => {
    initLogger("silent");
    tempDir = mkdtempSync(join(tmpdir(), "libscope-conflict-int-"));
    tempHome = join(tempDir, "home");
    mkdirSync(tempHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should detect conflict when two registries have the same pack name", async () => {
    const sharedPack: PackSummary = {
      name: "shared-pack",
      description: "Shared",
      tags: [],
      latestVersion: "1.0.0",
      author: "author",
      updatedAt: "2026-01-01",
    };

    const repo1 = createBareRepoWithPacks(tempDir, [sharedPack]);
    const repo2 = createBareRepoWithPacks(tempDir, [{ ...sharedPack, author: "other-author" }]);

    addTestRegistry(makeEntry("reg1", repo1, 2));
    addTestRegistry(makeEntry("reg2", repo2, 1));

    await syncRegistry(getRegistry("reg1")!);
    await syncRegistry(getRegistry("reg2")!);

    // With interactive resolution, should get conflict back
    const { resolved, conflict } = resolvePackFromRegistries("shared-pack", {
      conflictResolution: { strategy: "interactive" },
    });

    expect(resolved).toBeNull();
    expect(conflict).toBeDefined();
    expect(conflict!.sources).toHaveLength(2);
    expect(conflict!.sources.map((s) => s.registryName).sort()).toEqual(["reg1", "reg2"]);
  });

  it("should resolve conflict with explicit --registry flag", async () => {
    const sharedPack: PackSummary = {
      name: "shared-pack",
      description: "Shared",
      tags: [],
      latestVersion: "1.0.0",
      author: "author-1",
      updatedAt: "2026-01-01",
    };

    const repo1 = createBareRepoWithPacks(tempDir, [sharedPack]);
    const repo2 = createBareRepoWithPacks(tempDir, [{ ...sharedPack, author: "author-2" }]);

    addTestRegistry(makeEntry("reg1", repo1));
    addTestRegistry(makeEntry("reg2", repo2));
    await syncRegistry(getRegistry("reg1")!);
    await syncRegistry(getRegistry("reg2")!);

    const { resolved } = resolvePackFromRegistries("shared-pack", {
      registryName: "reg1",
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.registryName).toBe("reg1");
  });

  it("should resolve conflict by priority (lower wins)", async () => {
    const sharedPack: PackSummary = {
      name: "priority-pack",
      description: "Priority test",
      tags: [],
      latestVersion: "1.0.0",
      author: "author",
      updatedAt: "2026-01-01",
    };

    const repo1 = createBareRepoWithPacks(tempDir, [sharedPack]);
    const repo2 = createBareRepoWithPacks(tempDir, [sharedPack]);

    addTestRegistry(makeEntry("high-priority", repo1, 10));
    addTestRegistry(makeEntry("low-priority", repo2, 1));
    await syncRegistry(getRegistry("high-priority")!);
    await syncRegistry(getRegistry("low-priority")!);

    const { resolved } = resolvePackFromRegistries("priority-pack", {
      conflictResolution: { strategy: "priority" },
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.registryName).toBe("low-priority");
  });

  it("should not conflict when packs have different names", async () => {
    const repo1 = createBareRepoWithPacks(tempDir, [
      {
        name: "pack-a",
        description: "Pack A",
        tags: [],
        latestVersion: "1.0.0",
        author: "a",
        updatedAt: "2026-01-01",
      },
    ]);
    const repo2 = createBareRepoWithPacks(tempDir, [
      {
        name: "pack-b",
        description: "Pack B",
        tags: [],
        latestVersion: "1.0.0",
        author: "b",
        updatedAt: "2026-01-01",
      },
    ]);

    addTestRegistry(makeEntry("no-conflict-1", repo1));
    addTestRegistry(makeEntry("no-conflict-2", repo2));
    await syncRegistry(getRegistry("no-conflict-1")!);
    await syncRegistry(getRegistry("no-conflict-2")!);

    const { resolved: r1, conflict: c1 } = resolvePackFromRegistries("pack-a");
    expect(r1).not.toBeNull();
    expect(c1).toBeUndefined();

    const { resolved: r2, conflict: c2 } = resolvePackFromRegistries("pack-b");
    expect(r2).not.toBeNull();
    expect(c2).toBeUndefined();
  });

  it("should handle conflict with three registries", async () => {
    const sharedPack: PackSummary = {
      name: "triple-pack",
      description: "Three-way conflict",
      tags: [],
      latestVersion: "1.0.0",
      author: "author",
      updatedAt: "2026-01-01",
    };

    const repo1 = createBareRepoWithPacks(tempDir, [sharedPack]);
    const repo2 = createBareRepoWithPacks(tempDir, [sharedPack]);
    const repo3 = createBareRepoWithPacks(tempDir, [sharedPack]);

    addTestRegistry(makeEntry("triple-1", repo1));
    addTestRegistry(makeEntry("triple-2", repo2));
    addTestRegistry(makeEntry("triple-3", repo3));
    await syncRegistry(getRegistry("triple-1")!);
    await syncRegistry(getRegistry("triple-2")!);
    await syncRegistry(getRegistry("triple-3")!);

    const { conflict } = resolvePackFromRegistries("triple-pack", {
      conflictResolution: { strategy: "interactive" },
    });

    expect(conflict).toBeDefined();
    expect(conflict!.sources).toHaveLength(3);
  });

  it("should list all conflicting registries in conflict object", async () => {
    const sharedPack: PackSummary = {
      name: "info-pack",
      description: "Info test",
      tags: [],
      latestVersion: "1.0.0",
      author: "author",
      updatedAt: "2026-01-01",
    };

    const repo1 = createBareRepoWithPacks(tempDir, [sharedPack]);
    const repo2 = createBareRepoWithPacks(tempDir, [sharedPack]);

    addTestRegistry(makeEntry("info-reg1", repo1, 2));
    addTestRegistry(makeEntry("info-reg2", repo2, 1));
    await syncRegistry(getRegistry("info-reg1")!);
    await syncRegistry(getRegistry("info-reg2")!);

    const { conflict } = resolvePackFromRegistries("info-pack", {
      conflictResolution: { strategy: "interactive" },
    });

    expect(conflict!.packName).toBe("info-pack");
    for (const source of conflict!.sources) {
      expect(source.registryName).toBeTruthy();
      expect(source.registryUrl).toBeTruthy();
      expect(source.version).toBe("1.0.0");
      expect(typeof source.priority).toBe("number");
    }
  });
});
