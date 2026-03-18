import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { getLogger } from "../logger.js";

export interface DedupResult {
  isDuplicate: boolean;
  matchType?: "exact" | "similar";
  existingDocId?: string;
  similarity?: number;
}

export interface DedupOptions {
  /** Cosine similarity threshold for near-duplicate detection (default: 0.95). */
  threshold?: number;
  /** Strategy: exact hash only, semantic embedding, or both (default: 'both'). */
  strategy?: "exact" | "semantic" | "both";
}

export interface DuplicateGroup {
  /** Content hash shared by the group (null for semantic-only groups). */
  contentHash: string | null;
  /** Type of duplication detected. */
  matchType: "exact" | "similar";
  /** Document IDs in the group. */
  documentIds: string[];
  /** Titles of the documents in the group. */
  titles: string[];
}

const DEFAULT_THRESHOLD = 0.95;
const DEFAULT_STRATEGY = "both";
/** Maximum characters to sample for semantic comparison. */
const SAMPLE_SIZE = 1000;

function computeHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Check whether the given content is a duplicate of an existing document.
 *
 * Fast path: SHA-256 hash match against the content_hash column.
 * Slow path: embed a sample of the content and vector-search for similar docs.
 */
export async function checkDuplicate(
  db: Database.Database,
  provider: EmbeddingProvider,
  content: string,
  options?: DedupOptions,
): Promise<DedupResult> {
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  const strategy = options?.strategy ?? DEFAULT_STRATEGY;
  const log = getLogger();

  // --- Fast path: exact hash match ---
  if (strategy === "exact" || strategy === "both") {
    const hash = computeHash(content);
    const row = db.prepare("SELECT id FROM documents WHERE content_hash = ?").get(hash) as
      | { id: string }
      | undefined;

    if (row) {
      log.debug({ existingDocId: row.id }, "Exact duplicate detected via content hash");
      return { isDuplicate: true, matchType: "exact", existingDocId: row.id, similarity: 1.0 };
    }
  }

  // --- Slow path: semantic similarity ---
  if (strategy === "semantic" || strategy === "both") {
    try {
      const sample = content.slice(0, SAMPLE_SIZE);
      const queryEmbedding = await provider.embed(sample);
      const vecBuffer = Buffer.from(new Float32Array(queryEmbedding).buffer);

      const rows = db
        .prepare(
          `SELECT ce.chunk_id, ce.distance, c.document_id
           FROM chunk_embeddings ce
           JOIN chunks c ON c.id = ce.chunk_id
           WHERE ce.embedding MATCH ?
           ORDER BY ce.distance
           LIMIT 1`,
        )
        .all(vecBuffer) as Array<{
        chunk_id: string;
        distance: number;
        document_id: string;
      }>;

      if (rows.length > 0) {
        const best = rows[0]!;
        const similarity = 1 - best.distance;
        if (similarity >= threshold) {
          log.debug(
            { existingDocId: best.document_id, similarity },
            "Near-duplicate detected via semantic similarity",
          );
          return {
            isDuplicate: true,
            matchType: "similar",
            existingDocId: best.document_id,
            similarity,
          };
        }
      }
    } catch {
      log.debug("Semantic dedup skipped (vector table may not be available)");
    }
  }

  return { isDuplicate: false };
}

/** Find exact duplicate groups by content hash. */
function findExactDuplicateGroups(db: Database.Database): DuplicateGroup[] {
  const hashGroups = db
    .prepare(
      `SELECT content_hash, GROUP_CONCAT(id) AS ids, GROUP_CONCAT(title, '|||') AS titles
       FROM documents
       WHERE content_hash IS NOT NULL
       GROUP BY content_hash
       HAVING COUNT(*) > 1`,
    )
    .all() as Array<{ content_hash: string; ids: string; titles: string }>;

  return hashGroups.map((row) => ({
    contentHash: row.content_hash,
    matchType: "exact" as const,
    documentIds: row.ids.split(","),
    titles: row.titles.split("|||"),
  }));
}

/** Cluster documents by pairwise embedding similarity, returning groups with > 1 member. */
function clusterBySimilarity(
  remaining: Array<{ id: string; title: string }>,
  embeddings: number[][],
  threshold: number,
): DuplicateGroup[] {
  const matched = new Set<string>();
  const groups: DuplicateGroup[] = [];

  for (let i = 0; i < remaining.length; i++) {
    if (matched.has(remaining[i]!.id)) continue;
    const group: string[] = [remaining[i]!.id];
    const groupTitles: string[] = [remaining[i]!.title];

    for (let j = i + 1; j < remaining.length; j++) {
      if (matched.has(remaining[j]!.id)) continue;
      const sim = cosineSimilarity(embeddings[i]!, embeddings[j]!);
      if (sim >= threshold) {
        group.push(remaining[j]!.id);
        groupTitles.push(remaining[j]!.title);
        matched.add(remaining[j]!.id);
      }
    }

    if (group.length > 1) {
      matched.add(remaining[i]!.id);
      groups.push({
        contentHash: null,
        matchType: "similar",
        documentIds: group,
        titles: groupTitles,
      });
    }
  }

  return groups;
}

/**
 * Scan all documents and return groups of duplicates.
 *
 * Phase 1: group by content_hash (exact duplicates).
 * Phase 2: sample-check remaining docs for near-duplicates via embeddings.
 */
export async function findDuplicates(
  db: Database.Database,
  provider: EmbeddingProvider,
  options?: DedupOptions,
): Promise<DuplicateGroup[]> {
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  const strategy = options?.strategy ?? DEFAULT_STRATEGY;
  const log = getLogger();
  const groups: DuplicateGroup[] = [];

  if (strategy === "exact" || strategy === "both") {
    const exactGroups = findExactDuplicateGroups(db);
    groups.push(...exactGroups);
    log.info({ exactGroups: exactGroups.length }, "Exact duplicate scan complete");
  }

  if (strategy === "semantic" || strategy === "both") {
    const exactDocIds = new Set(groups.flatMap((g) => g.documentIds));
    const docs = db.prepare("SELECT id, title, content FROM documents").all() as Array<{
      id: string;
      title: string;
      content: string;
    }>;
    const remaining = docs.filter((d) => !exactDocIds.has(d.id));

    if (remaining.length > 1) {
      try {
        const samples = remaining.map((d) => d.content.slice(0, SAMPLE_SIZE));
        const embeddings = await provider.embedBatch(samples);
        const semanticGroups = clusterBySimilarity(remaining, embeddings, threshold);
        groups.push(...semanticGroups);
        log.info({ semanticGroups: groups.length }, "Semantic near-duplicate scan complete");
      } catch {
        log.debug("Semantic duplicate scan skipped (vector operations unavailable)");
      }
    }
  }

  return groups;
}
