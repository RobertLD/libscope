import { describe, it, expect, beforeEach } from "vitest";
import type { EmbeddingProvider } from "../../src/providers/embedding.js";
import type { ProviderFactory } from "../../src/providers/index.js";
import { registerProvider, createEmbeddingProvider } from "../../src/providers/index.js";
import type { LibScopeConfig } from "../../src/config.js";

function makeConfig(provider: string): LibScopeConfig {
  return {
    embedding: {
      provider,
    },
    database: { path: ":memory:" },
    indexing: { maxDocumentSize: 1024 },
    logging: { level: "silent" },
  };
}

class StubProvider implements EmbeddingProvider {
  readonly name = "stub";
  readonly dimensions = 3;

  embed(_text: string): Promise<number[]> {
    return Promise.resolve([0.1, 0.2, 0.3]);
  }

  embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map(() => [0.1, 0.2, 0.3]));
  }
}

describe("plugin provider registration", () => {
  beforeEach(() => {
    // Register a fresh custom provider before each test
    registerProvider("stub", () => new StubProvider());
  });

  it("should use a registered custom provider", () => {
    const provider = createEmbeddingProvider(makeConfig("stub"));
    expect(provider.name).toBe("stub");
    expect(provider.dimensions).toBe(3);
  });

  it("should return embeddings from a custom provider", async () => {
    const provider = createEmbeddingProvider(makeConfig("stub"));
    const result = await provider.embed("hello");
    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  it("should return batch embeddings from a custom provider", async () => {
    const provider = createEmbeddingProvider(makeConfig("stub"));
    const results = await provider.embedBatch(["a", "b"]);
    expect(results).toHaveLength(2);
  });

  it("should pass config to the factory function", () => {
    let receivedConfig: LibScopeConfig | undefined;
    const factory: ProviderFactory = (config) => {
      receivedConfig = config;
      return new StubProvider();
    };
    registerProvider("config-test", factory);
    const config = makeConfig("config-test");
    createEmbeddingProvider(config);
    expect(receivedConfig).toBe(config);
  });

  it("should still support built-in providers", () => {
    const provider = createEmbeddingProvider(makeConfig("local"));
    expect(provider.name).toBe("local");
  });

  it("should throw for unknown unregistered providers", () => {
    expect(() => createEmbeddingProvider(makeConfig("nonexistent"))).toThrow(
      "Unknown embedding provider",
    );
  });
});
