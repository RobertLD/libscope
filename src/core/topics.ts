import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { ValidationError, TopicNotFoundError } from "../errors.js";
import { createChildLogger } from "../logger.js";

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

  // Check for duplicate
  const existing = db.prepare("SELECT id FROM topics WHERE id = ?").get(id) as
    | { id: string }
    | undefined;
  if (existing) {
    throw new ValidationError(`Topic '${id}' already exists`);
  }

  db.prepare(
    `
    INSERT INTO topics (id, name, description, parent_id)
    VALUES (?, ?, ?, ?)
  `,
  ).run(id, input.name, input.description ?? null, input.parentId ?? null);

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
