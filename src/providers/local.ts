import { EmbeddingError } from "../errors.js";
import type { EmbeddingProvider } from "./embedding.js";
import { getLogger } from "../logger.js";

/**
 * Local embedding provider using @xenova/transformers (all-MiniLM-L6-v2).
 * Downloads the model on first use (~80MB). Runs entirely in-process.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly dimensions = 384;

  private pipeline: unknown = null;
  private initPromise: Promise<void> | null = null;

  private async ensureInitialized(): Promise<void> {
    this.initPromise ??= this.doInitialize();
    await this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const log = getLogger();
    log.info("Loading local embedding model (all-MiniLM-L6-v2)...");
    try {
      // Dynamic import to avoid loading transformers until needed
      const { pipeline } = await import("@xenova/transformers");
      this.pipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
      log.info("Local embedding model loaded successfully");
    } catch (err) {
      this.initPromise = null;
      throw new EmbeddingError("Failed to load local embedding model", err);
    }
  }

  async embed(text: string): Promise<number[]> {
    await this.ensureInitialized();
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      const output = await (this.pipeline as any)(text, { pooling: "mean", normalize: true });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      return Array.from(output.data as Float32Array);
    } catch (err) {
      throw new EmbeddingError(`Failed to generate embedding: ${String(err)}`, err);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Process sequentially to avoid memory issues with local model
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }
}
