import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { ValidationError } from "../errors.js";
import { getLogger } from "../logger.js";

export interface IndexDocumentInput {
  title: string;
  content: string;
  sourceType: "library" | "topic" | "manual" | "model-generated";
  library?: string | undefined;
  version?: string | undefined;
  topicId?: string | undefined;
  url?: string | undefined;
  submittedBy?: "manual" | "model" | "crawler" | undefined;
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
  const headingStack: Array<{ level: number; text: string }> = [];

  for (const line of lines) {
    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(line);

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

      currentChunk = breadcrumb ? [`<!-- context: ${breadcrumb} -->`, line] : [line];
    } else {
      if (headingMatch) {
        // First heading in the document
        const level = (headingMatch[1] ?? "").length;
        headingStack.push({ level, text: (headingMatch[2] ?? "").trim() });
      }
      currentChunk.push(line);
    }

    // Also split if chunk gets too large
    const currentText = currentChunk.join("\n");
    if (currentText.length > maxChunkSize) {
      const text = currentText.trim();
      if (text.length > 0) {
        chunks.push(text);
      }
      currentChunk = [];
    }
  }

  // Don't forget the last chunk
  const remaining = currentChunk.join("\n").trim();
  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
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

  // Check for duplicate by URL
  if (input.url) {
    const existing = db.prepare("SELECT id FROM documents WHERE url = ?").get(input.url) as
      | { id: string }
      | undefined;
    if (existing) {
      throw new ValidationError(
        `Document with URL already exists (id: ${existing.id}). Delete it first or use a different URL.`,
      );
    }
  }

  // Check for duplicate by title + content length (lightweight content dedup)
  const contentLength = input.content.length;
  const existingByContent = db
    .prepare("SELECT id FROM documents WHERE title = ? AND LENGTH(content) = ?")
    .get(input.title, contentLength) as { id: string } | undefined;
  if (existingByContent) {
    throw new ValidationError(
      `Document with same title and content length already exists (id: ${existingByContent.id}). Delete it first or modify the content.`,
    );
  }

  const docId = randomUUID();
  const chunks = chunkContent(input.content);

  log.info({ docId, title: input.title, chunkCount: chunks.length }, "Indexing document");

  // Generate embeddings for all chunks
  const embeddings = await provider.embedBatch(chunks);

  // Store everything in a transaction
  const insertDoc = db.prepare(`
    INSERT INTO documents (id, source_type, library, version, topic_id, title, content, url, submitted_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertChunk = db.prepare(`
    INSERT INTO chunks (id, document_id, content, chunk_index)
    VALUES (?, ?, ?, ?)
  `);

  const insertEmbedding = db.prepare(`
    INSERT INTO chunk_embeddings (chunk_id, embedding)
    VALUES (?, ?)
  `);

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
    );

    for (let i = 0; i < chunks.length; i++) {
      const chunkId = randomUUID();
      const chunkContent = chunks[i] ?? "";
      const embedding = embeddings[i] ?? [];

      insertChunk.run(chunkId, docId, chunkContent, i);

      try {
        const vecBuffer = Buffer.from(new Float32Array(embedding).buffer);
        insertEmbedding.run(chunkId, vecBuffer);
      } catch (err) {
        log.debug({ chunkId, err }, "Skipped vector insertion (sqlite-vec may not be loaded)");
      }
    }
  });

  transaction();

  log.info({ docId, chunkCount: chunks.length }, "Document indexed successfully");
  return { id: docId, chunkCount: chunks.length };
}
