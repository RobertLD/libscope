import { existsSync } from "node:fs";
import { join } from "node:path";
import { EmbeddingError } from "../errors.js";
import type { EmbeddingProvider } from "./embedding.js";
import { getLogger } from "../logger.js";

/** Minimal typed interface for the @xenova/transformers feature-extraction pipeline output. */
interface TransformersOutput {
  data: Float32Array;
}

/** Minimal typed interface for the @xenova/transformers feature-extraction pipeline function. */
type FeatureExtractionPipeline = (
  input: string,
  options: { pooling: string; normalize: boolean },
) => Promise<TransformersOutput>;

/** Download events from @xenova/transformers while the model is fetched (first use only). */
export interface ModelDownloadEvent {
  /** "initiate" | "download" | "progress" | "done" per file, then "ready". */
  status: string;
  file?: string | undefined;
  /** Percent of `file` downloaded (status "progress"). */
  progress?: number | undefined;
}

/**
 * Local embedding provider using @xenova/transformers (all-MiniLM-L6-v2).
 * Downloads the model on first use (~80MB). Runs entirely in-process.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly model = "Xenova/all-MiniLM-L6-v2";
  readonly dimensions = 384;

  private pipeline: FeatureExtractionPipeline | null = null;
  private initPromise: Promise<void> | null = null;

  /** Called while the model is downloaded (not when it is already cached), e.g. to show progress. */
  onDownloadProgress: ((event: ModelDownloadEvent) => void) | undefined;

  private async ensureInitialized(): Promise<void> {
    this.initPromise ??= this.doInitialize();
    await this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const log = getLogger();
    log.info("Loading local embedding model (all-MiniLM-L6-v2)...");
    try {
      // Dynamic import to avoid loading transformers until needed
      const { pipeline, env } = await import("@xenova/transformers");
      const cacheDir: unknown = env.cacheDir;
      const cached = typeof cacheDir === "string" && existsSync(join(cacheDir, this.model));
      const onDownload = cached ? undefined : this.onDownloadProgress;
      // Cast to the typed interface; @xenova/transformers lacks precise TS generics for pipeline output
      this.pipeline = (await pipeline(
        "feature-extraction",
        this.model,
        onDownload ? { progress_callback: onDownload } : undefined,
      )) as unknown as FeatureExtractionPipeline;
      log.info("Local embedding model loaded successfully");
    } catch (err) {
      this.initPromise = null;
      throw new EmbeddingError("Failed to load local embedding model", err);
    }
  }

  async embed(text: string): Promise<number[]> {
    if (!text.trim()) {
      throw new EmbeddingError("Input text must not be empty");
    }
    await this.ensureInitialized();
    try {
      const output = await this.pipeline!(text, { pooling: "mean", normalize: true });
      const embedding = Array.from(output.data);
      if (embedding.length !== this.dimensions) {
        throw new EmbeddingError(
          `Expected embedding dimension ${this.dimensions}, got ${embedding.length}`,
        );
      }
      return embedding;
    } catch (err) {
      throw new EmbeddingError(`Failed to generate embedding: ${String(err)}`, err);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      throw new EmbeddingError("Input texts array must not be empty");
    }
    for (const t of texts) {
      if (!t.trim()) {
        throw new EmbeddingError("Input text must not be empty");
      }
    }
    // Process sequentially to avoid memory issues with local model
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }
}
