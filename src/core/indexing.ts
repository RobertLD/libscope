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

  for (const line of lines) {
    // Split on markdown headings (## or higher)
    if (/^#{1,3}\s/.test(line) && currentChunk.length > 0) {
      const text = currentChunk.join("\n").trim();
      if (text.length > 0) {
        chunks.push(text);
      }
      currentChunk = [line];
    } else {
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
      const chunkContent = chunks[i]!;
      const embedding = embeddings[i]!;

      insertChunk.run(chunkId, docId, chunkContent, i);

      try {
        const vecBuffer = Buffer.from(new Float32Array(embedding).buffer);
        insertEmbedding.run(chunkId, vecBuffer);
      } catch {
        // Vector table might not exist — skip silently
        log.debug({ chunkId }, "Skipped vector insertion (sqlite-vec may not be loaded)");
      }
    }
  });

  transaction();

  log.info({ docId, chunkCount: chunks.length }, "Document indexed successfully");
  return { id: docId, chunkCount: chunks.length };
}
