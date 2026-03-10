import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DocumentNotFoundError, ValidationError } from "../errors.js";
import { validateRow, validateRows } from "../db/validate.js";
import { createChildLogger } from "../logger.js";
import type { Document } from "./documents.js";

const TagRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
});

const TagWithCountRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
  document_count: z.number(),
});

const DocTagRowSchema = z.object({
  document_id: z.string(),
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
});

const DocumentRowSchema = z.object({
  id: z.string(),
  source_type: z.string(),
  library: z.string().nullable(),
  version: z.string().nullable(),
  topic_id: z.string().nullable(),
  title: z.string(),
  content: z.string(),
  url: z.string().nullable(),
  content_hash: z.string().nullable(),
  submitted_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const NameRowSchema = z.object({ name: z.string() });

const TitleContentRowSchema = z.object({
  title: z.string(),
  content: z.string(),
});

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "must",
  "can",
  "could",
  "that",
  "this",
  "with",
  "from",
  "for",
  "not",
  "but",
  "and",
  "or",
  "nor",
  "so",
  "yet",
  "both",
  "either",
  "neither",
  "each",
  "every",
  "all",
  "any",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "than",
  "too",
  "very",
  "just",
  "about",
  "above",
  "after",
  "again",
  "against",
  "below",
  "between",
  "during",
  "into",
  "through",
  "under",
  "until",
  "also",
  "how",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "whom",
  "why",
  "its",
  "our",
  "their",
  "your",
  "his",
  "her",
  "our",
  "out",
  "then",
  "there",
  "these",
  "those",
  "them",
  "they",
  "you",
  "your",
  "only",
  "own",
  "same",
  "here",
  "over",
  "once",
  "use",
  "used",
]);

export interface Tag {
  id: string;
  name: string;
  createdAt: string;
}

export interface TagWithCount extends Tag {
  documentCount: number;
}

/** Create a tag or return the existing one if the name already exists. */
export function createTag(db: Database.Database, name: string): Tag {
  const log = createChildLogger({ operation: "createTag" });
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) {
    throw new ValidationError("Tag name is required");
  }

  const id = randomUUID();
  const result = db
    .prepare(
      `INSERT INTO tags (id, name) VALUES (?, ?)
       ON CONFLICT(name) DO NOTHING`,
    )
    .run(id, trimmed);

  if (result.changes > 0) {
    log.info({ tagId: id, name: trimmed }, "Tag created");
    return { id, name: trimmed, createdAt: new Date().toISOString() };
  }

  const existing = validateRow(
    TagRowSchema,
    db.prepare("SELECT id, name, created_at FROM tags WHERE name = ?").get(trimmed),
    "createTag.existing",
  );

  log.info({ name: trimmed }, "Tag already exists, returning existing");
  return { id: existing.id, name: existing.name, createdAt: existing.created_at };
}

/** Delete a tag and all its document associations. */
export function deleteTag(db: Database.Database, tagId: string): void {
  const log = createChildLogger({ operation: "deleteTag" });
  db.prepare("DELETE FROM tags WHERE id = ?").run(tagId);
  log.info({ tagId }, "Tag deleted");
}

/** List all tags with their document counts. */
export function listTags(db: Database.Database): TagWithCount[] {
  const rows = validateRows(
    TagWithCountRowSchema,
    db
      .prepare(
        `SELECT t.id, t.name, t.created_at, COUNT(dt.document_id) AS document_count
       FROM tags t
       LEFT JOIN document_tags dt ON dt.tag_id = t.id
       GROUP BY t.id
       ORDER BY t.name`,
      )
      .all(),
    "listTags",
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    documentCount: row.document_count,
  }));
}

/** Add multiple tags to a document, creating tags if they don't exist. */
export function addTagsToDocument(
  db: Database.Database,
  documentId: string,
  tagNames: string[],
): Tag[] {
  const log = createChildLogger({ operation: "addTagsToDocument" });

  const run = db.transaction(() => {
    const tags: Tag[] = [];
    for (const name of tagNames) {
      const tag = createTag(db, name);
      db.prepare(
        `INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)
         ON CONFLICT DO NOTHING`,
      ).run(documentId, tag.id);
      tags.push(tag);
    }
    return tags;
  });

  const tags = run();
  log.info({ documentId, tagCount: tags.length }, "Tags added to document");
  return tags;
}

/** Remove a specific tag from a document. */
export function removeTagFromDocument(
  db: Database.Database,
  documentId: string,
  tagId: string,
): void {
  const log = createChildLogger({ operation: "removeTagFromDocument" });
  db.prepare("DELETE FROM document_tags WHERE document_id = ? AND tag_id = ?").run(
    documentId,
    tagId,
  );
  log.info({ documentId, tagId }, "Tag removed from document");
}

/** Get all tags for multiple documents in a single query. Returns a Map of documentId → tags. */
export function getDocumentTagsBatch(
  db: Database.Database,
  documentIds: string[],
): Map<string, Tag[]> {
  if (documentIds.length === 0) return new Map();
  const placeholders = documentIds.map(() => "?").join(", ");
  const rows = validateRows(
    DocTagRowSchema,
    db
      .prepare(
        `SELECT dt.document_id, t.id, t.name, t.created_at
       FROM tags t
       JOIN document_tags dt ON dt.tag_id = t.id
       WHERE dt.document_id IN (${placeholders})
       ORDER BY t.name`,
      )
      .all(...documentIds),
    "getDocumentTagsBatch",
  );

  const result = new Map<string, Tag[]>();
  for (const row of rows) {
    const entry = result.get(row.document_id) ?? [];
    entry.push({ id: row.id, name: row.name, createdAt: row.created_at });
    result.set(row.document_id, entry);
  }
  return result;
}

/** Get all tags for a specific document. */
export function getDocumentTags(db: Database.Database, documentId: string): Tag[] {
  const rows = validateRows(
    TagRowSchema,
    db
      .prepare(
        `SELECT t.id, t.name, t.created_at
       FROM tags t
       JOIN document_tags dt ON dt.tag_id = t.id
       WHERE dt.document_id = ?
       ORDER BY t.name`,
      )
      .all(documentId),
    "getDocumentTags",
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
  }));
}

export interface GetDocumentsByTagOptions {
  limit?: number;
  offset?: number;
}

/** Get documents matching ALL specified tags (AND logic). */
export function getDocumentsByTag(
  db: Database.Database,
  tagNames: string[],
  options?: GetDocumentsByTagOptions,
): Document[] {
  const log = createChildLogger({ operation: "getDocumentsByTag" });
  if (tagNames.length === 0) return [];

  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const normalized = tagNames.map((t) => t.trim().toLowerCase());

  const placeholders = normalized.map(() => "?").join(", ");
  const sql = `
    SELECT d.id, d.source_type, d.library, d.version, d.topic_id,
           d.title, d.content, d.url, d.content_hash, d.submitted_by,
           d.created_at, d.updated_at
    FROM documents d
    JOIN document_tags dt ON dt.document_id = d.id
    JOIN tags t ON t.id = dt.tag_id
    WHERE t.name IN (${placeholders})
    GROUP BY d.id
    HAVING COUNT(DISTINCT t.name) = ?
    ORDER BY d.created_at DESC
    LIMIT ? OFFSET ?
  `;

  const params = [...normalized, normalized.length, limit, offset];
  const rows = validateRows(DocumentRowSchema, db.prepare(sql).all(...params), "getDocumentsByTag");

  log.info({ tagNames: normalized, resultCount: rows.length }, "Documents retrieved by tags");

  return rows.map((row) => ({
    id: row.id,
    sourceType: row.source_type,
    library: row.library,
    version: row.version,
    topicId: row.topic_id,
    title: row.title,
    content: row.content,
    url: row.url,
    contentHash: row.content_hash,
    submittedBy: row.submitted_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/** Tokenize text into lowercase words, filtering stopwords and short words. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/** Suggest tags from raw text without requiring a database (for pack creation). */
export function suggestTagsFromText(
  title: string,
  content: string,
  maxSuggestions?: number,
): string[] {
  const limit = maxSuggestions ?? 5;
  const fullText = `${title} ${content}`;
  const tokens = tokenize(fullText);
  if (tokens.length === 0) return [];

  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }

  const maxTf = Math.max(...tf.values());
  const scored: Array<{ term: string; score: number }> = [];

  for (const [term, count] of tf) {
    scored.push({ term, score: count / maxTf });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.term);
}
export function suggestTags(
  db: Database.Database,
  documentId: string,
  maxSuggestions?: number,
): string[] {
  const log = createChildLogger({ operation: "suggestTags" });
  const limit = maxSuggestions ?? 5;

  const raw = db.prepare("SELECT title, content FROM documents WHERE id = ?").get(documentId);

  if (!raw) {
    throw new DocumentNotFoundError(documentId);
  }
  const row = validateRow(TitleContentRowSchema, raw, "suggestTags.document");

  const fullText = `${row.title} ${row.content}`;
  const tokens = tokenize(fullText);
  if (tokens.length === 0) {
    return [];
  }

  // Calculate term frequency
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }

  // Get existing tags already on this document (to exclude them)
  const existingTags = new Set(
    validateRows(
      NameRowSchema,
      db
        .prepare(
          `SELECT t.name FROM tags t
           JOIN document_tags dt ON dt.tag_id = t.id
           WHERE dt.document_id = ?`,
        )
        .all(documentId),
      "suggestTags.existingTags",
    ).map((r) => r.name),
  );

  // Get all known tags in the system for boosting
  const knownTags = new Set(
    validateRows(
      NameRowSchema,
      db.prepare("SELECT name FROM tags").all(),
      "suggestTags.knownTags",
    ).map((r) => r.name),
  );

  // Score each term: TF normalized + boost for known tags
  const maxTf = Math.max(...tf.values());
  const scored: Array<{ term: string; score: number }> = [];

  for (const [term, count] of tf) {
    if (existingTags.has(term)) continue;
    const normalizedTf = count / maxTf;
    const knownBoost = knownTags.has(term) ? 2.0 : 1.0;
    scored.push({ term, score: normalizedTf * knownBoost });
  }

  scored.sort((a, b) => b.score - a.score);

  const suggestions = scored.slice(0, limit).map((s) => s.term);
  log.info({ documentId, suggestionCount: suggestions.length }, "Tags suggested");
  return suggestions;
}
