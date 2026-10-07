import type Database from "better-sqlite3";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Readable } from "node:stream";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { EmbeddingError, ValidationError } from "../errors.js";
import { REBUILD_VECTOR_INDEX_HINT, isVectorDimensionError } from "../db/index-meta.js";
import { getLogger } from "../logger.js";
import { checkDuplicate } from "./dedup.js";
import type { DedupOptions } from "./dedup.js";
import { deleteChunkEmbeddings } from "./documents.js";
import { extractAndStoreDocumentLinks } from "./links.js";
import { getParserForFile, getSupportedExtensions } from "./parsers/index.js";

export interface IndexDocumentInput {
  title: string;
  content: string;
  sourceType: "library" | "topic" | "manual" | "model-generated";
  library?: string | undefined;
  version?: string | undefined;
  topicId?: string | undefined;
  url?: string | undefined;
  submittedBy?: "manual" | "model" | "crawler" | undefined;
  /** Dedup behaviour: 'skip' returns existing doc, 'warn' logs but indexes, 'force' bypasses check. */
  dedup?: "skip" | "warn" | "force" | undefined;
  /** Options for duplicate detection (threshold, strategy). */
  dedupOptions?: DedupOptions | undefined;
  /** ISO 8601 expiry timestamp. Document will be pruned by pruneExpiredDocuments() after this time. */
  expiresAt?: string | undefined;
  /** If set, skip chunkContent() and use these directly as document chunks. */
  preChunked?: string[] | undefined;
}

export interface IndexedDocument {
  id: string;
  chunkCount: number;
}

export interface ChunkOptions {
  /** Maximum characters per chunk (default 1500). */
  maxChunkSize?: number;
  /** Fraction of the chunk to overlap with the next (0–0.5, default 0.1). */
  overlapFraction?: number;
}

/** Parse chunk options from the input parameter. */
function resolveChunkOptions(input: number | ChunkOptions): {
  maxChunkSize: number;
  overlapFraction: number;
} {
  const opts: ChunkOptions = typeof input === "number" ? { maxChunkSize: input } : input;
  return {
    maxChunkSize: opts.maxChunkSize ?? 1500,
    overlapFraction: Math.max(0, Math.min(opts.overlapFraction ?? 0.1, 0.5)),
  };
}

/** Update heading stack and return a breadcrumb-prefixed start for a new chunk. */
function startChunkAtHeading(
  headingMatch: RegExpExecArray,
  headingStack: Array<{ level: number; text: string }>,
  line: string,
): { lines: string[]; length: number } {
  const level = (headingMatch[1] ?? "").length;
  while (headingStack.length > 0 && (headingStack.at(-1)?.level ?? 0) >= level) {
    headingStack.pop();
  }
  const breadcrumb = headingStack.map((h) => h.text).join(" > ");
  headingStack.push({ level, text: (headingMatch[2] ?? "").trim() });

  if (breadcrumb) {
    const ctx = `Context: ${breadcrumb}`;
    return { lines: [ctx, line], length: ctx.length + 1 + line.length };
  }
  return { lines: [line], length: line.length };
}

/**
 * Split content into chunks by markdown headings with paragraph-aware
 * splitting for oversized sections and configurable inter-chunk overlap.
 * Breadcrumbs use plain text ("Context: …") instead of HTML comments
 * so the text is meaningful to embedding models.
 */
export function chunkContent(
  content: string,
  maxChunkSizeOrOpts: number | ChunkOptions = 1500,
): string[] {
  const { maxChunkSize, overlapFraction } = resolveChunkOptions(maxChunkSizeOrOpts);

  const lines = content.split("\n");
  const rawChunks: string[] = [];
  let currentChunk: string[] = [];
  let currentChunkLen = 0;
  const headingStack: Array<{ level: number; text: string }> = [];

  const flushChunk = (): void => {
    const text = currentChunk.join("\n").trim();
    if (text.length === 0) return;
    if (text.length <= maxChunkSize) {
      rawChunks.push(text);
    } else {
      splitAtParagraphs(text, maxChunkSize, rawChunks);
    }
    currentChunk = [];
    currentChunkLen = 0;
  };

  for (const line of lines) {
    const headingMatch = /^(#{1,3}) +(\S.*)$/.exec(line);

    if (headingMatch && currentChunk.length > 0) {
      flushChunk();
      const started = startChunkAtHeading(headingMatch, headingStack, line);
      currentChunk = started.lines;
      currentChunkLen = started.length;
    } else {
      if (headingMatch) {
        const level = (headingMatch[1] ?? "").length;
        headingStack.push({ level, text: (headingMatch[2] ?? "").trim() });
      }
      currentChunkLen += (currentChunk.length > 0 ? 1 : 0) + line.length;
      currentChunk.push(line);
    }

    if (currentChunkLen > maxChunkSize) {
      flushChunk();
    }
  }

  flushChunk();

  if (overlapFraction > 0 && rawChunks.length > 1) {
    return addChunkOverlap(rawChunks, overlapFraction);
  }

  return rawChunks;
}

/**
 * Split oversized text at paragraph boundaries (double-newline).
 * Falls back to hard character split when a paragraph exceeds maxSize.
 */
function splitAtParagraphs(text: string, maxSize: number, out: string[]): void {
  const emit = (buf: string): void => {
    const trimmed = buf.trim();
    if (trimmed.length === 0) return;
    if (trimmed.length <= maxSize) {
      out.push(trimmed);
    } else {
      for (let i = 0; i < trimmed.length; i += maxSize) {
        const slice = trimmed.slice(i, i + maxSize).trim();
        if (slice.length > 0) out.push(slice);
      }
    }
  };

  const paragraphs = text.split(/\n\n+/);
  let buffer = "";

  for (const para of paragraphs) {
    const candidate = buffer.length === 0 ? para : buffer + "\n\n" + para;
    if (candidate.length > maxSize && buffer.length > 0) {
      emit(buffer);
      buffer = para;
    } else {
      buffer = candidate;
    }
  }

  emit(buffer);
}

/**
 * Add overlap between consecutive chunks by appending trailing text from
 * the previous chunk to the beginning of the next chunk.
 */
function addChunkOverlap(chunks: string[], fraction: number): string[] {
  const result: string[] = [chunks[0]!];

  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1]!;
    const overlapChars = Math.floor(prev.length * fraction);

    if (overlapChars > 0) {
      // Take trailing portion of previous chunk, preferring line boundaries
      let overlapText = prev.slice(-overlapChars);
      const newlineIdx = overlapText.indexOf("\n");
      if (newlineIdx > 0) {
        overlapText = overlapText.slice(newlineIdx + 1);
      }
      overlapText = overlapText.trim();
      if (overlapText.length > 0) {
        result.push(overlapText + "\n\n" + chunks[i]!);
      } else {
        result.push(chunks[i]!);
      }
    } else {
      result.push(chunks[i]!);
    }
  }

  return result;
}

/** Size threshold above which streaming chunking is used (1MB). */
export const STREAMING_THRESHOLD = 1024 * 1024;

/** Find the best sentence/line boundary near the window end to avoid mid-sentence cuts. */
function findWindowBoundary(text: string, end: number): number {
  if (end >= text.length) return end;

  const sentenceEnd = text.indexOf(".", end);
  const newlineEnd = text.indexOf("\n", end);
  let boundary = -1;
  if (sentenceEnd !== -1 && sentenceEnd - end < 200) boundary = sentenceEnd + 1;
  if (newlineEnd !== -1 && newlineEnd - end < 200 && (boundary === -1 || newlineEnd < boundary)) {
    boundary = newlineEnd + 1;
  }
  return boundary !== -1 ? boundary : end;
}

/** Add chunks from a window to the output, deduplicating by content hash. */
function addDeduplicatedChunks(
  windowChunks: string[],
  allChunks: string[],
  seenHashes: Set<string>,
): void {
  for (const chunk of windowChunks) {
    const normalized = chunk.replaceAll(/\s+/g, " ").trim();
    const hash = createHash("sha256").update(normalized).digest("hex");
    if (!seenHashes.has(hash)) {
      seenHashes.add(hash);
      allChunks.push(chunk);
    }
  }
}

/**
 * Process content in fixed-size windows with overlap to avoid cutting sentences.
 * Suitable for large documents that shouldn't be loaded into chunkContent all at once.
 */
export function chunkContentStreaming(
  content: string | Readable,
  options: {
    maxChunkSize?: number;
    windowSize?: number;
    maxDocumentSize?: number;
  } = {},
): string[] {
  const maxChunkSize = options.maxChunkSize ?? 1500;
  const windowSize = options.windowSize ?? 64 * 1024;
  const maxDocumentSize = options.maxDocumentSize ?? 100 * 1024 * 1024;

  if (typeof content !== "string") {
    throw new ValidationError(
      "Readable stream must be converted to string before calling chunkContentStreaming",
    );
  }

  if (content.length > maxDocumentSize) {
    throw new ValidationError(
      `Document size (${content.length} bytes) exceeds maximum allowed size (${maxDocumentSize} bytes)`,
    );
  }

  const overlap = Math.min(Math.floor(windowSize * 0.1), 1024);
  const allChunks: string[] = [];
  const seenHashes = new Set<string>();
  let offset = 0;

  while (offset < content.length) {
    const end = Math.min(offset + windowSize, content.length);
    const windowEnd = findWindowBoundary(content, end);
    const window = content.slice(offset, windowEnd);
    const windowChunks = chunkContent(window, { maxChunkSize, overlapFraction: 0 });
    addDeduplicatedChunks(windowChunks, allChunks, seenHashes);

    offset = windowEnd - overlap;
    if (offset <= 0 || windowEnd >= content.length) {
      offset = windowEnd;
    }
  }

  return allChunks;
}

/** Run semantic/hash dedup check. Returns early result if duplicate should be skipped. */
async function runDedupCheck(
  db: Database.Database,
  provider: EmbeddingProvider,
  input: IndexDocumentInput,
): Promise<IndexedDocument | null> {
  const log = getLogger();
  if (!input.dedup || input.dedup === "force") return null;

  const dedupResult = await checkDuplicate(db, provider, input.content, input.dedupOptions);
  if (!dedupResult.isDuplicate) return null;

  if (input.dedup === "skip") {
    log.info(
      { existingDocId: dedupResult.existingDocId, matchType: dedupResult.matchType },
      "Duplicate detected, skipping",
    );
    return { id: dedupResult.existingDocId!, chunkCount: 0 };
  }
  if (input.dedup === "warn") {
    log.warn(
      {
        existingDocId: dedupResult.existingDocId,
        matchType: dedupResult.matchType,
        similarity: dedupResult.similarity,
      },
      "Duplicate detected, indexing anyway",
    );
  }
  return null;
}

/** Check for existing document by URL; delete stale version if content changed. Returns early result if unchanged. */
function handleUrlDedup(
  db: Database.Database,
  url: string,
  contentHash: string,
): IndexedDocument | null {
  const log = getLogger();
  const existing = db.prepare("SELECT id, content_hash FROM documents WHERE url = ?").get(url) as
    | { id: string; content_hash: string | null }
    | undefined;
  if (!existing) return null;

  if (existing.content_hash === contentHash) {
    log.info({ docId: existing.id, url }, "Document unchanged, skipping re-index");
    return { id: existing.id, chunkCount: 0 };
  }

  log.info({ docId: existing.id, url }, "Document updated, re-indexing");
  try {
    deleteChunkEmbeddings(db, [existing.id]);
  } catch (err: unknown) {
    log.debug({ err, docId: existing.id }, "Skipped chunk_embeddings cleanup during re-index");
  }
  db.prepare("DELETE FROM documents WHERE id = ?").run(existing.id);
  return null;
}

/** Check for duplicate by title + content length. Returns early result if skipping. */
function handleTitleLengthDedup(
  db: Database.Database,
  input: IndexDocumentInput,
): IndexedDocument | null {
  const log = getLogger();
  const existingByContent = db
    .prepare("SELECT id FROM documents WHERE title = ? AND LENGTH(content) = ?")
    .get(input.title, input.content.length) as { id: string } | undefined;

  if (!existingByContent) return null;

  if (input.dedup === "skip") {
    log.info(
      { existingDocId: existingByContent.id, title: input.title },
      "Duplicate by title+length detected, skipping",
    );
    return { id: existingByContent.id, chunkCount: 0 };
  }
  if (input.dedup === "warn") {
    log.warn(
      { existingDocId: existingByContent.id, title: input.title },
      "Duplicate by title+length detected, indexing anyway",
    );
    return null;
  }
  throw new ValidationError(
    `Document with same title and content length already exists (id: ${existingByContent.id}). Delete it first or modify the content.`,
  );
}

/** Document fields that are folded into every chunk's embedding text. */
export interface EmbeddingMeta {
  title?: string | null | undefined;
  library?: string | null | undefined;
  version?: string | null | undefined;
}

/** Build the metadata prefix for embedding enrichment. */
function buildMetaPrefix(meta: EmbeddingMeta): string {
  const parts: string[] = [];
  if (meta.title) parts.push(meta.title);
  if (meta.library) parts.push(`Library: ${meta.library}`);
  if (meta.version) parts.push(`Version: ${meta.version}`);
  return parts.length > 0 ? parts.join(" | ") + "\n\n" : "";
}

/**
 * The text that is embedded for a chunk: a title/library/version prefix plus the chunk.
 * Every write path (index, update, reindex, pack install) must embed this text so that
 * a chunk's vector does not depend on how its document was written.
 */
export function buildEmbeddingText(chunk: string, meta: EmbeddingMeta): string {
  return buildMetaPrefix(meta) + chunk;
}

/** True when two documents' metadata would produce different embedding text. */
export function embeddingMetaChanged(a: EmbeddingMeta, b: EmbeddingMeta): boolean {
  return buildMetaPrefix(a) !== buildMetaPrefix(b);
}

/** Split document content into chunks, using windowed chunking for very large documents. */
export function splitIntoChunks(content: string): string[] {
  return content.length > STREAMING_THRESHOLD
    ? chunkContentStreaming(content)
    : chunkContent(content);
}

/** Embed a document's chunks using {@link buildEmbeddingText}. */
export function embedChunks(
  provider: EmbeddingProvider,
  chunks: string[],
  meta: EmbeddingMeta,
): Promise<number[][]> {
  return provider.embedBatch(chunks.map((c) => buildEmbeddingText(c, meta)));
}

function isNoSuchTableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("no such table");
}

/** Writes chunk rows and vectors the same way for every write path. */
export interface ChunkWriter {
  /** Insert chunk rows for a document with their embeddings (matched by array index). */
  insertChunks(documentId: string, chunks: string[], embeddings: ReadonlyArray<number[]>): void;
  /** Replace the stored embedding of an existing chunk. */
  replaceEmbedding(chunkId: string, embedding: number[]): void;
}

/**
 * Create a {@link ChunkWriter}. Writes are synchronous; callers wrap them in a transaction.
 * When the vector table does not exist (sqlite-vec not loaded), vectors are skipped.
 */
export function createChunkWriter(db: Database.Database): ChunkWriter {
  const log = getLogger();
  const insertChunk = db.prepare(
    "INSERT INTO chunks (id, document_id, content, chunk_index) VALUES (?, ?, ?, ?)",
  );
  let insertVec: Database.Statement | undefined;
  let deleteVec: Database.Statement | undefined;

  const writeVector = (chunkId: string, embedding: number[], replace: boolean): void => {
    try {
      if (replace) {
        deleteVec ??= db.prepare("DELETE FROM chunk_embeddings WHERE chunk_id = ?");
        deleteVec.run(chunkId);
      }
      insertVec ??= db.prepare("INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)");
      insertVec.run(chunkId, Buffer.from(new Float32Array(embedding).buffer));
    } catch (err) {
      if (isVectorDimensionError(err)) {
        throw new EmbeddingError(
          `The embedding has ${embedding.length} dimensions, which does not match the vector index. ${REBUILD_VECTOR_INDEX_HINT}`,
          err,
        );
      }
      if (!isNoSuchTableError(err)) throw err;
      log.debug({ chunkId }, "Skipped vector insertion (sqlite-vec not loaded)");
    }
  };

  return {
    insertChunks(documentId, chunks, embeddings): void {
      for (let i = 0; i < chunks.length; i++) {
        const chunkId = randomUUID();
        insertChunk.run(chunkId, documentId, chunks[i] ?? "", i);
        writeVector(chunkId, embeddings[i] ?? [], false);
      }
    },
    replaceEmbedding(chunkId, embedding): void {
      writeVector(chunkId, embedding, true);
    },
  };
}

/** Index a document: validate, chunk, embed, and store. */
export async function indexDocument(
  db: Database.Database,
  provider: EmbeddingProvider,
  input: IndexDocumentInput,
): Promise<IndexedDocument> {
  const log = getLogger();

  if (!input.title.trim()) throw new ValidationError("Document title is required");
  if (!input.content.trim()) throw new ValidationError("Document content is required");

  const earlyDedup = await runDedupCheck(db, provider, input);
  if (earlyDedup) return earlyDedup;

  const contentHash = createHash("sha256").update(input.content).digest("hex");

  if (input.url) {
    const urlResult = handleUrlDedup(db, input.url, contentHash);
    if (urlResult) return urlResult;
  }

  const titleResult = handleTitleLengthDedup(db, input);
  if (titleResult) return titleResult;

  const docId = randomUUID();
  const chunks =
    input.preChunked && input.preChunked.length > 0
      ? input.preChunked
      : splitIntoChunks(input.content);

  log.info({ docId, title: input.title, chunkCount: chunks.length }, "Indexing document");

  const embeddings = await embedChunks(provider, chunks, input);

  const insertDoc = db.prepare(`
    INSERT INTO documents (id, source_type, library, version, topic_id, title, content, url, submitted_by, content_hash, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const writer = createChunkWriter(db);

  const transaction = db.transaction(() => {
    insertDoc.run(
      docId,
      input.sourceType,
      input.library ?? null,
      input.version ?? null,
      input.topicId ?? null,
      input.title,
      input.content,
      input.url ?? null,
      input.submittedBy ?? "manual",
      contentHash,
      input.expiresAt ?? null,
    );
    writer.insertChunks(docId, chunks, embeddings);
  });

  transaction();
  log.info({ docId, chunkCount: chunks.length }, "Document indexed successfully");

  storeDocumentLinks(db, docId, input.content);

  return { id: docId, chunkCount: chunks.length };
}

/** Extract markdown/wiki links from content and store them; failures are logged, not thrown. */
export function storeDocumentLinks(db: Database.Database, docId: string, content: string): void {
  try {
    extractAndStoreDocumentLinks(db, docId, content);
  } catch (err) {
    getLogger().warn({ err, docId }, "Failed to extract document links");
  }
}

export interface IndexFileOptions {
  topic?: string | undefined;
  library?: string | undefined;
  version?: string | undefined;
  title?: string | undefined;
  format?: string | undefined;
  dedup?: "skip" | "warn" | "force" | undefined;
  /** Overrides the source type derived from `library`/`topic`. */
  sourceType?: IndexDocumentInput["sourceType"] | undefined;
}

function fileSourceType(options: IndexFileOptions): IndexDocumentInput["sourceType"] {
  if (options.sourceType) return options.sourceType;
  if (options.library) return "library";
  return options.topic ? "topic" : "manual";
}

/**
 * Index a file: auto-detect format from extension, parse to text, then index.
 * Supports PDF, Word (.docx), CSV, YAML, JSON, and Markdown.
 */
export async function indexFile(
  db: Database.Database,
  provider: EmbeddingProvider,
  filePath: string,
  options: IndexFileOptions = {},
): Promise<IndexedDocument> {
  const log = getLogger();
  const rawFormat = options.format?.trim();
  const normalizedFormat =
    rawFormat && rawFormat.length > 0
      ? (rawFormat.startsWith(".") ? rawFormat : `.${rawFormat}`).toLowerCase()
      : undefined;
  const effectiveName = normalizedFormat ? `file${normalizedFormat}` : filePath;
  const parser = getParserForFile(effectiveName);

  if (!parser) {
    const supported = getSupportedExtensions().join(", ");
    throw new ValidationError(
      `Unsupported file format: "${filePath}". Supported extensions: ${supported}`,
    );
  }

  log.info({ filePath, parser: parser.extensions[0] }, "Parsing file for indexing");
  const buffer = readFileSync(filePath);
  const content = await parser.parse(buffer);

  const title = options.title ?? basename(filePath).replace(/\.[^.]+$/, "");

  return indexDocument(db, provider, {
    title,
    content,
    sourceType: fileSourceType(options),
    library: options.library,
    version: options.version,
    topicId: options.topic,
    dedup: options.dedup,
  });
}
