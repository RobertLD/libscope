import { EmbeddingError } from "../errors.js";
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
    try {
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
      return embedding;
    } catch (err) {
      if (err instanceof EmbeddingError) throw err;
      throw new EmbeddingError(
        `Failed to generate embedding: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Ollama supports batch input
    try {
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
      return data.embeddings;
    } catch (err) {
      if (err instanceof EmbeddingError) throw err;
      throw new EmbeddingError(
        `Failed to generate embedding: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }
}
