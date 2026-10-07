/**
 * LibScope custom error hierarchy.
 * All errors extend LibScopeError for consistent catching.
 */

export class LibScopeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LibScopeError";
  }
}

export class DatabaseError extends LibScopeError {
  constructor(message: string, cause?: unknown) {
    super(message, "DATABASE_ERROR", cause);
    this.name = "DatabaseError";
  }
}

export class EmbeddingError extends LibScopeError {
  constructor(message: string, cause?: unknown) {
    super(message, "EMBEDDING_ERROR", cause);
    this.name = "EmbeddingError";
  }
}

export class ValidationError extends LibScopeError {
  constructor(message: string, cause?: unknown) {
    super(message, "VALIDATION_ERROR", cause);
    this.name = "ValidationError";
  }
}

export class FetchError extends LibScopeError {
  constructor(message: string, cause?: unknown) {
    super(message, "FETCH_ERROR", cause);
    this.name = "FetchError";
  }
}

export class ConfigError extends LibScopeError {
  constructor(message: string, cause?: unknown) {
    super(message, "CONFIG_ERROR", cause);
    this.name = "ConfigError";
  }
}

/**
 * A requested resource does not exist. REST maps every NotFoundError to HTTP 404.
 * Subclasses keep their own `code`; other resources use this class directly with a specific code.
 */
export class NotFoundError extends LibScopeError {
  constructor(message: string, code: string = "NOT_FOUND", cause?: unknown) {
    super(message, code, cause);
    this.name = "NotFoundError";
  }
}

export class DocumentNotFoundError extends NotFoundError {
  constructor(documentId: string) {
    super(`Document not found: ${documentId}`, "DOCUMENT_NOT_FOUND");
    this.name = "DocumentNotFoundError";
  }
}

export class ChunkNotFoundError extends NotFoundError {
  constructor(chunkId: string) {
    super(`Chunk not found: ${chunkId}`, "CHUNK_NOT_FOUND");
    this.name = "ChunkNotFoundError";
  }
}

export class TopicNotFoundError extends NotFoundError {
  constructor(topicId: string) {
    super(`Topic not found: ${topicId}`, "TOPIC_NOT_FOUND");
    this.name = "TopicNotFoundError";
  }
}
