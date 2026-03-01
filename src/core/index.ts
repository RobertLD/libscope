export { indexDocument, chunkContent } from "./indexing.js";
export type { IndexDocumentInput, IndexedDocument } from "./indexing.js";

export { searchDocuments } from "./search.js";
export type { SearchOptions, SearchResult, SearchMethod, ScoreExplanation } from "./search.js";

export { rateDocument, getDocumentRatings, listRatings } from "./ratings.js";
export type { RateDocumentInput, Rating, RatingSummary } from "./ratings.js";

export { getDocument, deleteDocument, listDocuments } from "./documents.js";
export type { Document } from "./documents.js";

export {
  createTopic,
  listTopics,
  getTopic,
  deleteTopic,
  renameTopic,
  getDocumentsByTopic,
  getTopicStats,
} from "./topics.js";
export type { Topic, CreateTopicInput, GetDocumentsByTopicOptions, TopicStats } from "./topics.js";

export { fetchAndConvert, DEFAULT_FETCH_OPTIONS } from "./url-fetcher.js";
export type { FetchedDocument, FetchOptions } from "./url-fetcher.js";

export { exportKnowledgeBase, importFromBackup } from "./export.js";

export { batchImport } from "./batch.js";
export type {
  BatchImportOptions,
  BatchImportResult,
  BatchProgress,
  BatchFileResult,
} from "./batch.js";

export { registerProvider, createEmbeddingProvider } from "../providers/index.js";
export type { EmbeddingProvider } from "../providers/embedding.js";
export type { ProviderFactory } from "../providers/index.js";
