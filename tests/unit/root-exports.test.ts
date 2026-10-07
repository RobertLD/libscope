import { describe, expect, it } from "vitest";

/**
 * The runtime exports of the package entry points. Adding a public export is an API
 * decision: update this list deliberately (and docs/reference/lite-api.md or
 * docs/guide/programmatic-usage.md).
 */
const ROOT_EXPORTS = [
  "ChunkNotFoundError",
  "ConfigError",
  "DatabaseError",
  "DocumentNotFoundError",
  "EmbeddingError",
  "FetchError",
  "LibScope",
  "LibScopeError",
  "NotFoundError",
  "TopicNotFoundError",
  "ValidationError",
];

const LITE_EXTRAS = ["TreeSitterChunker", "createCodeChunker", "createLite", "normalizeRawInput"];

describe("package exports", () => {
  it("libscope exports only LibScope and the error classes", async () => {
    const root = await import("../../src/core/index.js");
    expect(Object.keys(root).sort()).toEqual(ROOT_EXPORTS);
  });

  it("libscope/lite exports the root plus the lite helpers", async () => {
    const lite = await import("../../src/lite/index.js");
    expect(Object.keys(lite).sort()).toEqual([...ROOT_EXPORTS, ...LITE_EXTRAS].sort());
  });
});
