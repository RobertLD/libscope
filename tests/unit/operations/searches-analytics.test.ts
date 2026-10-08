import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  deleteSavedSearchOperation,
  listSavedSearchesOperation,
  popularOperation,
  runSavedSearchOperation,
  saveSearchOperation,
  searchAnalyticsOperation,
  searchOperation,
  staleOperation,
  topQueriesOperation,
} from "../../../src/core/operations/index.js";
import { NotFoundError, ValidationError } from "../../../src/errors.js";
import { initLogger } from "../../../src/logger.js";
import { addDoc, expectValidationError, makeContext, run, type TestContext } from "./helpers.js";

initLogger("silent");

describe("saved search and analytics operations", () => {
  let t: TestContext;

  beforeEach(() => {
    t = makeContext();
  });

  afterEach(() => {
    t.db.close();
  });

  describe("saved searches", () => {
    it("saves with filters, lists, runs and deletes", async () => {
      await addDoc(t, "Hooks", "React hooks guide", { library: "react" });
      const saved = await run(saveSearchOperation, t.ctx, {
        name: "react-hooks",
        query: "hooks",
        library: "react",
        sourceType: "library",
      });
      expect(saved.filters).toEqual({ library: "react", sourceType: "library" });

      const list = await run(listSavedSearchesOperation, t.ctx, {});
      expect(list).toMatchObject({ total: 1, limit: 50, offset: 0 });

      const ran = await run(runSavedSearchOperation, t.ctx, { search: "react-hooks" });
      expect(ran.items).toHaveLength(1);
      expect(ran.search.resultCount).toBe(1);
      expect(ran.search.lastRunAt).not.toBeNull();

      // Stored filters apply when the search runs.
      await run(saveSearchOperation, t.ctx, { name: "vue", query: "hooks", library: "vue" });
      expect((await run(runSavedSearchOperation, t.ctx, { search: "vue" })).items).toEqual([]);

      await run(deleteSavedSearchOperation, t.ctx, { search: saved.id });
      expect((await run(listSavedSearchesOperation, t.ctx, {})).total).toBe(1);
    });

    it("rejects a missing query and a duplicate name", async () => {
      await expectValidationError(run(saveSearchOperation, t.ctx, { name: "x" }));
      await run(saveSearchOperation, t.ctx, { name: "dup", query: "q" });
      await expect(
        run(saveSearchOperation, t.ctx, { name: "dup", query: "q" }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("throws NotFoundError for an unknown saved search", async () => {
      await expect(run(runSavedSearchOperation, t.ctx, { search: "nope" })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(
        run(deleteSavedSearchOperation, t.ctx, { search: "nope" }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("analytics", () => {
    it("reports popular documents, stale documents, top queries and search analytics", async () => {
      const id = await addDoc(t, "Popular", "frequently searched content");
      await addDoc(t, "Lonely", "nobody searches this");
      await run(searchOperation, t.ctx, { query: "frequently" });
      await run(searchOperation, t.ctx, { query: "frequently" });

      const popular = await run(popularOperation, t.ctx, {});
      expect(popular.items[0]).toMatchObject({ documentId: id });
      const stale = await run(staleOperation, t.ctx, { days: 30 });
      expect(stale.items.map((d) => d.title)).toEqual(["Lonely"]);
      const top = await run(topQueriesOperation, t.ctx, { limit: 5 });
      expect(top.items[0]).toMatchObject({ query: "frequently", count: 2 });
      const analytics = await run(searchAnalyticsOperation, t.ctx, {});
      expect(analytics.totalSearches).toBe(2);
      expect(analytics.knowledgeGaps).toEqual(expect.any(Array));
    });

    it("rejects out-of-range input", async () => {
      await expectValidationError(run(popularOperation, t.ctx, { limit: 0 }));
      await expectValidationError(run(staleOperation, t.ctx, { days: 0 }));
      await expectValidationError(run(topQueriesOperation, t.ctx, { limit: "ten" }));
      await expectValidationError(run(searchAnalyticsOperation, t.ctx, { days: 1.5 }));
    });
  });
});
