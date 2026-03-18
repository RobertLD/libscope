/**
 * Integration test: Harder retrieval quality benchmark.
 *
 * Improvements over the original benchmark:
 *
 *  1. LARGER CORPUS — 20 docs across 4 topic clusters (5 docs each).
 *     Within each cluster, docs share common vocabulary, so the ranker must
 *     discriminate within the cluster, not just across domains.
 *     top-3 now means finding the needle in 15% of the corpus (was 37.5%).
 *
 *  2. THREE QUERY TIERS with escalating difficulty:
 *     - Easy   (4 queries): vocabulary directly in the target doc, all 4 must reach top-3.
 *     - Medium (6 queries): 2 competing docs share most query vocabulary; 4/6 must reach top-2.
 *                           Includes 2 near-paraphrase queries TF-IDF may struggle with.
 *     - Hard   (5 queries): must be rank-1; 3/5 must pass.
 *
 *  3. MRR (Mean Reciprocal Rank) across all 15 queries with explicit threshold.
 *     MRR rewards rank-1 hits over rank-2, and penalises rank-3+ — a much
 *     more informative signal than the old binary top-3 pass/fail.
 *
 *  4. Library-filter precision — searching with library= must return ONLY
 *     docs from that library; zero cross-library leakage allowed.
 *
 *  5. Neural model suite (conditional) — if @xenova/transformers +
 *     all-MiniLM-L6-v2 is available locally, the same 15 queries run with
 *     real embeddings under higher thresholds (MRR ≥ 0.82), plus 5 pure-
 *     paraphrase queries that TF-IDF cannot handle but a semantic model should.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import type { EmbeddingProvider } from "../../src/providers/embedding.js";
import { chunkContent } from "../../src/core/indexing.js";
import { searchDocuments } from "../../src/core/search.js";
import { createRequire } from "node:module";
import { runMigrations, createVectorTable } from "../../src/db/schema.js";

const TIMEOUT = 120_000;

// ---------------------------------------------------------------------------
// TF-IDF embedding provider — deterministic, no network, semantically
// meaningful within the training corpus (docs sharing words cluster together).
// ---------------------------------------------------------------------------
class TfIdfEmbeddingProvider implements EmbeddingProvider {
  readonly name = "tfidf-test";
  readonly dimensions: number;
  private readonly vocab: Map<string, number>;

  constructor(corpusTexts: string[]) {
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
    for (const w of this.tokenize(text)) {
      const idx = this.vocab.get(w);
      if (idx !== undefined) vec[idx] += 1;
    }
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
// Corpus — 20 docs, 4 clusters × 5 docs each.
// Within each cluster docs share cluster vocabulary (React/component/state,
// TypeScript/type/function, Node.js/JavaScript/async, SQL/table/query),
// so the ranker cannot rely on topic-level separation alone.
// ---------------------------------------------------------------------------
interface CorpusDoc {
  id: string;
  title: string;
  content: string;
  library?: string;
}

const CORPUS: CorpusDoc[] = [
  // ── React cluster (library: react) ─────────────────────────────────────────
  {
    id: "react-hooks",
    title: "React Hooks",
    library: "react",
    content:
      "React hooks let functional components use state and lifecycle features. " +
      "useState returns a stateful value and a setter function. " +
      "useEffect runs side effects after render and accepts a dependency array to control re-execution. " +
      "useCallback and useMemo memoize functions and computed values to avoid unnecessary re-renders. " +
      "Custom hooks extract reusable stateful logic into functions prefixed with use.",
  },
  {
    id: "react-context",
    title: "React Context API",
    library: "react",
    content:
      "React Context provides a way to share data across a component tree without passing props through every intermediate level, avoiding prop drilling. " +
      "createContext returns a Context object with a Provider and Consumer. " +
      "Wrapping children in a Provider makes the context value available throughout the subtree. " +
      "The useContext hook subscribes a functional component to the nearest Provider value. " +
      "Context suits global concerns like themes, authentication state, or locale.",
  },
  {
    id: "react-redux",
    title: "React Redux",
    library: "react",
    content:
      "Redux manages application state using a single immutable store shared across the React app. " +
      "useSelector reads values from the Redux store and triggers re-renders when those values change. " +
      "useDispatch returns the dispatch function used to send actions to reducers. " +
      "createSlice from Redux Toolkit combines action creators and reducer logic into one definition. " +
      "Middleware such as redux-thunk handles asynchronous action dispatching.",
  },
  {
    id: "react-router",
    title: "React Router",
    library: "react",
    content:
      "React Router provides declarative routing for single-page React applications. " +
      "BrowserRouter wraps the app and enables the HTML5 history API for navigation. " +
      "Route components map URL paths to rendered components. " +
      "Link and NavLink create navigation anchors without triggering a full page reload. " +
      "useNavigate returns a function for programmatic navigation. " +
      "useParams extracts named dynamic segments from the current URL path.",
  },
  {
    id: "react-forms",
    title: "React Forms",
    library: "react",
    content:
      "Controlled form inputs bind their value to React state via the value prop and update through an onChange handler. " +
      "Uncontrolled inputs use useRef to read the DOM value directly when needed. " +
      "A single onChange handler can manage multiple inputs by reading event.target.name. " +
      "Validation logic runs on change, on blur, or on the form submit event. " +
      "The onSubmit handler calls event.preventDefault and reads values via state or FormData.",
  },

  // ── TypeScript cluster (library: typescript) ────────────────────────────────
  {
    id: "ts-generics",
    title: "TypeScript Generics",
    library: "typescript",
    content:
      "TypeScript generics let you write reusable, type-safe functions and data structures with type parameters. " +
      "A type parameter is declared in angle brackets, such as function identity<T>(arg: T): T. " +
      "The extends keyword constrains a type parameter to a specific shape. " +
      "The infer keyword inside conditional types extracts and names a matched type. " +
      "Generic classes and interfaces allow flexible typed containers whose element type is chosen by the caller.",
  },
  {
    id: "ts-types",
    title: "TypeScript Advanced Types",
    library: "typescript",
    content:
      "TypeScript supports advanced type constructs beyond simple annotations. " +
      "Union types combine alternatives with the pipe operator. " +
      "Intersection types merge object shapes with the ampersand. " +
      "Conditional types branch at the type level using the T extends U ? X : Y syntax. " +
      "Mapped types iterate over keys with the in keyof syntax to transform type properties. " +
      "Template literal types compose string literal types from other types. " +
      "Distributive conditional types spread automatically over union members.",
  },
  {
    id: "ts-interfaces",
    title: "TypeScript Interfaces",
    library: "typescript",
    content:
      "TypeScript interfaces define object shape contracts for structural typing. " +
      "An interface can extend multiple other interfaces to compose shapes. " +
      "The implements keyword enforces that a class satisfies an interface. " +
      "Properties can be declared optional with a question mark or immutable with readonly. " +
      "Index signatures allow objects with arbitrary string or number keys. " +
      "Because TypeScript uses structural typing, any compatible object shape satisfies an interface without explicit declaration.",
  },
  {
    id: "ts-decorators",
    title: "TypeScript Decorators",
    library: "typescript",
    content:
      "TypeScript decorators annotate and modify classes and their members using the at-sign syntax. " +
      "A class decorator receives the constructor function as its argument. " +
      "Method decorators receive the prototype, method name, and property descriptor. " +
      "Property decorators attach metadata to class fields. " +
      "The reflect-metadata package enables reading and writing decorator metadata at runtime. " +
      "Decorators require the experimentalDecorators option in tsconfig.json.",
  },
  {
    id: "ts-utilities",
    title: "TypeScript Utility Types",
    library: "typescript",
    content:
      "TypeScript ships with built-in utility types for common type transformations. " +
      "Partial<T> makes all properties of T optional. " +
      "Required<T> makes every property required. " +
      "Pick<T, K> builds a type with only the listed keys. " +
      "Omit<T, K> removes specific keys from a type. " +
      "Exclude<T, U> removes union members assignable to U. " +
      "Extract<T, U> keeps only members assignable to U. " +
      "ReturnType<T> infers a function's return type. " +
      "Parameters<T> yields a tuple of parameter types.",
  },

  // ── Node.js cluster (library: nodejs) ──────────────────────────────────────
  {
    id: "node-streams",
    title: "Node.js Streams",
    library: "nodejs",
    content:
      "Node.js streams process data in chunks rather than loading entire datasets into memory. " +
      "A Readable stream emits data events or supports async iteration. " +
      "A Writable stream accepts data via the write method and signals completion with end. " +
      "A Transform stream is both readable and writable and can modify data passing through it. " +
      "The pipeline utility chains streams with automatic error propagation. " +
      "Backpressure is the mechanism by which a slow Writable signals a fast Readable to pause.",
  },
  {
    id: "node-http",
    title: "Node.js HTTP",
    library: "nodejs",
    content:
      "The Node.js http and https modules build web servers and handle HTTP requests. " +
      "http.createServer accepts a callback receiving an IncomingMessage request and a ServerResponse response. " +
      "The request object exposes headers, method, URL, and a readable body stream. " +
      "The response writes a status code with writeHead and a body with write and end. " +
      "Routing dispatches requests by inspecting request.url and request.method. " +
      "For TLS the https module requires a key and certificate passed as options.",
  },
  {
    id: "node-events",
    title: "Node.js EventEmitter",
    library: "nodejs",
    content:
      "EventEmitter is the foundation of event-driven programming in Node.js. " +
      "The on method registers a persistent listener for a named event. " +
      "once registers a listener that fires only on the first emission. " +
      "emit triggers all registered listeners synchronously. " +
      "removeListener and off detach a specific listener function. " +
      "Exceeding the default maxListeners threshold emits a memory leak warning. " +
      "The error event must have at least one listener or Node.js throws an uncaught exception.",
  },
  {
    id: "node-fs",
    title: "Node.js File System",
    library: "nodejs",
    content:
      "The Node.js fs module provides file system access. " +
      "readFile loads a complete file into a Buffer or string asynchronously. " +
      "writeFile creates or overwrites a file with the provided content. " +
      "createReadStream returns a Readable stream suitable for large files. " +
      "The fs.promises API exposes promise-based versions of all operations. " +
      "path.join and path.resolve construct platform-safe file paths. " +
      "stat returns metadata including file size and last modification time.",
  },
  {
    id: "node-worker",
    title: "Node.js Worker Threads",
    library: "nodejs",
    content:
      "Worker threads run JavaScript on separate operating system threads for CPU-bound work. " +
      "The Worker constructor accepts a script path and an optional workerData value. " +
      "Inside a worker parentPort posts messages back to the main thread and isMainThread is false. " +
      "SharedArrayBuffer enables a memory region shared between threads without copying. " +
      "Atomics provides thread-safe read-modify-write operations on shared integer arrays. " +
      "receiveMessageOnPort performs a synchronous message receive without blocking the event loop.",
  },

  // ── SQL cluster (library: sql) ───────────────────────────────────────────────
  {
    id: "sql-joins",
    title: "SQL Joins",
    library: "sql",
    content:
      "SQL JOINs combine rows from two or more database tables based on a related column. " +
      "INNER JOIN returns only rows where the ON condition is satisfied in both tables. " +
      "LEFT JOIN returns all rows from the left table and matched rows from the right, with NULLs for unmatched right rows. " +
      "RIGHT JOIN mirrors LEFT JOIN. " +
      "FULL OUTER JOIN returns all rows from both tables. " +
      "A self-join joins a table to itself using two aliases. " +
      "CROSS JOIN produces the Cartesian product of all row combinations.",
  },
  {
    id: "sql-index",
    title: "SQL Indexes",
    library: "sql",
    content:
      "A SQL index is a data structure that speeds up row lookups without scanning the full table. " +
      "CREATE INDEX defines a named index on one or more columns. " +
      "The default B-tree index supports equality and range predicates efficiently. " +
      "Hash indexes optimise equality comparisons only. " +
      "A covering index includes every column a query needs, avoiding a table scan entirely. " +
      "EXPLAIN or EXPLAIN ANALYZE reveals the query execution plan and whether an index is used. " +
      "Indexes trade storage and write overhead for faster read performance.",
  },
  {
    id: "sql-transactions",
    title: "SQL Transactions",
    library: "sql",
    content:
      "A database transaction groups SQL statements into an atomic unit of work. " +
      "BEGIN or START TRANSACTION opens a transaction. " +
      "COMMIT persists all changes. " +
      "ROLLBACK undoes every change since the last BEGIN. " +
      "SAVEPOINT marks an intermediate checkpoint for partial rollback with ROLLBACK TO. " +
      "The ACID properties guarantee Atomicity, Consistency, Isolation, and Durability. " +
      "Isolation levels — READ COMMITTED, REPEATABLE READ, SERIALIZABLE — control concurrent access.",
  },
  {
    id: "sql-window",
    title: "SQL Window Functions",
    library: "sql",
    content:
      "SQL window functions compute a value for each row based on a related set of rows called a window. " +
      "The OVER clause defines the window with optional PARTITION BY and ORDER BY sub-clauses. " +
      "ROW_NUMBER assigns a unique sequential integer to each row within its partition. " +
      "RANK assigns the same number to tied rows but leaves gaps in the sequence. " +
      "DENSE_RANK assigns ranks without gaps. " +
      "LAG and LEAD access values from preceding or following rows. " +
      "FIRST_VALUE and LAST_VALUE retrieve boundary values of the window frame.",
  },
  {
    id: "sql-constraints",
    title: "SQL Constraints",
    library: "sql",
    content:
      "SQL constraints enforce data integrity rules on table columns. " +
      "PRIMARY KEY uniquely identifies each row and implies NOT NULL. " +
      "FOREIGN KEY references a primary key in another table and supports CASCADE and RESTRICT actions. " +
      "UNIQUE prevents duplicate values across rows in a column. " +
      "CHECK enforces an arbitrary boolean expression on column values. " +
      "NOT NULL disallows null entries. " +
      "DEFAULT supplies a fallback value when an INSERT omits the column. " +
      "Constraints can be added or dropped with ALTER TABLE.",
  },
];

// ---------------------------------------------------------------------------
// Query tiers
// ---------------------------------------------------------------------------

/** Easy — vocabulary is directly in the target doc; all 4 must reach top-3. */
const EASY_QUERIES: Array<{ query: string; expectedId: string; label: string }> = [
  {
    query: "useState useEffect functional component side effects render",
    expectedId: "react-hooks",
    label: "React Hooks",
  },
  {
    query: "TypeScript generic type parameter T extends constraint infer",
    expectedId: "ts-generics",
    label: "TS Generics",
  },
  {
    query: "Readable Writable Transform pipe pipeline backpressure chunks",
    expectedId: "node-streams",
    label: "Node Streams",
  },
  {
    query: "INNER JOIN LEFT JOIN ON clause combine rows tables",
    expectedId: "sql-joins",
    label: "SQL Joins",
  },
];

/**
 * Medium — each query has at least one strong competitor in the same cluster;
 * 4/6 must reach top-2.  The last two use near-paraphrase vocabulary that
 * TF-IDF may struggle with.
 */
const MEDIUM_QUERIES: Array<{ query: string; expectedId: string; label: string }> = [
  {
    query: "React Provider Consumer useContext sharing state subtree prop drilling",
    expectedId: "react-context",
    label: "React Context",
  },
  {
    query: "Redux useSelector useDispatch store reducers createSlice actions",
    expectedId: "react-redux",
    label: "React Redux",
  },
  {
    query: "union intersection conditional mapped types keyof TypeScript pipe",
    expectedId: "ts-types",
    label: "TS Advanced Types",
  },
  {
    query: "EventEmitter on emit once removeListener memory leak error event",
    expectedId: "node-events",
    label: "Node EventEmitter",
  },
  // Near-paraphrase — TF-IDF may rank these incorrectly
  {
    query: "atomic unit database operations that revert when any statement fails",
    expectedId: "sql-transactions",
    label: "SQL Transactions (near-paraphrase)",
  },
  {
    query: "compute value per row relative to surrounding rows in same partition",
    expectedId: "sql-window",
    label: "SQL Window Functions (near-paraphrase)",
  },
];

/**
 * Hard — must be exactly rank-1; 3/5 must pass.
 * Each uses vocabulary specific to the target doc inside a competitive cluster.
 */
const HARD_QUERIES: Array<{ query: string; expectedId: string; label: string }> = [
  {
    query: "interface implements structural typing optional readonly property shape",
    expectedId: "ts-interfaces",
    label: "TS Interfaces (P@1)",
  },
  {
    query: "Worker workerData parentPort isMainThread SharedArrayBuffer Atomics",
    expectedId: "node-worker",
    label: "Node Worker Threads (P@1)",
  },
  {
    query: "ROW_NUMBER RANK DENSE_RANK LAG LEAD PARTITION BY window frame",
    expectedId: "sql-window",
    label: "SQL Window Functions (P@1)",
  },
  {
    query: "Partial Required Pick Omit Exclude ReturnType Parameters utility type",
    expectedId: "ts-utilities",
    label: "TS Utility Types (P@1)",
  },
  {
    query: "controlled input onChange event.target value validation onSubmit FormData",
    expectedId: "react-forms",
    label: "React Forms (P@1)",
  },
];

/**
 * Pure-paraphrase queries — neural model suite only.
 * No vocabulary is shared with the target document, so keyword matching fails.
 */
const PARAPHRASE_QUERIES: Array<{ query: string; expectedId: string; label: string }> = [
  {
    query: "stop passing variables down through every component that doesn't need them",
    expectedId: "react-context",
    label: "React Context (paraphrase)",
  },
  {
    query: "reuse stateful logic between multiple independent components",
    expectedId: "react-hooks",
    label: "React Hooks (paraphrase)",
  },
  {
    query: "write one function that handles strings integers and objects without duplicating code",
    expectedId: "ts-generics",
    label: "TS Generics (paraphrase)",
  },
  {
    query: "process a file too large to load entirely into memory",
    expectedId: "node-streams",
    label: "Node Streams (paraphrase)",
  },
  {
    query: "ensure multiple related database writes either all succeed or all fail together",
    expectedId: "sql-transactions",
    label: "SQL Transactions (paraphrase)",
  },
];

const ALL_SCORED_QUERIES = [...EASY_QUERIES, ...MEDIUM_QUERIES, ...HARD_QUERIES];

// ---------------------------------------------------------------------------
// Helpers
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

function isNeuralModelAvailable(): Promise<boolean> {
  try {
    const require = createRequire(import.meta.url);
    require.resolve("@xenova/transformers");
    // Attempt a quick model resolution without actually loading — just check the package exists
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
}

async function indexCorpus(db: Database.Database, provider: EmbeddingProvider): Promise<void> {
  const insertDoc = db.prepare(
    `INSERT INTO documents (id, title, content, source_type, library) VALUES (?, ?, ?, 'manual', ?)`,
  );
  const insertChunk = db.prepare(
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
      insertChunk.run(chunkId, doc.id, chunks[i], i);

      // Enrich with title + library prefix (mirrors production indexDocument)
      const metaParts: string[] = [];
      if (doc.title) metaParts.push(doc.title);
      if (doc.library) metaParts.push(`Library: ${doc.library}`);
      const enriched =
        metaParts.length > 0 ? metaParts.join(" | ") + "\n\n" + chunks[i]! : chunks[i]!;

      const embedding = await provider.embed(enriched);
      const vecBuffer = Buffer.from(new Float32Array(embedding).buffer);
      insertEmbedding.run(chunkId, vecBuffer);
    }
  }
}

/**
 * Run all scored queries and return an array of { label, rank } objects.
 * rank is 1-based; -1 means the expected doc was not in the result set.
 */
async function runAllQueries(
  db: Database.Database,
  provider: EmbeddingProvider,
  queries: Array<{ query: string; expectedId: string; label: string }>,
): Promise<Array<{ label: string; rank: number; expectedId: string; topId: string }>> {
  const out = [];
  for (const { query, expectedId, label } of queries) {
    const { results } = await searchDocuments(db, provider, {
      query,
      limit: 20,
      analyticsEnabled: false,
    });
    const rank = results.findIndex((r) => r.documentId === expectedId) + 1; // 0 → not found → becomes 0 below
    const actualRank = rank === 0 ? -1 : rank;
    const topId = results[0]?.documentId ?? "(none)";
    out.push({ label, rank: actualRank, expectedId, topId });
  }
  return out;
}

function computeMrr(
  ranks: Array<{ label: string; rank: number; expectedId: string; topId: string }>,
): number {
  if (ranks.length === 0) return 0;
  const sum = ranks.reduce((acc, { rank }) => acc + (rank > 0 ? 1 / rank : 0), 0);
  return sum / ranks.length;
}

function printResultsTable(
  label: string,
  ranks: Array<{ label: string; rank: number; expectedId: string; topId: string }>,
): void {
  if (!process.env.DEBUG) return;
  const mrr = computeMrr(ranks);
  console.log(`\n  ══ ${label} ══`);
  console.log(`  ${"Query".padEnd(42)} ${"Expected".padEnd(26)} ${"Top result".padEnd(26)} Rank`);
  console.log(`  ${"-".repeat(100)}`);
  for (const r of ranks) {
    const rank = r.rank > 0 ? String(r.rank) : "—";
    const ok = r.rank === 1 ? "✓" : r.rank > 0 && r.rank <= 3 ? "~" : "✗";
    console.log(
      `  ${ok} ${r.label.padEnd(40)} ${r.expectedId.padEnd(26)} ${r.topId.padEnd(26)} ${rank}`,
    );
  }
  console.log(`  MRR: ${mrr.toFixed(4)} (${ranks.length} queries)\n`);
}

// ============================================================================
// Suite A: TF-IDF embeddings — always runs, no network required
// ============================================================================
describe.runIf(isVecAvailable())(
  "retrieval quality [harder benchmark]: TF-IDF embeddings + sqlite-vec",
  () => {
    let db: Database.Database;
    let provider: TfIdfEmbeddingProvider;

    beforeAll(async () => {
      const allTexts = [
        ...CORPUS.map((d) => `${d.title} ${d.content}`),
        ...ALL_SCORED_QUERIES.map((q) => q.query),
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

    // ── Easy tier ──────────────────────────────────────────────────────────
    it("easy tier: all 4 expected docs in top-3", async () => {
      const ranks = await runAllQueries(db, provider, EASY_QUERIES);
      printResultsTable("Easy tier", ranks);

      for (const r of ranks) {
        expect(r.rank, `"${r.label}" expected in top-3 (got rank ${r.rank})`).toBeGreaterThan(0);
        expect(r.rank, `"${r.label}" expected in top-3 (got rank ${r.rank})`).toBeLessThanOrEqual(
          3,
        );
      }
    });

    // ── Medium tier ────────────────────────────────────────────────────────
    it("medium tier: at least 4 of 6 expected docs in top-2", async () => {
      const ranks = await runAllQueries(db, provider, MEDIUM_QUERIES);
      printResultsTable("Medium tier", ranks);

      const hits = ranks.filter((r) => r.rank > 0 && r.rank <= 2).length;
      if (process.env.DEBUG) {
        console.log(`  medium hits (top-2): ${hits}/${MEDIUM_QUERIES.length}`);
        for (const r of ranks.filter((r) => r.rank <= 0 || r.rank > 2)) {
          console.log(`  miss: "${r.label}" expected=${r.expectedId} actual_rank=${r.rank}`);
        }
      }
      expect(hits, `medium top-2 hits: ${hits}/6`).toBeGreaterThanOrEqual(4);
    });

    // ── Hard tier ──────────────────────────────────────────────────────────
    it("hard tier: at least 3 of 5 expected docs at rank-1 (P@1)", async () => {
      const ranks = await runAllQueries(db, provider, HARD_QUERIES);
      printResultsTable("Hard tier", ranks);

      const hits = ranks.filter((r) => r.rank === 1).length;
      if (process.env.DEBUG) {
        console.log(`  hard P@1 hits: ${hits}/${HARD_QUERIES.length}`);
        for (const r of ranks.filter((r) => r.rank !== 1)) {
          console.log(`  miss: "${r.label}" expected=${r.expectedId} actual_rank=${r.rank}`);
        }
      }
      expect(hits, `hard P@1 hits: ${hits}/5`).toBeGreaterThanOrEqual(3);
    });

    // ── MRR across all 15 queries ──────────────────────────────────────────
    it("overall MRR ≥ 0.65 across all 15 queries", async () => {
      const ranks = await runAllQueries(db, provider, ALL_SCORED_QUERIES);
      const mrr = computeMrr(ranks);
      printResultsTable("All 15 queries", ranks);
      if (process.env.DEBUG) console.log(`  ★ MRR: ${mrr.toFixed(4)}`);
      expect(mrr, `MRR = ${mrr.toFixed(4)}, expected ≥ 0.65`).toBeGreaterThanOrEqual(0.65);
    });

    // ── Library-filter precision ───────────────────────────────────────────
    it("library filter returns only docs from the requested library", async () => {
      for (const library of ["react", "typescript", "nodejs", "sql"] as const) {
        const { results } = await searchDocuments(db, provider, {
          query: "type state function data table",
          library,
          limit: 10,
          analyticsEnabled: false,
        });

        if (results.length === 0) continue; // no results is fine; just ensure no leakage

        const leaked = results.filter((r) => r.library !== library);
        if (process.env.DEBUG && leaked.length > 0) {
          console.log(
            `  library="${library}" leakage: ${leaked.map((r) => `${r.documentId}(${r.library})`).join(", ")}`,
          );
        }
        expect(
          leaked,
          `library="${library}" filter leaked ${leaked.length} docs from other libraries`,
        ).toHaveLength(0);
      }
    });

    // ── Hybrid search is used ──────────────────────────────────────────────
    it("hybrid search (RRF) method is active", async () => {
      const { results } = await searchDocuments(db, provider, {
        query: "React state component functional",
        limit: 8,
        analyticsEnabled: false,
      });
      const methods = new Set(results.map((r) => r.scoreExplanation.method));
      if (process.env.DEBUG) console.log(`  search methods: ${[...methods].join(", ")}`);
      expect(methods.has("hybrid")).toBe(true);
    });

    // ── Title boost is applied ─────────────────────────────────────────────
    it("title boost elevates docs whose title matches the query", async () => {
      const { results } = await searchDocuments(db, provider, {
        query: "TypeScript Utility Types",
        limit: 10,
        analyticsEnabled: false,
      });
      const target = results.find((r) => r.documentId === "ts-utilities");
      expect(target, "ts-utilities should appear in results").toBeDefined();
      const hasTitleBoost = target!.scoreExplanation.boostFactors.some((f) =>
        f.includes("title_match"),
      );
      if (process.env.DEBUG)
        console.log(`  title boost factors: ${target!.scoreExplanation.boostFactors.join(", ")}`);
      expect(hasTitleBoost, "title_match boost expected").toBe(true);
      expect(results[0]!.documentId, "ts-utilities should be rank 1 with title boost").toBe(
        "ts-utilities",
      );
    });
  },
);

// ============================================================================
// Suite B: Neural model (all-MiniLM-L6-v2) — conditional, higher thresholds
// ============================================================================
describe.runIf(isVecAvailable())(
  "retrieval quality [harder benchmark]: neural embeddings (all-MiniLM-L6-v2) — skipped if model unavailable",
  () => {
    let db: Database.Database;
    let neuralAvailable = false;

    // We build a lazy check — if the model fails to load we skip via `neuralAvailable`
    beforeAll(async () => {
      neuralAvailable = await isNeuralModelAvailable();
      if (!neuralAvailable) return;

      // Dynamic import to avoid loading transformers during TF-IDF suite
      const { LocalEmbeddingProvider } = await import("../../src/providers/local.js");
      const provider = new LocalEmbeddingProvider();

      // Prime the model (downloads if not cached; takes up to 60 s on first run)
      try {
        await provider.embed("warmup");
      } catch {
        neuralAvailable = false;
        return;
      }

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

    it("neural: overall MRR ≥ 0.82 across all 15 vocab-match queries", async () => {
      if (!neuralAvailable) {
        console.log("  [skip] all-MiniLM-L6-v2 model not available");
        return;
      }
      const { LocalEmbeddingProvider } = await import("../../src/providers/local.js");
      const provider = new LocalEmbeddingProvider();
      const ranks = await runAllQueries(db, provider, ALL_SCORED_QUERIES);
      const mrr = computeMrr(ranks);
      printResultsTable("Neural — vocab-match queries", ranks);
      if (process.env.DEBUG) console.log(`  ★ Neural MRR (vocab): ${mrr.toFixed(4)}`);
      expect(mrr, `Neural MRR = ${mrr.toFixed(4)}, expected ≥ 0.82`).toBeGreaterThanOrEqual(0.82);
    });

    it("neural: paraphrase queries — at least 3/5 in top-3 (semantic understanding required)", async () => {
      if (!neuralAvailable) {
        console.log("  [skip] all-MiniLM-L6-v2 model not available");
        return;
      }
      const { LocalEmbeddingProvider } = await import("../../src/providers/local.js");
      const provider = new LocalEmbeddingProvider();
      const ranks = await runAllQueries(db, provider, PARAPHRASE_QUERIES);
      printResultsTable("Neural — paraphrase queries", ranks);

      const hits = ranks.filter((r) => r.rank > 0 && r.rank <= 3).length;
      if (process.env.DEBUG)
        console.log(`  paraphrase top-3 hits: ${hits}/${PARAPHRASE_QUERIES.length}`);
      // all-MiniLM-L6-v2 (22M params) achieves 3/5 on cross-domain programming paraphrase.
      // TF-IDF scores 0–1/5 on these same queries (no vocabulary overlap) — raise this
      // threshold as larger / domain-adapted models are adopted.
      expect(
        hits,
        `Neural paraphrase top-3 hits: ${hits}/5 — TF-IDF cannot pass this`,
      ).toBeGreaterThanOrEqual(3);
    });

    it("neural: all 4 easy queries at rank-1 (P@1 — neural should be perfect on easy tier)", async () => {
      if (!neuralAvailable) {
        console.log("  [skip] all-MiniLM-L6-v2 model not available");
        return;
      }
      const { LocalEmbeddingProvider } = await import("../../src/providers/local.js");
      const provider = new LocalEmbeddingProvider();
      const ranks = await runAllQueries(db, provider, EASY_QUERIES);
      printResultsTable("Neural — easy tier", ranks);

      for (const r of ranks) {
        expect(r.rank, `Neural "${r.label}" expected at rank-1 (got ${r.rank})`).toBe(1);
      }
    });
  },
);
