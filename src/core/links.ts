import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { ValidationError, DocumentNotFoundError } from "../errors.js";
import { createChildLogger } from "../logger.js";

export type LinkType = "see_also" | "prerequisite" | "supersedes" | "related";

const VALID_LINK_TYPES: ReadonlySet<string> = new Set<LinkType>([
  "see_also",
  "prerequisite",
  "supersedes",
  "related",
]);

export interface DocumentLink {
  id: string;
  sourceId: string;
  targetId: string;
  linkType: LinkType;
  label: string | null;
  createdAt: string;
}

export interface DocumentLinkWithTitle extends DocumentLink {
  sourceTitle: string;
  targetTitle: string;
}

export interface DocumentLinks {
  outgoing: DocumentLinkWithTitle[];
  incoming: DocumentLinkWithTitle[];
}

interface LinkRow {
  id: string;
  source_id: string;
  target_id: string;
  link_type: string;
  label: string | null;
  created_at: string;
}

interface LinkRowWithTitles extends LinkRow {
  source_title: string;
  target_title: string;
}

function rowToLink(row: LinkRow): DocumentLink {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    linkType: row.link_type as LinkType,
    label: row.label,
    createdAt: row.created_at,
  };
}

function rowToLinkWithTitle(row: LinkRowWithTitles): DocumentLinkWithTitle {
  return {
    ...rowToLink(row),
    sourceTitle: row.source_title,
    targetTitle: row.target_title,
  };
}

function assertDocumentExists(db: Database.Database, docId: string, role: string): void {
  const row = db.prepare("SELECT id FROM documents WHERE id = ?").get(docId) as
    | { id: string }
    | undefined;
  if (!row) {
    throw new DocumentNotFoundError(`${role} document not found: ${docId}`);
  }
}

/** Create a link between two documents. Returns existing link if duplicate. */
export function createLink(
  db: Database.Database,
  sourceId: string,
  targetId: string,
  linkType: LinkType,
  label?: string,
): DocumentLink {
  const log = createChildLogger({ operation: "createLink" });

  if (!VALID_LINK_TYPES.has(linkType)) {
    throw new ValidationError(
      `Invalid link type: ${linkType}. Must be one of: ${[...VALID_LINK_TYPES].join(", ")}`,
    );
  }
  if (sourceId === targetId) {
    throw new ValidationError("Cannot link a document to itself");
  }

  assertDocumentExists(db, sourceId, "Source");
  assertDocumentExists(db, targetId, "Target");

  const id = randomUUID();
  const result = db
    .prepare(
      `INSERT INTO document_links (id, source_id, target_id, link_type, label)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_id, target_id, link_type) DO NOTHING`,
    )
    .run(id, sourceId, targetId, linkType, label ?? null);

  if (result.changes > 0) {
    log.info({ linkId: id, sourceId, targetId, linkType }, "Document link created");
    return {
      id,
      sourceId,
      targetId,
      linkType,
      label: label ?? null,
      createdAt: new Date().toISOString(),
    };
  }

  // Return existing
  const existing = db
    .prepare(
      `SELECT id, source_id, target_id, link_type, label, created_at
       FROM document_links WHERE source_id = ? AND target_id = ? AND link_type = ?`,
    )
    .get(sourceId, targetId, linkType) as LinkRow;

  log.info({ sourceId, targetId, linkType }, "Link already exists, returning existing");
  return rowToLink(existing);
}

/** Get all links for a document (both outgoing and incoming), with titles. */
export function getDocumentLinks(db: Database.Database, documentId: string): DocumentLinks {
  const outgoing = db
    .prepare(
      `SELECT l.id, l.source_id, l.target_id, l.link_type, l.label, l.created_at,
              s.title AS source_title, t.title AS target_title
       FROM document_links l
       JOIN documents s ON s.id = l.source_id
       JOIN documents t ON t.id = l.target_id
       WHERE l.source_id = ?
       ORDER BY l.created_at DESC`,
    )
    .all(documentId) as LinkRowWithTitles[];

  const incoming = db
    .prepare(
      `SELECT l.id, l.source_id, l.target_id, l.link_type, l.label, l.created_at,
              s.title AS source_title, t.title AS target_title
       FROM document_links l
       JOIN documents s ON s.id = l.source_id
       JOIN documents t ON t.id = l.target_id
       WHERE l.target_id = ?
       ORDER BY l.created_at DESC`,
    )
    .all(documentId) as LinkRowWithTitles[];

  return {
    outgoing: outgoing.map(rowToLinkWithTitle),
    incoming: incoming.map(rowToLinkWithTitle),
  };
}

/** Delete a link by its ID. */
export function deleteLink(db: Database.Database, linkId: string): void {
  const log = createChildLogger({ operation: "deleteLink" });
  const result = db.prepare("DELETE FROM document_links WHERE id = ?").run(linkId);
  if (result.changes === 0) {
    throw new ValidationError(`Link not found: ${linkId}`);
  }
  log.info({ linkId }, "Document link deleted");
}

/** Get the prerequisite chain for a document (ordered learning path). Detects cycles. */
export function getPrerequisiteChain(
  db: Database.Database,
  documentId: string,
): Array<{ id: string; title: string }> {
  const chain: Array<{ id: string; title: string }> = [];
  const visited = new Set<string>();
  let currentId = documentId;

  // Walk backwards through prerequisite links
  while (true) {
    if (visited.has(currentId)) break; // cycle detection
    visited.add(currentId);

    const prereq = db
      .prepare(
        `SELECT l.source_id, d.title
         FROM document_links l
         JOIN documents d ON d.id = l.source_id
         WHERE l.target_id = ? AND l.link_type = 'prerequisite'
         LIMIT 1`,
      )
      .get(currentId) as { source_id: string; title: string } | undefined;

    if (!prereq) break;

    chain.unshift({ id: prereq.source_id, title: prereq.title });
    currentId = prereq.source_id;
  }

  return chain;
}

/** List all links in the database, optionally filtered by type. */
export function listLinks(db: Database.Database, linkType?: LinkType): DocumentLinkWithTitle[] {
  let sql = `
    SELECT l.id, l.source_id, l.target_id, l.link_type, l.label, l.created_at,
           s.title AS source_title, t.title AS target_title
    FROM document_links l
    JOIN documents s ON s.id = l.source_id
    JOIN documents t ON t.id = l.target_id
  `;
  const params: unknown[] = [];

  if (linkType) {
    sql += " WHERE l.link_type = ?";
    params.push(linkType);
  }

  sql += " ORDER BY l.created_at DESC";

  const rows = db.prepare(sql).all(...params) as LinkRowWithTitles[];
  return rows.map(rowToLinkWithTitle);
}
