import type Database from "better-sqlite3";
import type { LibScopeConfig } from "./config.js";
import type { EmbeddingProvider } from "./providers/embedding.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/connection.js";
import { runMigrations, createVectorTable } from "./db/schema.js";
import { createEmbeddingProvider } from "./providers/index.js";
import { createLlmProvider } from "./core/rag.js";
import { getWorkspacePath, DEFAULT_WORKSPACE } from "./core/workspace.js";
import {
  indexDocument,
  indexFile,
  type IndexDocumentInput,
  type IndexFileOptions,
  type IndexedDocument,
} from "./core/indexing.js";
import { searchDocuments, type SearchOptions, type SearchResponse } from "./core/search.js";
import {
  askQuestion,
  askQuestionStream,
  type RagOptions,
  type RagResult,
  type RagStreamEvent,
} from "./core/rag.js";
import { getStats, type OverviewStats } from "./core/analytics.js";
import { listDocuments, getDocument, deleteDocument, type Document } from "./core/documents.js";
import {
  searchBatch,
  type BatchSearchRequest,
  type BatchSearchResponse,
} from "./core/batch-search.js";

export interface LibScopeOptions {
  /** Workspace name (default: "default"). */
  workspace?: string;
  /** Override config values. */
  config?: Partial<LibScopeConfig>;
}

export class LibScope {
  private readonly db: Database.Database;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly config: LibScopeConfig;

  private constructor(
    db: Database.Database,
    embeddingProvider: EmbeddingProvider,
    config: LibScopeConfig,
  ) {
    this.db = db;
    this.embeddingProvider = embeddingProvider;
    this.config = config;
  }

  /**
   * Create a new LibScope instance. Initializes DB, runs migrations, and sets up providers.
   */
  static create(options?: LibScopeOptions): LibScope {
    const baseConfig = loadConfig();
    const config: LibScopeConfig = {
      embedding: { ...baseConfig.embedding, ...options?.config?.embedding },
      llm: { ...baseConfig.llm, ...options?.config?.llm },
      database: { ...baseConfig.database, ...options?.config?.database },
      indexing: { ...baseConfig.indexing, ...options?.config?.indexing },
      logging: { ...baseConfig.logging, ...options?.config?.logging },
    };

    const workspace = options?.workspace ?? DEFAULT_WORKSPACE;
    const dbPath = config.database.path ?? getWorkspacePath(workspace);

    const db = createDatabase(dbPath);
    runMigrations(db);

    const embeddingProvider = createEmbeddingProvider(config);
    createVectorTable(db, embeddingProvider.dimensions);

    return new LibScope(db, embeddingProvider, config);
  }

  /** Index a document from content. */
  async index(input: IndexDocumentInput): Promise<IndexedDocument> {
    return indexDocument(this.db, this.embeddingProvider, input);
  }

  /** Index a file from disk. */
  async indexFile(filePath: string, options?: IndexFileOptions): Promise<IndexedDocument> {
    return indexFile(this.db, this.embeddingProvider, filePath, options);
  }

  /** Search documents. */
  async search(query: string, options?: Omit<SearchOptions, "query">): Promise<SearchResponse> {
    return searchDocuments(this.db, this.embeddingProvider, { ...options, query });
  }

  /** Run multiple searches concurrently. */
  async searchBatch(requests: BatchSearchRequest[]): Promise<BatchSearchResponse> {
    return searchBatch(this.db, this.embeddingProvider, requests);
  }

  /** Ask a question using RAG. */
  async ask(question: string, options?: Omit<RagOptions, "question">): Promise<RagResult> {
    const llm = createLlmProvider(this.config);
    return askQuestion(this.db, this.embeddingProvider, llm, { ...options, question });
  }

  /** Ask a question with streaming response. */
  async *askStream(
    question: string,
    options?: Omit<RagOptions, "question">,
  ): AsyncGenerator<RagStreamEvent> {
    const llm = createLlmProvider(this.config);
    yield* askQuestionStream(this.db, this.embeddingProvider, llm, { ...options, question });
  }

  /** Get overview stats. */
  stats(): OverviewStats {
    return getStats(this.db, this.config.database.path);
  }

  /** List documents. */
  list(options?: {
    library?: string;
    topicId?: string;
    sourceType?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  }): Document[] {
    return listDocuments(this.db, options);
  }

  /** Get a document by ID. */
  get(id: string): Document {
    return getDocument(this.db, id);
  }

  /** Delete a document by ID. */
  delete(id: string): void {
    deleteDocument(this.db, id);
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
