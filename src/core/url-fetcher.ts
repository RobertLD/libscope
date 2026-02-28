import { EmbeddingError } from "../errors.js";
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
    const response = await fetch(url, {
      headers: {
        "User-Agent": "LibScope/0.1.0 (documentation indexer)",
        Accept: "text/html, text/markdown, text/plain, */*",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
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
    if (err instanceof EmbeddingError) throw err;
    throw new EmbeddingError(`Failed to fetch URL: ${url} — ${String(err)}`, err);
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
  let text = html;

  // Remove script, style, nav, footer, header tags and their content
  text = text.replace(/<(script|style|nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Convert headings
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");

  // Convert code blocks
  text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n");
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // Convert lists
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");

  // Convert paragraphs and breaks
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<p[^>]*>/gi, "");

  // Convert links
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

  // Convert bold/italic
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");

  // Clean up whitespace
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}
