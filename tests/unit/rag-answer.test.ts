import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { answer, type LlmProvider } from "../../src/core/rag.js";
import { indexDocument } from "../../src/core/indexing.js";
import { addTagsToDocument } from "../../src/core/tags.js";
import { ConfigError } from "../../src/errors.js";
import { initLogger } from "../../src/logger.js";

initLogger("silent");

describe("answer", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;

  beforeEach(async () => {
    db = createTestDb();
    provider = new MockEmbeddingProvider();
    const tagged = await indexDocument(db, provider, {
      title: "Tagged guide",
      content: "Deploying the service with docker compose",
      sourceType: "library",
      library: "svc",
      version: "2",
    });
    addTagsToDocument(db, tagged.id, ["ops"]);
    await indexDocument(db, provider, {
      title: "Untagged guide",
      content: "Deploying the service by hand",
      sourceType: "manual",
    });
  });

  afterEach(() => {
    db.close();
  });

  it("returns the context prompt in passthrough mode without calling an LLM", async () => {
    const complete = vi.fn();
    const llm: LlmProvider = { model: "m", complete };
    const result = await answer(
      db,
      provider,
      { passthrough: true, llm },
      { question: "deploying" },
    );
    expect(result.mode).toBe("context");
    expect(complete).not.toHaveBeenCalled();
    if (result.mode === "context") expect(result.sources).toHaveLength(2);
  });

  it("asks the LLM and applies the filters to retrieval", async () => {
    const complete = vi.fn((prompt: string) => Promise.resolve({ text: prompt, tokensUsed: 3 }));
    const result = await answer(
      db,
      provider,
      { passthrough: false, llm: { model: "m", complete } },
      { question: "deploying", tags: ["ops"], version: "2", sourceType: "library" },
    );
    expect(result.mode).toBe("answer");
    if (result.mode === "answer") {
      expect(result.sources.map((s) => s.title)).toEqual(["Tagged guide"]);
      expect(result.tokensUsed).toBe(3);
    }
  });

  it("throws a ConfigError with setup instructions when no LLM is configured", async () => {
    const result = answer(db, provider, { passthrough: false, llm: null }, { question: "q" });
    await expect(result).rejects.toBeInstanceOf(ConfigError);
    await expect(result).rejects.toThrow("No LLM provider configured");
  });
});
