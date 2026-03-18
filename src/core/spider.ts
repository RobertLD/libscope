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
  fetchOptions?: Pick<
    FetchOptions,
    "allowPrivateUrls" | "allowSelfSignedCerts" | "timeout" | "maxBodySize"
  >;
}

export interface SpiderResult {
  url: string;
  title: string;
  content: string;
  depth: number;
}

export interface SpiderStats {
  /** Pages successfully fetched and yielded to the caller (caller decides whether to index). */
  pagesFetched: number;
  pagesCrawled: number;
  pagesSkipped: number;
  errors: Array<{ url: string; error: string }>;
  abortReason?: "maxPages" | "timeout";
}

// ── robots.txt parsing ───────────────────────────────────────────────────────

/** Fetch robots.txt for an origin, capping the timeout at 10 s regardless of caller options. */
async function fetchRobotsTxt(
  origin: string,
  fetchOptions?: SpiderOptions["fetchOptions"],
): Promise<Set<string>> {
  const robotsUrl = origin + "/robots.txt";
  // Cap robots.txt timeout: use caller's timeout only if shorter than our hard cap.
  const effectiveTimeout =
    fetchOptions?.timeout !== undefined && Number.isFinite(fetchOptions.timeout)
      ? Math.min(fetchOptions.timeout, 10_000)
      : 10_000;
  try {
    const raw = await fetchRaw(robotsUrl, { ...fetchOptions, timeout: effectiveTimeout });
    return parseRobotsTxt(raw.body);
  } catch {
    // robots.txt missing or inaccessible — no restrictions
    return new Set();
  }
}

/**
 * Parse robots.txt and return Disallow path prefixes that apply to our agent.
 *
 * Implements proper UA precedence: if any group explicitly names "libscope",
 * only those groups apply (ignoring wildcard). Otherwise wildcard groups apply.
 * This matches the robots.txt spec — a specific UA rule overrides the wildcard.
 */
type RobotsGroup = { agents: string[]; disallows: string[] };

/** Parse a single robots.txt line into groups, updating the current group state. */
function processRobotsLine(
  line: string,
  groups: RobotsGroup[],
  current: RobotsGroup | null,
): RobotsGroup | null {
  const lower = line.toLowerCase();
  if (lower.startsWith("user-agent:")) {
    const agent = line.slice("user-agent:".length).trim();
    if (current === null || current.disallows.length > 0) {
      current = { agents: [], disallows: [] };
      groups.push(current);
    }
    current.agents.push(agent.toLowerCase());
    return current;
  }
  if (lower.startsWith("disallow:") && current !== null) {
    const path = line.slice("disallow:".length).trim();
    if (path.length > 0) current.disallows.push(path);
  }
  return current;
}

function parseRobotsTxt(text: string): Set<string> {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#") || line.length === 0) continue;
    current = processRobotsLine(line, groups, current);
  }

  // Prefer explicit "libscope" group over the wildcard group
  const libscopeGroups = groups.filter((g) => g.agents.includes("libscope"));
  const selected =
    libscopeGroups.length > 0 ? libscopeGroups : groups.filter((g) => g.agents.includes("*"));

  const disallowed = new Set<string>();
  for (const group of selected) {
    for (const path of group.disallows) disallowed.add(path);
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

/**
 * Scan past a single HTML tag starting after the opening '<'.
 * Returns the index immediately after the closing '>'.
 * Respects quoted attribute values so '>' inside them doesn't end the tag early.
 */
function scanPastTag(input: string, start: number): number {
  let i = start;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ">") return i + 1;
    if (ch === '"' || ch === "'") {
      const close = input.indexOf(ch, i + 1);
      i = close === -1 ? input.length : close + 1;
    } else {
      i++;
    }
  }
  return i;
}

/**
 * Remove all HTML tags from a string using indexOf-based scanning.
 * Handles tags that span multiple lines and tags with > inside attribute values.
 * This avoids regex-based tag stripping which can be bypassed by newlines in tags.
 */
function stripTags(input: string): string {
  let result = "";
  let pos = 0;
  while (pos < input.length) {
    const open = input.indexOf("<", pos);
    if (open === -1) {
      result += input.slice(pos);
      break;
    }
    result += input.slice(pos, open);
    pos = scanPastTag(input, open + 1);
  }
  // Collapse whitespace left behind by removed tags
  return result.replace(/\s+/g, " ");
}

function extractTitle(html: string, url: string): string {
  // Try <title> tag
  const match = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  if (match?.[1]) return match[1].trim();
  // Try first <h1>
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1?.[1]) {
    return stripTags(h1[1]).trim();
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
    pagesFetched: 0,
    pagesCrawled: 0,
    pagesSkipped: 0,
    errors: [],
  };

  // Per-origin robots.txt cache — fetched lazily as new origins are encountered.
  // Pre-populate with the seed origin so we don't re-fetch it on the first page.
  const robotsCache = new Map<string, Set<string>>();
  const seedRobots = await fetchRobotsTxt(seedOrigin, fetchOptions);
  robotsCache.set(seedOrigin, seedRobots);
  log.debug({ origin: seedOrigin, rules: seedRobots.size }, "Loaded robots.txt rules");

  const visited = new Set<string>();
  // BFS queue entries
  type QueueEntry = { url: string; depth: number };
  const queue: QueueEntry[] = [{ url: seedUrl, depth: 0 }];

  const deadline = Date.now() + HARD_TOTAL_TIMEOUT_MS;

  while (queue.length > 0 && stats.pagesFetched < maxPages) {
    // Check total timeout
    if (Date.now() > deadline) {
      log.warn({ pagesFetched: stats.pagesFetched }, "Spider total timeout reached");
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
      // Fetch robots.txt for new origins (cross-domain crawl when sameDomain is false)
      let urlOrigin: string;
      try {
        urlOrigin = new URL(url).origin;
      } catch {
        urlOrigin = seedOrigin;
      }
      if (!robotsCache.has(urlOrigin)) {
        const rules = await fetchRobotsTxt(urlOrigin, fetchOptions);
        robotsCache.set(urlOrigin, rules);
        log.debug(
          { origin: urlOrigin, rules: rules.size },
          "Loaded robots.txt rules for new origin",
        );
      }
      if (isDisallowedByRobots(url, robotsCache.get(urlOrigin)!)) {
        log.debug({ url }, "Spider: skipping URL disallowed by robots.txt");
        stats.pagesSkipped++;
        continue;
      }
    }

    // Check maxPages before fetching
    if (stats.pagesFetched >= maxPages) {
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

    // Normalize to the final URL after any redirects.
    // This ensures the visited set, yielded URL, and link-extraction base are all consistent.
    const canonicalUrl = raw.finalUrl || url;
    if (canonicalUrl !== url) {
      visited.add(canonicalUrl);
    }

    // Convert to markdown
    const isHtml = raw.contentType.includes("text/html");
    const content = isHtml ? htmlToMarkdown(raw.body) : raw.body;
    const title = isHtml
      ? extractTitle(raw.body, canonicalUrl)
      : extractTextTitle(raw.body, canonicalUrl);

    stats.pagesFetched++;
    yield { url: canonicalUrl, title, content, depth };

    // Extract and enqueue child links if we haven't hit maxDepth
    if (depth < maxDepth) {
      if (isHtml) {
        const links = extractLinks(raw.body, canonicalUrl);
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
  if (!stats.abortReason && queue.length > 0 && stats.pagesFetched >= maxPages) {
    stats.abortReason = "maxPages";
  }

  log.info(
    {
      pagesFetched: stats.pagesFetched,
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
