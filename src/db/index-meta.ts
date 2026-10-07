import type Database from "better-sqlite3";
import { ConfigError, DatabaseError, EmbeddingError } from "../errors.js";
import { getLogger } from "../logger.js";
import { MAX_EMBEDDING_DIMENSIONS } from "../providers/dimensions.js";
import type { EmbeddingProvider } from "../providers/embedding.js";

/** Key/value table that records facts about how the indexes were built. */
export const INDEX_META_DDL = `
  CREATE TABLE IF NOT EXISTS index_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`;

/** The guidance shown whenever the vector index does not match the embedding model. */
export const REBUILD_VECTOR_INDEX_HINT =
  "Run `libscope reindex --rebuild` to rebuild the vector index with the configured embedding model.";

/** The embedding provider, model and vector size that built (or will build) the vector index. */
export interface EmbeddingIndexIdentity {
  provider?: string | undefined;
  model?: string | undefined;
  dimensions?: number | undefined;
}

type IdentityKey = keyof EmbeddingIndexIdentity;

const META_KEYS: Record<IdentityKey, string> = {
  provider: "embedding_provider",
  model: "embedding_model",
  dimensions: "embedding_dimensions",
};

const IDENTITY_KEYS: IdentityKey[] = ["provider", "model", "dimensions"];

/** A vector size, or undefined when it is 0, negative or not a number (unknown). */
function knownSize(dimensions: number | undefined): number | undefined {
  return dimensions !== undefined && dimensions > 0 ? dimensions : undefined;
}

/** Build an identity from a provider, or from a bare vector size. */
export function toEmbeddingIdentity(
  source: number | Pick<EmbeddingProvider, "name" | "model" | "dimensions">,
): EmbeddingIndexIdentity {
  if (typeof source === "number") return { dimensions: source };
  return { provider: source.name, model: source.model, dimensions: source.dimensions };
}

/** Read the stored identity. Returns an empty object when nothing is recorded. */
export function readEmbeddingIdentity(db: Database.Database): EmbeddingIndexIdentity {
  let rows: Array<{ key: string; value: string }>;
  try {
    rows = db.prepare("SELECT key, value FROM index_meta").all() as Array<{
      key: string;
      value: string;
    }>;
  } catch {
    return {}; // index_meta does not exist before migration 18
  }
  const values = new Map(rows.map((r) => [r.key, r.value]));
  return {
    provider: values.get(META_KEYS.provider),
    model: values.get(META_KEYS.model),
    dimensions: knownSize(Number(values.get(META_KEYS.dimensions))),
  };
}

/**
 * Store an identity. Fields that are undefined are removed when `replace` is true and
 * left as they are otherwise. Only changed rows are written.
 */
export function writeEmbeddingIdentity(
  db: Database.Database,
  identity: EmbeddingIndexIdentity,
  replace: boolean,
): void {
  const stored = readEmbeddingIdentity(db);
  const changed = IDENTITY_KEYS.filter(
    (k) => identity[k] !== stored[k] && (replace || identity[k] !== undefined),
  );
  if (changed.length === 0) return;
  db.exec(INDEX_META_DDL);
  const upsert = db.prepare(
    "INSERT INTO index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const remove = db.prepare("DELETE FROM index_meta WHERE key = ?");
  for (const k of changed) {
    const value = identity[k];
    if (value === undefined) remove.run(META_KEYS[k]);
    else upsert.run(META_KEYS[k], String(value));
  }
}

/**
 * Vector size of the existing chunk_embeddings table: undefined when the table does
 * not exist, 0 when it exists but its size cannot be read from its definition.
 */
export function getVectorTableDimensions(db: Database.Database): number | undefined {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chunk_embeddings'").get() as
    | { sql: string | null }
    | undefined;
  if (!row) return undefined;
  const match = /float\[(\d+)\]/.exec(row.sql ?? "");
  return match ? Number(match[1]) : 0;
}

/** Human-readable form, for example `ollama/nomic-embed-text, 768 dimensions`. */
export function describeEmbeddingIdentity(identity: EmbeddingIndexIdentity): string {
  const parts = [[identity.provider, identity.model].filter(Boolean).join("/")];
  if (identity.dimensions) parts.push(`${identity.dimensions} dimensions`);
  return parts.filter(Boolean).join(", ") || "unknown";
}

/** True when a field is known on both sides and differs. */
function identitiesConflict(a: EmbeddingIndexIdentity, b: EmbeddingIndexIdentity): boolean {
  return IDENTITY_KEYS.some((k) => {
    const left = a[k];
    const right = b[k];
    return Boolean(left) && Boolean(right) && left !== right;
  });
}

/**
 * Check the configured provider/model/vector size against the existing vector index and
 * record what is known. Throws a ConfigError that names both when they differ.
 */
export function checkVectorIndexIdentity(
  db: Database.Database,
  configured: EmbeddingIndexIdentity,
  tableDimensions: number,
): void {
  const stored = readEmbeddingIdentity(db);
  const index: EmbeddingIndexIdentity = {
    ...stored,
    dimensions: knownSize(tableDimensions) ?? stored.dimensions,
  };
  if (identitiesConflict(index, configured)) {
    throw new ConfigError(
      `The vector index (${describeEmbeddingIdentity(index)}) does not match ` +
        `the configured embedding model (${describeEmbeddingIdentity(configured)}). ` +
        REBUILD_VECTOR_INDEX_HINT,
    );
  }
  writeEmbeddingIdentity(
    db,
    {
      provider: configured.provider ?? index.provider,
      model: configured.model ?? index.model,
      dimensions: index.dimensions ?? knownSize(configured.dimensions),
    },
    false,
  );
}

/** Throw a DatabaseError unless `dimensions` is a usable vector size. */
export function assertValidVectorDimensions(dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions <= 0 || dimensions > MAX_EMBEDDING_DIMENSIONS) {
    throw new DatabaseError(
      `Invalid vector dimensions: must be a positive integer <= ${MAX_EMBEDDING_DIMENSIONS}`,
    );
  }
}

/** Create chunk_embeddings with the given vector size (no-op if it already exists). */
export function execCreateVectorTable(db: Database.Database, dimensions: number): void {
  assertValidVectorDimensions(dimensions);
  // dimensions is validated as a positive integer above, so interpolation is safe here
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_embeddings USING vec0(
      chunk_id TEXT PRIMARY KEY,
      embedding float[${dimensions}]
    );
  `);
}

/**
 * Drop and recreate chunk_embeddings for the given provider, and record the provider,
 * model and vector size. All stored vectors are removed; re-embed the chunks afterwards.
 * One probe text is embedded first to learn the vector size and to confirm that the model
 * works, so a misconfigured model fails before the existing vectors are dropped.
 */
export async function rebuildVectorTable(
  db: Database.Database,
  provider: EmbeddingProvider,
): Promise<EmbeddingIndexIdentity> {
  const dimensions = (await provider.embed("dimension probe")).length;
  if (provider.dimensions && provider.dimensions !== dimensions) {
    throw new EmbeddingError(
      `Expected embedding dimension ${provider.dimensions}, got ${dimensions} from ${describeEmbeddingIdentity(toEmbeddingIdentity(provider))}.`,
    );
  }
  assertValidVectorDimensions(dimensions);
  const identity: EmbeddingIndexIdentity = { ...toEmbeddingIdentity(provider), dimensions };

  const rebuild = db.transaction(() => {
    db.exec("DROP TABLE IF EXISTS chunk_embeddings");
    execCreateVectorTable(db, dimensions);
    writeEmbeddingIdentity(db, identity, true);
  });
  try {
    rebuild();
  } catch (err) {
    throw new DatabaseError(
      "Could not rebuild the vector table. The sqlite-vec extension must be available.",
      err,
    );
  }
  getLogger().info({ ...identity }, "Vector table rebuilt");
  return identity;
}
