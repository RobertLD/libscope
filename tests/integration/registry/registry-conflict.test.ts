import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { initLogger } from "../../../src/logger.js";
import { NotFoundError } from "../../../src/errors.js";
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
const { findRegistryPack } = await import("../../../src/registry/resolve.js");
const { installPackOperation, listPacksOperation, runOperation } =
  await import("../../../src/core/operations/index.js");
const { makeContext } = await import("../../unit/operations/helpers.js");

function makeEntry(name: string, url: string): RegistryEntry {
  return { name, url, lastSyncedAt: null };
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

  function pack(name: string, author = "author"): PackSummary {
    return {
      name,
      description: `The ${name} pack`,
      tags: [],
      latestVersion: "1.0.0",
      author,
      updatedAt: "2026-01-01",
    };
  }

  async function addSynced(name: string, packs: PackSummary[]): Promise<void> {
    addTestRegistry(makeEntry(name, createBareRepoWithPacks(tempDir, packs)));
    expect((await syncRegistry(getRegistry(name)!)).status).toBe("success");
  }

  it("refuses an ambiguous pack name and installs from the named registry", async () => {
    await addSynced("reg1", [pack("shared-pack")]);
    await addSynced("reg2", [pack("shared-pack", "other-author")]);
    const t = makeContext();
    try {
      await expect(
        runOperation(installPackOperation, t.ctx, { pack: "shared-pack" }),
      ).rejects.toThrow(/several registries \(reg1, reg2\)/);

      const result = await runOperation(installPackOperation, t.ctx, {
        pack: "shared-pack@1.0.0",
        registry: "reg2",
      });
      expect(result).toMatchObject({ packName: "shared-pack", documentsInstalled: 1 });
      const row = t.db.prepare("SELECT content FROM documents").get() as { content: string };
      expect(row.content).toContain("other-author");
    } finally {
      t.db.close();
    }
  });

  it("resolves packs with different names without a registry", async () => {
    await addSynced("one", [pack("alpha")]);
    await addSynced("two", [pack("beta")]);
    expect(findRegistryPack("alpha").registry).toBe("one");
    expect(findRegistryPack("beta").registry).toBe("two");
    expect(() => findRegistryPack("gamma")).toThrow(NotFoundError);
  });

  it("lists the packs available in the synced registries", async () => {
    await addSynced("one", [pack("alpha")]);
    await addSynced("two", [pack("beta"), pack("alpha")]);
    const t = makeContext();
    try {
      const all = await runOperation(listPacksOperation, t.ctx, { available: true });
      expect(all.items.map((p) => ("registry" in p ? `${p.registry}/${p.name}` : p.name))).toEqual([
        "one/alpha",
        "two/beta",
        "two/alpha",
      ]);
      const two = await runOperation(listPacksOperation, t.ctx, {
        available: true,
        registry: "two",
      });
      expect(two.items).toHaveLength(2);
    } finally {
      t.db.close();
    }
  });
});
