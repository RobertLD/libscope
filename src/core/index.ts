export { indexDocument, chunkContent } from "./indexing.js";
export type { IndexDocumentInput, IndexedDocument } from "./indexing.js";

export { searchDocuments } from "./search.js";
export type { SearchOptions, SearchResult } from "./search.js";

export { rateDocument, getDocumentRatings, listRatings } from "./ratings.js";
export type { RateDocumentInput, Rating, RatingSummary } from "./ratings.js";

export { getDocument, deleteDocument, listDocuments } from "./documents.js";
export type { Document } from "./documents.js";

export { createTopic, listTopics, getTopic } from "./topics.js";
export type { Topic, CreateTopicInput } from "./topics.js";

export { fetchAndConvert } from "./url-fetcher.js";
export type { FetchedDocument } from "./url-fetcher.js";
