import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { ValidationError, DocumentNotFoundError } from "../errors.js";

export interface RateDocumentInput {
  documentId: string;
  chunkId?: string | undefined;
  rating: number;
  feedback?: string | undefined;
  suggestedCorrection?: string | undefined;
  ratedBy?: string | undefined;
}

export interface Rating {
  id: string;
  documentId: string;
  chunkId: string | null;
  rating: number;
  feedback: string | null;
  suggestedCorrection: string | null;
  ratedBy: string;
  createdAt: string;
}

export interface RatingSummary {
  documentId: string;
  averageRating: number;
  totalRatings: number;
  corrections: number;
}

/** Add a rating to a document or chunk. */
export function rateDocument(db: Database.Database, input: RateDocumentInput): Rating {
  if (input.rating < 1 || input.rating > 5 || !Number.isInteger(input.rating)) {
    throw new ValidationError("Rating must be an integer between 1 and 5");
  }

  // Verify document exists
  const doc = db.prepare("SELECT id FROM documents WHERE id = ?").get(input.documentId) as
    | { id: string }
    | undefined;
  if (!doc) {
    throw new DocumentNotFoundError(input.documentId);
  }

  const id = randomUUID();
  const ratedBy = input.ratedBy ?? "user";

  db.prepare(
    `
    INSERT INTO ratings (id, document_id, chunk_id, rating, feedback, suggested_correction, rated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    input.documentId,
    input.chunkId ?? null,
    input.rating,
    input.feedback ?? null,
    input.suggestedCorrection ?? null,
    ratedBy,
  );

  return {
    id,
    documentId: input.documentId,
    chunkId: input.chunkId ?? null,
    rating: input.rating,
    feedback: input.feedback ?? null,
    suggestedCorrection: input.suggestedCorrection ?? null,
    ratedBy,
    createdAt: new Date().toISOString(),
  };
}

/** Get rating summary for a document. */
export function getDocumentRatings(db: Database.Database, documentId: string): RatingSummary {
  const doc = db.prepare("SELECT id FROM documents WHERE id = ?").get(documentId) as
    | { id: string }
    | undefined;
  if (!doc) {
    throw new DocumentNotFoundError(documentId);
  }

  const summary = db
    .prepare(
      `
    SELECT
      AVG(rating) AS avg_rating,
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN suggested_correction IS NOT NULL THEN 1 ELSE 0 END), 0) AS corrections
    FROM ratings
    WHERE document_id = ?
  `,
    )
    .get(documentId) as { avg_rating: number | null; total: number; corrections: number };

  return {
    documentId,
    averageRating: summary.avg_rating ?? 0,
    totalRatings: summary.total,
    corrections: summary.corrections,
  };
}

/** Get all ratings for a document. */
export function listRatings(db: Database.Database, documentId: string): Rating[] {
  const rows = db
    .prepare(
      `
    SELECT id, document_id, chunk_id, rating, feedback, suggested_correction, rated_by, created_at
    FROM ratings
    WHERE document_id = ?
    ORDER BY created_at DESC
  `,
    )
    .all(documentId) as Array<{
    id: string;
    document_id: string;
    chunk_id: string | null;
    rating: number;
    feedback: string | null;
    suggested_correction: string | null;
    rated_by: string;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    documentId: r.document_id,
    chunkId: r.chunk_id,
    rating: r.rating,
    feedback: r.feedback,
    suggestedCorrection: r.suggested_correction,
    ratedBy: r.rated_by,
    createdAt: r.created_at,
  }));
}
