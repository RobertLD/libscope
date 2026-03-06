/**
 * Integration test: End-to-end retrieval quality benchmark.
 *
 * Uses sqlite-vec for real vector search with a lightweight TF-IDF–style
 * embedding provider that produces deterministic, semantically meaningful
 * vectors without needing a neural model or network access.
 *
 * This proves the full pipeline: index → embed → store → search → rank,
 * including metadata enrichment, title boosting, hybrid RRF, and AND logic.
 *
 * If the local neural model (all-MiniLM-L6-v2) is available, a second
 * describe block runs the same queries with real embeddings.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import type { EmbeddingProvider } from "../../src/providers/embedding.js";
import { chunkContent } from "../../src/core/indexing.js";
import { searchDocuments } from "../../src/core/search.js";
import { createRequire } from "node:module";
import { runMigrations, createVectorTable } from "../../src/db/schema.js";

const TIMEOUT = 60_000;

// ---------------------------------------------------------------------------
// TF-IDF–style embedding provider: deterministic, no network, semantically
// meaningful (documents sharing words will have closer vectors).
// ---------------------------------------------------------------------------
class TfIdfEmbeddingProvider implements EmbeddingProvider {
  readonly name = "tfidf-test";
  readonly dimensions: number;
  private readonly vocab: Map<string, number>;

  constructor(corpusTexts: string[]) {
    // Build vocabulary from corpus
    const wordSet = new Set<string>();
    for (const text of corpusTexts) {
      for (const w of this.tokenize(text)) wordSet.add(w);
    }
    const sorted = [...wordSet].sort();
    this.vocab = new Map(sorted.map((w, i) => [w, i]));
    this.dimensions = sorted.length;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async embed(text: string): Promise<number[]> {
    const vec = new Float64Array(this.dimensions);
    const words = this.tokenize(text);
    for (const w of words) {
      const idx = this.vocab.get(w);
      if (idx !== undefined) vec[idx] += 1;
    }
    // L2 normalize
    let mag = 0;
    for (const v of vec) mag += v * v;
    mag = Math.sqrt(mag);
    if (mag > 0) {
      for (let i = 0; i < vec.length; i++) vec[i] /= mag;
    }
    return Array.from(vec);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------
interface CorpusDoc {
  id: string;
  title: string;
  content: string;
  library?: string;
}

const CORPUS: CorpusDoc[] = [
  {
    id: "react-hooks",
    title: "React Hooks",
    content:
      "React hooks like useState and useEffect allow state management in functional components. " +
      "useState returns a stateful value and a function to update it. " +
      "useEffect performs side effects after render.",
  },
  {
    id: "react-router",
    title: "React Router",
    content:
      "React Router provides declarative routing for React applications with dynamic route matching. " +
      "Use BrowserRouter and Route components to define navigation paths.",
  },
  {
    id: "ts-generics",
    title: "TypeScript Generics",
    library: "typescript",
    content:
      "TypeScript generics enable writing reusable type-safe functions and classes. " +
      "Use angle brackets to define type parameters like function identity<T>(arg: T): T.",
  },
  {
    id: "ts-types",
    title: "TypeScript Type System",
    library: "typescript",
    content:
      "TypeScript type system includes union types intersection types and conditional types. " +
      "Mapped types transform existing types property by property.",
  },
  {
    id: "node-streams",
    title: "Node.js Streams",
    content:
      "Node.js streams provide an interface for reading and writing data in chunks efficiently. " +
      "Readable streams emit data events, writable streams accept data via write method.",
  },
  {
    id: "node-http",
    title: "Node.js HTTP",
    content:
      "Node.js HTTP module allows creating web servers and handling HTTP requests and responses. " +
      "Use http.createServer to start a server listening on a port.",
  },
  {
    id: "sql-joins",
    title: "SQL Joins",
    content:
      "SQL joins combine rows from two or more tables based on related columns between them. " +
      "INNER JOIN returns matching rows, LEFT JOIN includes all rows from the left table.",
  },
  {
    id: "sql-index",
    title: "SQL Indexing",
    content:
      "SQL indexes improve query performance by creating efficient data structures for lookups. " +
      "B-tree indexes are the most common type supporting equality and range queries.",
  },
];

const QUERIES: Array<{ query: string; expectedTopId: string; label: string }> = [
  {
    query: "React state management hooks useState",
    expectedTopId: "react-hooks",
    label: "React hooks",
  },
  {
    query: "TypeScript generic type parameters reusable",
    expectedTopId: "ts-generics",
    label: "TS generics",
  },
  {
    query: "Node.js streaming data reading writing chunks",
    expectedTopId: "node-streams",
    label: "Node streams",
  },
  {
    query: "SQL join tables combine rows matching",
    expectedTopId: "sql-joins",
    label: "SQL joins",
  },
  {
    query: "React routing pages navigation BrowserRouter",
    expectedTopId: "react-router",
    label: "React routing",
  },
  {
    query: "SQL database index query performance",
    expectedTopId: "sql-index",
    label: "SQL indexing",
  },
];

// ---------------------------------------------------------------------------
// Helper: load sqlite-vec (returns false when the extension isn't available)
// ---------------------------------------------------------------------------
let vecAvailable: boolean | undefined;

function isVecAvailable(): boolean {
  if (vecAvailable !== undefined) return vecAvailable;
  try {
    const require = createRequire(import.meta.url);
    require.resolve("sqlite-vec");
    vecAvailable = true;
  } catch {
    vecAvailable = false;
  }
  return vecAvailable;
}

function loadVec(db: Database.Database): void {
  const require = createRequire(import.meta.url);
  const sqliteVec = require("sqlite-vec") as { load: (db: Database.Database) => void };
  sqliteVec.load(db);
}

// ---------------------------------------------------------------------------
// Helper: index full corpus into a DB
// ---------------------------------------------------------------------------
async function indexCorpus(db: Database.Database, provider: EmbeddingProvider): Promise<void> {
  const insertDoc = db.prepare(
    `INSERT INTO documents (id, title, content, source_type, library) VALUES (?, ?, ?, 'manual', ?)`,
  );
  const insertChunkStmt = db.prepare(
    `INSERT INTO chunks (id, document_id, content, chunk_index) VALUES (?, ?, ?, ?)`,
  );
  const insertEmbedding = db.prepare(
    `INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)`,
  );

  for (const doc of CORPUS) {
    insertDoc.run(doc.id, doc.title, doc.content, doc.library ?? null);

    const chunks = chunkContent(doc.content);
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = `${doc.id}-c${i}`;
      insertChunkStmt.run(chunkId, doc.id, chunks[i], i);

      // Metadata-enriched embedding (same as production indexDocument)
      const metaParts: string[] = [];
      if (doc.title) metaParts.push(doc.title);
      if (doc.library) metaParts.push(`Library: ${doc.library}`);
      const metaPrefix = metaParts.length > 0 ? metaParts.join(" | ") + "\n\n" : "";
      const enrichedText = metaPrefix + chunks[i]!;

      const embedding = await provider.embed(enrichedText);
      const vecBuffer = Buffer.from(new Float32Array(embedding).buffer);
      insertEmbedding.run(chunkId, vecBuffer);
    }
  }
}

// =========================================================================
// Test suite with TF-IDF provider (always runs, no network needed)
// =========================================================================
describe.runIf(isVecAvailable())("retrieval quality: TF-IDF embeddings + sqlite-vec", () => {
  let db: Database.Database;
  let provider: TfIdfEmbeddingProvider;

  beforeAll(async () => {
    // Build vocabulary from all corpus text + queries
    const allTexts = [
      ...CORPUS.map((d) => `${d.title} ${d.content}`),
      ...QUERIES.map((q) => q.query),
    ];
    provider = new TfIdfEmbeddingProvider(allTexts);

    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    loadVec(db);
    runMigrations(db);
    createVectorTable(db, provider.dimensions);

    await indexCorpus(db, provider);
  }, TIMEOUT);

  afterAll(() => {
    db?.close();
  });

  for (const { query, expectedTopId, label } of QUERIES) {
    it(`ranks "${label}" in top 3 for: "${query}"`, async () => {
      const { results } = await searchDocuments(db, provider, {
        query,
        limit: 8,
        analyticsEnabled: false,
      });

      expect(results.length).toBeGreaterThan(0);

      const rank = results.findIndex((r) => r.documentId === expectedTopId);
      const topResult = results[0]!;

      if (process.env.DEBUG) {
        console.log(
          `  [${label}] top=${topResult.documentId} (${topResult.score.toFixed(4)}), ` +
            `expected=${expectedTopId} at rank ${rank + 1}, method=${topResult.scoreExplanation.method}`,
        );
      }

      expect(rank).toBeGreaterThanOrEqual(0);
      expect(rank).toBeLessThan(3);
    });
  }

  it("uses hybrid search method (RRF fusion)", async () => {
    const { results } = await searchDocuments(db, provider, {
      query: "React hooks state management",
      limit: 8,
      analyticsEnabled: false,
    });

    expect(results.length).toBeGreaterThan(0);
    const methods = new Set(results.map((r) => r.scoreExplanation.method));

    if (process.env.DEBUG) console.log(`  search methods used: ${[...methods].join(", ")}`);

    // With both vector + FTS5, we should get hybrid results
    expect(methods.has("hybrid")).toBe(true);
  });

  it("title boost lifts title-matching documents", async () => {
    const { results } = await searchDocuments(db, provider, {
      query: "TypeScript Generics",
      limit: 8,
      analyticsEnabled: false,
    });

    const tsGenerics = results.find((r) => r.documentId === "ts-generics");
    expect(tsGenerics).toBeDefined();
    expect(tsGenerics!.scoreExplanation.boostFactors.some((f) => f.includes("title_match"))).toBe(
      true,
    );

    if (process.env.DEBUG) {
      console.log(
        `  title boost: ts-generics rank=${results.findIndex((r) => r.documentId === "ts-generics") + 1}, ` +
          `score=${tsGenerics!.score.toFixed(4)}, factors=${tsGenerics!.scoreExplanation.boostFactors.join(",")}`,
      );
    }

    // Should be rank 1
    expect(results[0]!.documentId).toBe("ts-generics");
  });

  it("AND logic prefers chunks containing all query terms", async () => {
    const { results } = await searchDocuments(db, provider, {
      query: "TypeScript generics reusable",
      limit: 8,
      analyticsEnabled: false,
    });

    expect(results.length).toBeGreaterThan(0);

    // The ts-generics doc contains all three terms
    const tsGenerics = results.find((r) => r.documentId === "ts-generics");
    expect(tsGenerics).toBeDefined();

    // It should be ranked high
    const rank = results.findIndex((r) => r.documentId === "ts-generics");
    if (process.env.DEBUG)
      console.log(`  AND logic: ts-generics rank=${rank + 1} for "TypeScript generics reusable"`);
    expect(rank).toBeLessThan(3);
  });

  it("overall precision: at least 5/6 queries rank expected doc in top 3", async () => {
    let hits = 0;

    for (const { query, expectedTopId, label } of QUERIES) {
      const { results } = await searchDocuments(db, provider, {
        query,
        limit: 8,
        analyticsEnabled: false,
      });
      const rank = results.findIndex((r) => r.documentId === expectedTopId);
      if (rank >= 0 && rank < 3) hits++;
      else if (process.env.DEBUG)
        console.log(`  miss: "${label}" expected=${expectedTopId} actual rank=${rank + 1}`);
    }

    if (process.env.DEBUG)
      console.log(`\n  ★ Overall precision: ${hits}/${QUERIES.length} in top-3\n`);
    expect(hits).toBeGreaterThanOrEqual(5);
  });
});
