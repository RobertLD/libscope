import OpenAI from "openai";
import { EmbeddingError } from "../errors.js";
import { withRetry } from "../utils/retry.js";
import type { EmbeddingProvider } from "./embedding.js";

/**
 * OpenAI embedding provider.
 * Uses the OpenAI API for high-quality embeddings.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly dimensions = 1536;

  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string = "text-embedding-3-small",
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async embed(text: string): Promise<number[]> {
    if (!text.trim()) {
      throw new EmbeddingError("Input text must not be empty");
    }
    try {
      return await withRetry<number[]>(async () => {
        const response = await this.client.embeddings.create({
          model: this.model,
          input: text,
        });
        const embedding = response.data[0]?.embedding;
        if (!embedding) {
          throw new Error("OpenAI returned empty embedding");
        }
        if (embedding.length !== this.dimensions) {
          throw new EmbeddingError(
            `Expected embedding dimension ${this.dimensions}, got ${embedding.length}`,
          );
        }
        return embedding;
      });
    } catch (err) {
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
        });
        if (response.data.length !== texts.length) {
          throw new EmbeddingError(
            `OpenAI returned ${response.data.length} embeddings for ${texts.length} inputs`,
          );
        }
        const embeddings = response.data.map((d) => d.embedding);
        for (const emb of embeddings) {
          if (emb.length !== this.dimensions) {
            throw new EmbeddingError(
              `Expected embedding dimension ${this.dimensions}, got ${emb.length}`,
            );
          }
        }
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
