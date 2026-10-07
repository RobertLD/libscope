import { extname } from "node:path";
import type Database from "better-sqlite3";
import { ValidationError } from "../errors.js";
import { LibScope } from "../LibScope.js";
import type { ConfigOverrides } from "../core/bootstrap.js";
import type { Chunker } from "../core/indexing.js";
import type { LlmProvider } from "../core/rag.js";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { TreeSitterChunker } from "./chunker-treesitter.js";

export interface LiteOptions {
  /** SQLite database file (":memory:" for an in-memory database). */
  dbPath?: string | undefined;
  /** Use an already-open database instead of `dbPath`. `close()` leaves it open. */
  db?: Database.Database | undefined;
  /** Embedding provider. Default: the local provider (Xenova/all-MiniLM-L6-v2). */
  provider?: EmbeddingProvider | undefined;
  /** LLM for ask/askStream. Without one, ask throws a ConfigError. */
  llmProvider?: LlmProvider | undefined;
  /** Custom chunker, e.g. createCodeChunker(). */
  chunker?: Chunker | undefined;
  /** Config values over the defaults (config files and environment are not read). */
  config?: ConfigOverrides | undefined;
}

/**
 * LibScope for embedding in an application: the same object and results as
 * `LibScope.create`, but config files and LIBSCOPE_* variables are ignored and the database
 * is the one you name.
 */
export function createLite(options: LiteOptions): LibScope {
  if (options.dbPath === undefined && options.db === undefined) {
    throw new ValidationError("createLite needs dbPath or db");
  }
  return LibScope.create({ ...options, useConfigFile: false });
}

function languageOf(name: string): string | undefined {
  const ext = extname(name).slice(1).toLowerCase();
  return ext === "" ? undefined : ext;
}

/**
 * A Chunker that splits source code at function and class boundaries with tree-sitter (an
 * optional peer dependency). The language is `language` if given, else the extension of the
 * file path, URL or title. Other documents, and code when tree-sitter is not installed, use
 * the built-in chunker.
 */
export function createCodeChunker(options: { language?: string | undefined } = {}): Chunker {
  const chunker = new TreeSitterChunker();
  return async ({ content, title, source }) => {
    const language = options.language ?? languageOf(source) ?? languageOf(title);
    if (language === undefined || !chunker.supports(language)) return undefined;
    try {
      const chunks = await chunker.chunk(content, language);
      return chunks.map((c) => c.content);
    } catch {
      // tree-sitter not installed or the parse failed: use the built-in chunker
      return undefined;
    }
  };
}
