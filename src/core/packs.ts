import type Database from "better-sqlite3";
import { readFileSync, writeFileSync } from "node:fs";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { ValidationError } from "../errors.js";
import { getLogger } from "../logger.js";
import { indexDocument } from "./indexing.js";

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

const DEFAULT_REGISTRY_URL = "https://raw.githubusercontent.com/libscope/packs/main/registry.json";

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

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Registry returned ${response.status}: ${response.statusText}`);
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
    throw new ValidationError(
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
    try {
      const raw = readFileSync(packNameOrPath, "utf-8");
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
    const baseUrl = registryUrl.replace(/\/[^/]+$/, "");
    const packUrl = `${baseUrl}/${packNameOrPath}.json`;
    try {
      const response = await fetch(packUrl);
      if (!response.ok) {
        throw new Error(`Pack fetch returned ${response.status}: ${response.statusText}`);
      }
      const data: unknown = await response.json();
      pack = validatePack(data);
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(
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
  const params: string[] = [];

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
