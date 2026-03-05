import type Database from "better-sqlite3";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  resolve as pathResolve,
  isAbsolute as pathIsAbsolute,
  basename,
  relative,
  join as pathJoin,
  extname,
} from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { ValidationError, FetchError } from "../errors.js";
import { getLogger } from "../logger.js";
import { chunkContent, chunkContentStreaming, STREAMING_THRESHOLD } from "./indexing.js";
import { getParserForFile, getSupportedExtensions } from "./parsers/index.js";
import { suggestTagsFromText } from "./tags.js";
import { fetchAndConvert } from "./url-fetcher.js";

export interface PackDocument {
  title: string;
  content: string;
  source: string;
  topics?: string[] | undefined;
  tags?: string[] | undefined;
}

export interface KnowledgePack {
  name: string;
  version: string;
  description: string;
  documents: PackDocument[];
  metadata: {
    author: string;
    license: string;
    createdAt: string;
  };
}

export interface PackInfo {
  name: string;
  version: string;
  description: string;
  docCount: number;
}

export interface InstalledPack {
  name: string;
  version: string;
  description: string | null;
  docCount: number;
  installedAt: string;
}

export interface InstallResult {
  packName: string;
  documentsInstalled: number;
  alreadyInstalled: boolean;
  errors: number;
}

export interface InstallOptions {
  registryUrl?: string | undefined;
  /** Number of documents to embed and insert per batch. Default: 10. */
  batchSize?: number | undefined;
  /** Skip the first N documents (for resuming a partial install). Default: 0. */
  resumeFrom?: number | undefined;
  /** Maximum number of batches to embed concurrently. Default: 4. */
  concurrency?: number | undefined;
  /** Called after each batch of documents is processed. */
  onProgress?: ((current: number, total: number, docTitle: string) => void) | undefined;
}

export interface CreatePackOptions {
  name: string;
  version?: string | undefined;
  description?: string | undefined;
  author?: string | undefined;
  license?: string | undefined;
  topic?: string | undefined;
  outputPath?: string | undefined;
}

export interface CreatePackFromSourceOptions {
  /** Pack name (required). */
  name: string;
  /** One or more source paths (directories or files) or URLs. */
  from: string[];
  version?: string | undefined;
  description?: string | undefined;
  author?: string | undefined;
  license?: string | undefined;
  outputPath?: string | undefined;
  /** Only include files with these extensions (e.g. [".md", ".html"]). Defaults to all supported. */
  extensions?: string[] | undefined;
  /** Glob-style patterns to exclude (matched against the relative path from the source root). */
  exclude?: string[] | undefined;
  /** Walk directories recursively (default: true). */
  recursive?: boolean | undefined;
  /** Called for each file processed, for progress reporting. */
  onProgress?: ((info: { file: string; index: number; total: number }) => void) | undefined;
}

const DEFAULT_REGISTRY_URL = "https://raw.githubusercontent.com/libscope/packs/main/registry.json";

/** Gzip magic number: first two bytes of a gzip stream. */
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

/** Check if a filename indicates gzip compression (.gz or .json.gz). */
function isGzipPath(filePath: string): boolean {
  return filePath.endsWith(".gz");
}

/** Write a pack to disk, gzip-compressing if the path ends in .gz. */
function writePackFile(filePath: string, pack: KnowledgePack): void {
  const json = JSON.stringify(pack, null, 2);
  if (isGzipPath(filePath)) {
    writeFileSync(filePath, gzipSync(Buffer.from(json, "utf-8")));
  } else {
    writeFileSync(filePath, json, "utf-8");
  }
}

/** Read a pack file, auto-detecting gzip by magic bytes or extension. */
function readPackFile(filePath: string): string {
  const raw = readFileSync(filePath);
  if (raw.length >= 2 && raw[0] === GZIP_MAGIC[0] && raw[1] === GZIP_MAGIC[1]) {
    return gunzipSync(raw).toString("utf-8");
  }
  return raw.toString("utf-8");
}

/** Validate that a registry URL uses https and is not a private IP. */
function validateRegistryUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError("Invalid registry URL");
  }
  if (parsed.protocol !== "https:") {
    throw new ValidationError("Registry URL must use https");
  }
  const host = parsed.hostname;
  if (
    host === "localhost" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.startsWith("169.254.")
  ) {
    throw new ValidationError("Registry URL must not point to a private/internal address");
  }
}

function validatePack(data: unknown): KnowledgePack {
  if (typeof data !== "object" || data === null) {
    throw new ValidationError("Invalid pack format: expected an object");
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj["name"] !== "string" || !obj["name"]) {
    throw new ValidationError("Invalid pack format: missing or invalid 'name'");
  }
  if (typeof obj["version"] !== "string" || !obj["version"]) {
    throw new ValidationError("Invalid pack format: missing or invalid 'version'");
  }
  if (typeof obj["description"] !== "string") {
    throw new ValidationError("Invalid pack format: missing or invalid 'description'");
  }
  if (!Array.isArray(obj["documents"])) {
    throw new ValidationError("Invalid pack format: 'documents' must be an array");
  }

  const documents = obj["documents"] as unknown[];
  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    if (typeof doc !== "object" || doc === null) {
      throw new ValidationError(`Invalid pack format: document at index ${i} is not an object`);
    }
    const d = doc as Record<string, unknown>;
    if (typeof d["title"] !== "string" || !d["title"]) {
      throw new ValidationError(
        `Invalid pack format: document at index ${i} missing or invalid 'title'`,
      );
    }
    if (typeof d["content"] !== "string" || !d["content"]) {
      throw new ValidationError(
        `Invalid pack format: document at index ${i} missing or invalid 'content'`,
      );
    }
    if (typeof d["source"] !== "string") {
      throw new ValidationError(
        `Invalid pack format: document at index ${i} missing or invalid 'source'`,
      );
    }
  }

  const metadata = obj["metadata"];
  if (typeof metadata !== "object" || metadata === null) {
    throw new ValidationError("Invalid pack format: missing or invalid 'metadata'");
  }
  const meta = metadata as Record<string, unknown>;
  if (typeof meta["author"] !== "string") {
    throw new ValidationError("Invalid pack format: metadata missing 'author'");
  }
  if (typeof meta["license"] !== "string") {
    throw new ValidationError("Invalid pack format: metadata missing 'license'");
  }
  if (typeof meta["createdAt"] !== "string") {
    throw new ValidationError("Invalid pack format: metadata missing 'createdAt'");
  }

  return data as KnowledgePack;
}

/** List available packs from a remote registry. */
export async function listAvailablePacks(registryUrl?: string): Promise<PackInfo[]> {
  const url = registryUrl ?? DEFAULT_REGISTRY_URL;
  const log = getLogger();

  validateRegistryUrl(url);

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new FetchError(`Registry returned ${response.status}: ${response.statusText}`);
    }
    const data: unknown = await response.json();
    if (!Array.isArray(data)) {
      throw new ValidationError("Registry response is not an array");
    }

    return (data as Array<Record<string, unknown>>).map((entry) => {
      const name = entry["name"];
      const version = entry["version"];
      const description = entry["description"];
      const docCount = entry["docCount"] ?? entry["doc_count"];
      return {
        name: typeof name === "string" ? name : "",
        version: typeof version === "string" ? version : "",
        description: typeof description === "string" ? description : "",
        docCount: typeof docCount === "number" ? docCount : 0,
      };
    });
  } catch (err) {
    log.error({ err, url }, "Failed to fetch pack registry");
    if (err instanceof ValidationError) throw err;
    if (err instanceof FetchError) throw err;
    throw new FetchError(
      `Failed to fetch pack registry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Install a pack from a local JSON file path or registry name. */
export async function installPack(
  db: Database.Database,
  provider: EmbeddingProvider,
  packNameOrPath: string,
  options?: InstallOptions,
): Promise<InstallResult> {
  const log = getLogger();
  let pack: KnowledgePack;

  // Try loading as a local file first (supports .json and .json.gz)
  if (packNameOrPath.endsWith(".json") || packNameOrPath.endsWith(".json.gz")) {
    const resolved = pathResolve(packNameOrPath);
    // Prevent path traversal: if a relative path is given, ensure it resolves within CWD
    if (!pathIsAbsolute(packNameOrPath) && !resolved.startsWith(process.cwd())) {
      throw new ValidationError("Pack file path must be within the current working directory");
    }
    try {
      const raw = readPackFile(resolved);
      const parsed: unknown = JSON.parse(raw);
      pack = validatePack(parsed);
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(
        `Failed to read pack file "${packNameOrPath}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    // Fetch from registry
    const registryUrl = options?.registryUrl ?? DEFAULT_REGISTRY_URL;

    validateRegistryUrl(registryUrl);
    const baseUrl = registryUrl.replace(/\/[^/]+$/, "");
    const packUrl = `${baseUrl}/${packNameOrPath}.json`;
    try {
      const response = await fetch(packUrl, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        throw new FetchError(`Pack fetch returned ${response.status}: ${response.statusText}`);
      }
      const data: unknown = await response.json();
      pack = validatePack(data);
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      if (err instanceof FetchError) throw err;
      throw new FetchError(
        `Failed to fetch pack "${packNameOrPath}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Check if already installed
  const existing = db.prepare("SELECT name FROM packs WHERE name = ?").get(pack.name) as
    | { name: string }
    | undefined;

  if (existing) {
    log.info({ pack: pack.name }, "Pack already installed");
    return { packName: pack.name, documentsInstalled: 0, alreadyInstalled: true, errors: 0 };
  }

  const batchSize = options?.batchSize ?? 10;
  const concurrency = options?.concurrency ?? 4;
  const resumeFrom = options?.resumeFrom ?? 0;
  const onProgress = options?.onProgress;
  const total = pack.documents.length;

  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new ValidationError("batchSize must be a positive integer");
  }
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new ValidationError("concurrency must be a positive integer");
  }
  if (!Number.isInteger(resumeFrom) || resumeFrom < 0) {
    throw new ValidationError("resumeFrom must be a non-negative integer");
  }
  if (resumeFrom > total) {
    throw new ValidationError(
      "resumeFrom cannot be greater than the total number of documents in the pack",
    );
  }

  const docs = resumeFrom > 0 ? pack.documents.slice(resumeFrom) : pack.documents;

  log.info(
    { pack: pack.name, docCount: total, batchSize, concurrency, resumeFrom },
    "Installing pack",
  );

  // Insert the pack record first (documents.pack_name has FK to packs.name)
  db.prepare("INSERT INTO packs (name, version, description, doc_count) VALUES (?, ?, ?, 0)").run(
    pack.name,
    pack.version,
    pack.description,
  );

  // Prepare statements once (reused across all batches)
  const insertDoc = db.prepare(`
    INSERT INTO documents (id, source_type, title, content, url, submitted_by, content_hash, pack_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertChunk = db.prepare(`
    INSERT INTO chunks (id, document_id, content, chunk_index)
    VALUES (?, ?, ?, ?)
  `);
  const insertEmbedding = db.prepare(`
    INSERT INTO chunk_embeddings (chunk_id, embedding)
    VALUES (?, ?)
  `);

  // Slice docs into batches by index only — chunks are computed lazily when each
  // batch is scheduled, so we never hold all chunks in memory simultaneously.
  type DocChunkInfo = {
    doc: PackDocument;
    docId: string;
    contentHash: string;
    chunks: string[];
    chunkOffset: number; // offset into allChunks for this batch
  };
  type BatchData = {
    batchDocs: PackDocument[];
  };
  type ResolvedBatch = {
    docInfos: DocChunkInfo[];
    allChunks: string[];
  };

  const batches: BatchData[] = [];
  for (let batchStart = 0; batchStart < docs.length; batchStart += batchSize) {
    batches.push({ batchDocs: docs.slice(batchStart, batchStart + batchSize) });
  }

  /** Chunk a batch's documents on demand, right before embedding. */
  function resolveBatch(batch: BatchData): ResolvedBatch {
    const docInfos: DocChunkInfo[] = [];
    const allChunks: string[] = [];
    for (const doc of batch.batchDocs) {
      const contentHash = createHash("sha256").update(doc.content).digest("hex");
      const useStreaming = doc.content.length > STREAMING_THRESHOLD;
      const chunks = useStreaming ? chunkContentStreaming(doc.content) : chunkContent(doc.content);
      docInfos.push({
        doc,
        docId: randomUUID(),
        contentHash,
        chunks,
        chunkOffset: allChunks.length,
      });
      allChunks.push(...chunks);
    }
    return { docInfos, allChunks };
  }

  // Phase 2 & 3: Embed batches concurrently (up to `concurrency` at a time),
  // inserting each batch into the DB in order as embeddings complete.
  // This maximises provider throughput while keeping inserts serialised (SQLite requirement).
  let installed = 0;
  let errors = 0;
  let processedCount = resumeFrom;

  type EmbedResult = { resolved: ResolvedBatch; embeddings: number[][]; success: boolean };
  const embedResults: Array<EmbedResult | undefined> = Array.from<EmbedResult | undefined>({
    length: batches.length,
  });
  let nextInsertIdx = 0;

  /** Insert completed batches in index order, advancing nextInsertIdx. */
  function flushInserts(): void {
    while (nextInsertIdx < batches.length && embedResults[nextInsertIdx] !== undefined) {
      const i = nextInsertIdx++;
      const { resolved: batch, embeddings, success } = embedResults[i]!;
      const result = { embeddings, success };

      if (!result.success) {
        errors += batch.docInfos.length;
      } else {
        let batchInstalled = 0;
        const doInsert = db.transaction(() => {
          batchInstalled = 0;
          for (const info of batch.docInfos) {
            insertDoc.run(
              info.docId,
              "library",
              info.doc.title,
              info.doc.content,
              info.doc.source || null,
              "manual",
              info.contentHash,
              pack.name,
            );
            for (let j = 0; j < info.chunks.length; j++) {
              const chunkId = randomUUID();
              const chunkText = info.chunks[j] ?? "";
              const embedding = result.embeddings[info.chunkOffset + j] ?? [];
              insertChunk.run(chunkId, info.docId, chunkText, j);
              try {
                const vecBuffer = Buffer.from(new Float32Array(embedding).buffer);
                insertEmbedding.run(chunkId, vecBuffer);
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (!message.includes("no such table")) {
                  log.warn({ chunkId, err }, "Failed to insert vector embedding");
                }
              }
            }
            batchInstalled++;
          }
        });
        try {
          doInsert();
          installed += batchInstalled;
        } catch (err) {
          log.warn(
            { err, pack: pack.name, batchIndex: i },
            "Transaction failed for batch, skipping these documents",
          );
          errors += batch.docInfos.length;
        }
      }

      processedCount += batch.docInfos.length;
      onProgress?.(
        processedCount,
        total,
        batch.docInfos[batch.docInfos.length - 1]?.doc.title ?? "",
      );
    }
  }

  // Semaphore-based concurrent embedding: up to `concurrency` embedBatch calls in flight at once.
  await new Promise<void>((resolve) => {
    if (batches.length === 0) {
      resolve();
      return;
    }

    let activeCount = 0;
    let scheduleIdx = 0;

    function scheduleNext(): void {
      while (activeCount < concurrency && scheduleIdx < batches.length) {
        const i = scheduleIdx++;
        const resolved = resolveBatch(batches[i]!);
        activeCount++;

        // Wrap in try/catch so synchronous throws from embedBatch don't leave
        // the surrounding Promise permanently pending.
        let embedPromise: Promise<number[][]>;
        if (resolved.allChunks.length > 0) {
          try {
            embedPromise = provider.embedBatch(resolved.allChunks);
          } catch (err) {
            embedPromise = Promise.reject(err instanceof Error ? err : new Error(String(err)));
          }
        } else {
          embedPromise = Promise.resolve([] as number[][]);
        }

        embedPromise
          .then((embeddings) => {
            embedResults[i] = { resolved, embeddings, success: true };
          })
          .catch((err) => {
            log.warn(
              { err, pack: pack.name, batchIndex: i },
              "Failed to embed batch, skipping these documents",
            );
            embedResults[i] = { resolved, embeddings: [], success: false };
          })
          .finally(() => {
            activeCount--;
            flushInserts();
            if (scheduleIdx < batches.length) {
              scheduleNext();
            } else if (activeCount === 0) {
              resolve();
            }
          });
      }
    }

    scheduleNext();
  });

  // Update doc count
  db.prepare("UPDATE packs SET doc_count = ? WHERE name = ?").run(installed, pack.name);

  log.info({ pack: pack.name, installed, errors }, "Pack installed");
  return { packName: pack.name, documentsInstalled: installed, alreadyInstalled: false, errors };
}

/** Remove a pack and all its associated documents. */
export function removePack(db: Database.Database, packName: string): void {
  const log = getLogger();

  const existing = db.prepare("SELECT name FROM packs WHERE name = ?").get(packName) as
    | { name: string }
    | undefined;

  if (!existing) {
    throw new ValidationError(`Pack "${packName}" is not installed`);
  }

  const docIds = db.prepare("SELECT id FROM documents WHERE pack_name = ?").all(packName) as Array<{
    id: string;
  }>;

  const deleteTransaction = db.transaction(() => {
    for (const { id } of docIds) {
      try {
        db.prepare(
          "DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)",
        ).run(id);
      } catch (err) {
        log.debug(
          { err, documentId: id },
          "chunk_embeddings cleanup skipped (table may not exist)",
        );
      }
      db.prepare("DELETE FROM documents WHERE id = ?").run(id);
    }
    db.prepare("DELETE FROM packs WHERE name = ?").run(packName);
  });

  deleteTransaction();

  log.info({ pack: packName, docsRemoved: docIds.length }, "Pack removed");
}

/** List all installed packs. */
export function listInstalledPacks(db: Database.Database): InstalledPack[] {
  const rows = db
    .prepare("SELECT name, version, description, doc_count, installed_at FROM packs ORDER BY name")
    .all() as Array<{
    name: string;
    version: string;
    description: string | null;
    doc_count: number;
    installed_at: string;
  }>;

  return rows.map((row) => ({
    name: row.name,
    version: row.version,
    description: row.description,
    docCount: row.doc_count,
    installedAt: row.installed_at,
  }));
}

/** Create a pack from existing documents in the database. */
export function createPack(db: Database.Database, options: CreatePackOptions): KnowledgePack {
  const log = getLogger();

  if (!options.name.trim()) {
    throw new ValidationError("Pack name is required");
  }

  let query = "SELECT id, title, content, url, topic_id FROM documents";
  const params: unknown[] = [];

  if (options.topic) {
    query += " WHERE topic_id = ?";
    params.push(options.topic);
  }

  const rows = db.prepare(query).all(...params) as Array<{
    id: string;
    title: string;
    content: string;
    url: string | null;
    topic_id: string | null;
  }>;

  if (rows.length === 0) {
    throw new ValidationError("No documents found matching the criteria");
  }

  const documents: PackDocument[] = rows.map((row) => ({
    title: row.title,
    content: row.content,
    source: row.url ?? "",
    ...(row.topic_id ? { topics: [row.topic_id] } : {}),
  }));

  const pack: KnowledgePack = {
    name: options.name,
    version: options.version ?? "1.0.0",
    description: options.description ?? `Knowledge pack: ${options.name}`,
    documents,
    metadata: {
      author: options.author ?? "libscope",
      license: options.license ?? "MIT",
      createdAt: new Date().toISOString(),
    },
  };

  if (options.outputPath) {
    writePackFile(options.outputPath, pack);
    log.info({ outputPath: options.outputPath, docCount: documents.length }, "Pack file created");
  }

  return pack;
}

// ---------------------------------------------------------------------------
// Create pack from filesystem / URL sources (no database required)
// ---------------------------------------------------------------------------

/** Simple glob-style pattern matching (supports * and ** wildcards). */
function matchesExcludePattern(relativePath: string, pattern: string): boolean {
  // Escape regex special chars except * and **
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*");
  return new RegExp(`^${escaped}$`).test(relativePath);
}

/** Recursively collect files from a directory. */
function collectFiles(
  dir: string,
  rootDir: string,
  recursive: boolean,
  extensions: Set<string>,
  excludePatterns: string[],
): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    throw new ValidationError(
      `Cannot read directory "${dir}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  for (const entry of entries) {
    const fullPath = pathJoin(dir, entry);
    const rel = relative(rootDir, fullPath);

    // Check exclude patterns
    if (excludePatterns.some((p) => matchesExcludePattern(rel, p))) {
      continue;
    }

    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue; // Skip unreadable entries
    }

    if (stat.isDirectory()) {
      if (recursive) {
        results.push(...collectFiles(fullPath, rootDir, recursive, extensions, excludePatterns));
      }
    } else if (stat.isFile()) {
      const ext = extname(fullPath).toLowerCase();
      if (extensions.has(ext)) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function isUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

/** Create a pack directly from filesystem paths and/or URLs (no database needed). */
export async function createPackFromSource(
  options: CreatePackFromSourceOptions,
): Promise<KnowledgePack> {
  const log = getLogger();

  if (!options.name.trim()) {
    throw new ValidationError("Pack name is required");
  }
  if (options.from.length === 0) {
    throw new ValidationError("At least one --from source is required");
  }

  const allSupported = getSupportedExtensions();
  const extensions = new Set(
    options.extensions?.map((e) => (e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`)) ??
      allSupported,
  );
  const excludePatterns = options.exclude ?? [];
  const recursive = options.recursive ?? true;

  const documents: PackDocument[] = [];
  const errors: Array<{ source: string; error: string }> = [];

  // Separate URLs from file paths
  const urls: string[] = [];
  const fileSources: string[] = [];
  for (const src of options.from) {
    if (isUrl(src)) {
      urls.push(src);
    } else {
      fileSources.push(src);
    }
  }

  // Collect all files from filesystem sources
  const allFiles: string[] = [];
  for (const src of fileSources) {
    const resolved = pathResolve(src);
    let stat;
    try {
      stat = statSync(resolved);
    } catch (err) {
      throw new ValidationError(
        `Source path "${src}" does not exist or is not accessible: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (stat.isDirectory()) {
      allFiles.push(...collectFiles(resolved, resolved, recursive, extensions, excludePatterns));
    } else if (stat.isFile()) {
      allFiles.push(resolved);
    } else {
      throw new ValidationError(`Source path "${src}" is not a file or directory`);
    }
  }

  // Parse filesystem files
  const totalCount = allFiles.length + urls.length;
  for (let i = 0; i < allFiles.length; i++) {
    const filePath = allFiles[i]!;
    options.onProgress?.({ file: filePath, index: i, total: totalCount });

    const parser = getParserForFile(filePath);
    if (!parser) {
      log.debug({ file: filePath }, "No parser for file, skipping");
      continue;
    }

    try {
      const buffer = readFileSync(filePath);
      const content = await parser.parse(buffer);
      const trimmed = content.trimEnd();
      if (trimmed.length === 0) {
        log.debug({ file: filePath }, "Empty content after parsing, skipping");
        continue;
      }

      const title = basename(filePath).replace(/\.[^.]+$/, "");
      const tags = suggestTagsFromText(title, trimmed);
      documents.push({
        title,
        content: trimmed,
        source: pathToFileURL(filePath).href,
        tags,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ file: filePath, err: msg }, "Failed to parse file, skipping");
      errors.push({ source: filePath, error: msg });
    }
  }

  // Fetch URLs
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!;
    options.onProgress?.({ file: url, index: allFiles.length + i, total: totalCount });

    try {
      const fetched = await fetchAndConvert(url);
      if (!fetched.content.trim()) {
        log.debug({ url }, "Empty content from URL, skipping");
        continue;
      }

      const tags = suggestTagsFromText(fetched.title, fetched.content.trimEnd());
      documents.push({
        title: fetched.title,
        content: fetched.content.trimEnd(),
        source: url,
        tags,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ url, err: msg }, "Failed to fetch URL, skipping");
      errors.push({ source: url, error: msg });
    }
  }

  if (documents.length === 0) {
    const detail =
      errors.length > 0
        ? ` (${errors.length} source(s) failed: ${errors.map((e) => e.source).join(", ")})`
        : "";
    throw new ValidationError(`No documents could be created from the provided sources${detail}`);
  }

  if (errors.length > 0) {
    log.warn({ errorCount: errors.length, errors }, "Some sources failed during pack creation");
  }

  const pack: KnowledgePack = {
    name: options.name,
    version: options.version ?? "1.0.0",
    description: options.description ?? `Knowledge pack: ${options.name}`,
    documents,
    metadata: {
      author: options.author ?? "libscope",
      license: options.license ?? "MIT",
      createdAt: new Date().toISOString(),
    },
  };

  if (options.outputPath) {
    writePackFile(options.outputPath, pack);
    log.info(
      { outputPath: options.outputPath, docCount: documents.length },
      "Pack file created from source",
    );
  }

  log.info(
    { name: pack.name, docCount: documents.length, errorCount: errors.length },
    "Pack created from source",
  );
  return pack;
}
