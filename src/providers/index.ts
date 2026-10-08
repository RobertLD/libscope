export type { EmbeddingProvider } from "./embedding.js";
export { LocalEmbeddingProvider } from "./local.js";
export { OllamaEmbeddingProvider } from "./ollama.js";
export { OpenAIEmbeddingProvider } from "./openai.js";

import { DEFAULT_OLLAMA_URL, type LibScopeConfig } from "../config.js";
import { ConfigError } from "../errors.js";
import { validateDimensionsOverride } from "./dimensions.js";
import type { EmbeddingProvider } from "./embedding.js";
import { LocalEmbeddingProvider } from "./local.js";
import { OllamaEmbeddingProvider } from "./ollama.js";
import { OpenAIEmbeddingProvider } from "./openai.js";

/** Create an embedding provider based on config. */
export function createEmbeddingProvider(config: LibScopeConfig): EmbeddingProvider {
  const { embedding } = config;
  switch (embedding.provider) {
    case "local":
      return new LocalEmbeddingProvider();
    case "ollama":
      return new OllamaEmbeddingProvider(
        embedding.url ?? DEFAULT_OLLAMA_URL,
        embedding.model ?? "nomic-embed-text",
        validateDimensionsOverride(embedding.dimensions),
      );
    case "openai": {
      const apiKey = config.openai?.apiKey;
      if (!apiKey) {
        throw new ConfigError(
          "OpenAI API key is required. Set LIBSCOPE_OPENAI_API_KEY or OPENAI_API_KEY, " +
            'or run "libscope config set openai.apiKey <key>".',
        );
      }
      return new OpenAIEmbeddingProvider(
        apiKey,
        embedding.model,
        validateDimensionsOverride(embedding.dimensions),
      );
    }
    default:
      throw new ConfigError(`Unknown embedding provider: ${String(config.embedding.provider)}`);
  }
}
