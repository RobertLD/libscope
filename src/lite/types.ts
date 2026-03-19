import type { EmbeddingProvider } from "../providers/embedding.js";
import type { LlmProvider } from "../core/rag.js";

export interface LiteOptions {
  dbPath?: string | undefined;
  provider?: EmbeddingProvider | undefined;
  model?: string | undefined;
  llmProvider?: LlmProvider | undefined;
}

export interface LiteDoc {
  title: string;
  content: string;
  url?: string | undefined;
  sourceType?: "library" | "topic" | "manual" | "model-generated" | undefined;
  library?: string | undefined;
  version?: string | undefined;
  topicId?: string | undefined;
  language?: string | undefined;
}

export type RawInput =
  | { type: "file"; path: string; title?: string | undefined }
  | { type: "url"; url: string; title?: string | undefined }
  | { type: "text"; content: string; title: string }
  | { type: "buffer"; buffer: Buffer; filename: string; title?: string | undefined };

export interface LiteSearchOptions {
  limit?: number | undefined;
  topic?: string | undefined;
  library?: string | undefined;
  tags?: string[] | undefined;
  diversity?: number | undefined;
}

export interface LiteSearchResult {
  docId: string;
  chunkId: string;
  title: string;
  content: string;
  score: number;
  url: string | null;
}

export interface LiteContextOptions {
  topK?: number | undefined;
  topic?: string | undefined;
  library?: string | undefined;
}

export interface LiteAskOptions {
  topK?: number | undefined;
  topic?: string | undefined;
  library?: string | undefined;
  systemPrompt?: string | undefined;
  llmProvider?: LlmProvider | undefined;
}
