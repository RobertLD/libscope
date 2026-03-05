/**
 * URL spider engine — BFS crawl from a seed URL with configurable depth, page, domain, and path limits.
 *
 * Safety guarantees:
 *  - All URLs are SSRF-validated via fetchRaw() before fetching
 *  - Hard caps on pages (200) and depth (5) that cannot be overridden by callers
 *  - Total wall-clock timeout of 10 minutes aborts the crawl
 *  - robots.txt is fetched once per origin and its Disallow rules are honoured
 *  - Private/internal IPs are blocked by the underlying url-fetcher
 */

import { getLogger } from "../logger.js";
import { FetchError } from "../errors.js";
import { fetchRaw, type FetchOptions } from "./url-fetcher.js";
import { extractLinks } from "./link-extractor.js";
import { NodeHtmlMarkdown } from "node-html-markdown";

// ── Hard limits that callers cannot override ────────────────────────────────

const HARD_MAX_PAGES = 200;
const HARD_MAX_DEPTH = 5;
/** Total spider wall-clock timeout in ms (10 minutes). */
const HARD_TOTAL_TIMEOUT_MS = 10 * 60 * 1000;
/** Default delay between requests in ms (1 second). */
const DEFAULT_REQUEST_DELAY_MS = 1_000;

// ── Public types ─────────────────────────────────────────────────────────────

export interface SpiderOptions {
  /** Maximum total pages to index (default: 25, hard cap: 200). */
  maxPages?: number;
  /** Maximum hop depth from the seed URL (default: 2, hard cap: 5). 0 = seed only. */
  maxDepth?: number;
  /** Only follow links that share the same hostname as the seed (default: true). */
  sameDomain?: boolean;
  /** Only follow links whose path starts with this prefix (e.g. "/docs/"). */
  pathPrefix?: string;
  /** Glob-style patterns for URLs to skip (matched against full URL string). */
  excludePatterns?: string[];
  /** Milliseconds to wait between requests (default: 1000). */
  requestDelay?: number;
  /** Passed through to fetchRaw for each page request. */
  fetchOptions?: Pick<FetchOptions, "allowPrivateUrls" | "allowSelfSignedCerts" | "timeout" | "maxBodySize">;
}

export interface SpiderResult {
  url: string;
  title: string;
  content: string;
  depth: number;
}

export interface SpiderStats {
  pagesIndexed: number;
  pagesCrawled: number;
  pagesSkipped: number;
  errors: Array<{ url: string; error: string }>;
  abortReason?: "maxPages" | "timeout";
}

// ── robots.txt parsing ───────────────────────────────────────────────────────

/** Fetch and parse robots.txt for an origin. Returns a set of Disallow paths for our user-agent. */
async function fetchRobotsTxt(
  origin: string,
  fetchOptions?: SpiderOptions["fetchOptions"],
): Promise<Set<string>> {
  const robotsUrl = origin + "/robots.txt";
  try {
    const raw = await fetchRaw(robotsUrl, { timeout: 10_000, ...fetchOptions });
    return parseRobotsTxt(raw.body);
  } catch {
    // robots.txt missing or inaccessible — no restrictions
    return new Set();
  }
}

/**
 * Parse robots.txt and return Disallow path prefixes that apply to our agent.
 * Matches rules for "LibScope", "libscope", "*" (in that priority order).
 */
function parseRobotsTxt(text: string): Set<string> {
  const disallowed = new Set<string>();
  const lines = text.split(/\r?\n/);

  let applicable = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#") || line.length === 0) continue;

    const lower = line.toLowerCase();
    if (lower.startsWith("user-agent:")) {
      const agent = line.slice("user-agent:".length).trim().toLowerCase();
      applicable = agent === "*" || agent === "libscope";
    } else if (applicable && lower.startsWith("disallow:")) {
      const path = line.slice("disallow:".length).trim();
      if (path.length > 0) disallowed.add(path);
    } else if (lower.startsWith("user-agent:")) {
      // New block — reset
      applicable = false;
    }
  }

  return disallowed;
}

function isDisallowedByRobots(url: string, disallowed: Set<string>): boolean {
  if (disallowed.size === 0) return false;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  for (const prefix of disallowed) {
    if (pathname.startsWith(prefix)) return true;
  }
  return false;
}

// ── Wildcard/glob pattern matching ──────────────────────────────────────────

const REGEX_SPECIAL = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

// Match a URL against a simple glob pattern.
// Both * and ** match any sequence of characters including path separators.
// Matching is case-insensitive and applied to the full URL string.
function matchesGlob(url: string, pattern: string): boolean {
  let regexStr = "^";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      regexStr += ".*";
      i += 2;
      if (pattern[i] === "/") i++; // skip optional trailing slash after **
    } else if (pattern[i] === "*") {
      regexStr += ".*"; // * also matches / in URL context
      i++;
    } else {
      const ch = pattern[i]!;
      // Escape chars that are special in regex
      if (REGEX_SPECIAL.has(ch)) {
        regexStr += "\\" + ch;
      } else {
        regexStr += ch;
      }
      i++;
    }
  }
  regexStr += "$";
  try {
    return new RegExp(regexStr, "i").test(url);
  } catch {
    return false;
  }
}

function isExcluded(url: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesGlob(url, p));
}

// ── Domain / path filtering ──────────────────────────────────────────────────

function isSameDomain(url: string, seedHostname: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const seed = seedHostname.toLowerCase();
    // Allow exact match or subdomain match (e.g. docs.example.com vs example.com)
    return host === seed || host.endsWith("." + seed);
  } catch {
    return false;
  }
}

function hasPathPrefix(url: string, prefix: string): boolean {
  if (!prefix) return true;
  try {
    return new URL(url).pathname.startsWith(prefix);
  } catch {
    return false;
  }
}

// ── HTML → markdown (reuse url-fetcher's approach) ──────────────────────────

function htmlToMarkdown(html: string): string {
  return NodeHtmlMarkdown.translate(html);
}

function extractTitle(html: string, url: string): string {
  // Try <title> tag
  const match = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  if (match?.[1]) return match[1].trim();
  // Try first <h1>
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1?.[1]) {
    // Strip inner tags
    return h1[1].replace(/<[^>]+>/g, "").trim();
  }
  // Fall back to URL path
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/$/, "");
    const last = path.split("/").pop();
    if (last) return last.replace(/[-_]/g, " ").replace(/\.\w+$/, "");
    return parsed.hostname;
  } catch {
    return url;
  }
}

// ── Spider engine ────────────────────────────────────────────────────────────

/**
 * Spider a seed URL, yielding each successfully fetched page as a SpiderResult.
 * Performs BFS up to maxDepth hops and maxPages total.
 *
 * @example
 * for await (const page of spiderUrl("https://docs.example.com", { maxPages: 50, maxDepth: 2 })) {
 *   await indexDocument(db, provider, { title: page.title, content: page.content, url: page.url });
 * }
 */
export async function* spiderUrl(
  seedUrl: string,
  options: SpiderOptions = {},
): AsyncGenerator<SpiderResult, SpiderStats, unknown> {
  const log = getLogger();

  // Resolve effective limits
  const maxPages = Math.min(options.maxPages ?? 25, HARD_MAX_PAGES);
  const maxDepth = Math.min(options.maxDepth ?? 2, HARD_MAX_DEPTH);
  const sameDomain = options.sameDomain ?? true;
  const pathPrefix = options.pathPrefix ?? "";
  const excludePatterns = options.excludePatterns ?? [];
  const requestDelay = options.requestDelay ?? DEFAULT_REQUEST_DELAY_MS;
  const fetchOptions = options.fetchOptions;

  // Parse seed URL for domain filtering
  let seedHostname: string;
  let seedOrigin: string;
  try {
    const parsed = new URL(seedUrl);
    seedHostname = parsed.hostname;
    seedOrigin = parsed.origin;
  } catch {
    throw new FetchError("Invalid seed URL: " + seedUrl);
  }

  const stats: SpiderStats = {
    pagesIndexed: 0,
    pagesCrawled: 0,
    pagesSkipped: 0,
    errors: [],
  };

  // Fetch robots.txt once for the origin
  const disallowed = await fetchRobotsTxt(seedOrigin, fetchOptions);
  log.debug({ origin: seedOrigin, rules: disallowed.size }, "Loaded robots.txt rules");

  const visited = new Set<string>();
  // BFS queue entries
  type QueueEntry = { url: string; depth: number };
  const queue: QueueEntry[] = [{ url: seedUrl, depth: 0 }];

  const deadline = Date.now() + HARD_TOTAL_TIMEOUT_MS;

  while (queue.length > 0 && stats.pagesIndexed < maxPages) {
    // Check total timeout
    if (Date.now() > deadline) {
      log.warn({ pagesIndexed: stats.pagesIndexed }, "Spider total timeout reached");
      stats.abortReason = "timeout";
      break;
    }

    const entry = queue.shift()!;
    const { url, depth } = entry;

    // Skip already-visited
    if (visited.has(url)) continue;
    visited.add(url);

    // Apply filters (except for seed URL at depth 0 — always fetch it)
    if (depth > 0) {
      if (sameDomain && !isSameDomain(url, seedHostname)) {
        log.debug({ url }, "Spider: skipping cross-domain link");
        stats.pagesSkipped++;
        continue;
      }
      if (pathPrefix && !hasPathPrefix(url, pathPrefix)) {
        log.debug({ url, pathPrefix }, "Spider: skipping link outside path prefix");
        stats.pagesSkipped++;
        continue;
      }
      if (excludePatterns.length > 0 && isExcluded(url, excludePatterns)) {
        log.debug({ url }, "Spider: skipping excluded URL");
        stats.pagesSkipped++;
        continue;
      }
      if (isDisallowedByRobots(url, disallowed)) {
        log.debug({ url }, "Spider: skipping URL disallowed by robots.txt");
        stats.pagesSkipped++;
        continue;
      }
    }

    // Check maxPages before fetching
    if (stats.pagesIndexed >= maxPages) {
      stats.abortReason = "maxPages";
      break;
    }

    // Delay between requests (skip delay before first request)
    if (stats.pagesCrawled > 0 && requestDelay > 0) {
      await sleep(requestDelay);
    }

    // Fetch the page
    log.info({ url, depth }, "Spider: fetching page");
    stats.pagesCrawled++;

    let raw: Awaited<ReturnType<typeof fetchRaw>>;
    try {
      raw = await fetchRaw(url, fetchOptions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ url, err: msg }, "Spider: fetch failed, skipping");
      stats.errors.push({ url, error: msg });
      continue;
    }

    // Convert to markdown
    const isHtml = raw.contentType.includes("text/html");
    const content = isHtml ? htmlToMarkdown(raw.body) : raw.body;
    const title = isHtml ? extractTitle(raw.body, url) : extractTextTitle(raw.body, url);

    stats.pagesIndexed++;
    yield { url, title, content, depth };

    // Extract and enqueue child links if we haven't hit maxDepth
    if (depth < maxDepth) {
      if (isHtml) {
        const links = extractLinks(raw.body, raw.finalUrl || url);
        for (const link of links) {
          if (!visited.has(link)) {
            queue.push({ url: link, depth: depth + 1 });
          }
        }
        log.debug({ url, linksFound: links.length }, "Spider: extracted links");
      }
    }
  }

  // If the loop exited via the outer while condition hitting maxPages (not via
  // an explicit break with abortReason already set), record the reason now.
  if (!stats.abortReason && queue.length > 0 && stats.pagesIndexed >= maxPages) {
    stats.abortReason = "maxPages";
  }

  log.info(
    {
      pagesIndexed: stats.pagesIndexed,
      pagesCrawled: stats.pagesCrawled,
      pagesSkipped: stats.pagesSkipped,
      errors: stats.errors.length,
      abortReason: stats.abortReason,
    },
    "Spider: crawl complete",
  );

  return stats;
}

function extractTextTitle(text: string, url: string): string {
  // For plain text/markdown, try first # heading
  const match = /^#\s+(.+)$/m.exec(text);
  if (match?.[1]) return match[1].trim();
  // Fall back to URL
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/$/, "");
    const last = path.split("/").pop();
    if (last) return last.replace(/[-_]/g, " ").replace(/\.\w+$/, "");
    return parsed.hostname;
  } catch {
    return url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
