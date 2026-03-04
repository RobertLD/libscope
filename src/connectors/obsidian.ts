import { readdirSync, readFileSync, statSync } from "node:fs";
import { load as yamlLoad } from "js-yaml";
import { join, relative, dirname, basename, extname, resolve } from "node:path";
import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { indexDocument } from "../core/indexing.js";
import { deleteDocument } from "../core/documents.js";
import { createTopic, listTopics } from "../core/topics.js";
import { addTagsToDocument, createTag } from "../core/tags.js";
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

export function parseObsidianMarkdown(
  content: string,
  vaultFiles: string[],
): {
  frontmatter: Record<string, unknown>;
  body: string;
  tags: string[];
  wikilinks: string[];
} {
  // Guard against excessively large files that could cause slow regex execution
  const safeContent = content.length > MAX_PARSE_SIZE ? content.slice(0, MAX_PARSE_SIZE) : content;

  let frontmatter: Record<string, unknown> = {};
  let body = safeContent;

  // Parse YAML frontmatter
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (fmMatch) {
    const fmBlock = fmMatch[1] ?? "";
    body = content.slice((fmMatch[0] ?? "").length).trimStart();
    try {
      const parsed = yamlLoad(fmBlock);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        // js-yaml parses bare YAML date literals (e.g. 2024-01-15) as Date objects per YAML 1.1.
        // Normalise them to ISO-8601 strings so downstream code always sees strings.
        const normalised: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          normalised[k] = v instanceof Date ? v.toISOString().slice(0, 10) : v;
        }
        frontmatter = normalised;
      }
    } catch {
      // Malformed frontmatter — leave frontmatter as empty object and continue
    }
  }

  // Build vault file map for wikilink resolution
  const fileMap = new Map<string, string>();
  for (const f of vaultFiles) {
    const name = basename(f, ".md");
    fileMap.set(name.toLowerCase(), f);
  }

  // Resolve ![[embeds]] — inline referenced content (1 level deep)
  body = body.replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?]]/g, (_match, link: string) => {
    const target = fileMap.get(link.toLowerCase());
    if (!target) return `[${link}]`;
    // Read embedded file content (no recursion)
    try {
      // We don't have vaultPath here, so embeds resolve via the caller
      return `[Embedded: ${link}]`;
    } catch {
      return `[Embedded: ${link}]`;
    }
  });

  // Collect wikilinks
  const wikilinks: string[] = [];
  const wikilinkRegex = /(?<!!)\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
  let wlMatch;
  while ((wlMatch = wikilinkRegex.exec(body)) !== null) {
    const link = wlMatch[1] ?? "";
    wikilinks.push(link);
  }

  // Resolve [[wikilinks]]
  body = body.replace(
    /(?<!!)\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g,
    (_match, link: string, display?: string) => {
      const displayText = display ?? link;
      const slug = link.toLowerCase().replace(/\s+/g, "-");
      return `[${displayText}](${slug})`;
    },
  );

  // Strip %%comments%%
  body = body.replace(/%%[\s\S]*?%%/g, "");

  // Strip dataview code blocks
  body = body.replace(/```dataview[\s\S]*?```/g, "");

  // Convert callouts to blockquotes with type prefix
  body = body.replace(/^> \[!(\w+)]\s*(.*)$/gm, (_match, type: string, rest: string) => {
    return `> **${type}**: ${rest}`;
  });

  // Extract #tags from body
  const tagSet = new Set<string>();
  const tagRegex = /(?:^|\s)#([a-zA-Z][\w/-]*)/g;
  let tagMatch;
  while ((tagMatch = tagRegex.exec(body)) !== null) {
    const tag = tagMatch[1];
    if (tag) tagSet.add(tag);
  }

  // Also include tags from frontmatter
  if (Array.isArray(frontmatter.tags)) {
    for (const t of frontmatter.tags) {
      if (typeof t === "string") tagSet.add(t);
    }
  }

  const tags = [...tagSet];

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

    // Load existing vault state
    const connectorConfig = loadConnectorConfig();
    const vaultKey = `obsidian:${config.vaultPath}`;
    const existingState = connectorConfig[vaultKey] as VaultState | undefined;
    const trackedFiles = existingState?.files ?? {};

    const newTrackedFiles: Record<string, VaultFileEntry> = {};
    const currentFileSet = new Set(vaultFiles);

    // Process each file
    for (const relPath of vaultFiles) {
      const fullPath = join(config.vaultPath, relPath);
      const source = buildSource(config.vaultPath, relPath);

      try {
        const stat = statSync(fullPath);
        const mtime = stat.mtime.toISOString();
        const tracked = trackedFiles[relPath];

        // Skip unchanged files during incremental sync
        if (tracked?.mtime === mtime) {
          newTrackedFiles[relPath] = tracked;
          continue;
        }

        const rawContent = readFileSync(fullPath, "utf-8");

        // Resolve embeds first (before main parsing)
        const contentWithEmbeds = resolveEmbeds(rawContent, config.vaultPath, vaultFiles);

        const parsed = parseObsidianMarkdown(contentWithEmbeds, vaultFiles);

        const title =
          typeof parsed.frontmatter.title === "string"
            ? parsed.frontmatter.title
            : basename(relPath, ".md");

        // Determine topic
        let topicId: string | undefined;
        if (config.topicMapping === "folder") {
          const topicPath = folderToTopic(relPath);
          if (topicPath) {
            topicId = getOrCreateTopic(db, topicPath);
          }
        } else if (config.topicMapping === "frontmatter") {
          const fmTopic = parsed.frontmatter.topic;
          if (typeof fmTopic === "string" && fmTopic) {
            topicId = getOrCreateTopic(db, fmTopic);
          }
        }

        // If updating, delete old document first
        if (tracked?.docId) {
          try {
            deleteDocument(db, tracked.docId);
          } catch {
            // Document may have been manually deleted
          }
        }

        const indexed = await indexDocument(db, provider, {
          title,
          content: parsed.body,
          sourceType: "manual",
          topicId,
          url: source,
          submittedBy: "crawler",
        });

        // Add tags
        if (parsed.tags.length > 0) {
          for (const tag of parsed.tags) {
            try {
              createTag(db, tag);
            } catch {
              // Tag may already exist
            }
          }
          try {
            addTagsToDocument(db, indexed.id, parsed.tags);
          } catch (err) {
            log.debug({ err, docId: indexed.id }, "Failed to add some tags");
          }
        }

        newTrackedFiles[relPath] = { mtime, docId: indexed.id };

        if (tracked) {
          result.updated++;
        } else {
          result.added++;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        result.errors.push({ file: relPath, error: errMsg });
        log.warn({ file: relPath, err }, "Failed to sync file");
        // Preserve old tracking if it exists
        const tracked = trackedFiles[relPath];
        if (tracked) {
          newTrackedFiles[relPath] = tracked;
        }
      }
    }

    // Delete documents for files that no longer exist
    for (const [relPath, entry] of Object.entries(trackedFiles)) {
      if (!currentFileSet.has(relPath)) {
        try {
          deleteDocument(db, entry.docId);
          result.deleted++;
        } catch {
          // Document may have been manually deleted
        }
      }
    }

    // Save updated state
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
