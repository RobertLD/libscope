/**
 * Documentation site connector for Sphinx, VitePress, and Doxygen.
 *
 * Crawls documentation sites, auto-detects the generator, extracts main content,
 * and indexes each page with URL-based deduplication. Supports incremental syncs
 * via content-hash comparison built into indexDocument().
 */
import type Database from "better-sqlite3";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { ValidationError } from "../errors.js";
import { getLogger } from "../logger.js";
import { fetchRaw } from "../core/url-fetcher.js";
import type { FetchOptions } from "../core/url-fetcher.js";
import { indexDocument } from "../core/indexing.js";
import { listDocuments, deleteDocument } from "../core/documents.js";
import { startSync, completeSync, failSync } from "./sync-tracker.js";
import type { EmbeddingProvider } from "../providers/embedding.js";

// Source type used to tag all docs-connector documents.
// "library" is the closest semantic match in the IndexDocumentInput union.
const SOURCE_TYPE = "library" as const;

// Internal connector type identifier used in the sync tracker.
const CONNECTOR_TYPE = "docs";

const DEFAULT_MAX_PAGES = 500;
const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_CONCURRENCY = 3;

/** Non-content file extensions that should not be crawled. */
const SKIP_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "ico",
  "webp",
  "pdf",
  "zip",
  "tar",
  "gz",
  "bz2",
  "xz",
  "css",
  "js",
  "mjs",
  "json",
  "xml",
  "woff",
  "woff2",
  "ttf",
  "eot",
  "otf",
  "mp4",
  "mp3",
  "ogg",
  "wav",
  "map",
]);

/** Supported documentation site generators. */
export type DocSiteType = "sphinx" | "vitepress" | "doxygen" | "generic";

/** Configuration for a documentation site sync. */
export interface DocSiteConfig {
  /** Root URL of the documentation site. */
  url: string;
  /** Documentation generator type. Set to "auto" (or omit) for auto-detection. */
  type?: DocSiteType | "auto";
  /** Library name to associate with indexed pages (used for filtering and metadata). */
  library?: string | undefined;
  /** Library version to associate with indexed pages. */
  version?: string | undefined;
  /** Maximum number of pages to crawl (default: 500). */
  maxPages?: number | undefined;
  /** Maximum link depth from the root page (default: 10). */
  maxDepth?: number | undefined;
  /** Maximum number of pages to fetch concurrently (1–10, default: 3). */
  concurrency?: number | undefined;
  /** Allow fetching from private/internal IP addresses (default: false). */
  allowPrivateUrls?: boolean | undefined;
  /** Accept self-signed or untrusted TLS certificates (default: false). */
  allowSelfSignedCerts?: boolean | undefined;
  /** ISO 8601 timestamp of the last sync; reserved for future incremental sync use. */
  lastSync?: string | undefined;
  /**
   * Restrict crawling to URLs whose path starts with this prefix.
   * Defaults to the root URL's pathname (e.g. "/docs/").
   */
  pathPrefix?: string | undefined;
}

/** Result of a documentation site sync. */
export interface DocSiteSyncResult {
  /** Pages newly indexed in this sync. */
  pagesIndexed: number;
  /** Pages that existed before and were re-indexed due to content changes. */
  pagesUpdated: number;
  /** Pages skipped because they are empty or contain no meaningful content. */
  pagesSkipped: number;
  /** The detected (or configured) documentation site type. */
  detectedType: DocSiteType;
  /** Per-page errors encountered during the crawl. */
  errors: Array<{ url: string; error: string }>;
}

// ---------------------------------------------------------------------------
// URL utilities
// ---------------------------------------------------------------------------

/**
 * Normalise a URL for deduplication: strip the fragment, remove trailing
 * slash from non-root paths, and keep scheme + host + path + query.
 */
export function normalizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.href;
  } catch {
    return rawUrl;
  }
}

// ---------------------------------------------------------------------------
// Site-type detection
// ---------------------------------------------------------------------------

/**
 * Detect the documentation generator from the HTML of a page.
 *
 * Checks generator meta tags and framework-specific CSS class names.
 * Returns "generic" when no known pattern is found.
 */
export function detectDocSiteType(html: string): DocSiteType {
  // Sphinx: <meta name="generator" content="Sphinx …"> or classic class names
  if (
    /content=["']Sphinx/i.test(html) ||
    /class=["'][^"']*sphinxsidebar[^"']*["']/i.test(html) ||
    /class=["'][^"']*rst-content[^"']*["']/i.test(html) ||
    /class=["'][^"']*sphinx-[a-z]/i.test(html)
  ) {
    return "sphinx";
  }

  // VitePress: framework-injected global or VPDoc / vp-doc class
  if (
    /__VITEPRESS_/i.test(html) ||
    /class=["'][^"']*VPDoc[^"']*["']/i.test(html) ||
    /class=["'][^"']*vp-doc[^"']*["']/i.test(html) ||
    /content=["']VitePress/i.test(html)
  ) {
    return "vitepress";
  }

  // Doxygen: HTML comment injected by doxygen, or generator meta tag
  if (
    /Generated by Doxygen/i.test(html) ||
    /content=["']Doxygen/i.test(html) ||
    /id=["']doc-content["']/i.test(html) ||
    /class=["'][^"']*doxygen[^"']*["']/i.test(html)
  ) {
    return "doxygen";
  }

  return "generic";
}

// ---------------------------------------------------------------------------
// HTML content extraction
// ---------------------------------------------------------------------------

/**
 * Extract the balanced inner HTML of the first element whose opening tag
 * matches `tagName` and whose attribute string matches `attrPattern`.
 *
 * Uses a depth-counting approach so nested elements of the same tag name
 * are handled correctly.  Returns null when no matching element is found.
 */
export function extractElementByPattern(
  html: string,
  tagName: string,
  attrPattern: RegExp,
): string | null {
  // Scan for the first opening tag of tagName whose attributes match
  const scanner = new RegExp(`<(${tagName})(\\s[^>]*)?>`, "gi");
  let startTagMatch: RegExpExecArray | null = null;

  let m: RegExpExecArray | null;
  while ((m = scanner.exec(html)) !== null) {
    const attrs = m[2] ?? "";
    // attrPattern with no source ("(?:)") matches everything — used for
    // tag-name-only matches like <main> or <article>.
    if (attrPattern.source === "(?:)" || attrPattern.test(attrs)) {
      startTagMatch = m;
      break;
    }
  }

  if (!startTagMatch) return null;

  const contentStart = startTagMatch.index + startTagMatch[0].length;

  // Walk forward counting open/close tags to find the matching close tag
  const openRe = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, "gi");
  const closeRe = new RegExp(`</${tagName}>`, "gi");

  let depth = 1;
  let pos = contentStart;

  while (depth > 0) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;

    const nextOpen = openRe.exec(html);
    const nextClose = closeRe.exec(html);

    if (!nextClose) break; // malformed HTML — return what we have

    if (nextOpen !== null && nextOpen.index < nextClose.index) {
      depth++;
      pos = nextOpen.index + nextOpen[0].length;
    } else {
      depth--;
      if (depth === 0) {
        return html.slice(contentStart, nextClose.index);
      }
      pos = nextClose.index + nextClose[0].length;
    }
  }

  return null;
}

/**
 * Extract the main documentation content from a page's HTML.
 *
 * Attempts to isolate the primary content container for each site type so
 * that navigation, sidebars, and footers are excluded.  Falls back to
 * full-page conversion when no known container is found.
 */
export function extractMainContent(html: string, siteType: DocSiteType): string {
  let contentHtml: string | null = null;

  switch (siteType) {
    case "sphinx":
      // Read-the-Docs and classic Sphinx themes use role="main" or .body
      contentHtml =
        extractElementByPattern(html, "div", /role=["']main["']/i) ??
        extractElementByPattern(html, "div", /class=["'][^"']*\bbody\b[^"']*["']/) ??
        extractElementByPattern(html, "section", /role=["']main["']/i) ??
        extractElementByPattern(html, "article", /(?:)/) ??
        null;
      break;

    case "vitepress":
      contentHtml =
        extractElementByPattern(html, "div", /class=["'][^"']*\bvp-doc\b[^"']*["']/i) ??
        extractElementByPattern(html, "div", /class=["'][^"']*\bVPDoc\b[^"']*["']/i) ??
        extractElementByPattern(html, "main", /(?:)/) ??
        null;
      break;

    case "doxygen":
      contentHtml =
        extractElementByPattern(html, "div", /class=["'][^"']*\bcontents\b[^"']*["']/) ??
        extractElementByPattern(html, "div", /id=["']doc-content["']/) ??
        extractElementByPattern(html, "div", /class=["'][^"']*\btextblock\b[^"']*["']/) ??
        null;
      break;

    case "generic":
      contentHtml =
        extractElementByPattern(html, "main", /(?:)/) ??
        extractElementByPattern(html, "article", /(?:)/) ??
        extractElementByPattern(html, "div", /\bid=["']content["']/) ??
        extractElementByPattern(html, "div", /class=["'][^"']*\bcontent\b[^"']*["']/) ??
        null;
      break;
  }

  return NodeHtmlMarkdown.translate(contentHtml ?? html);
}

/**
 * Extract the page title from HTML.
 *
 * Tries (in order): H1 tag, <title> tag, URL-derived fallback.
 */
export function extractDocTitle(html: string, url: string): string {
  // H1 is the most semantically accurate source for documentation pages
  const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1Match?.[1]) {
    const title = h1Match[1].replace(/<[^>]+>/g, "").trim();
    if (title) return title;
  }

  // <title> tag as fallback
  const titleTagMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  if (titleTagMatch?.[1]) {
    const title = titleTagMatch[1].trim();
    if (title) return title;
  }

  // Last resort: derive from URL path
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/$/, "");
    const segment = path.split("/").pop();
    if (segment) {
      return segment.replace(/[-_]/g, " ").replace(/\.\w+$/, "");
    }
    return parsed.hostname;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------

/**
 * Extract all internal HTML anchor links from a page.
 *
 * Filters links to:
 * - Same origin as the base URL
 * - Path starting with `pathPrefix`
 * - Not a binary/asset file extension
 * - Not fragment-only references
 *
 * Returns an array of normalised absolute URLs.
 */
export function extractDocLinks(html: string, baseUrl: string, pathPrefix: string): string[] {
  const base = new URL(baseUrl);
  const links = new Set<string>();

  const hrefRe = /<a\s[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = hrefRe.exec(html)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    // Skip fragment-only, mailto:, javascript:, etc.
    if (raw.startsWith("#") || raw.startsWith("mailto:") || raw.startsWith("javascript:")) {
      continue;
    }

    try {
      const resolved = new URL(raw, baseUrl);

      if (resolved.origin !== base.origin) continue;
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;

      const ext = resolved.pathname.split(".").pop()?.toLowerCase() ?? "";
      if (SKIP_EXTENSIONS.has(ext)) continue;

      if (pathPrefix && !resolved.pathname.startsWith(pathPrefix)) continue;

      links.add(normalizeUrl(resolved.href));
    } catch {
      // Ignore unparseable hrefs
    }
  }

  return [...links];
}

// ---------------------------------------------------------------------------
// Sitemap parsing
// ---------------------------------------------------------------------------

/**
 * Extract page URLs from a sitemap.xml (or sitemap index) document.
 *
 * Only returns URLs on the same origin as `baseUrl` and under `pathPrefix`.
 * Binary/asset paths are excluded.
 */
export function extractSitemapUrls(xml: string, baseUrl: string, pathPrefix: string): string[] {
  const base = new URL(baseUrl);
  const urls: string[] = [];
  const seen = new Set<string>();

  const locRe = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;

  while ((match = locRe.exec(xml)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    try {
      const parsed = new URL(raw);
      if (parsed.origin !== base.origin) continue;
      if (pathPrefix && !parsed.pathname.startsWith(pathPrefix)) continue;

      const ext = parsed.pathname.split(".").pop()?.toLowerCase() ?? "";
      if (SKIP_EXTENSIONS.has(ext)) continue;

      const normalised = normalizeUrl(parsed.href);
      if (!seen.has(normalised)) {
        seen.add(normalised);
        urls.push(normalised);
      }
    } catch {
      // Skip invalid URLs
    }
  }

  return urls;
}

// ---------------------------------------------------------------------------
// Internal page processing
// ---------------------------------------------------------------------------

/** Context passed to processPage to avoid a long parameter list. */
interface PageContext {
  siteType: DocSiteType;
  db: Database.Database;
  provider: EmbeddingProvider;
  config: DocSiteConfig;
  /** Map of normalised URL → existing document ID for update detection. */
  existingUrlMap: Map<string, string>;
  result: DocSiteSyncResult;
}

/**
 * Process a single documentation page: extract title + content, then index.
 *
 * indexDocument() handles URL-based dedup automatically: if the URL already
 * exists and the content hash is unchanged the call is a no-op; if the hash
 * changed the old document is replaced.
 */
async function processPage(url: string, html: string, ctx: PageContext): Promise<void> {
  const log = getLogger();

  const title = extractDocTitle(html, url);
  const content = extractMainContent(html, ctx.siteType);

  if (!content.trim()) {
    ctx.result.pagesSkipped++;
    log.debug({ url }, "Skipping empty page");
    return;
  }

  const normalised = normalizeUrl(url);
  const isKnown = ctx.existingUrlMap.has(normalised);

  const indexed = await indexDocument(ctx.db, ctx.provider, {
    title,
    content,
    sourceType: SOURCE_TYPE,
    url,
    library: ctx.config.library,
    version: ctx.config.version,
    submittedBy: "crawler",
  });

  // chunkCount === 0 means indexDocument determined the page was unchanged
  if (indexed.chunkCount === 0 && isKnown) {
    ctx.result.pagesSkipped++;
  } else if (isKnown) {
    ctx.result.pagesUpdated++;
  } else {
    ctx.result.pagesIndexed++;
  }

  log.debug({ url, title, chunks: indexed.chunkCount }, "Processed documentation page");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Crawl and index a documentation site.
 *
 * 1. Fetches the root page to auto-detect the site type.
 * 2. Tries to discover all pages via sitemap.xml.
 * 3. Falls back to (or supplements) BFS link crawling.
 * 4. Processes pages concurrently in configurable batches.
 *
 * URL-based deduplication is handled by indexDocument(): unchanged pages
 * are skipped automatically; changed pages are re-indexed in-place.
 */
export async function syncDocSite(
  db: Database.Database,
  provider: EmbeddingProvider,
  config: DocSiteConfig,
): Promise<DocSiteSyncResult> {
  const log = getLogger();

  // --- Validate input ---
  if (!config.url?.trim()) {
    throw new ValidationError("DocSiteConfig.url is required");
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(config.url);
  } catch {
    throw new ValidationError(`Invalid URL: ${config.url}`);
  }

  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new ValidationError(`URL must use http or https scheme: ${config.url}`);
  }

  const maxPages = config.maxPages ?? DEFAULT_MAX_PAGES;
  const maxDepth = config.maxDepth ?? DEFAULT_MAX_DEPTH;
  const concurrency = Math.max(1, Math.min(config.concurrency ?? DEFAULT_CONCURRENCY, 10));

  // Restrict crawl to the root pathname by default so we don't leave the docs section
  const pathPrefix = config.pathPrefix ?? baseUrl.pathname;

  const fetchOptions: FetchOptions = {
    allowPrivateUrls: config.allowPrivateUrls ?? false,
    allowSelfSignedCerts: config.allowSelfSignedCerts ?? false,
  };

  const result: DocSiteSyncResult = {
    pagesIndexed: 0,
    pagesUpdated: 0,
    pagesSkipped: 0,
    detectedType: "generic",
    errors: [],
  };

  const syncId = startSync(db, CONNECTOR_TYPE, config.url);

  try {
    // --- Fetch root page ---
    log.info({ url: config.url }, "Fetching documentation root page");

    let rootHtml: string;
    try {
      const raw = await fetchRaw(config.url, fetchOptions);
      rootHtml = raw.body;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to fetch root page: ${msg}`);
    }

    // --- Detect site type ---
    result.detectedType =
      config.type !== undefined && config.type !== "auto"
        ? config.type
        : detectDocSiteType(rootHtml);

    log.info({ type: result.detectedType, url: config.url }, "Documentation site type");

    // --- URL discovery ---
    const visited = new Set<string>();
    // Queue entries: { url, depth }
    const queue: Array<{ url: string; depth: number }> = [];

    const rootNormalised = normalizeUrl(config.url);
    visited.add(rootNormalised);

    // Attempt sitemap discovery for comprehensive URL list
    const sitemapUrl = `${baseUrl.origin}/sitemap.xml`;
    try {
      const sitemapRaw = await fetchRaw(sitemapUrl, fetchOptions);
      if (sitemapRaw.contentType.includes("xml") || sitemapRaw.body.includes("<urlset")) {
        const sitemapUrls = extractSitemapUrls(sitemapRaw.body, config.url, pathPrefix);
        for (const u of sitemapUrls) {
          if (!visited.has(u)) {
            queue.push({ url: u, depth: 1 });
            visited.add(u);
          }
        }
        log.info({ count: sitemapUrls.length }, "Discovered URLs from sitemap.xml");
      }
    } catch {
      log.debug({ url: sitemapUrl }, "sitemap.xml unavailable, falling back to link crawling");
    }

    // Seed queue from root page links (supplements or replaces sitemap)
    for (const link of extractDocLinks(rootHtml, config.url, pathPrefix)) {
      if (!visited.has(link)) {
        queue.push({ url: link, depth: 1 });
        visited.add(link);
      }
    }

    // --- Build existing-URL index for update tracking ---
    const existingDocs = listDocuments(db, { sourceType: SOURCE_TYPE, library: config.library });
    const existingUrlMap = new Map<string, string>(
      existingDocs
        .filter((d): d is typeof d & { url: string } => d.url !== null)
        .map((d) => [normalizeUrl(d.url), d.id]),
    );

    const ctx: PageContext = {
      siteType: result.detectedType,
      db,
      provider,
      config,
      existingUrlMap,
      result,
    };

    // --- Process the root page first ---
    await processPage(rootNormalised, rootHtml, ctx);

    // --- BFS crawl ---
    while (queue.length > 0 && visited.size <= maxPages) {
      const batch = queue.splice(0, concurrency);

      await Promise.allSettled(
        batch.map(async ({ url, depth }) => {
          if (visited.size > maxPages) return;

          let html: string;
          let contentType: string;
          try {
            const raw = await fetchRaw(url, fetchOptions);
            html = raw.body;
            contentType = raw.contentType;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ url, error: msg }, "Failed to fetch documentation page");
            result.errors.push({ url, error: msg });
            return;
          }

          // Only process HTML pages (skip binary/asset responses that slipped through)
          if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
            return;
          }

          await processPage(url, html, ctx);

          // Continue link discovery if within depth budget
          if (depth < maxDepth) {
            for (const link of extractDocLinks(html, url, pathPrefix)) {
              if (!visited.has(link)) {
                visited.add(link);
                queue.push({ url: link, depth: depth + 1 });
              }
            }
          }
        }),
      );
    }

    completeSync(db, syncId, {
      added: result.pagesIndexed,
      updated: result.pagesUpdated,
      deleted: 0,
      errored: result.errors.length,
    });

    log.info(
      {
        pagesIndexed: result.pagesIndexed,
        pagesUpdated: result.pagesUpdated,
        pagesSkipped: result.pagesSkipped,
        errors: result.errors.length,
      },
      "Documentation site sync complete",
    );

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failSync(db, syncId, msg);
    throw err;
  }
}

/**
 * Remove all documents that were indexed from a given documentation site.
 *
 * Identifies documents by URL prefix (`siteUrl + "%"`) so only pages that
 * originated from the specified site are removed.
 *
 * @param db      The database connection.
 * @param siteUrl Root URL of the documentation site (used as URL prefix filter).
 * @returns       The number of documents deleted.
 */
export function disconnectDocSite(db: Database.Database, siteUrl: string): number {
  const log = getLogger();

  let basePrefix: string;
  try {
    const parsed = new URL(siteUrl);
    // Use origin + pathname as prefix so we don't accidentally match sibling sites
    basePrefix = parsed.origin + parsed.pathname;
  } catch {
    throw new ValidationError(`Invalid site URL for disconnect: ${siteUrl}`);
  }

  const rows = db
    .prepare("SELECT id FROM documents WHERE url LIKE ?")
    .all(`${basePrefix}%`) as Array<{ id: string }>;

  let removed = 0;
  for (const row of rows) {
    try {
      deleteDocument(db, row.id);
      removed++;
    } catch {
      // Document may have already been deleted
    }
  }

  log.info({ siteUrl, removed }, "Documentation site disconnected");
  return removed;
}
