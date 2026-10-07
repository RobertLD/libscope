import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  addOperation,
  deleteDocumentOperation,
  documentHistoryOperation,
  getDocumentOperation,
  listDocumentsOperation,
  rateDocumentOperation,
  rollbackDocumentOperation,
  updateDocumentOperation,
} from "../../../src/core/operations/index.js";
import { createTopic } from "../../../src/core/topics.js";
import { saveVersion } from "../../../src/core/versioning.js";
import { DocumentNotFoundError, NotFoundError, TopicNotFoundError } from "../../../src/errors.js";
import { initLogger } from "../../../src/logger.js";
import { addDoc, expectValidationError, makeContext, run, type TestContext } from "./helpers.js";

initLogger("silent");

describe("document operations", () => {
  let t: TestContext;

  beforeEach(() => {
    t = makeContext();
  });

  afterEach(() => {
    t.db.close();
  });

  describe("add", () => {
    it("adds inline content with tags and the default source type", async () => {
      createTopic(t.db, { name: "Guides" });
      const result = await run(addOperation, t.ctx, {
        title: "Setup",
        content: "How to set up the project",
        topic: "guides",
        tags: ["Setup"],
      });
      expect(result.kind).toBe("content");
      expect(result.documents).toHaveLength(1);
      const id = result.documents[0]!.documentId;
      const view = await run(getDocumentOperation, t.ctx, { documentId: id });
      expect(view.document.sourceType).toBe("topic");
      expect(view.tags).toEqual(["setup"]);
    });

    it("rejects input without content or source", async () => {
      await expectValidationError(run(addOperation, t.ctx, {}));
    });

    it("rejects a malformed url", async () => {
      await expectValidationError(run(addOperation, t.ctx, { url: "not a url" }));
    });

    it("fails for an unknown topic", async () => {
      await expect(
        run(addOperation, t.ctx, { title: "A", content: "B", topic: "nope" }),
      ).rejects.toBeInstanceOf(TopicNotFoundError);
    });

    it("adds a local directory from the CLI but refuses it over MCP", async () => {
      const dir = mkdtempSync(join(tmpdir(), "libscope-add-op-"));
      try {
        writeFileSync(join(dir, "a.md"), "# A\n\nAlpha content");
        const result = await run(addOperation, t.ctx, { source: dir });
        expect(result.kind).toBe("directory");
        expect(result.documents).toHaveLength(1);

        const mcp = makeContext({ db: t.db, surface: "mcp" });
        await expectValidationError(run(addOperation, mcp.ctx, { source: dir }));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("get-document", () => {
    it("returns paged content with tags, links and ratings", async () => {
      const id = await addDoc(t, "Paged", "0123456789");
      const view = await run(getDocumentOperation, t.ctx, {
        documentId: id,
        offset: 2,
        maxLength: 3,
      });
      expect(view.content).toBe("234");
      expect(view.nextOffset).toBe(5);
      expect(view.contentLength).toBe(10);
      expect(view.document.documentId).toBe(id);
      expect(view.ratings.totalRatings).toBe(0);
      expect(view.links).toEqual({ outgoing: [], incoming: [] });
    });

    it("rejects a negative offset", async () => {
      await expectValidationError(
        run(getDocumentOperation, t.ctx, { documentId: "x", offset: -1 }),
      );
    });

    it("throws NotFoundError for an unknown document", async () => {
      await expect(
        run(getDocumentOperation, t.ctx, { documentId: "missing" }),
      ).rejects.toBeInstanceOf(DocumentNotFoundError);
    });
  });

  describe("list-documents", () => {
    it("pages with total and filters by library and tags", async () => {
      await addDoc(t, "One", "first doc", { library: "react" });
      await addDoc(t, "Two", "second doc", { library: "react" });
      await addDoc(t, "Three", "third doc");
      const page = await run(listDocumentsOperation, t.ctx, { library: "react", limit: 1 });
      expect(page.total).toBe(2);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).not.toHaveProperty("content");
      expect(page.limit).toBe(1);
      expect(page.offset).toBe(0);
    });

    it("rejects limit 0", async () => {
      await expectValidationError(run(listDocumentsOperation, t.ctx, { limit: 0 }));
    });
  });

  describe("update-document", () => {
    it("updates the title and replaces tags", async () => {
      const id = await addDoc(t, "Old");
      await run(updateDocumentOperation, t.ctx, { documentId: id, tags: ["a", "b"] });
      const view = await run(updateDocumentOperation, t.ctx, {
        documentId: id,
        title: "New",
        tags: ["b", "c"],
      });
      expect(view.document.title).toBe("New");
      expect(view.tags).toEqual(["b", "c"]);
    });

    it("rejects an update with no fields", async () => {
      await expectValidationError(run(updateDocumentOperation, t.ctx, { documentId: "x" }));
    });

    it("throws NotFoundError for an unknown document", async () => {
      await expect(
        run(updateDocumentOperation, t.ctx, { documentId: "missing", title: "x" }),
      ).rejects.toBeInstanceOf(DocumentNotFoundError);
    });
  });

  describe("delete-document", () => {
    it("deletes a document", async () => {
      const id = await addDoc(t, "Gone");
      expect(await run(deleteDocumentOperation, t.ctx, { documentId: id })).toEqual({
        documentId: id,
        deleted: true,
      });
      await expect(run(getDocumentOperation, t.ctx, { documentId: id })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("rejects an empty id", async () => {
      await expectValidationError(run(deleteDocumentOperation, t.ctx, { documentId: "" }));
    });

    it("throws NotFoundError for an unknown document", async () => {
      await expect(
        run(deleteDocumentOperation, t.ctx, { documentId: "missing" }),
      ).rejects.toBeInstanceOf(DocumentNotFoundError);
    });
  });

  describe("rate-document", () => {
    it("records a rating attributed to the surface", async () => {
      const id = await addDoc(t, "Rated");
      const mcp = makeContext({ db: t.db, surface: "mcp" });
      const rating = await run(rateDocumentOperation, mcp.ctx, { documentId: id, rating: 4 });
      expect(rating).toMatchObject({ documentId: id, rating: 4, ratedBy: "model" });
    });

    it("rejects a rating of 6", async () => {
      await expectValidationError(
        run(rateDocumentOperation, t.ctx, { documentId: "x", rating: 6 }),
      );
    });

    it("throws NotFoundError for an unknown document", async () => {
      await expect(
        run(rateDocumentOperation, t.ctx, { documentId: "missing", rating: 3 }),
      ).rejects.toBeInstanceOf(DocumentNotFoundError);
    });
  });

  describe("document-history and rollback-document", () => {
    it("lists versions and rolls back", async () => {
      const id = await addDoc(t, "Original");
      saveVersion(t.db, id);
      await run(updateDocumentOperation, t.ctx, { documentId: id, title: "Changed" });
      const history = await run(documentHistoryOperation, t.ctx, { documentId: id });
      expect(history.items.length).toBeGreaterThanOrEqual(1);
      const restored = await run(rollbackDocumentOperation, t.ctx, { documentId: id, version: 1 });
      expect(restored.title).toBe("Original");
    });

    it("rejects version 0", async () => {
      await expectValidationError(
        run(rollbackDocumentOperation, t.ctx, { documentId: "x", version: 0 }),
      );
    });

    it("throws NotFoundError for an unknown document or version", async () => {
      await expect(
        run(documentHistoryOperation, t.ctx, { documentId: "missing" }),
      ).rejects.toBeInstanceOf(DocumentNotFoundError);
      const id = await addDoc(t, "No versions");
      await expect(
        run(rollbackDocumentOperation, t.ctx, { documentId: id, version: 9 }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
