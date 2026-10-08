/**
 * Package root (`import ... from "libscope"`): the LibScope class, its option and result
 * types, and the error classes. Everything else is reached through LibScope methods.
 * tests/unit/root-exports.test.ts lists the runtime exports so additions are deliberate.
 */
export { LibScope } from "../LibScope.js";
export type {
  LibScopeOptions,
  RunOptions,
  NamespaceName,
  LibScopeNamespace,
  LibScopeInput,
  LibScopeOutput,
  OperationInput,
  OperationOutput,
  AddInput,
  AddResult,
  SearchInput,
  SearchOutput,
  AskInput,
  AskOutput,
} from "../LibScope.js";

export {
  LibScopeError,
  DatabaseError,
  EmbeddingError,
  ValidationError,
  FetchError,
  ConfigError,
  NotFoundError,
  DocumentNotFoundError,
  ChunkNotFoundError,
  TopicNotFoundError,
} from "../errors.js";

// Providers and hooks callers can pass to LibScope.create.
export type { EmbeddingProvider } from "../providers/embedding.js";
export type { LlmProvider } from "./rag.js";
export type { Chunker } from "./indexing.js";
export type { ConfigOverrides } from "./bootstrap.js";
export type { LibScopeConfig } from "../config.js";

// Result element types.
export type { ListResult, ProgressEvent } from "./operations/types.js";
export type { DocumentSummary } from "./operations/documents.js";
export type { SearchResult, ContextChunk, ScoreExplanation } from "./search.js";
export type {
  AnswerResult,
  PassthroughResult,
  RagResult,
  RagSource,
  RagStreamEvent,
} from "./rag.js";
export type { IngestResult, IngestedDocument, IngestKind } from "./ingest.js";
export type { DocumentView } from "./document-view.js";
export type { Overview } from "./overview.js";
export type { Task, TaskStatus } from "./tasks.js";
