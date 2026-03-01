export type { EmbeddingProvider } from "./embedding.js";
export { LocalEmbeddingProvider } from "./local.js";
export { OllamaEmbeddingProvider } from "./ollama.js";
export { OpenAIEmbeddingProvider } from "./openai.js";

import type { LibScopeConfig } from "../config.js";
import { ConfigError } from "../errors.js";
import type { EmbeddingProvider } from "./embedding.js";
import { LocalEmbeddingProvider } from "./local.js";
import { OllamaEmbeddingProvider } from "./ollama.js";
import { OpenAIEmbeddingProvider } from "./openai.js";

/** Create an embedding provider based on config. */
export function createEmbeddingProvider(config: LibScopeConfig): EmbeddingProvider {
  switch (config.embedding.provider) {
    case "local":
      return new LocalEmbeddingProvider();
    case "ollama": {
      if (!config.embedding.ollamaUrl) {
        throw new ConfigError(
          "Ollama URL is required. Set LIBSCOPE_OLLAMA_URL or configure in ~/.libscope/config.json",
        );
      }
      if (!config.embedding.ollamaModel) {
        throw new ConfigError(
          "Ollama model is required. Set LIBSCOPE_OLLAMA_MODEL or configure in ~/.libscope/config.json",
        );
      }
      return new OllamaEmbeddingProvider(config.embedding.ollamaUrl, config.embedding.ollamaModel);
    }
    case "openai": {
      const apiKey = config.embedding.openaiApiKey;
      if (!apiKey) {
        throw new ConfigError(
          "OpenAI API key is required. Set LIBSCOPE_OPENAI_API_KEY or configure in ~/.libscope/config.json",
        );
      }
      return new OpenAIEmbeddingProvider(apiKey, config.embedding.openaiModel);
    }
    default:
      throw new ConfigError(`Unknown embedding provider: ${String(config.embedding.provider)}`);
  }
}
