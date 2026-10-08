import { describe, it, expect } from "vitest";
import {
  LibScopeError,
  DatabaseError,
  EmbeddingError,
  FetchError,
  ValidationError,
  ConfigError,
  DocumentNotFoundError,
  ChunkNotFoundError,
  TopicNotFoundError,
  NotFoundError,
} from "../../src/errors.js";

describe("NotFoundError", () => {
  it("is the base class of every not-found error and keeps each code", () => {
    const cases: Array<[NotFoundError, string]> = [
      [new DocumentNotFoundError("d"), "DOCUMENT_NOT_FOUND"],
      [new ChunkNotFoundError("c"), "CHUNK_NOT_FOUND"],
      [new TopicNotFoundError("t"), "TOPIC_NOT_FOUND"],
      [new NotFoundError("Link not found: l", "LINK_NOT_FOUND"), "LINK_NOT_FOUND"],
      [new NotFoundError("gone"), "NOT_FOUND"],
    ];
    for (const [err, code] of cases) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect(err).toBeInstanceOf(LibScopeError);
      expect(err.code).toBe(code);
    }
  });
});

describe("errors", () => {
  it("should create LibScopeError with code", () => {
    const err = new LibScopeError("test", "TEST_ERROR");
    expect(err.message).toBe("test");
    expect(err.code).toBe("TEST_ERROR");
    expect(err.name).toBe("LibScopeError");
    expect(err).toBeInstanceOf(Error);
  });

  it("should create DatabaseError", () => {
    const cause = new Error("sqlite error");
    const err = new DatabaseError("DB failed", cause);
    expect(err.code).toBe("DATABASE_ERROR");
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(LibScopeError);
  });

  it("should create EmbeddingError", () => {
    const err = new EmbeddingError("embed failed");
    expect(err.code).toBe("EMBEDDING_ERROR");
    expect(err).toBeInstanceOf(LibScopeError);
  });

  it("should create FetchError", () => {
    const cause = new Error("network error");
    const err = new FetchError("fetch failed", cause);
    expect(err.code).toBe("FETCH_ERROR");
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(LibScopeError);
  });

  it("should create ValidationError", () => {
    const err = new ValidationError("invalid input");
    expect(err.code).toBe("VALIDATION_ERROR");
  });

  it("should create ConfigError", () => {
    const err = new ConfigError("bad config");
    expect(err.code).toBe("CONFIG_ERROR");
  });

  it("should create DocumentNotFoundError with ID", () => {
    const err = new DocumentNotFoundError("abc-123");
    expect(err.message).toContain("abc-123");
    expect(err.code).toBe("DOCUMENT_NOT_FOUND");
  });

  it("should create ChunkNotFoundError with ID", () => {
    const err = new ChunkNotFoundError("chunk-456");
    expect(err.message).toContain("chunk-456");
    expect(err.code).toBe("CHUNK_NOT_FOUND");
  });

  it("should be catchable as LibScopeError", () => {
    const errors = [
      new DatabaseError("db"),
      new EmbeddingError("embed"),
      new FetchError("fetch"),
      new ValidationError("valid"),
      new ConfigError("config"),
      new DocumentNotFoundError("doc"),
      new ChunkNotFoundError("chunk"),
    ];

    for (const err of errors) {
      expect(err).toBeInstanceOf(LibScopeError);
    }
  });
});
