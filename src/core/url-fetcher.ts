import { NodeHtmlMarkdown } from "node-html-markdown";
import { FetchError } from "../errors.js";
import { getLogger } from "../logger.js";

export interface FetchedDocument {
  title: string;
  content: string;
}

/**
 * Fetch a URL and convert its HTML content to clean markdown-like text.
 * Strips tags, preserves code blocks and headings.
 */
export async function fetchAndConvert(url: string): Promise<FetchedDocument> {
  const log = getLogger();
  log.info({ url }, "Fetching URL");

  try {
    // redirect: "follow" uses the browser/Node default of ~20 redirects
    const response = await fetch(url, {
      headers: {
        "User-Agent": "LibScope/0.1.0 (documentation indexer)",
        Accept: "text/html, text/markdown, text/plain, */*",
      },
      signal: AbortSignal.timeout(30_000),
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Check content-length to avoid downloading huge pages
    const contentLength = parseInt(response.headers.get("content-length") ?? "0", 10);
    const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
    if (contentLength > MAX_BODY_SIZE) {
      throw new FetchError(
        `Response too large: ${contentLength} bytes (max ${MAX_BODY_SIZE})`,
        undefined,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    // Body download is also bounded by the 30-second timeout above
    const body = await response.text();

    // If it's already markdown or plain text, return as-is
    if (contentType.includes("text/markdown") || contentType.includes("text/plain")) {
      return {
        title: extractTitleFromMarkdown(body) ?? titleFromUrl(url),
        content: body,
      };
    }

    // Convert HTML to simplified text
    const converted = htmlToText(body);
    return {
      title: extractTitleFromHtml(body) ?? titleFromUrl(url),
      content: converted,
    };
  } catch (err) {
    if (err instanceof FetchError) throw err;
    throw new FetchError(`Failed to fetch URL: ${url} — ${String(err)}`, err);
  }
}

/** Extract title from HTML <title> tag. */
function extractTitleFromHtml(html: string): string | null {
  const match = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  return match?.[1]?.trim() ?? null;
}

/** Extract title from first markdown heading. */
function extractTitleFromMarkdown(md: string): string | null {
  const match = /^#\s+(.+)$/m.exec(md);
  return match?.[1]?.trim() ?? null;
}

/** Derive a title from the URL path. */
function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/$/, "");
    const last = path.split("/").pop();
    if (last) {
      return last.replace(/[-_]/g, " ").replace(/\.\w+$/, "");
    }
    return parsed.hostname;
  } catch {
    return url;
  }
}

/** Convert HTML to simplified plain text / pseudo-markdown. */
function htmlToText(html: string): string {
  return NodeHtmlMarkdown.translate(html);
}
