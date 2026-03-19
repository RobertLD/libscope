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

  embed(text: string): Promise<number[]> {
    this.embedCallCount++;
    return Promise.resolve(this.hashToVector(text));
  }

  embedBatch(texts: string[]): Promise<number[][]> {
    this.embedBatchCallCount++;
    return Promise.resolve(texts.map((t) => this.hashToVector(t)));
  }

  /** Simple deterministic hash → 4D unit vector. */
  private hashToVector(text: string): number[] {
    let hash = 5381; // Non-zero seed avoids the zero-hash collapse
    for (let i = 0; i < text.length; i++) {
      hash = Math.trunc((hash * 33) ^ text.codePointAt(i)!);
    }
    const a = Math.sin(hash) * 10000;
    const b = Math.sin(hash + 1) * 10000;
    const c = Math.sin(hash + 2) * 10000;
    const d = Math.sin(hash + 3) * 10000;
    // Normalize — guard against zero magnitude (hash collision to 0)
    const mag = Math.hypot(a, b, c, d);
    if (mag === 0) return [1, 0, 0, 0];
    return [a / mag, b / mag, c / mag, d / mag];
  }
}
