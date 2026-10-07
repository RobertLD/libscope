import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../providers/embedding.js";
import {
  getVectorTableDimensions,
  readEmbeddingIdentity,
  toEmbeddingIdentity,
  type EmbeddingIndexIdentity,
} from "../db/index-meta.js";
import { getLogger } from "../logger.js";
import { getStats, type OverviewStats } from "./analytics.js";
import { listInstalledPacks, type InstalledPack } from "./packs.js";
import { getTopicStats, type TopicStats } from "./topics.js";

export type HealthStatus = "ok" | "error";

export interface Overview {
  stats: OverviewStats;
  /** Every topic with its document count. */
  topics: TopicStats[];
  packs: InstalledPack[];
  index: {
    /** Provider/model/vector size recorded for the vector index (empty when none). */
    stored: EmbeddingIndexIdentity;
    /** The configured embedding provider, when one was given. */
    configured?: EmbeddingIndexIdentity | undefined;
    /** Vector size of chunk_embeddings; undefined when the table does not exist. */
    vectorTableDimensions?: number | undefined;
  };
  health: {
    database: HealthStatus;
    /** Full-text (keyword) index. */
    fts: HealthStatus;
    /** True when the vector table exists, so semantic search can run. */
    vectorSearch: boolean;
  };
}

function check(name: string, fn: () => unknown): HealthStatus {
  try {
    fn();
    return "ok";
  } catch (err) {
    getLogger().warn({ err }, `Health check failed: ${name}`);
    return "error";
  }
}

/**
 * Everything a user or assistant needs to orient themselves, computed in one place:
 * counts, topics, installed packs, which embedding model built the index, and health.
 * Replaces the separate stats / health-check / list-topics / list-packs views.
 */
export function getOverview(db: Database.Database, provider?: EmbeddingProvider): Overview {
  const vectorTableDimensions = getVectorTableDimensions(db);
  return {
    stats: getStats(db),
    topics: getTopicStats(db),
    packs: listInstalledPacks(db),
    index: {
      stored: readEmbeddingIdentity(db),
      ...(provider ? { configured: toEmbeddingIdentity(provider) } : {}),
      ...(vectorTableDimensions === undefined ? {} : { vectorTableDimensions }),
    },
    health: {
      database: check("database", () => db.prepare("SELECT 1").get()),
      fts: check("fts", () => db.prepare("SELECT COUNT(*) FROM chunks_fts").get()),
      vectorSearch: vectorTableDimensions !== undefined,
    },
  };
}
