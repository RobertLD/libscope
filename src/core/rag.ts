import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../providers/embedding.js";
import {
  DEFAULT_OLLAMA_URL,
  resolveLlmProviderName,
  type LibScopeConfig,
  type LlmSurface,
} from "../config.js";
import { searchDocuments, type SearchResult } from "./search.js";
import { ConfigError, FetchError } from "../errors.js";

export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful assistant. Answer based on the provided context. " +
  "Cite sources by title. If the context doesn't contain enough information, say so.";

export interface RagOptions {
  question: string;
  topK?: number | undefined;
  topic?: string | undefined;
  library?: string | undefined;
  version?: string | undefined;
  /** Filter by document source type. */
  sourceType?: string | undefined;
  /** Only documents carrying all of these tags. */
  tags?: string[] | undefined;
  minRating?: number | undefined;
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

export { resolveLlmProviderName, type LlmSurface } from "../config.js";

type LlmConfig = NonNullable<LibScopeConfig["llm"]>;

/** Options for resolving `llm.provider` ("auto" depends on the calling surface). */
export interface LlmResolveOptions {
  surface?: LlmSurface | undefined;
}

/**
 * Returns true if the LLM step is delegated to the caller: `llm.provider` is "passthrough",
 * or it is "auto" and the surface is "mcp" (the calling assistant is the LLM).
 */
export function isPassthroughMode(
  config: LibScopeConfig,
  options: LlmResolveOptions = {},
): boolean {
  return resolveLlmProviderName(config, options) === "passthrough";
}

const NO_LLM_HINT =
  "No LLM provider configured. Set an OpenAI or Anthropic API key (LIBSCOPE_OPENAI_API_KEY, " +
  "OPENAI_API_KEY, LIBSCOPE_ANTHROPIC_API_KEY, ANTHROPIC_API_KEY), or run " +
  '"libscope config set llm.provider <openai|anthropic|ollama|passthrough>".';

/**
 * Create an LLM provider from config. `llm.provider` "auto" (the default) is resolved with
 * resolveLlmProviderName. Throws ConfigError when no LLM is available, or when the result is
 * passthrough (no LLM is created; check isPassthroughMode first).
 */
export function createLlmProvider(
  config: LibScopeConfig,
  options: LlmResolveOptions = {},
): LlmProvider {
  const llmConfig: LlmConfig | undefined = config.llm;
  const providerType = resolveLlmProviderName(config, options);

  if (providerType === "openai") {
    return createOpenAiProvider(config.openai?.apiKey, llmConfig);
  }
  if (providerType === "ollama") {
    return createOllamaProvider(config.embedding, llmConfig);
  }
  if (providerType === "anthropic") {
    return createAnthropicProvider(config.anthropic?.apiKey, llmConfig);
  }
  if (providerType === "passthrough") {
    throw new ConfigError(
      'llm.provider resolves to "passthrough": no LLM is created and the caller writes the ' +
        "answer from the retrieved context.",
    );
  }

  throw new ConfigError(NO_LLM_HINT);
}

/** Retrieve the top-K search results for a RAG question (default K = 5). */
async function retrieveResults(
  db: Database.Database,
  embeddingProvider: EmbeddingProvider,
  options: RagOptions,
): Promise<SearchResult[]> {
  const { results } = await searchDocuments(db, embeddingProvider, {
    query: options.question,
    topic: options.topic,
    library: options.library,
    version: options.version,
    source: options.sourceType,
    tags: options.tags,
    minRating: options.minRating,
    limit: options.topK ?? 5,
  });
  return results;
}

export interface PassthroughResult {
  contextPrompt: string;
  sources: RagSource[];
}

/**
 * Retrieve relevant chunks and return the formatted context prompt without calling an LLM.
 * Used in passthrough mode so the calling LLM can synthesize the answer itself.
 */
export async function getContextForQuestion(
  db: Database.Database,
  embeddingProvider: EmbeddingProvider,
  options: RagOptions,
): Promise<PassthroughResult> {
  const results = await retrieveResults(db, embeddingProvider, options);

  return {
    contextPrompt: buildContextPrompt(options.question, results),
    sources: extractSources(results),
  };
}

function createOpenAiProvider(
  apiKey: string | undefined,
  llmConfig: LlmConfig | undefined,
): LlmProvider {
  if (!apiKey) {
    throw new ConfigError(
      "OpenAI API key is required. Set LIBSCOPE_OPENAI_API_KEY or OPENAI_API_KEY, " +
        'or run "libscope config set openai.apiKey <key>".',
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
          throw new FetchError(`OpenAI LLM request timed out after ${timeoutMs}ms`);
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
        throw new FetchError(`OpenAI API error: ${message}`);
      }

      const data = (await res.json()) as {
        choices?: Array<{ message: { content: string } }>;
        usage?: { total_tokens: number };
      };

      const firstChoice = data.choices?.[0];
      if (!firstChoice) {
        throw new FetchError("OpenAI API error: LLM returned no choices in response");
      }

      return {
        text: firstChoice.message.content,
        tokensUsed: data.usage?.total_tokens,
      };
    },
  };
}

function createOllamaProvider(
  embedding: LibScopeConfig["embedding"],
  llmConfig: LlmConfig | undefined,
): LlmProvider {
  const baseUrl = llmConfig?.url ?? embedding.url ?? DEFAULT_OLLAMA_URL;
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
          throw new FetchError(`Ollama LLM request timed out after ${timeoutMs}ms`);
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
        throw new FetchError(`Ollama API error: ${message}`);
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

function createAnthropicProvider(
  apiKey: string | undefined,
  llmConfig: LlmConfig | undefined,
): LlmProvider {
  if (!apiKey) {
    throw new ConfigError(
      "Anthropic API key is required. Set LIBSCOPE_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY, " +
        'or run "libscope config set anthropic.apiKey <key>".',
    );
  }

  const model = llmConfig?.model ?? "claude-3-5-haiku-20241022";

  return {
    model,
    async complete(
      prompt: string,
      systemPrompt?: string,
    ): Promise<{ text: string; tokensUsed?: number | undefined }> {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey });

      const message = await client.messages.create({
        model,
        max_tokens: 4096,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages: [{ role: "user", content: prompt }],
      });

      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => ("text" in block ? block.text : ""))
        .join("");

      const tokensUsed = message.usage.input_tokens + message.usage.output_tokens;

      return { text, tokensUsed };
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
  const results = await retrieveResults(db, embeddingProvider, options);

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
  const results = await retrieveResults(db, embeddingProvider, options);

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

/** How `answer` should produce its result. */
export interface AnswerMode {
  /** Return the retrieved context instead of calling an LLM (the caller is the LLM). */
  passthrough: boolean;
  /** LLM used when not in passthrough mode; null when none is configured. */
  llm: LlmProvider | null;
}

/** An LLM answer, or (passthrough) the context prompt for the caller to answer from. */
export type AnswerResult =
  | ({ mode: "answer" } & RagResult)
  | ({ mode: "context" } & PassthroughResult);

/**
 * Answer a question from the knowledge base. Every surface uses this one function:
 * passthrough mode returns the context prompt and sources; otherwise the LLM writes the answer.
 * @throws ConfigError when not in passthrough mode and no LLM is configured.
 */
export async function answer(
  db: Database.Database,
  embeddingProvider: EmbeddingProvider,
  mode: AnswerMode,
  options: RagOptions,
): Promise<AnswerResult> {
  if (mode.passthrough) {
    return { mode: "context", ...(await getContextForQuestion(db, embeddingProvider, options)) };
  }
  if (!mode.llm) throw new ConfigError(NO_LLM_HINT);
  return { mode: "answer", ...(await askQuestion(db, embeddingProvider, mode.llm, options)) };
}
