export { indexDocument, chunkContent } from "./indexing.js";
export type { IndexDocumentInput, IndexedDocument } from "./indexing.js";

export { checkDuplicate, findDuplicates } from "./dedup.js";
export type { DedupResult, DedupOptions, DuplicateGroup } from "./dedup.js";

export { searchDocuments } from "./search.js";
export type { SearchOptions, SearchResult, SearchMethod, ScoreExplanation } from "./search.js";

export {
  logSearch,
  getStats,
  getPopularDocuments,
  getStaleDocuments,
  getTopQueries,
  getSearchTrends,
} from "./analytics.js";
export type {
  SearchLogEntry,
  OverviewStats,
  PopularDocument,
  StaleDocument,
  TopQuery,
  SearchTrend,
} from "./analytics.js";

export { rateDocument, getDocumentRatings, listRatings } from "./ratings.js";
export type { RateDocumentInput, Rating, RatingSummary } from "./ratings.js";

export { getDocument, deleteDocument, listDocuments } from "./documents.js";
export type { Document } from "./documents.js";

export {
  saveVersion,
  getVersionHistory,
  getVersion,
  rollbackToVersion,
  pruneVersions,
  MAX_VERSIONS_DEFAULT,
} from "./versioning.js";
export type { DocumentVersion } from "./versioning.js";

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

export {
  createTag,
  deleteTag,
  listTags,
  addTagsToDocument,
  removeTagFromDocument,
  getDocumentTags,
  getDocumentsByTag,
} from "./tags.js";
export type { Tag, TagWithCount, GetDocumentsByTagOptions } from "./tags.js";

export { FileWatcher, DEFAULT_WATCH_EXTENSIONS } from "./watcher.js";
export type { WatchOptions } from "./watcher.js";

export { askQuestion, createLlmProvider, buildContextPrompt, extractSources } from "./rag.js";
export type { RagOptions, RagResult, RagSource, LlmProvider } from "./rag.js";

export { reindex } from "./reindex.js";
export type { ReindexOptions, ReindexResult, ReindexProgress } from "./reindex.js";

export {
  listAvailablePacks,
  installPack,
  removePack,
  listInstalledPacks,
  createPack,
} from "./packs.js";
export type {
  KnowledgePack,
  PackDocument,
  PackInfo,
  InstalledPack,
  InstallResult,
  CreatePackOptions,
} from "./packs.js";

export { indexRepository, parseRepoUrl } from "./repo.js";
export type { RepoOptions, RepoResult } from "./repo.js";

export { registerProvider, createEmbeddingProvider } from "../providers/index.js";
export type { EmbeddingProvider } from "../providers/embedding.js";
export type { ProviderFactory } from "../providers/index.js";

export {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  getWorkspacePath,
  getWorkspacesDir,
  getActiveWorkspace,
  setActiveWorkspace,
  DEFAULT_WORKSPACE,
} from "./workspace.js";
export type { Workspace } from "./workspace.js";

export { buildKnowledgeGraph, detectClusters } from "./graph.js";
export type { KnowledgeGraph, GraphNode, GraphEdge, GraphOptions } from "./graph.js";
