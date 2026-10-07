import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../../src/db/connection.js";
import { createVectorTable, runMigrations } from "../../../src/db/schema.js";
import { askOperation, searchOperation } from "../../../src/core/operations/index.js";
import type { LlmProvider } from "../../../src/core/rag.js";
import { ConfigError, DocumentNotFoundError } from "../../../src/errors.js";
import { initLogger } from "../../../src/logger.js";
import { MockEmbeddingProvider } from "../../fixtures/mock-provider.js";
import {
  addDoc,
  expectValidationError,
  makeContext,
  run,
  testConfig,
  type TestContext,
} from "./helpers.js";

initLogger("silent");

const fakeLlm: LlmProvider = {
  model: "fake-model",
  complete: (prompt: string) =>
    Promise.resolve({ text: `answered (${prompt.length} chars)`, tokensUsed: 7 }),
};

describe("search operations", () => {
  let t: TestContext;

  beforeEach(() => {
    t = makeContext();
  });

  afterEach(() => {
    t.db.close();
  });

  describe("search", () => {
    it("finds documents by keyword and returns documentId and chunkId", async () => {
      const id = await addDoc(t, "Kubernetes", "Kubernetes pods and deployments explained");
      await addDoc(t, "Cooking", "Recipes for pasta");
      const result = await run(searchOperation, t.ctx, { query: "kubernetes" });
      expect(result.total).toBeGreaterThanOrEqual(1);
      expect(result.items[0]).toMatchObject({ documentId: id });
      expect(result.items[0]?.chunkId).toEqual(expect.any(String));
      expect(result.limit).toBe(10);
    });

    it("needs exactly one of query and relatedTo", async () => {
      await expectValidationError(run(searchOperation, t.ctx, {}));
      await expectValidationError(run(searchOperation, t.ctx, { query: "a", relatedTo: "b" }));
    });

    it("rejects limit above the maximum", async () => {
      await expectValidationError(run(searchOperation, t.ctx, { query: "a", limit: 500 }));
    });

    it("throws NotFoundError when relatedTo names nothing", async () => {
      await expect(run(searchOperation, t.ctx, { relatedTo: "missing" })).rejects.toBeInstanceOf(
        DocumentNotFoundError,
      );
    });

    it("finds content related to a document (sqlite-vec)", async () => {
      const db = createDatabase(":memory:");
      runMigrations(db);
      createVectorTable(db, new MockEmbeddingProvider());
      const v = makeContext({ db });
      try {
        const id = await addDoc(v, "Seed", "Vector search seed document");
        await addDoc(v, "Other", "Another document to compare with");
        const result = await run(searchOperation, v.ctx, { relatedTo: id });
        expect(result.items.every((r) => r.documentId !== id)).toBe(true);
        expect(result.total).toBe(result.items.length);
      } finally {
        db.close();
      }
    });
  });

  describe("ask", () => {
    it("answers with the LLM and lists sources", async () => {
      const llmCtx = makeContext({ db: t.db, llm: fakeLlm });
      await addDoc(t, "Install", "Run npm install to install libscope");
      const result = await run(askOperation, llmCtx.ctx, { question: "How do I install?" });
      expect(result.mode).toBe("answer");
      if (result.mode === "answer") {
        expect(result.model).toBe("fake-model");
        expect(result.sources.length).toBeGreaterThan(0);
      }
    });

    it("returns context in passthrough mode", async () => {
      const p = makeContext({ db: t.db, config: testConfig("passthrough"), llm: undefined });
      await addDoc(t, "Install", "Run npm install to install libscope");
      const result = await run(askOperation, p.ctx, { question: "install" });
      expect(result.mode).toBe("context");
      if (result.mode === "context") expect(result.contextPrompt).toContain("install");
    });

    it("resolves llm.provider auto to passthrough under MCP", async () => {
      const mcp = makeContext({ db: t.db, surface: "mcp", llm: undefined });
      await addDoc(t, "Install", "Run npm install to install libscope");
      const result = await run(askOperation, mcp.ctx, { question: "install" });
      expect(result.mode).toBe("context");
    });

    it("throws ConfigError when no LLM is configured", async () => {
      await expect(run(askOperation, t.ctx, { question: "anything" })).rejects.toBeInstanceOf(
        ConfigError,
      );
    });

    it("rejects an empty question and topK above 20", async () => {
      await expectValidationError(run(askOperation, t.ctx, { question: "" }));
      await expectValidationError(run(askOperation, t.ctx, { question: "q", topK: 21 }));
    });
  });
});
