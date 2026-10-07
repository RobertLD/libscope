import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  backupOperation,
  bulkDeleteOperation,
  bulkMoveOperation,
  bulkRetagOperation,
  createPackOperation,
  dedupeOperation,
  installPackOperation,
  listDocumentsOperation,
  listPacksOperation,
  overviewOperation,
  pruneExpiredOperation,
  reindexOperation,
  removePackOperation,
  restoreOperation,
} from "../../../src/core/operations/index.js";
import { indexDocument } from "../../../src/core/indexing.js";
import { createTopic } from "../../../src/core/topics.js";
import { NotFoundError, TopicNotFoundError, ValidationError } from "../../../src/errors.js";
import { initLogger } from "../../../src/logger.js";
import { addDoc, expectValidationError, makeContext, run, type TestContext } from "./helpers.js";

initLogger("silent");

describe("pack and admin operations", () => {
  let t: TestContext;
  let dir: string;

  beforeEach(() => {
    t = makeContext();
    dir = mkdtempSync(join(tmpdir(), "libscope-ops-"));
  });

  afterEach(() => {
    t.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function writePack(name: string): string {
    const path = join(dir, `${name}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        name,
        version: "1.0.0",
        description: "Test pack",
        documents: [{ title: "Pack doc", content: "Content from a pack", source: "test" }],
        metadata: { author: "tests", license: "MIT", createdAt: new Date().toISOString() },
      }),
    );
    return path;
  }

  describe("packs", () => {
    it("installs from a file, lists, and removes", async () => {
      const result = await run(installPackOperation, t.ctx, { pack: writePack("demo") });
      expect(result).toMatchObject({ packName: "demo", documentsInstalled: 1 });
      const listed = await run(listPacksOperation, t.ctx, {});
      expect(listed.items.map((p) => p.name)).toEqual(["demo"]);
      await run(removePackOperation, t.ctx, { pack: "demo" });
      expect((await run(listPacksOperation, t.ctx, {})).items).toEqual([]);
    });

    it("refuses pack files over the REST API", async () => {
      const api = makeContext({ db: t.db, surface: "api" });
      await expectValidationError(run(installPackOperation, api.ctx, { pack: writePack("x") }));
      await expectValidationError(run(createPackOperation, api.ctx, { name: "x" }));
    });

    it("rejects an empty pack name", async () => {
      await expectValidationError(run(installPackOperation, t.ctx, { pack: "" }));
      await expectValidationError(run(removePackOperation, t.ctx, {}));
    });

    it("throws NotFoundError when removing a pack that is not installed", async () => {
      await expect(run(removePackOperation, t.ctx, { pack: "nope" })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("creates a pack file from the database", async () => {
      await addDoc(t, "Packed");
      const outputPath = join(dir, "out.json");
      const pack = await run(createPackOperation, t.ctx, { name: "out", outputPath });
      expect(pack.documents).toHaveLength(1);
      expect(existsSync(outputPath)).toBe(true);
    });
  });

  describe("overview", () => {
    it("reports counts, topics, packs and health", async () => {
      createTopic(t.db, { name: "Guides" });
      await addDoc(t, "Doc");
      const overview = await run(overviewOperation, t.ctx, {});
      expect(overview.stats.totalDocuments).toBe(1);
      expect(overview.topics.map((x) => x.name)).toEqual(["Guides"]);
      expect(overview.health).toMatchObject({ database: "ok", fts: "ok" });
      expect(overview.index.configured).toMatchObject({ provider: "mock", dimensions: 4 });
    });
  });

  describe("reindex and dedupe", () => {
    it("re-embeds every chunk", async () => {
      await addDoc(t, "Reindexed");
      const result = await run(reindexOperation, t.ctx, {});
      expect(result.total).toBeGreaterThan(0);
      expect(result.failed).toBe(0);
    });

    it("rejects rebuild combined with filters, and bad dates", async () => {
      await expectValidationError(
        run(reindexOperation, t.ctx, { rebuild: true, documentIds: ["a"] }),
      );
      await expectValidationError(run(reindexOperation, t.ctx, { since: "yesterday" }));
    });

    it("groups exact duplicates", async () => {
      await indexDocument(t.db, t.provider, {
        title: "Copy one",
        content: "identical body",
        sourceType: "manual",
      });
      await indexDocument(t.db, t.provider, {
        title: "Copy two",
        content: "identical body",
        sourceType: "manual",
        dedup: "force",
      });
      const result = await run(dedupeOperation, t.ctx, { strategy: "exact" });
      expect(result.items).toHaveLength(1);
      await expectValidationError(run(dedupeOperation, t.ctx, { threshold: 2 }));
    });
  });

  describe("backup and restore", () => {
    it("writes and reads a backup from the CLI, but not over MCP", async () => {
      await addDoc(t, "Saved");
      const outputPath = join(dir, "backup.json");
      const backup = await run(backupOperation, t.ctx, { outputPath });
      expect(backup.counts.documents).toBe(1);

      const target = makeContext();
      try {
        const restored = await run(restoreOperation, target.ctx, { backupPath: outputPath });
        expect(restored.counts.documents).toBe(1);
      } finally {
        target.db.close();
      }

      const mcp = makeContext({ db: t.db, surface: "mcp" });
      await expectValidationError(run(backupOperation, mcp.ctx, { outputPath }));
      await expectValidationError(run(restoreOperation, t.ctx, {}));
    });
  });

  describe("prune-expired", () => {
    it("deletes expired documents only", async () => {
      await indexDocument(t.db, t.provider, {
        title: "Old news",
        content: "expired content",
        sourceType: "manual",
        expiresAt: "2000-01-01T00:00:00Z",
      });
      await addDoc(t, "Fresh");
      expect(await run(pruneExpiredOperation, t.ctx, {})).toEqual({ pruned: 1 });
      expect((await run(listDocumentsOperation, t.ctx, {})).total).toBe(1);
    });
  });

  describe("bulk operations", () => {
    it("deletes (with dry run), retags and moves by filter", async () => {
      createTopic(t.db, { name: "Target" });
      await addDoc(t, "R1", "react one", { library: "react" });
      await addDoc(t, "R2", "react two", { library: "react" });

      const dry = await run(bulkDeleteOperation, t.ctx, { library: "react", dryRun: true });
      expect(dry.affected).toBe(2);
      const retag = await run(bulkRetagOperation, t.ctx, { library: "react", addTags: ["ui"] });
      expect(retag.affected).toBe(2);
      const moved = await run(bulkMoveOperation, t.ctx, { tags: ["ui"], targetTopic: "Target" });
      expect(moved.affected).toBe(2);
      const deleted = await run(bulkDeleteOperation, t.ctx, { topic: "target" });
      expect(deleted.affected).toBe(2);
    });

    it("rejects an empty selector and an invalid source type", async () => {
      await expect(run(bulkDeleteOperation, t.ctx, {})).rejects.toBeInstanceOf(ValidationError);
      await expectValidationError(run(bulkDeleteOperation, t.ctx, { sourceType: "web" }));
    });

    it("throws TopicNotFoundError for an unknown target topic", async () => {
      await expect(
        run(bulkMoveOperation, t.ctx, { library: "x", targetTopic: "nowhere" }),
      ).rejects.toBeInstanceOf(TopicNotFoundError);
    });
  });
});
