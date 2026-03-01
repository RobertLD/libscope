import { EmbeddingError } from "../errors.js";
import { createChildLogger } from "../logger.js";
import { withRetry } from "../utils/retry.js";
import type { EmbeddingProvider } from "./embedding.js";

/**
 * Ollama embedding provider.
 * Connects to a local Ollama instance for embedding generation.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = "ollama";
  readonly dimensions: number;

  constructor(
    private readonly baseUrl: string = "http://localhost:11434",
    private readonly model: string = "nomic-embed-text",
    dimensions: number = 768,
  ) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const log = createChildLogger({ provider: this.name, model: this.model });
    if (!text.trim()) {
      throw new EmbeddingError("Input text must not be empty");
    }
    try {
      return await withRetry<number[]>(async () => {
        const response = await fetch(`${this.baseUrl}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.model, input: text }),
        });

        if (!response.ok) {
          throw new Error(`Ollama API returned ${response.status}: ${await response.text()}`);
        }

        const data = (await response.json()) as { embeddings: number[][] };
        const embedding = data.embeddings[0];
        if (!embedding) {
          throw new Error("Ollama returned empty embeddings");
        }
        if (embedding.length !== this.dimensions) {
          throw new EmbeddingError(
            `Expected embedding dimension ${this.dimensions}, got ${embedding.length}`,
          );
        }
        return embedding;
      });
    } catch (err) {
      log.error({ err }, "Ollama embedding failed");
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
    // Ollama supports batch input
    try {
      return await withRetry<number[][]>(async () => {
        const response = await fetch(`${this.baseUrl}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.model, input: texts }),
        });

        if (!response.ok) {
          throw new Error(`Ollama API returned ${response.status}: ${await response.text()}`);
        }

        const data = (await response.json()) as { embeddings: number[][] };
        if (data.embeddings.length !== texts.length) {
          throw new EmbeddingError(
            `Ollama returned ${data.embeddings.length} embeddings for ${texts.length} inputs`,
          );
        }
        for (const emb of data.embeddings) {
          if (emb.length !== this.dimensions) {
            throw new EmbeddingError(
              `Expected embedding dimension ${this.dimensions}, got ${emb.length}`,
            );
          }
        }
        return data.embeddings;
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
