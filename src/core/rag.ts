import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../providers/embedding.js";
import type { LibScopeConfig } from "../config.js";
import { searchDocuments, type SearchResult } from "./search.js";

export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful assistant. Answer based on the provided context. " +
  "Cite sources by title. If the context doesn't contain enough information, say so.";

export interface RagOptions {
  question: string;
  topK?: number | undefined;
  topic?: string | undefined;
  library?: string | undefined;
  systemPrompt?: string | undefined;
}

export interface RagSource {
  documentId: string;
  title: string;
  chunk: string;
  score: number;
}

export interface RagResult {
  answer: string;
  sources: RagSource[];
  model: string;
  tokensUsed?: number | undefined;
}

export interface LlmProvider {
  readonly model: string;
  complete(
    prompt: string,
    systemPrompt?: string,
  ): Promise<{ text: string; tokensUsed?: number | undefined }>;
  completeStream?(prompt: string, systemPrompt?: string): AsyncIterable<string>;
}

/** Build the context prompt from retrieved search results. */
export function buildContextPrompt(question: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `Question: ${question}\n\nNo relevant documents were found. Please let the user know.`;
  }

  const contextBlocks = results
    .map((r, i) => `[Source ${i + 1}: "${r.title}"]\n${r.content}`)
    .join("\n\n");

  return (
    "Use the following context to answer the question. Cite sources by their title.\n\n" +
    `${contextBlocks}\n\n` +
    `Question: ${question}`
  );
}

/** Extract source citations from search results. */
export function extractSources(results: SearchResult[]): RagSource[] {
  return results.map((r) => ({
    documentId: r.documentId,
    title: r.title,
    chunk: r.content,
    score: r.score,
  }));
}

interface LlmConfig {
  provider?: "openai" | "ollama";
  model?: string;
  ollamaUrl?: string;
  openaiApiKey?: string;
}

/** Create an LLM provider from config. */
export function createLlmProvider(config: LibScopeConfig): LlmProvider {
  const llmConfig: LlmConfig | undefined = config.llm;
  const providerType = llmConfig?.provider;

  if (providerType === "openai") {
    return createOpenAiProvider(config.embedding, llmConfig);
  }
  if (providerType === "ollama") {
    return createOllamaProvider(config.embedding, llmConfig);
  }

  throw new Error(
    "No LLM provider configured. Set llm.provider to 'openai' or 'ollama' in your config, " +
      "or set LIBSCOPE_LLM_PROVIDER environment variable.",
  );
}

function createOpenAiProvider(
  embedding: LibScopeConfig["embedding"],
  llmConfig: LlmConfig | undefined,
): LlmProvider {
  const apiKey = llmConfig?.openaiApiKey ?? embedding.openaiApiKey;
  if (!apiKey) {
    throw new Error(
      "OpenAI API key is required. Set llm.openaiApiKey or embedding.openaiApiKey in config.",
    );
  }

  const model = llmConfig?.model ?? "gpt-4o-mini";

  return {
    model,
    async complete(
      prompt: string,
      systemPrompt?: string,
    ): Promise<{ text: string; tokensUsed?: number | undefined }> {
      const messages: Array<{ role: string; content: string }> = [];
      if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt });
      }
      messages.push({ role: "user", content: prompt });

      const timeoutMs = 60_000;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, messages }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error(`OpenAI LLM request timed out after ${timeoutMs}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) {
        const status = res.status;
        // Sanitize: don't leak response body which may contain account details
        const genericMessages: Record<number, string> = {
          401: "Invalid or expired API key",
          429: "Rate limit exceeded",
          500: "OpenAI internal server error",
          503: "OpenAI service unavailable",
        };
        const message = genericMessages[status] ?? `HTTP ${status}`;
        throw new Error(`OpenAI API error: ${message}`);
      }

      const data = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
        usage?: { total_tokens: number };
      };

      return {
        text: data.choices[0]?.message.content ?? "",
        tokensUsed: data.usage?.total_tokens,
      };
    },
  };
}

function createOllamaProvider(
  embedding: LibScopeConfig["embedding"],
  llmConfig: LlmConfig | undefined,
): LlmProvider {
  const baseUrl = llmConfig?.ollamaUrl ?? embedding.ollamaUrl ?? "http://localhost:11434";
  const model = llmConfig?.model ?? "llama3.2";

  return {
    model,
    async complete(
      prompt: string,
      systemPrompt?: string,
    ): Promise<{ text: string; tokensUsed?: number | undefined }> {
      const timeoutMs = 60_000;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            prompt,
            system: systemPrompt,
            stream: false,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error(`Ollama LLM request timed out after ${timeoutMs}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) {
        const status = res.status;
        const genericMessages: Record<number, string> = {
          400: "Bad request",
          404: "Model not found",
          500: "Ollama internal server error",
          503: "Ollama service unavailable",
        };
        const message = genericMessages[status] ?? `HTTP ${status}`;
        throw new Error(`Ollama API error: ${message}`);
      }

      const data = (await res.json()) as {
        response: string;
        eval_count?: number;
        prompt_eval_count?: number;
      };

      const tokensUsed =
        data.eval_count != null && data.prompt_eval_count != null
          ? data.eval_count + data.prompt_eval_count
          : undefined;

      return { text: data.response, tokensUsed };
    },
  };
}

/** SSE event for streaming RAG responses. */
export type RagStreamEvent =
  | { token: string }
  | { done: true; sources: RagSource[]; model: string; tokensUsed?: number };

/**
 * Perform streaming RAG: retrieve relevant chunks, then stream LLM tokens.
 * Falls back to returning the full response as a single token event
 * when the provider does not support completeStream.
 */
export async function* askQuestionStream(
  db: Database.Database,
  embeddingProvider: EmbeddingProvider,
  llmProvider: LlmProvider,
  options: RagOptions,
): AsyncGenerator<RagStreamEvent> {
  const topK = options.topK ?? 5;

  const { results } = await searchDocuments(db, embeddingProvider, {
    query: options.question,
    topic: options.topic,
    library: options.library,
    limit: topK,
  });

  const contextPrompt = buildContextPrompt(options.question, results);
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  if (llmProvider.completeStream) {
    for await (const chunk of llmProvider.completeStream(contextPrompt, systemPrompt)) {
      yield { token: chunk };
    }
  } else {
    // Fallback: get full response and emit as a single token
    const { text } = await llmProvider.complete(contextPrompt, systemPrompt);
    yield { token: text };
  }

  yield {
    done: true,
    sources: extractSources(results),
    model: llmProvider.model,
  };
}

/** Perform RAG: retrieve relevant chunks, then generate an LLM answer. */
export async function askQuestion(
  db: Database.Database,
  embeddingProvider: EmbeddingProvider,
  llmProvider: LlmProvider,
  options: RagOptions,
): Promise<RagResult> {
  const topK = options.topK ?? 5;

  const { results } = await searchDocuments(db, embeddingProvider, {
    query: options.question,
    topic: options.topic,
    library: options.library,
    limit: topK,
  });

  const contextPrompt = buildContextPrompt(options.question, results);
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  const { text, tokensUsed } = await llmProvider.complete(contextPrompt, systemPrompt);

  return {
    answer: text,
    sources: extractSources(results),
    model: llmProvider.model,
    tokensUsed,
  };
}
