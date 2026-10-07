import OpenAI from "openai";
import { EmbeddingError } from "../errors.js";
import { createChildLogger } from "../logger.js";
import { withRetry } from "../utils/retry.js";
import { EmbeddingDimensions } from "./dimensions.js";
import type { EmbeddingProvider } from "./embedding.js";

/**
 * OpenAI embedding provider.
 * Uses the OpenAI API for high-quality embeddings.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";

  private readonly client: OpenAI;
  private readonly expectedDimensions: EmbeddingDimensions;
  /** Sent as the API `dimensions` parameter (text-embedding-3 models can shorten vectors). */
  private readonly requestDimensions: { dimensions?: number };

  /**
   * @param dimensions - Override for the vector size. For text-embedding-3 models it is also
   *   sent to the API to request shortened vectors.
   */
  constructor(
    apiKey: string,
    readonly model: string = "text-embedding-3-small",
    dimensions?: number,
  ) {
    this.client = new OpenAI({ apiKey, timeout: 30_000 });
    this.expectedDimensions = new EmbeddingDimensions(model, dimensions);
    this.requestDimensions =
      dimensions !== undefined && model.startsWith("text-embedding-3") ? { dimensions } : {};
  }

  /** Vector size, or 0 until the first embedding of an unknown model. */
  get dimensions(): number {
    return this.expectedDimensions.value;
  }

  async embed(text: string): Promise<number[]> {
    const log = createChildLogger({ provider: this.name, model: this.model });
    if (!text.trim()) {
      throw new EmbeddingError("Input text must not be empty");
    }
    try {
      return await withRetry<number[]>(async () => {
        const response = await this.client.embeddings.create({
          model: this.model,
          input: text,
          ...this.requestDimensions,
        });
        const embedding = response.data[0]?.embedding;
        if (!embedding) {
          throw new EmbeddingError("OpenAI returned empty embedding");
        }
        this.expectedDimensions.check([embedding]);
        return embedding;
      });
    } catch (err) {
      log.error({ err }, "OpenAI embedding failed");
      if (err instanceof EmbeddingError) throw err;
      throw new EmbeddingError(
        `Failed to generate embedding: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
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
    try {
      return await withRetry<number[][]>(async () => {
        const response = await this.client.embeddings.create({
          model: this.model,
          input: texts,
          ...this.requestDimensions,
        });
        if (response.data.length !== texts.length) {
          throw new EmbeddingError(
            `OpenAI returned ${response.data.length} embeddings for ${texts.length} inputs`,
          );
        }
        const embeddings = response.data.map((d) => d.embedding);
        this.expectedDimensions.check(embeddings);
        return embeddings;
      });
    } catch (err) {
      if (err instanceof EmbeddingError) throw err;
      throw new EmbeddingError(
        `Failed to generate embedding: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }
}
