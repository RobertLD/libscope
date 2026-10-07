import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const openaiCreate = vi.fn();

vi.mock("openai", () => ({
  default: class {
    embeddings = { create: openaiCreate };
  },
}));

vi.mock("../../src/utils/retry.js", () => ({
  withRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

import {
  EmbeddingDimensions,
  knownModelDimensions,
  validateDimensionsOverride,
} from "../../src/providers/dimensions.js";
import { OllamaEmbeddingProvider } from "../../src/providers/ollama.js";
import { OpenAIEmbeddingProvider } from "../../src/providers/openai.js";
import { createEmbeddingProvider } from "../../src/providers/index.js";
import type { LibScopeConfig } from "../../src/config.js";
import { ConfigError, EmbeddingError } from "../../src/errors.js";
import { initLogger } from "../../src/logger.js";

function vector(size: number): number[] {
  return Array.from({ length: size }, () => 0.1);
}

function config(embedding: LibScopeConfig["embedding"]): LibScopeConfig {
  return {
    embedding,
    database: { path: ":memory:" },
    indexing: { maxDocumentSize: 1024, allowPrivateUrls: false, allowSelfSignedCerts: false },
    logging: { level: "silent" },
  };
}

/** Make fetch return an Ollama /api/embed response with vectors of the given sizes. */
function stubOllama(...sizes: number[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ embeddings: sizes.map((s) => vector(s)) }), { status: 200 }),
      ),
    ),
  );
}

beforeEach(() => {
  initLogger("silent");
  openaiCreate.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("knownModelDimensions", () => {
  it("knows common OpenAI and Ollama models", () => {
    expect(knownModelDimensions("text-embedding-3-small")).toBe(1536);
    expect(knownModelDimensions("text-embedding-3-large")).toBe(3072);
    expect(knownModelDimensions("nomic-embed-text")).toBe(768);
    expect(knownModelDimensions("mxbai-embed-large")).toBe(1024);
    expect(knownModelDimensions("all-minilm")).toBe(384);
  });

  it("ignores Ollama tags", () => {
    expect(knownModelDimensions("nomic-embed-text:v1.5")).toBe(768);
    expect(knownModelDimensions("mxbai-embed-large:latest")).toBe(1024);
  });

  it("returns undefined for unknown models", () => {
    expect(knownModelDimensions("my-custom-embedder")).toBeUndefined();
  });
});

describe("validateDimensionsOverride", () => {
  it("accepts undefined and positive integers", () => {
    expect(validateDimensionsOverride(undefined)).toBeUndefined();
    expect(validateDimensionsOverride(1024)).toBe(1024);
  });

  it.each([0, -1, 1.5, 10001, "512"])("rejects %j", (value) => {
    expect(() => validateDimensionsOverride(value)).toThrow(ConfigError);
  });
});

describe("EmbeddingDimensions", () => {
  it("learns the size from the first vector and checks later vectors against it", () => {
    const dims = new EmbeddingDimensions("custom");
    expect(dims.value).toBe(0);
    dims.check([vector(5)]);
    expect(dims.value).toBe(5);
    expect(() => dims.check([vector(4)])).toThrow("Expected embedding dimension 5, got 4");
  });

  it("prefers the override over the known size", () => {
    expect(new EmbeddingDimensions("text-embedding-3-large", 256).value).toBe(256);
  });
});

describe("OllamaEmbeddingProvider dimensions", () => {
  it("uses the known size of the model", () => {
    expect(new OllamaEmbeddingProvider("http://x", "mxbai-embed-large").dimensions).toBe(1024);
  });

  it("learns the size of an unknown model from the first response", async () => {
    const provider = new OllamaEmbeddingProvider("http://x", "custom-embed");
    expect(provider.dimensions).toBe(0);
    stubOllama(640);
    await provider.embed("hello");
    expect(provider.dimensions).toBe(640);
  });

  it("checks batch responses against the learned size", async () => {
    const provider = new OllamaEmbeddingProvider("http://x", "custom-embed");
    stubOllama(32, 16);
    await expect(provider.embedBatch(["a", "b"])).rejects.toThrow(EmbeddingError);
  });

  it("explains how to fix a wrong override", async () => {
    const provider = new OllamaEmbeddingProvider("http://x", "custom-embed", 512);
    stubOllama(1024);
    await expect(provider.embed("hello")).rejects.toThrow(
      /Expected embedding dimension 512, got 1024.*set embedding\.dimensions to 1024/,
    );
  });
});

describe("OpenAIEmbeddingProvider dimensions", () => {
  it("uses the known size of the model", () => {
    expect(new OpenAIEmbeddingProvider("k", "text-embedding-3-large").dimensions).toBe(3072);
  });

  it("sends the override as the dimensions parameter for text-embedding-3 models", async () => {
    openaiCreate.mockResolvedValue({ data: [{ embedding: vector(256) }] });
    const provider = new OpenAIEmbeddingProvider("k", "text-embedding-3-large", 256);

    await provider.embed("hello");

    expect(openaiCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "text-embedding-3-large", dimensions: 256 }),
    );
    expect(provider.dimensions).toBe(256);
  });

  it("does not send a dimensions parameter without an override", async () => {
    openaiCreate.mockResolvedValue({
      data: [{ embedding: vector(1536) }, { embedding: vector(1536) }],
    });
    const provider = new OpenAIEmbeddingProvider("k", "text-embedding-3-small");

    await provider.embedBatch(["a", "b"]);

    expect(openaiCreate.mock.calls[0]?.[0]).not.toHaveProperty("dimensions");
  });
});

describe("createEmbeddingProvider dimensions", () => {
  it("passes embedding.dimensions to the Ollama provider", () => {
    const provider = createEmbeddingProvider(
      config({
        provider: "ollama",
        ollamaUrl: "http://x",
        ollamaModel: "custom-embed",
        dimensions: 2048,
      }),
    );
    expect(provider.dimensions).toBe(2048);
    expect(provider.model).toBe("custom-embed");
  });

  it("uses the known size for the configured OpenAI model", () => {
    const provider = createEmbeddingProvider(
      config({ provider: "openai", openaiApiKey: "k", openaiModel: "text-embedding-3-large" }),
    );
    expect(provider.dimensions).toBe(3072);
  });

  it("rejects an invalid embedding.dimensions", () => {
    expect(() =>
      createEmbeddingProvider(
        config({ provider: "ollama", ollamaUrl: "http://x", ollamaModel: "m", dimensions: -5 }),
      ),
    ).toThrow(ConfigError);
  });
});
