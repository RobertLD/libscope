import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { getLogger } from "../logger.js";
import { ValidationError, FetchError } from "../errors.js";
import { fetchWithRetry } from "./http-utils.js";
import { indexDocument } from "../core/indexing.js";
import { deleteDocument } from "../core/documents.js";
import { startSync, completeSync, failSync } from "./sync-tracker.js";

const NOTION_API_BASE = "https://api.notion.com";
const NOTION_VERSION = "2022-06-28";

export interface NotionConfig {
  token: string;
  lastSync?: string | undefined;
  excludePages?: string[] | undefined;
}

export interface NotionSyncResult {
  pagesIndexed: number;
  databasesIndexed: number;
  errors: Array<{ page: string; error: string }>;
}

export interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean | undefined;
  [key: string]: unknown;
}

interface NotionRichText {
  plain_text: string;
  href?: string | null;
}

interface NotionSearchResult {
  object: string;
  id: string;
  last_edited_time: string;
  properties?: Record<string, NotionProperty>;
  parent?: { type: string; database_id?: string };
  url?: string;
  title?: Array<{ plain_text: string }>;
}

interface NotionProperty {
  type: string;
  title?: Array<{ plain_text: string }>;
  rich_text?: Array<{ plain_text: string }>;
  select?: { name: string } | null;
  multi_select?: Array<{ name: string }>;
  date?: { start: string; end?: string | null } | null;
  number?: number | null;
  checkbox?: boolean;
  url?: string | null;
  [key: string]: unknown;
}

interface NotionSearchResponse {
  results: NotionSearchResult[];
  has_more: boolean;
  next_cursor: string | null;
}

interface NotionBlocksResponse {
  results: NotionBlock[];
  has_more: boolean;
  next_cursor: string | null;
}

interface NotionDatabaseQueryResponse {
  results: NotionSearchResult[];
  has_more: boolean;
  next_cursor: string | null;
}

async function notionFetch<T>(
  endpoint: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const url = `${NOTION_API_BASE}${endpoint}`;
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };

  const fetchOptions: RequestInit = { method, headers };
  if (options.body) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  const response = await fetchWithRetry(url, fetchOptions);

  if (response.status === 401) {
    throw new ValidationError("Invalid Notion token or insufficient permissions");
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    throw new FetchError(`Notion API error (${response.status}): ${text}`);
  }

  return (await response.json()) as T;
}

async function searchNotion(token: string, lastSync?: string): Promise<NotionSearchResult[]> {
  const allResults: NotionSearchResult[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body["start_cursor"] = cursor;
    if (lastSync) {
      body["filter"] = { timestamp: "last_edited_time", last_edited_time: { after: lastSync } };
    }

    const response = await notionFetch<NotionSearchResponse>("/v1/search", token, {
      method: "POST",
      body,
    });

    allResults.push(...response.results);
    hasMore = response.has_more;
    cursor = response.next_cursor;
  }

  return allResults;
}

async function fetchBlockChildren(token: string, blockId: string): Promise<NotionBlock[]> {
  const allBlocks: NotionBlock[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const endpoint: string = `/v1/blocks/${blockId}/children${cursor ? `?start_cursor=${cursor}` : ""}`;
    const response: NotionBlocksResponse = await notionFetch<NotionBlocksResponse>(endpoint, token);
    allBlocks.push(...response.results);
    hasMore = response.has_more;
    cursor = response.next_cursor;
  }

  // Recursively fetch children
  for (const block of allBlocks) {
    if (block.has_children) {
      const children = await fetchBlockChildren(token, block.id);
      (block as Record<string, unknown>)["children"] = children;
    }
  }

  return allBlocks;
}

async function queryDatabase(token: string, databaseId: string): Promise<NotionSearchResult[]> {
  const allRows: NotionSearchResult[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body["start_cursor"] = cursor;

    const response = await notionFetch<NotionDatabaseQueryResponse>(
      `/v1/databases/${databaseId}/query`,
      token,
      { method: "POST", body },
    );

    allRows.push(...response.results);
    hasMore = response.has_more;
    cursor = response.next_cursor;
  }

  return allRows;
}

function extractRichText(richText: NotionRichText[] | undefined): string {
  if (!richText) return "";
  return richText.map((t) => t.plain_text).join("");
}

function getBlockText(block: NotionBlock): string {
  const data = block[block.type] as Record<string, unknown> | undefined;
  if (!data) return "";
  const richText = data["rich_text"] as NotionRichText[] | undefined;
  return extractRichText(richText);
}

/** Convert an array of Notion blocks to markdown. */
export function convertNotionBlocks(blocks: NotionBlock[]): string {
  const lines: string[] = [];

  for (const block of blocks) {
    const text = getBlockText(block);
    const children = (block as Record<string, unknown>)["children"] as NotionBlock[] | undefined;

    switch (block.type) {
      case "paragraph":
        lines.push(text);
        break;

      case "heading_1":
        lines.push(`# ${text}`);
        break;

      case "heading_2":
        lines.push(`## ${text}`);
        break;

      case "heading_3":
        lines.push(`### ${text}`);
        break;

      case "bulleted_list_item":
        lines.push(`- ${text}`);
        break;

      case "numbered_list_item":
        lines.push(`1. ${text}`);
        break;

      case "to_do": {
        const data = block["to_do"] as { checked?: boolean } | undefined;
        const checked = data?.checked ? "x" : " ";
        lines.push(`- [${checked}] ${text}`);
        break;
      }

      case "toggle":
        lines.push(text);
        break;

      case "code": {
        const data = block["code"] as { language?: string } | undefined;
        const lang = data?.language ?? "";
        lines.push(`\`\`\`${lang}\n${text}\n\`\`\``);
        break;
      }

      case "quote":
        lines.push(`> ${text}`);
        break;

      case "callout": {
        const data = block["callout"] as { icon?: { emoji?: string } } | undefined;
        const emoji = data?.icon?.emoji ?? "";
        lines.push(`> ${emoji} ${text}`.trim());
        break;
      }

      case "divider":
        lines.push("---");
        break;

      case "table": {
        if (children) {
          for (const row of children) {
            const rowData = row["table_row"] as { cells?: NotionRichText[][] } | undefined;
            if (rowData?.cells) {
              const cells = rowData.cells.map((cell) => extractRichText(cell));
              lines.push(`| ${cells.join(" | ")} |`);
            }
          }
        }
        break;
      }

      case "table_row":
        // Handled by table
        break;

      case "image": {
        const data = block["image"] as
          | {
              type?: string;
              file?: { url?: string };
              external?: { url?: string };
              caption?: NotionRichText[];
            }
          | undefined;
        const url = data?.type === "external" ? data?.external?.url : data?.file?.url;
        const caption = extractRichText(data?.caption);
        if (url) {
          lines.push(`![${caption}](${url})`);
        } else {
          lines.push("[image]");
        }
        break;
      }

      case "bookmark": {
        const data = block["bookmark"] as { url?: string; caption?: NotionRichText[] } | undefined;
        const caption = extractRichText(data?.caption);
        const url = data?.url ?? "";
        lines.push(`[${caption || url}](${url})`);
        break;
      }

      case "child_page": {
        const data = block["child_page"] as { title?: string } | undefined;
        lines.push(`[${data?.title ?? "Untitled"}](notion://page/${block.id})`);
        break;
      }

      default:
        if (text) lines.push(text);
        break;
    }

    // Render nested children (except table children which are handled inline)
    if (children && block.type !== "table") {
      const childContent = convertNotionBlocks(children);
      if (childContent) {
        const indented = childContent
          .split("\n")
          .map((l) => `  ${l}`)
          .join("\n");
        lines.push(indented);
      }
    }
  }

  return lines.join("\n");
}

function extractTitle(result: NotionSearchResult): string {
  // Direct title field (databases)
  if (result.title) {
    return extractRichText(result.title);
  }
  // Search through properties for title type
  if (result.properties) {
    for (const prop of Object.values(result.properties)) {
      if (prop.type === "title" && prop.title) {
        return extractRichText(prop.title as unknown as NotionRichText[]);
      }
    }
  }
  return "Untitled";
}

function extractPropertyMetadata(properties: Record<string, NotionProperty>): string[] {
  const tags: string[] = [];
  for (const [key, prop] of Object.entries(properties)) {
    if (prop.type === "title") continue; // Skip title, it's used as the document title
    switch (prop.type) {
      case "select":
        if (prop.select) tags.push(`${key}:${prop.select.name}`);
        break;
      case "multi_select":
        if (prop.multi_select) {
          for (const s of prop.multi_select) {
            tags.push(`${key}:${s.name}`);
          }
        }
        break;
      case "date":
        if (prop.date) tags.push(`${key}:${prop.date.start}`);
        break;
      case "rich_text":
        if (prop.rich_text) {
          const text = extractRichText(prop.rich_text as unknown as NotionRichText[]);
          if (text) tags.push(`${key}:${text}`);
        }
        break;
      default:
        break;
    }
  }
  return tags;
}

/** Sync pages and databases from Notion into the knowledge base. */
export async function syncNotion(
  db: Database.Database,
  provider: EmbeddingProvider,
  config: NotionConfig,
): Promise<NotionSyncResult> {
  const log = getLogger();

  if (!config.token.startsWith("secret_") && !config.token.startsWith("ntn_")) {
    throw new ValidationError("Notion token must start with 'secret_' or 'ntn_'");
  }

  const syncId = startSync(db, "notion", "notion");

  try {
    const result: NotionSyncResult = {
      pagesIndexed: 0,
      databasesIndexed: 0,
      errors: [],
    };

    const excludeSet = new Set(config.excludePages ?? []);

    log.info({ lastSync: config.lastSync }, "Starting Notion sync");
    const searchResults = await searchNotion(config.token, config.lastSync);
    log.info({ count: searchResults.length }, "Found Notion objects");

    for (const item of searchResults) {
      if (excludeSet.has(item.id)) {
        log.debug({ id: item.id }, "Skipping excluded page");
        continue;
      }

      try {
        if (item.object === "page") {
          // Check if this page is a database row (has a database parent)
          // Database rows are indexed when their parent database is processed
          if (item.parent?.type === "database_id") {
            continue;
          }

          const title = extractTitle(item);
          const blocks = await fetchBlockChildren(config.token, item.id);
          const content = convertNotionBlocks(blocks);

          if (!content.trim()) {
            log.debug({ id: item.id, title }, "Skipping empty page");
            continue;
          }

          // Delete existing document for this Notion page before re-indexing
          const existingDocs = db
            .prepare("SELECT id FROM documents WHERE url = ?")
            .all(`notion://page/${item.id}`) as Array<{ id: string }>;
          for (const doc of existingDocs) {
            deleteDocument(db, doc.id);
          }

          await indexDocument(db, provider, {
            title,
            content,
            sourceType: "manual",
            url: `notion://page/${item.id}`,
            submittedBy: "crawler",
          });

          result.pagesIndexed++;
          log.debug({ id: item.id, title }, "Indexed Notion page");
        } else if (item.object === "database") {
          const dbTitle = extractTitle(item);
          const rows = await queryDatabase(config.token, item.id);

          for (const row of rows) {
            if (excludeSet.has(row.id)) continue;

            const rowTitle = extractTitle(row);
            const tags = row.properties ? extractPropertyMetadata(row.properties) : [];
            const metadataSection = tags.length > 0 ? `\n\nMetadata: ${tags.join(", ")}` : "";

            // Fetch row page content
            const blocks = await fetchBlockChildren(config.token, row.id);
            const content = convertNotionBlocks(blocks);
            const fullContent = `# ${rowTitle}${metadataSection}\n\n${content}`;

            const existingDocs = db
              .prepare("SELECT id FROM documents WHERE url = ?")
              .all(`notion://page/${row.id}`) as Array<{ id: string }>;
            for (const doc of existingDocs) {
              deleteDocument(db, doc.id);
            }

            await indexDocument(db, provider, {
              title: `${dbTitle} — ${rowTitle}`,
              content: fullContent,
              sourceType: "manual",
              url: `notion://page/${row.id}`,
              submittedBy: "crawler",
            });
          }

          result.databasesIndexed++;
          log.debug({ id: item.id, title: dbTitle, rows: rows.length }, "Indexed Notion database");
        }
      } catch (err) {
        const title = extractTitle(item);
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({ page: title, error: message });
        log.warn({ id: item.id, err }, "Failed to index Notion item");
      }
    }

    log.info(
      {
        pagesIndexed: result.pagesIndexed,
        databasesIndexed: result.databasesIndexed,
        errors: result.errors.length,
      },
      "Notion sync complete",
    );

    completeSync(db, syncId, {
      added: result.pagesIndexed + result.databasesIndexed,
      updated: 0,
      deleted: 0,
      errored: result.errors.length,
    });

    return result;
  } catch (err) {
    failSync(db, syncId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/** Remove all Notion-sourced documents from the knowledge base. */
export function disconnectNotion(db: Database.Database): Promise<number> {
  const log = getLogger();
  const docs = db.prepare("SELECT id FROM documents WHERE url LIKE 'notion://%'").all() as Array<{
    id: string;
  }>;
  let removed = 0;

  for (const doc of docs) {
    deleteDocument(db, doc.id);
    removed++;
  }

  log.info({ removed }, "Disconnected Notion");
  return Promise.resolve(removed);
}
