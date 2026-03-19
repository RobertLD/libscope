import { readdirSync, readFileSync, statSync } from "node:fs";
import { load as yamlLoad } from "js-yaml";
import { join, relative, dirname, basename, extname, resolve } from "node:path";
import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { indexDocument } from "../core/indexing.js";
import { deleteDocument } from "../core/documents.js";
import { createTopic, listTopics } from "../core/topics.js";
import { addTagsToDocument, createTag } from "../core/tags.js";
import { createLink, resolveDocumentByTitle } from "../core/links.js";
import { getLogger } from "../logger.js";
import { ValidationError } from "../errors.js";
import { loadConnectorConfig, saveConnectorConfig } from "./index.js";
import { startSync, completeSync, failSync } from "./sync-tracker.js";

export interface ObsidianConfig {
  vaultPath: string;
  lastSync?: string | undefined;
  topicMapping: "folder" | "frontmatter";
  excludePatterns: string[];
}

export interface SyncResult {
  added: number;
  updated: number;
  deleted: number;
  errors: Array<{ file: string; error: string }>;
}

interface VaultFileEntry {
  mtime: string;
  docId: string;
}

interface VaultState {
  type: string;
  vaultPath: string;
  lastSync: string;
  topicMapping: "folder" | "frontmatter";
  excludePatterns: string[];
  files: Record<string, VaultFileEntry>;
}

const DEFAULT_EXCLUDE = [".obsidian/", ".trash/", "templates/"];

function buildSource(vaultPath: string, relPath: string): string {
  return `obsidian://${vaultPath}/${relPath}`;
}

function findMarkdownFiles(dir: string, excludePatterns: string[]): string[] {
  const results: string[] = [];

  function walk(currentDir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const relFromRoot = relative(dir, fullPath);

      const excluded = excludePatterns.some((pat) => {
        if (pat.endsWith("/")) {
          return relFromRoot.startsWith(pat) || relFromRoot + "/" === pat;
        }
        return relFromRoot === pat || entry === pat;
      });
      if (excluded) continue;

      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile() && extname(entry) === ".md") {
        results.push(relFromRoot);
      }
    }
  }

  walk(dir);
  return results;
}

/** Maximum content size (5 MB) to process through regex-heavy parsing. */
const MAX_PARSE_SIZE = 5 * 1024 * 1024;

/** Parse YAML frontmatter from the top of a markdown file. Returns the parsed object and remaining body. */
function extractFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!fmMatch) return { frontmatter: {}, body: content };

  const fmBlock = fmMatch[1] ?? "";
  const body = content.slice((fmMatch[0] ?? "").length).trimStart();

  try {
    const parsed = yamlLoad(fmBlock);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { frontmatter: {}, body };
    }
    // Normalise Date objects to ISO-8601 date strings
    const normalised: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      normalised[k] = v instanceof Date ? v.toISOString().slice(0, 10) : v;
    }
    return { frontmatter: normalised, body };
  } catch {
    return { frontmatter: {}, body };
  }
}

/** Build a case-insensitive map from base filenames (without .md) to relative paths. */
function buildVaultFileMap(vaultFiles: string[]): Map<string, string> {
  const fileMap = new Map<string, string>();
  for (const f of vaultFiles) {
    const name = basename(f, ".md");
    fileMap.set(name.toLowerCase(), f);
  }
  return fileMap;
}

/** Collect all [[wikilinks]] from the body text. */
function collectWikilinks(body: string): string[] {
  const wikilinks: string[] = [];
  const wikilinkRegex = /(?<!!)\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
  let wlMatch;
  while ((wlMatch = wikilinkRegex.exec(body)) !== null) {
    const link = wlMatch[1] ?? "";
    wikilinks.push(link);
  }
  return wikilinks;
}

/** Apply Obsidian-specific markdown transformations: embeds, wikilinks, comments, callouts. */
function transformObsidianBody(body: string, fileMap: Map<string, string>): string {
  let result = body;

  // Resolve ![[embeds]] — inline referenced content (1 level deep)
  result = result.replaceAll(/!\[\[([^\]|]+)(?:\|[^\]]*)?]]/g, (_match, link: string) => {
    const target = fileMap.get(link.toLowerCase());
    return target ? `[Embedded: ${link}]` : `[${link}]`;
  });

  // Resolve [[wikilinks]]
  result = result.replaceAll(
    /(?<!!)\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g,
    (_match, link: string, display?: string) => {
      const displayText = display ?? link;
      const slug = link.toLowerCase().replaceAll(/\s+/g, "-");
      return `[${displayText}](${slug})`;
    },
  );

  // Strip %%comments%%
  result = result.replaceAll(/%%[\s\S]*?%%/g, "");
  // Strip dataview code blocks
  result = result.replaceAll(/```dataview[\s\S]*?```/g, "");
  // Convert callouts to blockquotes with type prefix (line-by-line to avoid regex backtracking)
  result = result
    .split("\n")
    .map((line) => {
      if (!line.startsWith("> [!")) return line;
      const close = line.indexOf("]", 4);
      if (close === -1) return line;
      const type = line.slice(4, close);
      if (!/^\w+$/.test(type)) return line;
      const rest = line.slice(close + 1).trimStart();
      return `> **${type}**: ${rest}`;
    })
    .join("\n");

  return result;
}

/** Extract #tags from body text and frontmatter. */
function collectTags(body: string, frontmatter: Record<string, unknown>): string[] {
  const tagSet = new Set<string>();
  const tagRegex = /(?:^|\s)#([a-zA-Z][\w/-]*)/g;
  let tagMatch;
  while ((tagMatch = tagRegex.exec(body)) !== null) {
    const tag = tagMatch[1];
    if (tag) tagSet.add(tag);
  }
  if (Array.isArray(frontmatter.tags)) {
    for (const t of frontmatter.tags) {
      if (typeof t === "string") tagSet.add(t);
    }
  }
  return [...tagSet];
}

export function parseObsidianMarkdown(
  content: string,
  vaultFiles: string[],
): {
  frontmatter: Record<string, unknown>;
  body: string;
  tags: string[];
  wikilinks: string[];
} {
  const safeContent = content.length > MAX_PARSE_SIZE ? content.slice(0, MAX_PARSE_SIZE) : content;

  const { frontmatter, body: rawBody } = extractFrontmatter(safeContent);
  const fileMap = buildVaultFileMap(vaultFiles);
  const wikilinks = collectWikilinks(rawBody);
  const body = transformObsidianBody(rawBody, fileMap);
  const tags = collectTags(body, frontmatter);

  return { frontmatter, body: body.trim(), tags, wikilinks };
}

function resolveEmbeds(
  body: string,
  vaultPath: string,
  vaultFiles: string[],
  _visited: Set<string> = new Set(),
): string {
  const fileMap = new Map<string, string>();
  for (const f of vaultFiles) {
    const name = basename(f, ".md");
    fileMap.set(name.toLowerCase(), f);
  }

  return body.replace(
    /!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g,
    (_match, link: string, display?: string) => {
      const target = fileMap.get(link.toLowerCase());
      if (!target) return display ?? `[${link}]`;
      if (_visited.has(target)) return display ?? `[${link}]`;
      _visited.add(target);
      try {
        const filePath = join(vaultPath, target);
        if (!resolve(filePath).startsWith(resolve(vaultPath))) {
          return display ?? `[${link}]`;
        }
        const content = readFileSync(filePath, "utf-8");
        // Strip frontmatter from embedded content
        const fmEnd = /^---\r?\n[\s\S]*?\r?\n---/.exec(content);
        const embeddedBody = fmEnd ? content.slice((fmEnd[0] ?? "").length).trim() : content.trim();
        return embeddedBody;
      } catch {
        return display ?? `[${link}]`;
      }
    },
  );
}

function folderToTopic(relPath: string): string | undefined {
  const dir = dirname(relPath);
  if (dir === ".") return undefined;
  return dir;
}

function getOrCreateTopic(db: Database.Database, topicPath: string): string {
  const existing = listTopics(db);
  const found = existing.find((t) => t.name === topicPath);
  if (found) return found.id;

  const topic = createTopic(db, { name: topicPath });
  return topic.id;
}

/** Determine the topic ID for a file based on the topic mapping strategy. */
function resolveTopicId(
  db: Database.Database,
  relPath: string,
  parsed: { frontmatter: Record<string, unknown> },
  topicMapping: "folder" | "frontmatter",
): string | undefined {
  if (topicMapping === "folder") {
    const topicPath = folderToTopic(relPath);
    return topicPath ? getOrCreateTopic(db, topicPath) : undefined;
  }
  if (topicMapping === "frontmatter") {
    const fmTopic = parsed.frontmatter.topic;
    return typeof fmTopic === "string" && fmTopic ? getOrCreateTopic(db, fmTopic) : undefined;
  }
  return undefined;
}

/** Safely delete the previous version of a document, ignoring already-deleted docs. */
function safeDeletePrevious(db: Database.Database, docId: string | undefined): void {
  if (!docId) return;
  try {
    deleteDocument(db, docId);
  } catch {
    // Document may have been manually deleted
  }
}

/** Ensure tags exist and attach them to a document. */
function applyTags(
  db: Database.Database,
  docId: string,
  tags: string[],
  log: ReturnType<typeof getLogger>,
): void {
  if (tags.length === 0) return;
  for (const tag of tags) {
    try {
      createTag(db, tag);
    } catch {
      // Tag may already exist
    }
  }
  try {
    addTagsToDocument(db, docId, tags);
  } catch (err) {
    log.debug({ err, docId }, "Failed to add some tags");
  }
}

/** Resolve wikilinks and create document reference links. */
function applyWikilinks(
  db: Database.Database,
  docId: string,
  wikilinks: string[],
  log: ReturnType<typeof getLogger>,
): void {
  for (const pageName of wikilinks) {
    try {
      const targetId = resolveDocumentByTitle(db, pageName);
      if (targetId && targetId !== docId) {
        createLink(db, docId, targetId, "references");
      }
    } catch (err) {
      log.debug({ err, pageName, docId }, "Failed to resolve wikilink");
    }
  }
}

/** Process a single vault file: parse, index, tag, and link. Returns the new VaultFileEntry or undefined on skip. */
async function processVaultFile(
  db: Database.Database,
  provider: EmbeddingProvider,
  config: ObsidianConfig,
  relPath: string,
  vaultFiles: string[],
  tracked: VaultFileEntry | undefined,
  log: ReturnType<typeof getLogger>,
): Promise<{ entry: VaultFileEntry; isUpdate: boolean } | "unchanged"> {
  const fullPath = join(config.vaultPath, relPath);
  const stat = statSync(fullPath);
  const mtime = stat.mtime.toISOString();

  if (tracked?.mtime === mtime) return "unchanged";

  const rawContent = readFileSync(fullPath, "utf-8");
  const contentWithEmbeds = resolveEmbeds(rawContent, config.vaultPath, vaultFiles);
  const parsed = parseObsidianMarkdown(contentWithEmbeds, vaultFiles);

  const title =
    typeof parsed.frontmatter.title === "string"
      ? parsed.frontmatter.title
      : basename(relPath, ".md");

  const topicId = resolveTopicId(db, relPath, parsed, config.topicMapping);
  safeDeletePrevious(db, tracked?.docId);

  const indexed = await indexDocument(db, provider, {
    title,
    content: parsed.body,
    sourceType: "manual",
    topicId,
    url: buildSource(config.vaultPath, relPath),
    submittedBy: "crawler",
  });

  applyTags(db, indexed.id, parsed.tags, log);
  applyWikilinks(db, indexed.id, parsed.wikilinks, log);

  return { entry: { mtime, docId: indexed.id }, isUpdate: !!tracked };
}

/** Delete tracked documents whose files no longer exist on disk. */
function deleteRemovedFiles(
  db: Database.Database,
  trackedFiles: Record<string, VaultFileEntry>,
  currentFileSet: Set<string>,
): number {
  let deleted = 0;
  for (const [relPath, entry] of Object.entries(trackedFiles)) {
    if (currentFileSet.has(relPath)) continue;
    try {
      deleteDocument(db, entry.docId);
      deleted++;
    } catch {
      // Document may have been manually deleted
    }
  }
  return deleted;
}

export async function syncObsidianVault(
  db: Database.Database,
  provider: EmbeddingProvider,
  config: ObsidianConfig,
): Promise<SyncResult> {
  const log = getLogger();
  const result: SyncResult = { added: 0, updated: 0, deleted: 0, errors: [] };

  if (!config.vaultPath) {
    throw new ValidationError("Vault path is required");
  }

  const syncId = startSync(db, "obsidian", config.vaultPath);

  try {
    const excludePatterns = [...DEFAULT_EXCLUDE, ...config.excludePatterns];
    const vaultFiles = findMarkdownFiles(config.vaultPath, excludePatterns);

    log.info(
      { vaultPath: config.vaultPath, fileCount: vaultFiles.length },
      "Syncing Obsidian vault",
    );

    const connectorConfig = loadConnectorConfig();
    const vaultKey = `obsidian:${config.vaultPath}`;
    const existingState = connectorConfig[vaultKey] as VaultState | undefined;
    const trackedFiles = existingState?.files ?? {};
    const newTrackedFiles: Record<string, VaultFileEntry> = {};
    const currentFileSet = new Set(vaultFiles);

    for (const relPath of vaultFiles) {
      try {
        const outcome = await processVaultFile(
          db,
          provider,
          config,
          relPath,
          vaultFiles,
          trackedFiles[relPath],
          log,
        );

        if (outcome === "unchanged") {
          newTrackedFiles[relPath] = trackedFiles[relPath]!;
        } else if (outcome.isUpdate) {
          newTrackedFiles[relPath] = outcome.entry;
          result.updated++;
        } else {
          newTrackedFiles[relPath] = outcome.entry;
          result.added++;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        result.errors.push({ file: relPath, error: errMsg });
        log.warn({ file: relPath, err }, "Failed to sync file");
        const tracked = trackedFiles[relPath];
        if (tracked) {
          newTrackedFiles[relPath] = tracked;
        }
      }
    }

    result.deleted = deleteRemovedFiles(db, trackedFiles, currentFileSet);

    connectorConfig[vaultKey] = {
      type: "obsidian",
      vaultPath: config.vaultPath,
      lastSync: new Date().toISOString(),
      topicMapping: config.topicMapping,
      excludePatterns: config.excludePatterns,
      files: newTrackedFiles,
    } satisfies VaultState;
    saveConnectorConfig(connectorConfig);

    log.info(
      {
        added: result.added,
        updated: result.updated,
        deleted: result.deleted,
        errors: result.errors.length,
      },
      "Obsidian vault sync complete",
    );

    completeSync(db, syncId, {
      added: result.added,
      updated: result.updated,
      deleted: result.deleted,
      errored: result.errors.length,
    });

    return result;
  } catch (err) {
    failSync(db, syncId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export function disconnectVault(db: Database.Database, vaultPath: string): number {
  const log = getLogger();
  const connectorConfig = loadConnectorConfig();
  const vaultKey = `obsidian:${vaultPath}`;
  const state = connectorConfig[vaultKey] as VaultState | undefined;

  let removed = 0;

  if (state?.files) {
    for (const entry of Object.values(state.files)) {
      try {
        deleteDocument(db, entry.docId);
        removed++;
      } catch {
        // Document may have been manually deleted
      }
    }
  }

  // Also delete any documents with matching source URL pattern
  const sourcePrefix = `obsidian://${vaultPath}/`;
  const rows = db
    .prepare("SELECT id FROM documents WHERE url LIKE ?")
    .all(`${sourcePrefix}%`) as Array<{ id: string }>;

  for (const row of rows) {
    try {
      deleteDocument(db, row.id);
      removed++;
    } catch {
      // Already deleted
    }
  }

  // Remove from connector config
  delete connectorConfig[vaultKey];
  saveConnectorConfig(connectorConfig);

  log.info({ vaultPath, removed }, "Obsidian vault disconnected");
  return removed;
}
