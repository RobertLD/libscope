import type { EmbeddingProvider } from "../../src/providers/embedding.js";

/**
 * Mock embedding provider for tests.
 * Returns deterministic vectors based on text content hash.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock";
  readonly dimensions = 4;

  embedCallCount = 0;
  embedBatchCallCount = 0;

  async embed(text: string): Promise<number[]> {
    this.embedCallCount++;
    return this.hashToVector(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    this.embedBatchCallCount++;
    return texts.map((t) => this.hashToVector(t));
  }

  /** Simple deterministic hash → 4D unit vector. */
  private hashToVector(text: string): number[] {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = Math.trunc(hash * 31 + text.codePointAt(i)!);
    }
    const a = Math.sin(hash) * 10000;
    const b = Math.sin(hash + 1) * 10000;
    const c = Math.sin(hash + 2) * 10000;
    const d = Math.sin(hash + 3) * 10000;
    // Normalize
    const mag = Math.hypot(a, b, c, d);
    return [a / mag, b / mag, c / mag, d / mag];
  }
}
