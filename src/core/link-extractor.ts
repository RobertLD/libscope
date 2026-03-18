/**
 * Link extraction from HTML.
 * Parses <a href="..."> tags using fast indexOf-based parsing (no regex catastrophic backtracking).
 * Resolves relative URLs, strips fragments, deduplicates, and filters to http/https only.
 */

/**
 * Extract all unique, normalized http/https links from an HTML string.
 *
 * @param html     Raw HTML to parse.
 * @param baseUrl  The URL the HTML was fetched from — used to resolve relative hrefs.
 * @returns        Deduplicated array of absolute http/https URLs (no fragments, trailing slashes
 *                 on path roots normalized away).
 */
export function extractLinks(html: string, baseUrl: string): string[] {
  const seen = new Set<string>();
  const links: string[] = [];

  let pos = 0;
  const lower = html.toLowerCase();

  while (pos < html.length) {
    // Find the next <a opening tag
    const tagStart = lower.indexOf("<a", pos);
    if (tagStart === -1) break;

    // Make sure it's really an <a> tag (next char must be space, >, or /)
    const charAfterA = lower[tagStart + 2];
    if (
      charAfterA !== " " &&
      charAfterA !== "\t" &&
      charAfterA !== "\n" &&
      charAfterA !== "\r" &&
      charAfterA !== ">" &&
      charAfterA !== "/"
    ) {
      pos = tagStart + 2;
      continue;
    }

    // Find end of opening tag
    const tagEnd = html.indexOf(">", tagStart);
    if (tagEnd === -1) break;

    const tag = html.slice(tagStart, tagEnd + 1);
    const href = extractHref(tag);

    if (href !== null) {
      const resolved = resolveUrl(href, baseUrl);
      if (resolved !== null && !seen.has(resolved)) {
        seen.add(resolved);
        links.push(resolved);
      }
    }

    pos = tagEnd + 1;
  }

  return links;
}

/** Check if the character before href is valid whitespace (attribute boundary). */
function isAttributeBoundary(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/** Skip whitespace characters starting from pos. */
function skipWhitespace(tag: string, pos: number): number {
  let i = pos;
  while (i < tag.length && (tag[i] === " " || tag[i] === "\t")) i++;
  return i;
}

/** Extract an attribute value starting at valStart (quoted or unquoted). Returns null on failure. */
function extractAttributeValue(tag: string, valStart: number): string | null {
  if (valStart >= tag.length) return null;

  const quote = tag[valStart];
  if (quote === '"' || quote === "'") {
    const closeQuote = tag.indexOf(quote, valStart + 1);
    if (closeQuote === -1) return null;
    return tag.slice(valStart + 1, closeQuote);
  }

  // Unquoted attribute value — ends at whitespace or >
  let end = valStart;
  while (
    end < tag.length &&
    tag[end] !== " " &&
    tag[end] !== "\t" &&
    tag[end] !== ">" &&
    tag[end] !== "\n"
  ) {
    end++;
  }
  return tag.slice(valStart, end);
}

/**
 * Extract the href attribute value from an <a ...> tag string.
 * Returns null if no href found or href is empty.
 */
function extractHref(tag: string): string | null {
  const lowerTag = tag.toLowerCase();
  let searchPos = 0;

  while (searchPos < lowerTag.length) {
    const hrefIdx = lowerTag.indexOf("href", searchPos);
    if (hrefIdx === -1) return null;

    const charBefore = hrefIdx > 0 ? (lowerTag[hrefIdx - 1] ?? "") : "";
    if (!isAttributeBoundary(charBefore)) {
      searchPos = hrefIdx + 4;
      continue;
    }

    const eqIdx = skipWhitespace(tag, hrefIdx + 4);
    if (tag[eqIdx] !== "=") {
      searchPos = hrefIdx + 4;
      continue;
    }

    const valStart = skipWhitespace(tag, eqIdx + 1);
    const raw = extractAttributeValue(tag, valStart);
    if (raw === null) return null;

    const href = raw.trim();
    return href.length > 0 ? href : null;
  }

  return null;
}

/**
 * Resolve a potentially-relative href against a base URL.
 * Returns null if the result is not an http/https URL (e.g. mailto:, javascript:, data:, #fragment-only).
 */
/**
 * Extract markdown-style links from content.
 * Parses [text](url) patterns and returns an array of {text, url} objects.
 */
export function extractMarkdownLinks(content: string): Array<{ text: string; url: string }> {
  if (!content) return [];

  const results: Array<{ text: string; url: string }> = [];

  // indexOf-based parsing to avoid ReDoS with regex on untrusted content
  let pos = 0;
  while (pos < content.length) {
    const bracketOpen = content.indexOf("[", pos);
    if (bracketOpen === -1) break;

    const bracketClose = content.indexOf("]", bracketOpen + 1);
    if (bracketClose === -1) break;

    // Must be followed immediately by (
    if (bracketClose + 1 >= content.length || content[bracketClose + 1] !== "(") {
      pos = bracketClose + 1;
      continue;
    }

    const parenClose = content.indexOf(")", bracketClose + 2);
    if (parenClose === -1) break;

    const text = content.slice(bracketOpen + 1, bracketClose);
    const url = content.slice(bracketClose + 2, parenClose);

    // Skip if text contains unescaped [ (nested brackets) or url is empty
    if (url.length > 0 && !text.includes("[")) {
      results.push({ text, url });
    }

    pos = parenClose + 1;
  }

  return results;
}

/**
 * Extract wikilinks from content.
 * Parses [[PageName]] and [[PageName|alias]] formats.
 * Returns deduplicated array of page names.
 */
export function extractWikilinks(content: string): string[] {
  if (!content) return [];

  const seen = new Set<string>();

  // indexOf-based parsing to avoid ReDoS with regex on untrusted content
  let pos = 0;
  while (pos < content.length) {
    const open = content.indexOf("[[", pos);
    if (open === -1) break;

    const close = content.indexOf("]]", open + 2);
    if (close === -1) break;

    const inner = content.slice(open + 2, close);

    // Skip if inner contains nested [[ (malformed)
    if (!inner.includes("[[")) {
      // [[PageName|alias]] → extract PageName (before the pipe)
      const pipeIdx = inner.indexOf("|");
      const pageName = (pipeIdx === -1 ? inner : inner.slice(0, pipeIdx)).trim();
      if (pageName) {
        seen.add(pageName);
      }
    }

    pos = close + 2;
  }

  return [...seen];
}

function resolveUrl(href: string, baseUrl: string): string | null {
  // Skip fragment-only links immediately — they point to the same page
  if (href.startsWith("#")) return null;

  let resolved: URL;
  try {
    resolved = new URL(href, baseUrl);
  } catch {
    return null;
  }

  // Allowlist: only permit http and https.
  // This rejects javascript:, vbscript:, data:, mailto:, ftp:, file:, and
  // any other non-http scheme without needing an enumerated blocklist.
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return null;
  }

  // Strip fragment
  resolved.hash = "";

  // Normalize: remove trailing slash from non-root paths
  // e.g. https://example.com/docs/ → https://example.com/docs
  // but  https://example.com/      stays as https://example.com/
  if (resolved.pathname.length > 1 && resolved.pathname.endsWith("/")) {
    resolved.pathname = resolved.pathname.slice(0, -1);
  }

  return resolved.href;
}
