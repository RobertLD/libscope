import { describe, it, expect, beforeAll } from "vitest";
import {
  clsPoolNormalized,
  LOCAL_MODELS,
  LocalEmbeddingProvider,
  meanPoolNormalized,
  truncateTokenIds,
} from "../../src/providers/local.js";
import { createEmbeddingProvider } from "../../src/providers/index.js";
import type { LibScopeConfig } from "../../src/config.js";
import { ConfigError } from "../../src/errors.js";
import { initLogger } from "../../src/logger.js";

const CLS = 101;
const SEP = 102;

const TOKEN_LIMITS = [...new Set([...LOCAL_MODELS.values()].map((model) => model.maxTokens))];

describe.each(TOKEN_LIMITS)("truncateTokenIds to %i tokens", (maxTokens) => {
  it("keeps input of at most maxTokens ids unchanged", () => {
    const ids = [CLS, ...Array.from({ length: maxTokens - 2 }, (_, i) => 1000 + i), SEP];
    expect(truncateTokenIds(ids, maxTokens)).toEqual(ids);
  });

  it("cuts longer input to maxTokens ids and keeps the final [SEP]", () => {
    const body = Array.from({ length: 600 }, (_, i) => 1000 + i);
    const truncated = truncateTokenIds([CLS, ...body, SEP], maxTokens);
    expect(truncated).toHaveLength(maxTokens);
    expect(truncated[0]).toBe(CLS);
    expect(truncated.at(-1)).toBe(SEP);
    expect(truncated.slice(1, -1)).toEqual(body.slice(0, maxTokens - 2));
  });
});

describe("clsPoolNormalized", () => {
  it("takes the first token vector and scales it to unit length", () => {
    expect(clsPoolNormalized(new Float32Array([3, 4, 1, 0]), 2)).toEqual([0.6, 0.8]);
  });
});

describe("local model selection", () => {
  function config(embedding: LibScopeConfig["embedding"]): LibScopeConfig {
    return {
      embedding,
      database: { path: ":memory:" },
      indexing: { maxDocumentSize: 1024, allowPrivateUrls: false, allowSelfSignedCerts: false },
      logging: { level: "silent" },
    };
  }

  it("uses all-MiniLM-L6-v2 when embedding.model is not set", () => {
    const provider = createEmbeddingProvider(config({ provider: "local" }));
    expect(provider.model).toBe("sentence-transformers/all-MiniLM-L6-v2");
    expect(provider.dimensions).toBe(384);
  });

  it.each([
    ["all-MiniLM-L6-v2", "sentence-transformers/all-MiniLM-L6-v2", 384],
    ["bge-small-en-v1.5", "BAAI/bge-small-en-v1.5", 384],
    ["bge-base-en-v1.5", "BAAI/bge-base-en-v1.5", 768],
  ])("selects %s from embedding.model", (name, model, dimensions) => {
    const provider = createEmbeddingProvider(config({ provider: "local", model: name }));
    expect(provider.model).toBe(model);
    expect(provider.dimensions).toBe(dimensions);
  });

  it.each(["bge-m3", "constructor"])("rejects the unknown model %s", (name) => {
    const create = (): unknown =>
      createEmbeddingProvider(config({ provider: "local", model: name }));
    expect(create).toThrow(ConfigError);
    expect(create).toThrow(
      `embedding.model "${name}" is not a model of the local provider. ` +
        "Supported models: all-MiniLM-L6-v2, bge-small-en-v1.5, bge-base-en-v1.5. " +
        'Run "libscope config set embedding.model <model>" or ' +
        '"libscope config unset embedding.model". ' +
        "If LIBSCOPE_EMBEDDING_MODEL or a project .libscope.json sets it, change it there.",
    );
  });
});

describe("meanPoolNormalized", () => {
  it("averages the token vectors and scales the result to unit length", () => {
    // Two tokens, two dimensions: mean of [1, 0] and [3, 4] is [2, 2].
    const pooled = meanPoolNormalized(new Float32Array([1, 0, 3, 4]), 2, 2);
    expect(pooled[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(pooled[1]).toBeCloseTo(Math.SQRT1_2, 6);
  });
});

// Reference values: the first 8 dimensions from Python onnxruntime (CPU) running the same
// full-precision model with the Hugging Face tokenizer, truncated to 256 tokens.
const REFERENCES = [
  {
    text: "The quick brown fox jumps over the lazy dog.",
    head: [0.043934, 0.058934, 0.048178, 0.077548, 0.026744, -0.03763, -0.002605, -0.059943],
  },
  {
    text: Array.from({ length: 400 }, (_, i) => `word${i % 50}`).join(" "),
    head: [0.004672, -0.058774, -0.039712, -0.016036, 0.016489, 0.011557, 0.082817, -0.027109],
  },
];

describe("LocalEmbeddingProvider — skipped if the model cannot be loaded", () => {
  const provider = new LocalEmbeddingProvider();
  let available = false;

  beforeAll(async () => {
    initLogger("silent");
    try {
      await provider.embed("warmup");
      available = true;
    } catch {
      available = false;
    }
  }, 300_000);

  it("matches the reference vectors for short and truncated long input", async () => {
    if (!available) {
      console.log("  [skip] all-MiniLM-L6-v2 model not available");
      return;
    }
    for (const { text, head } of REFERENCES) {
      const vector = await provider.embed(text);
      expect(vector).toHaveLength(provider.dimensions);
      vector.slice(0, head.length).forEach((value, i) => {
        expect(value).toBeCloseTo(head[i]!, 5);
      });
    }
  });
});
