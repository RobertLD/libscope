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
    if (charAfterA !== " " && charAfterA !== "\t" && charAfterA !== "\n" && charAfterA !== "\r" && charAfterA !== ">" && charAfterA !== "/") {
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

    // Skip whitespace before =
    let eqIdx = hrefIdx + 4;
    while (eqIdx < tag.length && (tag[eqIdx] === " " || tag[eqIdx] === "\t")) eqIdx++;

    if (tag[eqIdx] !== "=") {
      searchPos = hrefIdx + 4;
      continue;
    }

    // Skip whitespace after =
    let valStart = eqIdx + 1;
    while (valStart < tag.length && (tag[valStart] === " " || tag[valStart] === "\t")) valStart++;

    if (valStart >= tag.length) return null;

    let href: string;
    const quote = tag[valStart];
    if (quote === '"' || quote === "'") {
      const closeQuote = tag.indexOf(quote, valStart + 1);
      if (closeQuote === -1) return null;
      href = tag.slice(valStart + 1, closeQuote);
    } else {
      // Unquoted attribute value — ends at whitespace or >
      let end = valStart;
      while (end < tag.length && tag[end] !== " " && tag[end] !== "\t" && tag[end] !== ">" && tag[end] !== "\n") {
        end++;
      }
      href = tag.slice(valStart, end);
    }

    href = href.trim();
    return href.length > 0 ? href : null;
  }

  return null;
}

/**
 * Resolve a potentially-relative href against a base URL.
 * Returns null if the result is not an http/https URL (e.g. mailto:, javascript:, data:, #fragment-only).
 */
function resolveUrl(href: string, baseUrl: string): string | null {
  // Skip fragment-only links immediately — they point to the same page
  if (href.startsWith("#")) return null;

  // Skip clearly non-http schemes before URL parsing to avoid errors
  const lowerHref = href.toLowerCase();
  if (
    lowerHref.startsWith("mailto:") ||
    lowerHref.startsWith("javascript:") ||
    lowerHref.startsWith("tel:") ||
    lowerHref.startsWith("data:") ||
    lowerHref.startsWith("ftp:") ||
    lowerHref.startsWith("file:")
  ) {
    return null;
  }

  let resolved: URL;
  try {
    resolved = new URL(href, baseUrl);
  } catch {
    return null;
  }

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
