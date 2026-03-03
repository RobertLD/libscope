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
        const timeoutMs = 30_000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;
        try {
          response = await fetch(`${this.baseUrl}/api/embed`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: this.model, input: text }),
            signal: controller.signal,
          });
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            throw new EmbeddingError(`Request to ${this.name} timed out after ${timeoutMs}ms`);
          }
          throw err;
        } finally {
          clearTimeout(timeoutId);
        }

        if (!response.ok) {
          throw new EmbeddingError(
            `Ollama API returned ${response.status}: ${await response.text()}`,
          );
        }

        const data = (await response.json()) as Record<string, unknown>;
        if (!data.embeddings || !Array.isArray(data.embeddings)) {
          throw new EmbeddingError(
            `Unexpected Ollama response shape: ${JSON.stringify(Object.keys(data))}`,
          );
        }
        const embedding = data.embeddings[0] as number[] | undefined;
        if (!embedding) {
          throw new EmbeddingError("Ollama returned empty embeddings");
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
        const timeoutMs = 60_000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;
        try {
          response = await fetch(`${this.baseUrl}/api/embed`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: this.model, input: texts }),
            signal: controller.signal,
          });
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            throw new EmbeddingError(`Request to ${this.name} timed out after ${timeoutMs}ms`);
          }
          throw err;
        } finally {
          clearTimeout(timeoutId);
        }

        if (!response.ok) {
          throw new EmbeddingError(
            `Ollama API returned ${response.status}: ${await response.text()}`,
          );
        }

        const data = (await response.json()) as Record<string, unknown>;
        if (!data.embeddings || !Array.isArray(data.embeddings)) {
          throw new EmbeddingError(
            `Unexpected Ollama response shape: ${JSON.stringify(Object.keys(data))}`,
          );
        }
        const embeddings = data.embeddings as number[][];
        if (embeddings.length !== texts.length) {
          throw new EmbeddingError(
            `Ollama returned ${embeddings.length} embeddings for ${texts.length} inputs`,
          );
        }
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
