import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LibScopeLite } from "../../src/lite/index.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import type { LlmProvider } from "../../src/core/rag.js";

function* fakeStream(): Generator<string> {
  yield "Hello";
  yield " world";
}

describe("LibScopeLite", () => {
  let lite: LibScopeLite;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    provider = new MockEmbeddingProvider();
    lite = new LibScopeLite({ dbPath: ":memory:", provider });
  });

  afterEach(() => {
    lite.close();
  });

  describe("constructor", () => {
    it("should create an instance with in-memory DB", () => {
      expect(lite).toBeInstanceOf(LibScopeLite);
    });

    it("should accept custom embedding provider", () => {
      const custom = new MockEmbeddingProvider();
      const instance = new LibScopeLite({ dbPath: ":memory:", provider: custom });
      expect(instance).toBeInstanceOf(LibScopeLite);
      instance.close();
    });
  });

  describe("index()", () => {
    it("should index a single document", async () => {
      await lite.index([{ title: "Test Doc", content: "This is test content for indexing." }]);

      expect(provider.embedBatchCallCount).toBeGreaterThan(0);
    });

    it("should index multiple documents", async () => {
      await lite.index([
        { title: "Doc A", content: "Content of document A about TypeScript." },
        { title: "Doc B", content: "Content of document B about Python." },
      ]);

      // Both docs should have been processed
      expect(provider.embedBatchCallCount).toBeGreaterThanOrEqual(2);
    });

    it("should index with optional metadata fields", async () => {
      await lite.index([
        {
          title: "Library Doc",
          content: "React documentation content here.",
          library: "react",
          sourceType: "library",
          version: "18.0.0",
          url: "https://react.dev",
        },
      ]);

      // Should succeed without errors
      expect(provider.embedBatchCallCount).toBeGreaterThan(0);
    });
  });

  describe("indexBatch()", () => {
    it("should index documents with concurrency control", async () => {
      const docs = Array.from({ length: 5 }, (_, i) => ({
        title: `Batch Doc ${i}`,
        content: `Batch content number ${i} with enough text to be meaningful.`,
      }));

      await lite.indexBatch(docs, { concurrency: 2 });

      expect(provider.embedBatchCallCount).toBe(5);
    });

    it("should handle empty array", async () => {
      await lite.indexBatch([], { concurrency: 2 });
      expect(provider.embedBatchCallCount).toBe(0);
    });

    it("should handle concurrency of 1 (sequential)", async () => {
      const docs = [
        { title: "A", content: "Content A for sequential test." },
        { title: "B", content: "Content B for sequential test." },
      ];

      await lite.indexBatch(docs, { concurrency: 1 });
      expect(provider.embedBatchCallCount).toBe(2);
    });
  });

  describe("search()", () => {
    beforeEach(async () => {
      await lite.index([
        {
          title: "React Hooks",
          content: "useState and useEffect are the most common React hooks.",
        },
        { title: "Vue Composition", content: "Vue 3 composition API uses setup function." },
        { title: "Angular DI", content: "Angular uses dependency injection pattern extensively." },
      ]);
    });

    it("should return search results", async () => {
      const results = await lite.search("React hooks");
      expect(results.length).toBeGreaterThan(0);
    });

    it("should return results with expected shape", async () => {
      const results = await lite.search("React");
      const first = results[0];
      expect(first).toBeDefined();
      expect(first).toHaveProperty("docId");
      expect(first).toHaveProperty("chunkId");
      expect(first).toHaveProperty("title");
      expect(first).toHaveProperty("content");
      expect(first).toHaveProperty("score");
      expect(first).toHaveProperty("url");
      expect(typeof first?.score).toBe("number");
    });

    it("should respect limit option", async () => {
      const results = await lite.search("API", { limit: 1 });
      expect(results.length).toBeLessThanOrEqual(1);
    });
  });

  describe("getContext()", () => {
    beforeEach(async () => {
      await lite.index([
        {
          title: "Node.js Streams",
          content: "Readable streams in Node.js are a fundamental pattern.",
        },
      ]);
    });

    it("should return a context string", async () => {
      const context = await lite.getContext("How do Node.js streams work?");
      expect(typeof context).toBe("string");
      expect(context.length).toBeGreaterThan(0);
    });
  });

  describe("ask()", () => {
    it("should throw when no LlmProvider is configured", async () => {
      await lite.index([{ title: "Test", content: "Some content for testing ask." }]);
      await expect(lite.ask("What is this about?")).rejects.toThrow("No LlmProvider configured");
    });

    it("should call LlmProvider.complete with context", async () => {
      const mockLlm: LlmProvider = {
        model: "test-model",
        complete: vi.fn().mockResolvedValue({ text: "Mocked LLM response" }),
      };

      const liteWithLlm = new LibScopeLite({
        dbPath: ":memory:",
        provider,
        llmProvider: mockLlm,
      });

      await liteWithLlm.index([
        { title: "Test Doc", content: "Information about testing patterns." },
      ]);

      const answer = await liteWithLlm.ask("What are testing patterns?");
      expect(answer).toBe("Mocked LLM response");
      expect(vi.mocked(mockLlm).complete).toHaveBeenCalledOnce();

      // The first argument should be the context prompt
      const callArgs = vi.mocked(mockLlm).complete.mock.calls[0];
      expect(callArgs?.[0]).toContain("testing patterns");

      liteWithLlm.close();
    });

    it("should allow llmProvider override in ask() opts", async () => {
      const mockLlm: LlmProvider = {
        model: "override-model",
        complete: vi.fn().mockResolvedValue({ text: "Override response" }),
      };

      await lite.index([{ title: "Test", content: "Some content for LLM." }]);

      const answer = await lite.ask("Question?", { llmProvider: mockLlm });
      expect(answer).toBe("Override response");
    });
  });

  describe("askStream()", () => {
    it("should throw when no LlmProvider is configured", async () => {
      await lite.index([{ title: "Test", content: "Content here." }]);
      const gen = lite.askStream("Question?");
      await expect(gen.next()).rejects.toThrow("No LlmProvider configured");
    });

    it("should throw when LlmProvider does not support streaming", async () => {
      const mockLlm: LlmProvider = {
        model: "no-stream",
        complete: vi.fn().mockResolvedValue({ text: "done" }),
        // No completeStream method
      };

      const liteWithLlm = new LibScopeLite({
        dbPath: ":memory:",
        provider,
        llmProvider: mockLlm,
      });

      await liteWithLlm.index([{ title: "Test", content: "Content." }]);

      const gen = liteWithLlm.askStream("Question?");
      await expect(gen.next()).rejects.toThrow("does not support streaming");

      liteWithLlm.close();
    });

    it("should stream tokens from LlmProvider", async () => {
      const mockLlm: LlmProvider = {
        model: "stream-model",
        complete: vi.fn().mockResolvedValue({ text: "done" }),
        completeStream: vi.fn().mockReturnValue(fakeStream()),
      };

      const liteWithLlm = new LibScopeLite({
        dbPath: ":memory:",
        provider,
        llmProvider: mockLlm,
      });

      await liteWithLlm.index([{ title: "Test", content: "Test content." }]);

      const tokens: string[] = [];
      for await (const token of liteWithLlm.askStream("Question?")) {
        tokens.push(token);
      }

      expect(tokens).toEqual(["Hello", " world"]);
      liteWithLlm.close();
    });
  });

  describe("rate()", () => {
    it("should rate an indexed document", async () => {
      await lite.index([{ title: "Rate Me", content: "Content to rate." }]);

      // Find the doc ID via search
      const results = await lite.search("rate");
      expect(results.length).toBeGreaterThan(0);
      const docId = results[0]?.docId;
      expect(docId).toBeDefined();

      // Should not throw
      lite.rate(docId!, 5);
    });

    it("should throw for nonexistent document", () => {
      expect(() => lite.rate("nonexistent-doc", 3)).toThrow();
    });
  });

  describe("close()", () => {
    it("should close the database without error", () => {
      const instance = new LibScopeLite({ dbPath: ":memory:", provider });
      expect(() => instance.close()).not.toThrow();
    });
  });
});
