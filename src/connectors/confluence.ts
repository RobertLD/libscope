import type Database from "better-sqlite3";
import { NodeHtmlMarkdown } from "node-html-markdown";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { indexDocument } from "../core/indexing.js";
import { createTopic } from "../core/topics.js";
import { addTagsToDocument } from "../core/tags.js";
import { deleteDocument } from "../core/documents.js";
import { getLogger } from "../logger.js";
import { FetchError, ValidationError } from "../errors.js";
import { fetchWithRetry } from "./http-utils.js";
import { startSync, completeSync, failSync } from "./sync-tracker.js";

export interface ConfluenceConfig {
  baseUrl: string;
  /** "cloud" uses Basic auth (email:token). "server" uses Bearer PAT. Default: "cloud". */
  type?: "cloud" | "server" | undefined;
  /** Email for Confluence Cloud (Basic auth). Required when type is "cloud". */
  email?: string | undefined;
  token: string;
  spaces: string[];
  lastSync?: string | undefined;
  excludeSpaces?: string[] | undefined;
}

export interface ConfluenceSyncResult {
  spaces: number;
  pagesIndexed: number;
  pagesUpdated: number;
  errors: Array<{ page: string; error: string }>;
}

interface ConfluenceSpace {
  id: string;
  key: string;
  name: string;
}

interface ConfluencePage {
  id: string;
  title: string;
  spaceId: string;
  version: { number: number };
  body?: { storage?: { value: string } };
  labels?: { results: Array<{ name: string }> };
  _links?: { webui?: string };
}

interface PaginatedResponse<T> {
  results: T[];
  _links?: { next?: string };
}

function buildAuthHeader(
  type: "cloud" | "server",
  email: string | undefined,
  token: string,
): string {
  if (type === "server") {
    return `Bearer ${token}`;
  }
  const encoded = Buffer.from(`${email ?? ""}:${token}`).toString("base64");
  return `Basic ${encoded}`;
}

async function confluenceFetch<T>(url: string, auth: string): Promise<T> {
  const log = getLogger();
  log.debug({ url }, "Confluence API request");

  const response = await fetchWithRetry(url, {
    headers: {
      Authorization: auth,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new FetchError(
      `Confluence API error ${response.status}: ${response.statusText} — ${body}`,
    );
  }

  return (await response.json()) as T;
}

async function fetchAllPages<T>(initialUrl: string, baseUrl: string, auth: string): Promise<T[]> {
  const all: T[] = [];
  let url: string | undefined = initialUrl;

  while (url) {
    const resp: PaginatedResponse<T> = await confluenceFetch<PaginatedResponse<T>>(url, auth);
    all.push(...resp.results);
    const next: string | undefined = resp._links?.next;
    url = next ? `${baseUrl}${next}` : undefined;
  }

  return all;
}

export function convertConfluenceStorage(html: string): string {
  let processed = html;

  // Code blocks: <ac:structured-macro ac:name="code">
  processed = processed.replace(
    /<ac:structured-macro [^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_match, inner: string) => {
      // Extract attrs from the opening tag
      const tagEnd = _match.indexOf(">");
      const attrs = _match.slice(0, tagEnd);
      if (!/ac:name="code"/i.test(attrs)) return _match;
      const langMatch = /<ac:parameter\s+ac:name="language">(.*?)<\/ac:parameter>/i.exec(inner);
      const lang = langMatch?.[1] ?? "";
      const bodyMatch =
        /<ac:plain-text-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-body>/i.exec(inner);
      const code = bodyMatch?.[1] ?? "";
      const langAttr = lang ? ` class="language-${lang}"` : "";
      return `<pre><code${langAttr}>${code}</code></pre>`;
    },
  );

  // Info/note/warning/tip panels
  processed = processed.replace(
    /<ac:structured-macro [^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_match, inner: string) => {
      const tagEnd = _match.indexOf(">");
      const attrs = _match.slice(0, tagEnd);
      const nameMatch = /ac:name="(info|note|warning|tip)"/i.exec(attrs);
      if (!nameMatch) return _match;
      const type = nameMatch[1] ?? "info";
      const bodyMatch = /<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/i.exec(inner);
      const body = bodyMatch?.[1] ?? "";
      const prefix = type.charAt(0).toUpperCase() + type.slice(1);
      return `<blockquote><strong>${prefix}:</strong> ${body.trim()}</blockquote>`;
    },
  );

  // Panel → blockquote
  processed = processed.replace(
    /<ac:structured-macro\s[^>]*ac:name="panel"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_match, inner: string) => {
      const bodyMatch = /<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/i.exec(inner);
      const body = bodyMatch?.[1] ?? "";
      return `<blockquote>${body.trim()}</blockquote>`;
    },
  );

  // Expand → just content
  processed = processed.replace(
    /<ac:structured-macro\s[^>]*ac:name="expand"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_match, inner: string) => {
      const titleMatch = /<ac:parameter\s+ac:name="title">(.*?)<\/ac:parameter>/i.exec(inner);
      const bodyMatch = /<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/i.exec(inner);
      const title = titleMatch?.[1] ?? "Details";
      const body = bodyMatch?.[1] ?? "";
      return `<p><strong>${title}</strong></p>${body.trim()}`;
    },
  );

  // TOC → strip
  processed = processed.replace(
    /<ac:structured-macro\s[^>]*ac:name="toc"[^>]*>[\s\S]*?<\/ac:structured-macro>/gi,
    "",
  );
  // Self-closing TOC
  processed = processed.replace(/<ac:structured-macro\s[^>]*ac:name="toc"[^>]*\/>/gi, "");

  // JIRA macro → [JIRA: KEY-123] as a span to avoid escaping
  processed = processed.replace(
    /<ac:structured-macro\s[^>]*ac:name="jira"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_match, inner: string) => {
      const keyMatch = /<ac:parameter\s+ac:name="key">(.*?)<\/ac:parameter>/i.exec(inner);
      const key = keyMatch?.[1] ?? "UNKNOWN";
      return `<span>[JIRA: ${key}]</span>`;
    },
  );

  // ac:image → [image] as span
  processed = processed.replace(/<ac:image[^>]*>[\s\S]*?<\/ac:image>/gi, "<span>[image]</span>");

  // ac:link → extract URL/title as an anchor
  processed = processed.replace(
    /<ac:link[^>]*>([\s\S]*?)<\/ac:link>/gi,
    (_match, inner: string) => {
      const titleMatch =
        /<ac:link-body>(.*?)<\/ac:link-body>/i.exec(inner) ??
        /<ac:plain-text-link-body>\s*<!\[CDATA\[(.*?)\]\]>\s*<\/ac:plain-text-link-body>/i.exec(
          inner,
        );
      const title = titleMatch?.[1] ?? "link";
      const hrefMatch = /<ri:page\s+ri:content-title="([^"]*)"[^>]*/i.exec(inner);
      if (hrefMatch?.[1]) {
        return `<a href="${hrefMatch[1]}">${title}</a>`;
      }
      return `<span>[${title}]</span>`;
    },
  );

  // ri:attachment → [attached: filename] as span
  processed = processed.replace(
    /<ri:attachment\s+ri:filename="([^"]*)"[^>]*\/?>/gi,
    (_match, filename: string) => `<span>[attached: ${filename}]</span>`,
  );

  // Strip remaining ac:parameter tags
  processed = processed.replace(/<ac:parameter[^>]*>[\s\S]*?<\/ac:parameter>/gi, "");

  // Strip remaining ac:structured-macro wrappers but keep body
  processed = processed.replace(/<\/?ac:structured-macro[^>]*>/gi, "");
  processed = processed.replace(/<\/?ac:rich-text-body>/gi, "");
  processed = processed.replace(/<\/?ac:plain-text-body>/gi, "");

  // Convert remaining HTML to markdown
  let markdown = NodeHtmlMarkdown.translate(processed);

  // Un-escape bracket patterns that NHM escaped
  markdown = markdown.replace(/\\\[JIRA: ([^\]]+)\\\]/g, "[JIRA: $1]");
  markdown = markdown.replace(/\\\[image\\\]/g, "[image]");
  markdown = markdown.replace(/\\\[attached: ([^\]]+)\\\]/g, "[attached: $1]");

  return markdown;
}

function extractLabels(page: ConfluencePage): string[] {
  return page.labels?.results.map((l) => l.name) ?? [];
}

export async function syncConfluence(
  db: Database.Database,
  provider: EmbeddingProvider,
  config: ConfluenceConfig,
): Promise<ConfluenceSyncResult> {
  const log = getLogger();

  if (!config.baseUrl.trim()) {
    throw new ValidationError("Confluence baseUrl is required");
  }
  if (!config.token.trim()) {
    throw new ValidationError("Confluence token is required");
  }

  const confluenceType = config.type ?? "cloud";
  if (confluenceType === "cloud" && !config.email?.trim()) {
    throw new ValidationError(
      "Confluence email is required for Cloud. For Server/Data Center, use --type server",
    );
  }

  const auth = buildAuthHeader(confluenceType, config.email, config.token);
  let base = config.baseUrl;
  while (base.endsWith("/")) base = base.slice(0, -1);
  const syncId = startSync(db, "confluence", base);

  try {
    const result: ConfluenceSyncResult = {
      spaces: 0,
      pagesIndexed: 0,
      pagesUpdated: 0,
      errors: [],
    };

    log.info({ baseUrl: base }, "Starting Confluence sync");

    // Fetch all spaces
    const allSpaces = await fetchAllPages<ConfluenceSpace>(
      `${base}/wiki/api/v2/spaces`,
      base,
      auth,
    );

    // Filter spaces
    const excludeSet = new Set(config.excludeSpaces ?? []);
    const requestedAll = config.spaces.length === 1 && config.spaces[0] === "all";
    const spacesToSync = allSpaces.filter((s) => {
      if (excludeSet.has(s.key)) return false;
      return requestedAll || config.spaces.includes(s.key);
    });

    result.spaces = spacesToSync.length;
    log.info({ spaceCount: spacesToSync.length }, "Spaces to sync");

    for (const space of spacesToSync) {
      // Create or get topic for this space
      const topic = createTopic(db, { name: space.name });

      // Fetch pages in space
      let pages: ConfluencePage[];
      try {
        pages = await fetchAllPages<ConfluencePage>(
          `${base}/wiki/api/v2/spaces/${space.id}/pages`,
          base,
          auth,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ spaceKey: space.key, err }, "Failed to fetch pages for space");
        result.errors.push({ page: `space:${space.key}`, error: msg });
        continue;
      }

      for (const page of pages) {
        try {
          // Fetch full page content with body
          const fullPage = await confluenceFetch<ConfluencePage>(
            `${base}/wiki/api/v2/pages/${page.id}?body-format=storage`,
            auth,
          );

          const storageHtml = fullPage.body?.storage?.value ?? "";
          const pageUrl = fullPage._links?.webui
            ? `${base}${fullPage._links.webui}`
            : `${base}/wiki/spaces/${space.key}/pages/${page.id}`;

          // Incremental sync: check existing doc version
          const existingDoc = db
            .prepare("SELECT id, url FROM documents WHERE url = ?")
            .get(pageUrl) as { id: string; url: string } | undefined;

          const existingMeta = existingDoc
            ? (db
                .prepare(
                  "SELECT id FROM document_tags dt JOIN tags t ON dt.tag_id = t.id WHERE dt.document_id = ? AND t.name = ?",
                )
                .get(existingDoc.id, `confluence-version:${fullPage.version.number}`) as
                | { id: string }
                | undefined)
            : undefined;

          if (existingDoc && existingMeta) {
            // Same version — skip
            log.debug({ pageId: page.id, title: page.title }, "Page unchanged, skipping");
            continue;
          }

          if (existingDoc) {
            // Version changed — delete old doc and re-index
            deleteDocument(db, existingDoc.id);
            result.pagesUpdated++;
          }

          const markdown = convertConfluenceStorage(storageHtml);

          const indexed = await indexDocument(db, provider, {
            title: fullPage.title,
            content: markdown,
            sourceType: "topic",
            topicId: topic.id,
            url: pageUrl,
            submittedBy: "crawler",
            dedup: "force",
          });

          // Extract labels as tags + add version tag for incremental sync
          const labels = extractLabels(fullPage);
          const allTags = [
            ...labels,
            `confluence-space:${space.key}`,
            `confluence-version:${fullPage.version.number}`,
          ];
          addTagsToDocument(db, indexed.id, allTags);

          result.pagesIndexed++;
          log.info(
            { pageId: page.id, title: fullPage.title, chunkCount: indexed.chunkCount },
            "Page indexed",
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error({ pageId: page.id, title: page.title, err }, "Failed to index page");
          result.errors.push({ page: page.title, error: msg });
        }
      }
    }

    log.info(
      {
        spaces: result.spaces,
        indexed: result.pagesIndexed,
        updated: result.pagesUpdated,
        errors: result.errors.length,
      },
      "Confluence sync complete",
    );

    completeSync(db, syncId, {
      added: result.pagesIndexed,
      updated: result.pagesUpdated,
      deleted: 0,
      errored: result.errors.length,
    });

    return result;
  } catch (err) {
    failSync(db, syncId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export function disconnectConfluence(db: Database.Database): number {
  const log = getLogger();

  // Find all documents tagged as confluence content
  const rows = db
    .prepare(
      `SELECT DISTINCT dt.document_id
       FROM document_tags dt
       JOIN tags t ON dt.tag_id = t.id
       WHERE t.name LIKE 'confluence-space:%'`,
    )
    .all() as Array<{ document_id: string }>;

  for (const row of rows) {
    deleteDocument(db, row.document_id);
  }

  log.info({ removedCount: rows.length }, "Confluence disconnected");
  return rows.length;
}

export { buildAuthHeader };
