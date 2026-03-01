import type Database from "better-sqlite3";

/** Common test document IDs. */
export const TEST_DOC_IDS = {
  doc1: "doc-1",
  doc2: "doc-2",
  doc3: "doc-3",
} as const;

/** Insert a minimal document row for search / chunk tests. */
export function insertDoc(
  db: Database.Database,
  id: string,
  title: string,
  opts: { library?: string; topicId?: string; sourceType?: string; createdAt?: string } = {},
): void {
  db.prepare(
    `INSERT INTO documents (id, title, content, source_type, library, topic_id, created_at)
     VALUES (?, ?, '', ?, ?, ?, ?)`,
  ).run(
    id,
    title,
    opts.sourceType ?? "manual",
    opts.library ?? null,
    opts.topicId ?? null,
    opts.createdAt ?? new Date().toISOString(),
  );
}

/** Insert a minimal chunk row for search tests. */
export function insertChunk(
  db: Database.Database,
  id: string,
  documentId: string,
  content: string,
): void {
  db.prepare(`INSERT INTO chunks (id, document_id, content, chunk_index) VALUES (?, ?, ?, 0)`).run(
    id,
    documentId,
    content,
  );
}

/**
 * Run `fn` with one or more environment variables temporarily set,
 * then restore the original values (or delete them) when done.
 */
export function withEnv(vars: Record<string, string>, fn: () => void): void {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    originals[key] = process.env[key];
    process.env[key] = vars[key];
  }
  try {
    fn();
  } finally {
    for (const [key, original] of Object.entries(originals)) {
      if (original !== undefined) {
        process.env[key] = original;
      } else {
        delete process.env[key];
      }
    }
  }
}

/** Seed a single test document and return its ID. */
export function seedTestDocument(
  db: Database.Database,
  id: string,
  opts: {
    sourceType?: string;
    library?: string;
    version?: string;
    title?: string;
    content?: string;
    submittedBy?: string;
  } = {},
): string {
  db.prepare(
    `INSERT INTO documents (id, source_type, library, version, title, content, submitted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.sourceType ?? "manual",
    opts.library ?? null,
    opts.version ?? null,
    opts.title ?? "Test Doc",
    opts.content ?? "Test content",
    opts.submittedBy ?? "manual",
  );
  return id;
}
