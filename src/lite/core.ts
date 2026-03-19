import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { LocalEmbeddingProvider } from "../providers/local.js";
import { createDatabase } from "../db/connection.js";
import { runMigrations, createVectorTable } from "../db/schema.js";
import { indexDocument } from "../core/indexing.js";
import { searchDocuments } from "../core/search.js";
import { rateDocument } from "../core/ratings.js";
import { askQuestion, getContextForQuestion, type LlmProvider } from "../core/rag.js";
import { normalizeRawInput } from "./normalize.js";
import type {
  LiteOptions,
  LiteDoc,
  RawInput,
  LiteSearchOptions,
  LiteSearchResult,
  LiteContextOptions,
  LiteAskOptions,
} from "./types.js";

export class LibScopeLite {
  private readonly db: Database.Database;
  private readonly provider: EmbeddingProvider;
  private readonly llmProvider: LlmProvider | null;

  constructor(opts: LiteOptions = {}) {
    this.provider = opts.provider ?? new LocalEmbeddingProvider();
    this.llmProvider = opts.llmProvider ?? null;

    if (opts.db === undefined) {
      const dbPath = opts.dbPath ?? join(homedir(), ".libscope", "lite.db");
      // createDatabase handles directory creation, WAL mode, pragmas, and sqlite-vec loading.
      this.db = createDatabase(dbPath);
      runMigrations(this.db);
      // Create vector table best-effort (requires sqlite-vec to be loaded).
      try {
        createVectorTable(this.db, this.provider.dimensions);
      } catch {
        /* sqlite-vec not loaded — FTS5 search still works */
      }
    } else {
      // Caller-provided DB: skip all setup (migrations, extension loading, vector table).
      this.db = opts.db;
    }
  }

  async index(docs: LiteDoc[]): Promise<void> {
    for (const doc of docs) {
      await indexDocument(this.db, this.provider, {
        title: doc.title,
        content: doc.content,
        sourceType: doc.sourceType ?? "manual",
        library: doc.library,
        version: doc.version,
        topicId: doc.topicId,
        url: doc.url,
      });
    }
  }

  async indexRaw(input: RawInput): Promise<string> {
    const normalized = await normalizeRawInput(input);
    if (normalized.chunks !== undefined && normalized.chunks.length > 1) {
      let firstId = "";
      for (let i = 0; i < normalized.chunks.length; i++) {
        const chunk = normalized.chunks[i]!;
        const result = await indexDocument(this.db, this.provider, {
          title: `${normalized.title} (part ${String(i + 1)})`,
          content: chunk,
          sourceType: "manual",
        });
        if (i === 0) firstId = result.id;
      }
      return firstId;
    }
    const result = await indexDocument(this.db, this.provider, {
      title: normalized.title,
      content: normalized.content,
      sourceType: "manual",
      url: input.type === "url" ? input.url : undefined,
    });
    return result.id;
  }

  async indexBatch(docs: LiteDoc[], opts: { concurrency: number }): Promise<void> {
    const concurrency = Math.max(1, opts.concurrency);
    let activeCount = 0;
    let idx = 0;

    await new Promise<void>((resolve) => {
      if (docs.length === 0) {
        resolve();
        return;
      }

      const runNext = (): void => {
        while (activeCount < concurrency && idx < docs.length) {
          const doc = docs[idx];
          if (!doc) break;
          idx++;
          activeCount++;
          void this.index([doc]).finally(() => {
            activeCount--;
            if (idx >= docs.length && activeCount === 0) {
              resolve();
            } else {
              runNext();
            }
          });
        }
      };

      runNext();
    });
  }

  async search(query: string, opts?: LiteSearchOptions): Promise<LiteSearchResult[]> {
    const { results } = await searchDocuments(this.db, this.provider, {
      query,
      limit: opts?.limit ?? 10,
      topic: opts?.topic,
      library: opts?.library,
      tags: opts?.tags,
      diversity: opts?.diversity,
    });
    return results.map((r) => ({
      docId: r.documentId,
      chunkId: r.chunkId,
      title: r.title,
      content: r.content,
      score: r.score,
      url: r.url,
    }));
  }

  async getContext(question: string, opts?: LiteContextOptions): Promise<string> {
    const { contextPrompt } = await getContextForQuestion(this.db, this.provider, {
      question,
      topK: opts?.topK ?? 5,
      topic: opts?.topic,
      library: opts?.library,
    });
    return contextPrompt;
  }

  async ask(question: string, opts?: LiteAskOptions): Promise<string> {
    const llm = opts?.llmProvider ?? this.llmProvider;
    if (!llm) {
      throw new Error("No LlmProvider configured. Pass llmProvider to constructor or ask() opts.");
    }
    const result = await askQuestion(this.db, this.provider, llm, {
      question,
      topK: opts?.topK ?? 5,
      topic: opts?.topic,
      library: opts?.library,
      systemPrompt: opts?.systemPrompt,
    });
    return result.answer;
  }

  async *askStream(question: string, opts?: LiteAskOptions): AsyncGenerator<string> {
    const llm = opts?.llmProvider ?? this.llmProvider;
    if (!llm) {
      throw new Error("No LlmProvider configured.");
    }
    if (!llm.completeStream) {
      throw new Error("This LlmProvider does not support streaming.");
    }
    const context = await this.getContext(question, opts);
    yield* llm.completeStream(context, opts?.systemPrompt);
  }

  rate(docId: string, score: number): void {
    rateDocument(this.db, { documentId: docId, rating: score });
  }

  close(): void {
    this.db.close();
  }
}
