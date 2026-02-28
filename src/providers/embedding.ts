/**
 * Embedding provider interface.
 * All providers must implement this contract.
 */
export interface EmbeddingProvider {
  /** Provider name for display/logging. */
  readonly name: string;

  /** Dimensionality of the output vectors. */
  readonly dimensions: number;

  /** Generate an embedding vector for a single text input. */
  embed(text: string): Promise<number[]>;

  /** Generate embeddings for multiple texts (batch). */
  embedBatch(texts: string[]): Promise<number[][]>;
}
