import OpenAI from "openai";
import { EmbeddingError } from "../errors.js";
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
    try {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: text,
      });
      const embedding = response.data[0]?.embedding;
      if (!embedding) {
        throw new Error("OpenAI returned empty embedding");
      }
      return embedding;
    } catch (err) {
      if (err instanceof EmbeddingError) throw err;
      throw new EmbeddingError(`OpenAI embedding failed: ${String(err)}`, err);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    try {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: texts,
      });
      return response.data.map((d) => d.embedding);
    } catch (err) {
      if (err instanceof EmbeddingError) throw err;
      throw new EmbeddingError(`OpenAI batch embedding failed: ${String(err)}`, err);
    }
  }
}
