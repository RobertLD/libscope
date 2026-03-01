import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { ValidationError, TopicNotFoundError } from "../errors.js";
import { createChildLogger } from "../logger.js";
import { validateRow } from "../utils/db-validation.js";
import type { Document } from "./documents.js";

export interface Topic {
  id: string;
  name: string;
  description: string | null;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTopicInput {
  name: string;
  description?: string | undefined;
  parentId?: string | undefined;
}

/** Create a new topic. */
export function createTopic(db: Database.Database, input: CreateTopicInput): Topic {
  const log = createChildLogger({ operation: "createTopic" });
  if (!input.name.trim()) {
    throw new ValidationError("Topic name is required");
  }

  // Generate slug from name
  const id =
    input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || randomUUID();

  // Verify parent exists if provided
  if (input.parentId) {
    const parent = db.prepare("SELECT id FROM topics WHERE id = ?").get(input.parentId) as
      | { id: string }
      | undefined;
    if (!parent) {
      throw new ValidationError(`Parent topic '${input.parentId}' not found`);
    }
  }

  // Atomic insert: ON CONFLICT avoids check-then-insert race condition
  const result = db
    .prepare(
      `
    INSERT INTO topics (id, name, description, parent_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO NOTHING
  `,
    )
    .run(id, input.name, input.description ?? null, input.parentId ?? null);

  if (result.changes > 0) {
    log.info({ topicId: id, name: input.name }, "Topic created");
    return {
      id,
      name: input.name,
      description: input.description ?? null,
      parentId: input.parentId ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  // Topic already existed — fetch and return it
  log.info({ name: input.name }, "Topic already exists, returning existing");
  const row = db
    .prepare(
      "SELECT id, name, description, parent_id, created_at, updated_at FROM topics WHERE name = ?",
    )
    .get(input.name);

  const validated = validateRow<{
    id: string;
    name: string;
    description: string | null;
    parent_id: string | null;
    created_at: string;
    updated_at: string;
  }>(
    row,
    ["id", "name", "description", "parent_id", "created_at", "updated_at"],
    "existing topic lookup",
  );

  return {
    id: validated.id,
    name: validated.name,
    description: validated.description,
    parentId: validated.parent_id,
    createdAt: validated.created_at,
    updatedAt: validated.updated_at,
  };
}

/** List topics, optionally filtered by parent. */
export function listTopics(db: Database.Database, parentId?: string): Topic[] {
  let sql = `
    SELECT id, name, description, parent_id, created_at, updated_at
    FROM topics
  `;
  const params: unknown[] = [];

  if (parentId !== undefined) {
    sql += " WHERE parent_id = ?";
    params.push(parentId);
  } else {
    sql += " WHERE parent_id IS NULL";
  }

  sql += " ORDER BY name";

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    name: string;
    description: string | null;
    parent_id: string | null;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    parentId: row.parent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/** Get a topic by ID. */
export function getTopic(db: Database.Database, topicId: string): Topic {
  const row = db
    .prepare(
      `
    SELECT id, name, description, parent_id, created_at, updated_at
    FROM topics WHERE id = ?
  `,
    )
    .get(topicId) as
    | {
        id: string;
        name: string;
        description: string | null;
        parent_id: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  if (!row) throw new TopicNotFoundError(topicId);

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    parentId: row.parent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface GetDocumentsByTopicOptions {
  limit?: number;
  offset?: number;
}

export interface TopicStats {
  id: string;
  name: string;
  description: string | null;
  parentId: string | null;
  documentCount: number;
}

/** Delete a topic and optionally its document associations. */
export function deleteTopic(
  db: Database.Database,
  topicId: string,
  options?: { deleteDocuments?: boolean },
): void {
  const log = createChildLogger({ operation: "deleteTopic" });
  getTopic(db, topicId);
  const run = db.transaction(() => {
    if (options?.deleteDocuments) {
      db.prepare("DELETE FROM documents WHERE topic_id = ?").run(topicId);
    }
    db.prepare("DELETE FROM topics WHERE id = ?").run(topicId);
  });
  run();
  log.info({ topicId, deleteDocuments: options?.deleteDocuments ?? false }, "Topic deleted");
}

/** Rename a topic. */
export function renameTopic(db: Database.Database, topicId: string, newName: string): Topic {
  const log = createChildLogger({ operation: "renameTopic" });
  if (!newName.trim()) {
    throw new ValidationError("Topic name is required");
  }
  getTopic(db, topicId);
  db.prepare("UPDATE topics SET name = ?, updated_at = datetime('now') WHERE id = ?").run(
    newName,
    topicId,
  );
  log.info({ topicId, newName }, "Topic renamed");
  return getTopic(db, topicId);
}

/** Get documents for a topic with pagination. */
export function getDocumentsByTopic(
  db: Database.Database,
  topicId: string,
  options?: GetDocumentsByTopicOptions,
): Document[] {
  getTopic(db, topicId);
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const rows = db
    .prepare(
      `SELECT id, source_type, library, version, topic_id, title, content, url, content_hash, submitted_by, created_at, updated_at
    FROM documents WHERE topic_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(topicId, limit, offset) as Array<{
    id: string;
    source_type: string;
    library: string | null;
    version: string | null;
    topic_id: string | null;
    title: string;
    content: string;
    url: string | null;
    content_hash: string | null;
    submitted_by: string;
    created_at: string;
    updated_at: string;
  }>;
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

/** Get topics with document counts. */
export function getTopicStats(db: Database.Database): TopicStats[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.name, t.description, t.parent_id, COUNT(d.id) AS document_count
    FROM topics t LEFT JOIN documents d ON d.topic_id = t.id GROUP BY t.id ORDER BY t.name`,
    )
    .all() as Array<{
    id: string;
    name: string;
    description: string | null;
    parent_id: string | null;
    document_count: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    parentId: row.parent_id,
    documentCount: row.document_count,
  }));
}
