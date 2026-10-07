import { ConfigError, EmbeddingError } from "../errors.js";

/** Output dimensions of common embedding models, keyed by model name (without a tag). */
const KNOWN_MODEL_DIMENSIONS: ReadonlyMap<string, number> = new Map([
  // OpenAI
  ["text-embedding-3-small", 1536],
  ["text-embedding-3-large", 3072],
  ["text-embedding-ada-002", 1536],
  // Ollama
  ["nomic-embed-text", 768],
  ["mxbai-embed-large", 1024],
  ["all-minilm", 384],
  ["bge-m3", 1024],
  ["bge-large", 1024],
  ["snowflake-arctic-embed2", 1024],
  ["paraphrase-multilingual", 768],
]);

/** Largest dimension count accepted for the vector table. */
export const MAX_EMBEDDING_DIMENSIONS = 10000;

/**
 * Look up the output dimension of a known model. Ollama tags (`name:tag`) are ignored,
 * because every tag of the models in the table has the same dimension.
 */
export function knownModelDimensions(model: string): number | undefined {
  return KNOWN_MODEL_DIMENSIONS.get(model) ?? KNOWN_MODEL_DIMENSIONS.get(model.split(":")[0] ?? "");
}

/** Throw a ConfigError unless `value` is a usable `embedding.dimensions` value. */
export function validateDimensionsOverride(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_EMBEDDING_DIMENSIONS
  ) {
    throw new ConfigError(
      `embedding.dimensions must be a positive integer <= ${MAX_EMBEDDING_DIMENSIONS}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Tracks the expected vector size for a provider. The expected size comes from the
 * `embedding.dimensions` override, else the known-model table, else the first response.
 */
export class EmbeddingDimensions {
  private expected: number | undefined;

  constructor(
    private readonly model: string,
    override?: number,
  ) {
    this.expected = override ?? knownModelDimensions(model);
  }

  /** Expected dimension, or 0 while it is unknown (before the first embedding). */
  get value(): number {
    return this.expected ?? 0;
  }

  /** Check every vector against the expected size; learn the size from the first vector. */
  check(vectors: number[][]): void {
    for (const vector of vectors) {
      this.expected ??= vector.length;
      if (vector.length !== this.expected) {
        throw new EmbeddingError(
          `Expected embedding dimension ${this.expected}, got ${vector.length} from model "${this.model}". ` +
            `If this model produces ${vector.length}-dimensional vectors, set embedding.dimensions to ${vector.length}.`,
        );
      }
    }
  }
}
