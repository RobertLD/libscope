import { describe, it, expect, vi } from "vitest";
import {
  buildContextPrompt,
  extractSources,
  createLlmProvider,
  isPassthroughMode,
  resolveLlmProviderName,
  DEFAULT_SYSTEM_PROMPT,
  type LlmProvider,
} from "../../src/core/rag.js";
import type { SearchResult } from "../../src/core/search.js";
import type { LibScopeConfig } from "../../src/config.js";

function makeSearchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    documentId: "doc-1",
    chunkId: "chunk-1",
    title: "Test Doc",
    content: "Some content about testing.",
    sourceType: "manual",
    library: null,
    version: null,
    topicId: null,
    url: null,
    score: 0.95,
    avgRating: null,
    scoreExplanation: {
      method: "vector",
      rawScore: 0.05,
      boostFactors: [],
      details: "test",
    },
    ...overrides,
  };
}

function createMockLlmProvider(response = "Test answer"): LlmProvider {
  return {
    model: "mock-model",
    complete: vi.fn().mockResolvedValue({ text: response, tokensUsed: 42 }),
  };
}

describe("buildContextPrompt", () => {
  it("includes question and source titles in prompt", () => {
    const results = [
      makeSearchResult({ title: "React Hooks Guide", content: "useEffect runs after render." }),
      makeSearchResult({ title: "Vue Composition API", content: "setup() runs before mount." }),
    ];

    const prompt = buildContextPrompt("How do hooks work?", results);

    expect(prompt).toContain("How do hooks work?");
    expect(prompt).toContain('[Source 1: "React Hooks Guide"]');
    expect(prompt).toContain('[Source 2: "Vue Composition API"]');
    expect(prompt).toContain("useEffect runs after render.");
    expect(prompt).toContain("setup() runs before mount.");
  });

  it("handles empty results with informative message", () => {
    const prompt = buildContextPrompt("What is X?", []);

    expect(prompt).toContain("What is X?");
    expect(prompt).toContain("No relevant documents were found");
  });
});

describe("extractSources", () => {
  it("maps search results to RagSource format", () => {
    const results = [
      makeSearchResult({ documentId: "d1", title: "Doc 1", content: "chunk text", score: 0.9 }),
      makeSearchResult({ documentId: "d2", title: "Doc 2", content: "other text", score: 0.7 }),
    ];

    const sources = extractSources(results);

    expect(sources).toHaveLength(2);
    expect(sources[0]).toEqual({
      documentId: "d1",
      title: "Doc 1",
      chunk: "chunk text",
      score: 0.9,
    });
    expect(sources[1]).toEqual({
      documentId: "d2",
      title: "Doc 2",
      chunk: "other text",
      score: 0.7,
    });
  });
});

describe("askQuestion", () => {
  it("retrieves context and calls LLM provider", async () => {
    const mockLlm = createMockLlmProvider("The answer is 42.");
    const mockEmbedding = {
      name: "mock",
      dimensions: 4,
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4]),
      embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4]]),
    };

    const searchMock = vi.fn().mockResolvedValue({
      results: [makeSearchResult({ title: "Relevant Doc" })],
      totalCount: 1,
    });

    const { askQuestion: askFn } = await import("../../src/core/rag.js");
    const searchModule = await import("../../src/core/search.js");
    vi.spyOn(searchModule, "searchDocuments").mockImplementation(searchMock);

    const mockDb = {} as Parameters<typeof askFn>[0];

    try {
      const result = await askFn(mockDb, mockEmbedding, mockLlm, {
        question: "What is the meaning of life?",
        topK: 3,
      });

      expect(result.answer).toBe("The answer is 42.");
      expect(result.model).toBe("mock-model");
      expect(result.tokensUsed).toBe(42);
      expect(result.sources).toHaveLength(1);
      expect(result.sources[0]!.title).toBe("Relevant Doc");

      expect(searchMock).toHaveBeenCalledWith(mockDb, mockEmbedding, {
        query: "What is the meaning of life?",
        topic: undefined,
        library: undefined,
        limit: 3,
      });

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockLlm.complete).toHaveBeenCalledWith(
        expect.stringContaining("What is the meaning of life?"),
        DEFAULT_SYSTEM_PROMPT,
      );
    } finally {
      vi.mocked(searchModule.searchDocuments).mockRestore();
    }
  });

  it("uses custom system prompt when provided", async () => {
    const mockLlm = createMockLlmProvider("Custom answer");
    const mockEmbedding = {
      name: "mock",
      dimensions: 4,
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4]),
      embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4]]),
    };

    const searchModule = await import("../../src/core/search.js");
    vi.spyOn(searchModule, "searchDocuments").mockResolvedValue({
      results: [],
      totalCount: 0,
    });

    const { askQuestion: askFn } = await import("../../src/core/rag.js");
    const mockDb = {} as Parameters<typeof askFn>[0];

    try {
      await askFn(mockDb, mockEmbedding, mockLlm, {
        question: "test",
        systemPrompt: "You are a pirate.",
      });

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockLlm.complete).toHaveBeenCalledWith(expect.any(String), "You are a pirate.");
    } finally {
      vi.mocked(searchModule.searchDocuments).mockRestore();
    }
  });

  it("defaults topK to 5", async () => {
    const mockLlm = createMockLlmProvider();
    const mockEmbedding = {
      name: "mock",
      dimensions: 4,
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4]),
      embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4]]),
    };

    const searchModule = await import("../../src/core/search.js");
    const searchMock = vi.spyOn(searchModule, "searchDocuments").mockResolvedValue({
      results: [],
      totalCount: 0,
    });

    const { askQuestion: askFn } = await import("../../src/core/rag.js");
    const mockDb = {} as Parameters<typeof askFn>[0];

    try {
      await askFn(mockDb, mockEmbedding, mockLlm, { question: "test" });

      expect(searchMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ limit: 5 }),
      );
    } finally {
      searchMock.mockRestore();
    }
  });
});

describe("createLlmProvider", () => {
  it("throws when no LLM provider is configured", () => {
    const config: LibScopeConfig = {
      embedding: { provider: "local" },
      database: { path: ":memory:" },
      indexing: { maxDocumentSize: 1024 },
      logging: { level: "silent" },
    };

    expect(() => createLlmProvider(config)).toThrow("No LLM provider configured");
  });

  it("creates an OpenAI provider when configured", () => {
    const config: LibScopeConfig = {
      embedding: { provider: "local" },
      llm: { provider: "openai", model: "gpt-4o" },
      openai: { apiKey: "sk-test" },
      database: { path: ":memory:" },
      indexing: { maxDocumentSize: 1024 },
      logging: { level: "silent" },
    };

    const provider = createLlmProvider(config);
    expect(provider.model).toBe("gpt-4o");
  });

  it("creates an Ollama provider when configured", () => {
    const config: LibScopeConfig = {
      embedding: { provider: "local" },
      llm: { provider: "ollama", model: "mistral" },
      database: { path: ":memory:" },
      indexing: { maxDocumentSize: 1024 },
      logging: { level: "silent" },
    };

    const provider = createLlmProvider(config);
    expect(provider.model).toBe("mistral");
  });

  it("uses default model for Ollama when not specified", () => {
    const config: LibScopeConfig = {
      embedding: { provider: "local" },
      llm: { provider: "ollama" },
      database: { path: ":memory:" },
      indexing: { maxDocumentSize: 1024 },
      logging: { level: "silent" },
    };

    const provider = createLlmProvider(config);
    expect(provider.model).toBe("llama3.2");
  });

  it("uses default model for OpenAI when not specified", () => {
    const config: LibScopeConfig = {
      embedding: { provider: "local" },
      llm: { provider: "openai" },
      openai: { apiKey: "sk-test" },
      database: { path: ":memory:" },
      indexing: { maxDocumentSize: 1024 },
      logging: { level: "silent" },
    };

    const provider = createLlmProvider(config);
    expect(provider.model).toBe("gpt-4o-mini");
  });

  it("uses the shared OpenAI key for embeddings and the LLM", () => {
    const config: LibScopeConfig = {
      embedding: { provider: "openai" },
      llm: { provider: "openai" },
      openai: { apiKey: "sk-shared" },
      database: { path: ":memory:" },
      indexing: { maxDocumentSize: 1024 },
      logging: { level: "silent" },
    };

    const provider = createLlmProvider(config);
    expect(provider.model).toBe("gpt-4o-mini");
  });

  it("sanitizes Ollama error messages", async () => {
    const config: LibScopeConfig = {
      embedding: { provider: "local" },
      llm: { provider: "ollama", model: "llama3.2" },
      database: { path: ":memory:" },
      indexing: { maxDocumentSize: 1024 },
      logging: { level: "silent" },
    };
    const provider = createLlmProvider(config);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });

    try {
      await expect(provider.complete("test")).rejects.toThrow("Model not found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles Ollama 500 error", async () => {
    const config: LibScopeConfig = {
      embedding: { provider: "local" },
      llm: { provider: "ollama" },
      database: { path: ":memory:" },
      indexing: { maxDocumentSize: 1024 },
      logging: { level: "silent" },
    };
    const provider = createLlmProvider(config);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    try {
      await expect(provider.complete("test")).rejects.toThrow("Ollama internal server error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles Ollama unknown status code", async () => {
    const config: LibScopeConfig = {
      embedding: { provider: "local" },
      llm: { provider: "ollama" },
      database: { path: ":memory:" },
      indexing: { maxDocumentSize: 1024 },
      logging: { level: "silent" },
    };
    const provider = createLlmProvider(config);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 418,
    });

    try {
      await expect(provider.complete("test")).rejects.toThrow("HTTP 418");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns tokensUsed from Ollama when available", async () => {
    const config: LibScopeConfig = {
      embedding: { provider: "local" },
      llm: { provider: "ollama" },
      database: { path: ":memory:" },
      indexing: { maxDocumentSize: 1024 },
      logging: { level: "silent" },
    };
    const provider = createLlmProvider(config);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ response: "answer", eval_count: 10, prompt_eval_count: 5 }),
    });

    try {
      const result = await provider.complete("test", "system prompt");
      expect(result.text).toBe("answer");
      expect(result.tokensUsed).toBe(15);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns undefined tokensUsed from Ollama when counts are missing", async () => {
    const config: LibScopeConfig = {
      embedding: { provider: "local" },
      llm: { provider: "ollama" },
      database: { path: ":memory:" },
      indexing: { maxDocumentSize: 1024 },
      logging: { level: "silent" },
    };
    const provider = createLlmProvider(config);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ response: "answer" }),
    });

    try {
      const result = await provider.complete("test");
      expect(result.tokensUsed).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles OpenAI empty choices response", async () => {
    const config: LibScopeConfig = {
      embedding: { provider: "local" },
      llm: { provider: "openai" },
      openai: { apiKey: "sk-test" },
      database: { path: ":memory:" },
      indexing: { maxDocumentSize: 1024 },
      logging: { level: "silent" },
    };
    const provider = createLlmProvider(config);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [] }),
    });

    try {
      await expect(provider.complete("test")).rejects.toThrow("no choices in response");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles OpenAI unknown status codes", async () => {
    const config: LibScopeConfig = {
      embedding: { provider: "local" },
      llm: { provider: "openai" },
      openai: { apiKey: "sk-test" },
      database: { path: ":memory:" },
      indexing: { maxDocumentSize: 1024 },
      logging: { level: "silent" },
    };
    const provider = createLlmProvider(config);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
    });

    try {
      await expect(provider.complete("test")).rejects.toThrow("HTTP 502");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles OpenAI 429 rate limit", async () => {
    const config: LibScopeConfig = {
      embedding: { provider: "local" },
      llm: { provider: "openai" },
      openai: { apiKey: "sk-test" },
      database: { path: ":memory:" },
      indexing: { maxDocumentSize: 1024 },
      logging: { level: "silent" },
    };
    const provider = createLlmProvider(config);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
    });

    try {
      await expect(provider.complete("test")).rejects.toThrow("Rate limit exceeded");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws when OpenAI provider has no API key", () => {
    const config: LibScopeConfig = {
      embedding: { provider: "local" },
      llm: { provider: "openai" },
      database: { path: ":memory:" },
      indexing: { maxDocumentSize: 1024 },
      logging: { level: "silent" },
    };

    expect(() => createLlmProvider(config)).toThrow("OpenAI API key is required");
  });

  it("sanitizes OpenAI error messages (does not leak response body)", async () => {
    const config: LibScopeConfig = {
      embedding: { provider: "local" },
      llm: { provider: "openai", model: "gpt-4o" },
      openai: { apiKey: "sk-test" },
      database: { path: ":memory:" },
      indexing: { maxDocumentSize: 1024 },
      logging: { level: "silent" },
    };
    const provider = createLlmProvider(config);

    // Mock fetch to return a 401
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('{"error":{"message":"Invalid API key: sk-test****"}}'),
    });

    try {
      await expect(provider.complete("test")).rejects.toThrow("Invalid or expired API key");
      // Should NOT contain the actual response body with key info
      await expect(provider.complete("test")).rejects.not.toThrow("sk-test");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("askQuestionStream", () => {
  it("yields token events then a done event with sources (fallback path)", async () => {
    const mockLlm = createMockLlmProvider("Streamed answer.");
    const mockEmbedding = {
      name: "mock",
      dimensions: 4,
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4]),
      embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4]]),
    };

    const searchModule = await import("../../src/core/search.js");
    vi.spyOn(searchModule, "searchDocuments").mockResolvedValue({
      results: [makeSearchResult({ title: "Stream Doc" })],
      totalCount: 1,
    });

    const { askQuestionStream } = await import("../../src/core/rag.js");
    const mockDb = {} as Parameters<typeof askQuestionStream>[0];

    try {
      const events = [];
      for await (const event of askQuestionStream(mockDb, mockEmbedding, mockLlm, {
        question: "Stream test?",
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ token: "Streamed answer." });
      expect(events[1]).toMatchObject({
        done: true,
        model: "mock-model",
      });
      // Check sources in done event
      const done = events[1] as { done: true; sources: unknown[] };
      expect(done.sources).toHaveLength(1);
    } finally {
      vi.mocked(searchModule.searchDocuments).mockRestore();
    }
  });

  it("uses completeStream when provider supports it", async () => {
    async function* fakeStream(): AsyncIterable<string> {
      await Promise.resolve();
      yield "Hello ";
      yield "world!";
    }

    const mockLlm: LlmProvider = {
      model: "streaming-model",
      complete: vi.fn().mockResolvedValue({ text: "", tokensUsed: 0 }),
      completeStream: vi.fn().mockReturnValue(fakeStream()),
    };

    const mockEmbedding = {
      name: "mock",
      dimensions: 4,
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4]),
      embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4]]),
    };

    const searchModule = await import("../../src/core/search.js");
    vi.spyOn(searchModule, "searchDocuments").mockResolvedValue({
      results: [],
      totalCount: 0,
    });

    const { askQuestionStream } = await import("../../src/core/rag.js");
    const mockDb = {} as Parameters<typeof askQuestionStream>[0];

    try {
      const events = [];
      for await (const event of askQuestionStream(mockDb, mockEmbedding, mockLlm, {
        question: "Stream test?",
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(3);
      expect(events[0]).toEqual({ token: "Hello " });
      expect(events[1]).toEqual({ token: "world!" });
      expect(events[2]).toMatchObject({ done: true, model: "streaming-model" });
      // complete should NOT have been called
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockLlm.complete).not.toHaveBeenCalled();
    } finally {
      vi.mocked(searchModule.searchDocuments).mockRestore();
    }
  });
});

describe('llm.provider "auto"', () => {
  function autoConfig(overrides: Partial<LibScopeConfig> = {}): LibScopeConfig {
    return {
      embedding: { provider: "local" },
      llm: { provider: "auto" },
      database: {},
      indexing: { maxDocumentSize: 1024, allowPrivateUrls: false, allowSelfSignedCerts: false },
      logging: { level: "silent" },
      ...overrides,
    };
  }

  it("resolves to passthrough under MCP, even when API keys are set", () => {
    const config = autoConfig({ openai: { apiKey: "sk-x" } });
    expect(resolveLlmProviderName(config, { surface: "mcp" })).toBe("passthrough");
    expect(isPassthroughMode(config, { surface: "mcp" })).toBe(true);
    expect(() => createLlmProvider(config, { surface: "mcp" })).toThrow(/passthrough/);
  });

  it.each(["cli", "api", "sdk", undefined] as const)(
    "is not passthrough on surface %s",
    (surface) => {
      expect(isPassthroughMode(autoConfig(), { surface })).toBe(false);
    },
  );

  it("picks openai when an OpenAI key is set", () => {
    const config = autoConfig({
      openai: { apiKey: "sk-x" },
      anthropic: { apiKey: "sk-ant" },
    });
    expect(resolveLlmProviderName(config, { surface: "cli" })).toBe("openai");
    expect(createLlmProvider(config).model).toBe("gpt-4o-mini");
  });

  it("picks anthropic when only an Anthropic key is set", () => {
    const config = autoConfig({ anthropic: { apiKey: "sk-ant" } });
    expect(resolveLlmProviderName(config)).toBe("anthropic");
    expect(createLlmProvider(config).model).toBe("claude-3-5-haiku-20241022");
  });

  it("picks ollama when llm.url is set", () => {
    const config = autoConfig({ llm: { provider: "auto", url: "http://gpu:11434" } });
    expect(resolveLlmProviderName(config)).toBe("ollama");
    expect(createLlmProvider(config).model).toBe("llama3.2");
  });

  it("picks ollama when the embedding provider is ollama", () => {
    const config = autoConfig({ embedding: { provider: "ollama" } });
    expect(resolveLlmProviderName(config)).toBe("ollama");
  });

  it("returns null and createLlmProvider throws a hint when nothing is configured", () => {
    const config = autoConfig();
    expect(resolveLlmProviderName(config)).toBeNull();
    expect(() => createLlmProvider(config)).toThrow(/No LLM provider configured.*OPENAI_API_KEY/);
  });

  it("treats a missing llm section as auto", () => {
    const config = autoConfig({ openai: { apiKey: "sk-x" } });
    delete config.llm;
    expect(resolveLlmProviderName(config)).toBe("openai");
  });

  it("an explicit provider is used on every surface", () => {
    const config = autoConfig({ llm: { provider: "ollama" }, openai: { apiKey: "sk-x" } });
    expect(resolveLlmProviderName(config, { surface: "mcp" })).toBe("ollama");
    expect(isPassthroughMode(autoConfig({ llm: { provider: "passthrough" } }))).toBe(true);
  });

  it("the ollama LLM uses llm.url, then embedding.url", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ response: "hi" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const fromEmbedding = createLlmProvider(
        autoConfig({
          embedding: { provider: "ollama", url: "http://embed:11434" },
          llm: { provider: "ollama" },
        }),
      );
      await fromEmbedding.complete("q");
      const fromLlm = createLlmProvider(
        autoConfig({
          embedding: { provider: "ollama", url: "http://embed:11434" },
          llm: { provider: "ollama", url: "http://llm:11434" },
        }),
      );
      await fromLlm.complete("q");
      expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
        "http://embed:11434/api/generate",
        "http://llm:11434/api/generate",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
