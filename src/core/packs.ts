import type Database from "better-sqlite3";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import {
  resolve as pathResolve,
  isAbsolute as pathIsAbsolute,
  basename,
  relative,
  join as pathJoin,
} from "node:path";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { ValidationError, FetchError } from "../errors.js";
import { getLogger } from "../logger.js";
import { indexDocument } from "./indexing.js";
import { getParserForFile, getSupportedExtensions } from "./parsers/index.js";
import { fetchAndConvert } from "./url-fetcher.js";
import { pathToFileURL } from "node:url";

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
  options?: { registryUrl?: string | undefined },
): Promise<InstallResult> {
  const log = getLogger();
  let pack: KnowledgePack;

  // Try loading as a local file first
  if (packNameOrPath.endsWith(".json")) {
    const resolved = pathResolve(packNameOrPath);
    // Prevent path traversal: if a relative path is given, ensure it resolves within CWD
    if (!pathIsAbsolute(packNameOrPath) && !resolved.startsWith(process.cwd())) {
      throw new ValidationError("Pack file path must be within the current working directory");
    }
    try {
      const raw = readFileSync(resolved, "utf-8");
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
    return { packName: pack.name, documentsInstalled: 0, alreadyInstalled: true };
  }

  log.info({ pack: pack.name, docCount: pack.documents.length }, "Installing pack");

  // Insert the pack record first (documents.pack_name has FK to packs.name)
  db.prepare("INSERT INTO packs (name, version, description, doc_count) VALUES (?, ?, ?, 0)").run(
    pack.name,
    pack.version,
    pack.description,
  );

  let installed = 0;
  for (const doc of pack.documents) {
    try {
      const result = await indexDocument(db, provider, {
        title: doc.title,
        content: doc.content,
        sourceType: "library",
        url: doc.source || undefined,
        submittedBy: "manual",
        dedup: "warn",
      });

      // Tag the document with the pack name
      db.prepare("UPDATE documents SET pack_name = ? WHERE id = ?").run(pack.name, result.id);
      installed++;
    } catch (err) {
      log.warn(
        { err, title: doc.title, pack: pack.name },
        "Failed to index pack document, skipping",
      );
    }
  }

  // Update doc count
  db.prepare("UPDATE packs SET doc_count = ? WHERE name = ?").run(installed, pack.name);

  log.info({ pack: pack.name, installed }, "Pack installed");
  return { packName: pack.name, documentsInstalled: installed, alreadyInstalled: false };
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
      } catch {
        // chunk_embeddings table may not exist
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
    writeFileSync(options.outputPath, JSON.stringify(pack, null, 2), "utf-8");
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
      const ext = fullPath.substring(fullPath.lastIndexOf(".")).toLowerCase();
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

      documents.push({
        title: basename(filePath).replace(/\.[^.]+$/, ""),
        content: trimmed,
        source: pathToFileURL(filePath).href,
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

      documents.push({
        title: fetched.title,
        content: fetched.content.trimEnd(),
        source: url,
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
    writeFileSync(options.outputPath, JSON.stringify(pack, null, 2), "utf-8");
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
