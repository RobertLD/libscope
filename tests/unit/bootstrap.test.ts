import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LibScopeConfig } from "../../src/config.js";
import { bootstrap, mergeConfig, UnavailableEmbeddingProvider } from "../../src/core/bootstrap.js";
import { getVectorTableDimensions } from "../../src/db/index-meta.js";
import { ConfigError } from "../../src/errors.js";
import { initLogger } from "../../src/logger.js";
import { createTestDb } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";

initLogger("silent");

function config(provider = "local"): LibScopeConfig {
  return {
    embedding: { provider },
    llm: {},
    database: {},
    indexing: { maxDocumentSize: 1000, allowPrivateUrls: false, allowSelfSignedCerts: false },
    logging: { level: "silent" },
  } as LibScopeConfig;
}

class EightDimProvider extends MockEmbeddingProvider {
  override readonly dimensions = 8 as 4;
}

describe("bootstrap", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "libscope-bootstrap-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("opens and migrates the database and creates the vector table", () => {
    const dbPath = join(dir, "kb.db");
    const app = bootstrap({ dbPath, config: config(), provider: new MockEmbeddingProvider() });
    expect(app.dbPath).toBe(dbPath);
    const row = app.db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as {
      v: number;
    };
    expect(row.v).toBeGreaterThan(0);
    expect(getVectorTableDimensions(app.db)).toBe(4);
    app.close();
    app.close();
    expect(app.db.open).toBe(false);
  });

  it("uses database.path from config when no dbPath is given", () => {
    const dbPath = join(dir, "from-config.db");
    const app = bootstrap({
      config: config(),
      configOverrides: { database: { path: dbPath } },
      provider: new MockEmbeddingProvider(),
    });
    expect(app.dbPath).toBe(dbPath);
    app.close();
  });

  it("fails on an embedding model mismatch and closes the database it opened", () => {
    const dbPath = join(dir, "kb.db");
    bootstrap({ dbPath, config: config(), provider: new MockEmbeddingProvider() }).close();
    expect(() =>
      bootstrap({
        dbPath,
        config: config(),
        provider: new EightDimProvider(),
        vectorTable: "best-effort",
      }),
    ).toThrow(ConfigError);
  });

  it("keeps going without an embedding provider when it is not required", async () => {
    const app = bootstrap({
      dbPath: join(dir, "kb.db"),
      config: config("openai"),
      requireProvider: false,
    });
    expect(app.provider).toBeInstanceOf(UnavailableEmbeddingProvider);
    await expect(app.provider.embed("x")).rejects.toBeInstanceOf(ConfigError);
    expect(getVectorTableDimensions(app.db)).toBeUndefined();
    app.close();
    expect(() => bootstrap({ dbPath: join(dir, "kb2.db"), config: config("openai") })).toThrow(
      ConfigError,
    );
  });

  it("uses an injected database without closing it", () => {
    const db = createTestDb();
    const app = bootstrap({
      db,
      config: config(),
      provider: new MockEmbeddingProvider(),
      vectorTable: "skip",
    });
    app.close();
    expect(db.open).toBe(true);
    db.close();
  });
});

describe("mergeConfig", () => {
  it("merges each section one level deep", () => {
    const merged = mergeConfig(config(), { indexing: { allowPrivateUrls: true } });
    expect(merged.indexing).toEqual({
      maxDocumentSize: 1000,
      allowPrivateUrls: true,
      allowSelfSignedCerts: false,
    });
    expect(mergeConfig(config())).toEqual(config());
  });
});
