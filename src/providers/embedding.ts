/**
 * Embedding provider interface.
 * All providers must implement this contract.
 */
export interface EmbeddingProvider {
  /** Provider name for display/logging. */
  readonly name: string;

  /** Model identifier, recorded with the vector index to detect model changes. */
  readonly model?: string | undefined;

  /**
   * Dimensionality of the output vectors.
   * 0 means not yet known: the provider learns it from the first embedding it returns.
   */
  readonly dimensions: number;

  /** Generate an embedding vector for a single text input. */
  embed(text: string): Promise<number[]>;

  /** Generate embeddings for multiple texts (batch). */
  embedBatch(texts: string[]): Promise<number[][]>;
}
