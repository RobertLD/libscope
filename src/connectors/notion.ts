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
  const log = getLogger();
  const allResults: NotionSearchResult[] = [];
  let cursor: string | null = null;
  let hasMore = true;
  const MAX_PAGES = 10_000;

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

    if (allResults.length >= MAX_PAGES) {
      log.warn(
        { count: allResults.length, max: MAX_PAGES },
        "Reached max page limit, stopping pagination",
      );
      break;
    }

    if (hasMore && !cursor) {
      log.warn("API returned hasMore=true but no cursor — stopping pagination");
      break;
    }
  }

  return allResults;
}

async function fetchBlockChildren(
  token: string,
  blockId: string,
  depth: number = 0,
  maxDepth: number = 20,
): Promise<NotionBlock[]> {
  const log = getLogger();

  if (depth >= maxDepth) {
    log.warn({ blockId, depth, maxDepth }, "Max recursion depth reached in fetchBlockChildren");
    return [];
  }

  const allBlocks: NotionBlock[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const url = new URL(`${NOTION_API_BASE}/v1/blocks/${blockId}/children`);
    if (cursor) {
      url.searchParams.set("start_cursor", cursor);
    }
    const endpoint = url.pathname + url.search;
    const response: NotionBlocksResponse = await notionFetch<NotionBlocksResponse>(endpoint, token);
    allBlocks.push(...response.results);
    hasMore = response.has_more;
    cursor = response.next_cursor;

    if (hasMore && !cursor) {
      log.warn("API returned hasMore=true but no cursor — stopping pagination");
      break;
    }
  }

  // Recursively fetch children
  for (const block of allBlocks) {
    if (block.has_children) {
      const children = await fetchBlockChildren(token, block.id, depth + 1, maxDepth);
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

    if (hasMore && !cursor) {
      const log = getLogger();
      log.warn("API returned hasMore=true but no cursor — stopping pagination");
      break;
    }
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

/** Convert a single Notion block to its markdown line(s). Does not handle children. */
function blockToMarkdownLine(block: NotionBlock, text: string): string | undefined {
  switch (block.type) {
    case "paragraph":
      return text;
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "toggle":
      return text;
    case "quote":
      return `> ${text}`;
    case "divider":
      return "---";
    case "table_row":
      return undefined; // Handled by table
    default:
      return text || undefined;
  }
}

/** Convert a Notion block with type-specific data to markdown. */
function convertSpecialBlock(block: NotionBlock, text: string): string | undefined {
  switch (block.type) {
    case "to_do": {
      const data = block["to_do"] as { checked?: boolean } | undefined;
      const checked = data?.checked ? "x" : " ";
      return `- [${checked}] ${text}`;
    }
    case "code": {
      const data = block["code"] as { language?: string } | undefined;
      const lang = data?.language ?? "";
      return `\`\`\`${lang}\n${text}\n\`\`\``;
    }
    case "callout": {
      const data = block["callout"] as { icon?: { emoji?: string } } | undefined;
      const emoji = data?.icon?.emoji ?? "";
      return `> ${emoji} ${text}`.trim();
    }
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
      return url ? `![${caption}](${url})` : "[image]";
    }
    case "bookmark": {
      const data = block["bookmark"] as { url?: string; caption?: NotionRichText[] } | undefined;
      const caption = extractRichText(data?.caption);
      const url = data?.url ?? "";
      return `[${caption || url}](${url})`;
    }
    case "child_page": {
      const data = block["child_page"] as { title?: string } | undefined;
      return `[${data?.title ?? "Untitled"}](notion://page/${block.id})`;
    }
    default:
      return undefined;
  }
}

/** Render table rows from children blocks. */
function renderTableRows(children: NotionBlock[]): string[] {
  const lines: string[] = [];
  for (const row of children) {
    const rowData = row["table_row"] as { cells?: NotionRichText[][] } | undefined;
    if (!rowData?.cells) continue;
    const cells = rowData.cells.map((cell) => extractRichText(cell));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines;
}

/** Render indented child content for non-table blocks. */
function renderChildContent(children: NotionBlock[]): string | undefined {
  const childContent = convertNotionBlocks(children);
  if (!childContent) return undefined;
  return childContent
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}

/** Convert a single Notion block to markdown line(s), appending to the output array. */
function convertSingleBlock(block: NotionBlock, lines: string[]): void {
  const text = getBlockText(block);
  const children = (block as Record<string, unknown>)["children"] as NotionBlock[] | undefined;

  // Handle table specially (children are inline rows)
  if (block.type === "table" && children) {
    lines.push(...renderTableRows(children));
    return;
  }

  // Try special blocks first (ones needing type-specific data extraction)
  const specialLine = convertSpecialBlock(block, text);
  if (specialLine === undefined) {
    const simpleLine = blockToMarkdownLine(block, text);
    if (simpleLine !== undefined) lines.push(simpleLine);
  } else {
    lines.push(specialLine);
  }

  // Render nested children (except table children which are handled above)
  if (children && block.type !== "table") {
    const indented = renderChildContent(children);
    if (indented) lines.push(indented);
  }
}

/** Convert an array of Notion blocks to markdown. */
export function convertNotionBlocks(blocks: NotionBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    convertSingleBlock(block, lines);
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

/** Convert a single Notion property to tag string(s). Returns empty array for unsupported types. */
function propertyToTags(key: string, prop: NotionProperty): string[] {
  if (prop.type === "select" && prop.select) return [`${key}:${prop.select.name}`];
  if (prop.type === "multi_select" && prop.multi_select) {
    return prop.multi_select.map((s) => `${key}:${s.name}`);
  }
  if (prop.type === "date" && prop.date) return [`${key}:${prop.date.start}`];
  if (prop.type === "rich_text" && prop.rich_text) {
    const text = extractRichText(prop.rich_text as unknown as NotionRichText[]);
    return text ? [`${key}:${text}`] : [];
  }
  return [];
}

function extractPropertyMetadata(properties: Record<string, NotionProperty>): string[] {
  const tags: string[] = [];
  for (const [key, prop] of Object.entries(properties)) {
    if (prop.type === "title") continue;
    tags.push(...propertyToTags(key, prop));
  }
  return tags;
}

/** Delete any existing documents for a Notion page URL and re-index. */
async function upsertNotionDocument(
  db: Database.Database,
  provider: EmbeddingProvider,
  pageId: string,
  title: string,
  content: string,
): Promise<void> {
  const existingDocs = db
    .prepare("SELECT id FROM documents WHERE url = ?")
    .all(`notion://page/${pageId}`) as Array<{ id: string }>;
  for (const doc of existingDocs) {
    deleteDocument(db, doc.id);
  }

  await indexDocument(db, provider, {
    title,
    content,
    sourceType: "manual",
    url: `notion://page/${pageId}`,
    submittedBy: "crawler",
  });
}

/** Sync a single Notion page. Returns true if indexed, false if skipped. */
async function syncNotionPage(
  db: Database.Database,
  provider: EmbeddingProvider,
  token: string,
  item: NotionSearchResult,
): Promise<boolean> {
  const log = getLogger();

  // Database rows are indexed via their parent database
  if (item.parent?.type === "database_id") return false;

  const title = extractTitle(item);
  const blocks = await fetchBlockChildren(token, item.id);
  const content = convertNotionBlocks(blocks);

  if (!content.trim()) {
    log.debug({ id: item.id, title }, "Skipping empty page");
    return false;
  }

  await upsertNotionDocument(db, provider, item.id, title, content);
  log.debug({ id: item.id, title }, "Indexed Notion page");
  return true;
}

/** Sync a single Notion database and all its rows. */
async function syncNotionDatabase(
  db: Database.Database,
  provider: EmbeddingProvider,
  token: string,
  item: NotionSearchResult,
  excludeSet: Set<string>,
): Promise<void> {
  const log = getLogger();
  const dbTitle = extractTitle(item);
  const rows = await queryDatabase(token, item.id);

  for (const row of rows) {
    if (excludeSet.has(row.id)) continue;

    const rowTitle = extractTitle(row);
    const tags = row.properties ? extractPropertyMetadata(row.properties) : [];
    const metadataSection = tags.length > 0 ? `\n\nMetadata: ${tags.join(", ")}` : "";

    const blocks = await fetchBlockChildren(token, row.id);
    const content = convertNotionBlocks(blocks);
    const fullContent = `# ${rowTitle}${metadataSection}\n\n${content}`;

    await upsertNotionDocument(db, provider, row.id, `${dbTitle} — ${rowTitle}`, fullContent);
  }

  log.debug({ id: item.id, title: dbTitle, rows: rows.length }, "Indexed Notion database");
}

/** Sync a single search result item (page or database). */
async function syncNotionItem(
  db: Database.Database,
  provider: EmbeddingProvider,
  token: string,
  item: NotionSearchResult,
  excludeSet: Set<string>,
  result: NotionSyncResult,
): Promise<void> {
  if (item.object === "page") {
    const indexed = await syncNotionPage(db, provider, token, item);
    if (indexed) result.pagesIndexed++;
  } else if (item.object === "database") {
    await syncNotionDatabase(db, provider, token, item, excludeSet);
    result.databasesIndexed++;
  }
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
        await syncNotionItem(db, provider, config.token, item, excludeSet, result);
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
