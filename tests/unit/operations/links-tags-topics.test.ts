import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  addTagsOperation,
  createTopicOperation,
  deleteTopicOperation,
  linkDocumentsOperation,
  listLinksOperation,
  listTagsOperation,
  listTopicsOperation,
  prerequisitesOperation,
  removeTagsOperation,
  suggestTagsOperation,
  unlinkDocumentsOperation,
} from "../../../src/core/operations/index.js";
import { DocumentNotFoundError, NotFoundError, TopicNotFoundError } from "../../../src/errors.js";
import { initLogger } from "../../../src/logger.js";
import { addDoc, expectValidationError, makeContext, run, type TestContext } from "./helpers.js";

initLogger("silent");

describe("link, tag and topic operations", () => {
  let t: TestContext;

  beforeEach(() => {
    t = makeContext();
  });

  afterEach(() => {
    t.db.close();
  });

  describe("links", () => {
    it("links, lists with direction, follows prerequisites and unlinks", async () => {
      const basics = await addDoc(t, "Basics");
      const advanced = await addDoc(t, "Advanced");
      const link = await run(linkDocumentsOperation, t.ctx, {
        documentId: basics,
        targetDocumentId: advanced,
        linkType: "prerequisite",
      });
      expect(link).toMatchObject({ sourceId: basics, targetId: advanced });
      expect(link.linkId).toEqual(expect.any(String));

      const links = await run(listLinksOperation, t.ctx, { documentId: advanced });
      expect(links.items).toEqual([
        expect.objectContaining({ linkId: link.linkId, direction: "incoming" }),
      ]);
      const all = await run(listLinksOperation, t.ctx, {});
      expect(all.items).toHaveLength(1);

      const prereqs = await run(prerequisitesOperation, t.ctx, { documentId: advanced });
      expect(prereqs.items).toEqual([{ documentId: basics, title: "Basics" }]);

      await run(unlinkDocumentsOperation, t.ctx, { linkId: link.linkId });
      expect((await run(listLinksOperation, t.ctx, {})).items).toHaveLength(0);
    });

    it("rejects an unknown link type", async () => {
      await expectValidationError(
        run(linkDocumentsOperation, t.ctx, {
          documentId: "a",
          targetDocumentId: "b",
          linkType: "friend",
        }),
      );
    });

    it("throws NotFoundError for unknown documents and links", async () => {
      const a = await addDoc(t, "A");
      await expect(
        run(linkDocumentsOperation, t.ctx, {
          documentId: a,
          targetDocumentId: "missing",
          linkType: "related",
        }),
      ).rejects.toBeInstanceOf(DocumentNotFoundError);
      await expect(run(unlinkDocumentsOperation, t.ctx, { linkId: "nope" })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(
        run(listLinksOperation, t.ctx, { documentId: "missing" }),
      ).rejects.toBeInstanceOf(DocumentNotFoundError);
      await expect(
        run(prerequisitesOperation, t.ctx, { documentId: "missing" }),
      ).rejects.toBeInstanceOf(DocumentNotFoundError);
    });
  });

  describe("tags", () => {
    it("adds, lists, suggests and removes tags", async () => {
      const id = await addDoc(t, "Tagged", "database indexing database performance tuning");
      const added = await run(addTagsOperation, t.ctx, { documentId: id, tags: ["DB", "perf"] });
      expect(added.tags).toEqual(["db", "perf"]);
      const listed = await run(listTagsOperation, t.ctx, {});
      expect(listed.items.map((tag) => tag.name)).toEqual(["db", "perf"]);
      const removed = await run(removeTagsOperation, t.ctx, { documentId: id, tags: ["perf"] });
      expect(removed).toMatchObject({ removed: ["perf"], tags: ["db"] });
      const suggested = await run(suggestTagsOperation, t.ctx, { documentId: id, limit: 3 });
      expect(suggested.suggestions.length).toBeLessThanOrEqual(3);
    });

    it("rejects an empty tag list", async () => {
      await expectValidationError(run(addTagsOperation, t.ctx, { documentId: "x", tags: [] }));
      await expectValidationError(run(suggestTagsOperation, t.ctx, { documentId: "x", limit: 0 }));
    });

    it("throws NotFoundError for an unknown document", async () => {
      for (const op of [addTagsOperation, removeTagsOperation]) {
        await expect(run(op, t.ctx, { documentId: "missing", tags: ["x"] })).rejects.toBeInstanceOf(
          DocumentNotFoundError,
        );
      }
      await expect(
        run(suggestTagsOperation, t.ctx, { documentId: "missing" }),
      ).rejects.toBeInstanceOf(DocumentNotFoundError);
    });
  });

  describe("topics", () => {
    it("creates, lists by parent name and deletes topics", async () => {
      const parent = await run(createTopicOperation, t.ctx, { name: "Backend" });
      await run(createTopicOperation, t.ctx, { name: "Databases", parent: "backend" });
      const children = await run(listTopicsOperation, t.ctx, { parent: "Backend" });
      expect(children.items.map((topic) => topic.name)).toEqual(["Databases"]);
      expect(children.items[0]?.documentCount).toBe(0);

      const deleted = await run(deleteTopicOperation, t.ctx, { topic: "Databases" });
      expect(deleted.deleted).toBe(true);
      expect((await run(listTopicsOperation, t.ctx, {})).items.map((x) => x.id)).toEqual([
        parent.id,
      ]);
    });

    it("rejects an empty topic name", async () => {
      await expectValidationError(run(createTopicOperation, t.ctx, { name: "" }));
    });

    it("throws TopicNotFoundError for unknown topics", async () => {
      await expect(run(deleteTopicOperation, t.ctx, { topic: "nope" })).rejects.toBeInstanceOf(
        TopicNotFoundError,
      );
      await expect(run(listTopicsOperation, t.ctx, { parent: "nope" })).rejects.toBeInstanceOf(
        TopicNotFoundError,
      );
    });
  });
});
