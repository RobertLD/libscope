import { describe, it, expect, beforeAll } from "vitest";
import {
  LocalEmbeddingProvider,
  MAX_TOKENS,
  meanPoolNormalized,
  truncateTokenIds,
} from "../../src/providers/local.js";
import { initLogger } from "../../src/logger.js";

const CLS = 101;
const SEP = 102;

describe("truncateTokenIds", () => {
  it("keeps input of at most MAX_TOKENS ids unchanged", () => {
    const ids = [CLS, ...Array.from({ length: MAX_TOKENS - 2 }, (_, i) => 1000 + i), SEP];
    expect(truncateTokenIds(ids)).toEqual(ids);
  });

  it("cuts longer input to MAX_TOKENS ids and keeps the final [SEP]", () => {
    const body = Array.from({ length: 600 }, (_, i) => 1000 + i);
    const truncated = truncateTokenIds([CLS, ...body, SEP]);
    expect(truncated).toHaveLength(MAX_TOKENS);
    expect(truncated[0]).toBe(CLS);
    expect(truncated.at(-1)).toBe(SEP);
    expect(truncated.slice(1, -1)).toEqual(body.slice(0, MAX_TOKENS - 2));
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
