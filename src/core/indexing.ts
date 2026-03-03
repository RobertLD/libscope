import type Database from "better-sqlite3";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Readable } from "node:stream";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { ValidationError } from "../errors.js";
import { getLogger } from "../logger.js";
import { checkDuplicate } from "./dedup.js";
import type { DedupOptions } from "./dedup.js";
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
}

export interface IndexedDocument {
  id: string;
  chunkCount: number;
}

/**
 * Split content into chunks by markdown headings.
 * Falls back to paragraph-based splitting for non-markdown content.
 */
export function chunkContent(content: string, maxChunkSize: number = 1500): string[] {
  const lines = content.split("\n");
  const chunks: string[] = [];
  let currentChunk: string[] = [];
  let currentChunkLen = 0; // Running byte length to avoid O(n²) join-per-line
  const headingStack: Array<{ level: number; text: string }> = [];

  for (const line of lines) {
    const headingMatch = /^(#{1,3}) +(\S.*)$/.exec(line);

    // Split on markdown headings (## or higher)
    if (headingMatch && currentChunk.length > 0) {
      const text = currentChunk.join("\n").trim();
      if (text.length > 0) {
        chunks.push(text);
      }

      // Update heading stack
      const level = (headingMatch[1] ?? "").length;
      // Remove headings at same or deeper level
      while (
        headingStack.length > 0 &&
        (headingStack[headingStack.length - 1]?.level ?? 0) >= level
      ) {
        headingStack.pop();
      }

      // Build breadcrumb from parent headings
      const breadcrumb = headingStack.map((h) => h.text).join(" > ");
      headingStack.push({ level, text: (headingMatch[2] ?? "").trim() });

      if (breadcrumb) {
        const ctx = `<!-- context: ${breadcrumb} -->`;
        currentChunk = [ctx, line];
        currentChunkLen = ctx.length + 1 + line.length;
      } else {
        currentChunk = [line];
        currentChunkLen = line.length;
      }
    } else {
      if (headingMatch) {
        // First heading in the document
        const level = (headingMatch[1] ?? "").length;
        headingStack.push({ level, text: (headingMatch[2] ?? "").trim() });
      }
      currentChunkLen += (currentChunk.length > 0 ? 1 : 0) + line.length;
      currentChunk.push(line);
    }

    // Also split if chunk gets too large (use running counter instead of join)
    if (currentChunkLen > maxChunkSize) {
      const text = currentChunk.join("\n").trim();
      if (text.length > 0) {
        chunks.push(text);
      }
      currentChunk = [];
      currentChunkLen = 0;
    }
  }

  // Don't forget the last chunk
  const remaining = currentChunk.join("\n").trim();
  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/** Size threshold above which streaming chunking is used (1MB). */
export const STREAMING_THRESHOLD = 1024 * 1024;

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
  const windowSize = options.windowSize ?? 64 * 1024; // 64KB
  const maxDocumentSize = options.maxDocumentSize ?? 100 * 1024 * 1024; // 100MB

  if (typeof content !== "string") {
    throw new ValidationError(
      "Readable stream must be converted to string before calling chunkContentStreaming",
    );
  }

  const text = content;

  if (text.length > maxDocumentSize) {
    throw new ValidationError(
      `Document size (${text.length} bytes) exceeds maximum allowed size (${maxDocumentSize} bytes)`,
    );
  }

  const overlap = Math.min(Math.floor(windowSize * 0.1), 1024); // 10% overlap, max 1KB
  const allChunks: string[] = [];
  const seenHashes = new Set<string>();
  let offset = 0;

  while (offset < text.length) {
    const end = Math.min(offset + windowSize, text.length);
    let windowEnd = end;

    // If we're not at the end, extend to the next sentence boundary to avoid mid-sentence cuts
    if (end < text.length) {
      const sentenceEnd = text.indexOf(".", end);
      const newlineEnd = text.indexOf("\n", end);
      let boundary = -1;
      if (sentenceEnd !== -1 && sentenceEnd - end < 200) boundary = sentenceEnd + 1;
      if (newlineEnd !== -1 && newlineEnd - end < 200 && (boundary === -1 || newlineEnd < boundary))
        boundary = newlineEnd + 1;
      if (boundary !== -1) {
        windowEnd = boundary;
      }
    }

    const window = text.slice(offset, windowEnd);

    // Chunk this window using the existing logic
    const windowChunks = chunkContent(window, maxChunkSize);
    for (const chunk of windowChunks) {
      const normalized = chunk.replace(/\s+/g, " ").trim();
      const hash = createHash("sha256").update(normalized).digest("hex");
      if (!seenHashes.has(hash)) {
        seenHashes.add(hash);
        allChunks.push(chunk);
      }
    }

    // Advance past window, minus overlap
    offset = windowEnd - overlap;
    if (offset <= 0 || windowEnd >= text.length) {
      offset = windowEnd;
    }
  }

  return allChunks;
}

/** Index a document: validate, chunk, embed, and store. */
export async function indexDocument(
  db: Database.Database,
  provider: EmbeddingProvider,
  input: IndexDocumentInput,
): Promise<IndexedDocument> {
  const log = getLogger();

  if (!input.title.trim()) {
    throw new ValidationError("Document title is required");
  }
  if (!input.content.trim()) {
    throw new ValidationError("Document content is required");
  }

  // Dedup check (unless mode is 'force' or unset — backwards compatible)
  if (input.dedup && input.dedup !== "force") {
    const dedupResult = await checkDuplicate(db, provider, input.content, input.dedupOptions);
    if (dedupResult.isDuplicate) {
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
    }
  }

  // Compute content hash for versioning
  const contentHash = createHash("sha256").update(input.content).digest("hex");

  // Check for duplicate by URL with content hash comparison
  if (input.url) {
    const existing = db
      .prepare("SELECT id, content_hash FROM documents WHERE url = ?")
      .get(input.url) as { id: string; content_hash: string | null } | undefined;
    if (existing) {
      if (existing.content_hash === contentHash) {
        log.info({ docId: existing.id, url: input.url }, "Document unchanged, skipping re-index");
        return { id: existing.id, chunkCount: 0 };
      }
      // Document updated — delete old version and re-index
      log.info({ docId: existing.id, url: input.url }, "Document updated, re-indexing");
      try {
        db.prepare(
          "DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)",
        ).run(existing.id);
      } catch (err: unknown) {
        // chunk_embeddings table may not exist
        log.debug({ err, docId: existing.id }, "Skipped chunk_embeddings cleanup during re-index");
      }
      db.prepare("DELETE FROM documents WHERE id = ?").run(existing.id);
    }
  }

  // Check for duplicate by title + content length (lightweight content dedup)
  const contentLength = input.content.length;
  const existingByContent = db
    .prepare("SELECT id FROM documents WHERE title = ? AND LENGTH(content) = ?")
    .get(input.title, contentLength) as { id: string } | undefined;
  if (existingByContent) {
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
      // Continue indexing with a new ID
    } else {
      throw new ValidationError(
        `Document with same title and content length already exists (id: ${existingByContent.id}). Delete it first or modify the content.`,
      );
    }
  }

  const docId = randomUUID();
  const useStreaming = input.content.length > STREAMING_THRESHOLD;
  const chunks = useStreaming ? chunkContentStreaming(input.content) : chunkContent(input.content);

  log.info(
    { docId, title: input.title, chunkCount: chunks.length, streaming: useStreaming },
    "Indexing document",
  );

  // Generate embeddings for all chunks
  const embeddings = await provider.embedBatch(chunks);

  // Store everything in a transaction
  const insertDoc = db.prepare(`
    INSERT INTO documents (id, source_type, library, version, topic_id, title, content, url, submitted_by, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertChunk = db.prepare(`
    INSERT INTO chunks (id, document_id, content, chunk_index)
    VALUES (?, ?, ?, ?)
  `);

  const insertEmbedding = db.prepare(`
    INSERT INTO chunk_embeddings (chunk_id, embedding)
    VALUES (?, ?)
  `);

  // Store provider/model metadata if the table exists
  let insertMeta: Database.Statement<[string, string, string]> | null = null;
  try {
    const metaTableExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_embedding_metadata'",
      )
      .get();
    if (metaTableExists) {
      insertMeta = db.prepare(`
        INSERT OR REPLACE INTO chunk_embedding_metadata (chunk_id, embedding_provider, embedding_model)
        VALUES (?, ?, ?)
      `);
    }
  } catch (err: unknown) {
    // metadata table may not exist yet
    log.debug({ err }, "Skipped chunk_embedding_metadata check");
  }

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
    );

    for (let i = 0; i < chunks.length; i++) {
      const chunkId = randomUUID();
      const chunkContent = chunks[i] ?? "";
      const embedding = embeddings[i] ?? [];

      insertChunk.run(chunkId, docId, chunkContent, i);

      try {
        const vecBuffer = Buffer.from(new Float32Array(embedding).buffer);
        insertEmbedding.run(chunkId, vecBuffer);
        insertMeta?.run(chunkId, provider.name, "unknown");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("no such table")) {
          log.debug({ chunkId, err }, "Skipped vector insertion (sqlite-vec may not be loaded)");
        } else {
          log.warn({ chunkId, err }, "Failed to insert vector embedding");
        }
      }
    }
  });

  transaction();

  log.info({ docId, chunkCount: chunks.length }, "Document indexed successfully");
  return { id: docId, chunkCount: chunks.length };
}

export interface IndexFileOptions {
  topic?: string | undefined;
  library?: string | undefined;
  version?: string | undefined;
  title?: string | undefined;
  format?: string | undefined;
  dedup?: "skip" | "warn" | "force" | undefined;
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
    sourceType: options.library ? "library" : options.topic ? "topic" : "manual",
    library: options.library,
    version: options.version,
    topicId: options.topic,
    dedup: options.dedup,
  });
}
