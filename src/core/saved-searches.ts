import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { searchDocuments } from "./search.js";
import type { SearchOptions, SearchResult } from "./search.js";
import { ValidationError, DocumentNotFoundError } from "../errors.js";

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  filters: Omit<SearchOptions, "query"> | null;
  createdAt: string;
  lastRunAt: string | null;
  resultCount: number;
}

interface SavedSearchRow {
  id: string;
  name: string;
  query: string;
  filters: string | null;
  created_at: string;
  last_run_at: string | null;
  result_count: number;
}

function rowToSavedSearch(row: SavedSearchRow): SavedSearch {
  let filters: Omit<SearchOptions, "query"> | null = null;
  if (row.filters) {
    filters = JSON.parse(row.filters) as Omit<SearchOptions, "query">;
  }
  return {
    id: row.id,
    name: row.name,
    query: row.query,
    filters,
    createdAt: row.created_at,
    lastRunAt: row.last_run_at,
    resultCount: row.result_count,
  };
}

export function createSavedSearch(
  db: Database.Database,
  name: string,
  query: string,
  filters?: Omit<SearchOptions, "query">,
): SavedSearch {
  const trimmedName = name.trim();
  const trimmedQuery = query.trim();

  if (!trimmedName) {
    throw new ValidationError("Saved search name is required");
  }
  if (!trimmedQuery) {
    throw new ValidationError("Saved search query is required");
  }

  const existing = db.prepare("SELECT id FROM saved_searches WHERE name = ?").get(trimmedName) as
    | { id: string }
    | undefined;
  if (existing) {
    throw new ValidationError(`A saved search named "${trimmedName}" already exists`);
  }

  const id = randomUUID();
  const filtersJson = filters ? JSON.stringify(filters) : null;

  db.prepare("INSERT INTO saved_searches (id, name, query, filters) VALUES (?, ?, ?, ?)").run(
    id,
    trimmedName,
    trimmedQuery,
    filtersJson,
  );

  const row = db.prepare("SELECT * FROM saved_searches WHERE id = ?").get(id) as SavedSearchRow;
  return rowToSavedSearch(row);
}

export function listSavedSearches(
  db: Database.Database,
  limit?: number,
  offset?: number,
): SavedSearch[] {
  const effectiveLimit = Math.max(1, Math.min(limit ?? 50, 1000));
  const effectiveOffset = Math.max(0, offset ?? 0);
  const rows = db
    .prepare("SELECT * FROM saved_searches ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .all(effectiveLimit, effectiveOffset) as SavedSearchRow[];
  return rows.map(rowToSavedSearch);
}

export function getSavedSearch(db: Database.Database, id: string): SavedSearch {
  const row = db.prepare("SELECT * FROM saved_searches WHERE id = ? OR name = ?").get(id, id) as
    | SavedSearchRow
    | undefined;
  if (!row) {
    throw new DocumentNotFoundError(id);
  }
  return rowToSavedSearch(row);
}

export function deleteSavedSearch(db: Database.Database, id: string): void {
  const result = db.prepare("DELETE FROM saved_searches WHERE id = ? OR name = ?").run(id, id);
  if (result.changes === 0) {
    throw new DocumentNotFoundError(id);
  }
}

export async function runSavedSearch(
  db: Database.Database,
  provider: EmbeddingProvider,
  id: string,
): Promise<{ search: SavedSearch; results: SearchResult[] }> {
  const search = getSavedSearch(db, id);

  const options: SearchOptions = {
    query: search.query,
    ...search.filters,
  };

  const { results } = await searchDocuments(db, provider, options);

  db.prepare(
    "UPDATE saved_searches SET last_run_at = datetime('now'), result_count = ? WHERE id = ?",
  ).run(results.length, search.id);

  const updated = getSavedSearch(db, search.id);
  return { search: updated, results };
}
