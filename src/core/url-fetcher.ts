import { promises as dns } from "node:dns";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { FetchError } from "../errors.js";
import { getLogger } from "../logger.js";

export interface FetchedDocument {
  title: string;
  content: string;
}

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB

/** Check whether an IP address belongs to a private/reserved range. */
export function isPrivateIP(ip: string): boolean {
  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) — extract the IPv4 part
  const v4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const normalized = v4Mapped ? v4Mapped[1]! : ip;

  // IPv6 checks
  if (normalized.includes(":")) {
    const lower = normalized.toLowerCase();
    if (lower === "::1") return true;
    if (/^f[cd]/i.test(lower)) return true; // fc00::/7
    if (/^fe[89ab]/i.test(lower)) return true; // fe80::/10
    return false;
  }

  // IPv4 checks
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

/**
 * Validate that the URL uses an allowed scheme and does not resolve to a
 * private/internal IP address (SSRF protection).
 */
async function validateUrl(url: string): Promise<void> {
  const parsed = new URL(url);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new FetchError(`Blocked scheme: ${parsed.protocol} — only http and https are allowed`);
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const { resolve4, resolve6 } = dns;
  const results = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);

  const addresses: string[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") addresses.push(...r.value);
  }

  if (addresses.length === 0) {
    throw new FetchError(`DNS resolution failed for hostname: ${hostname}`);
  }

  for (const addr of addresses) {
    if (isPrivateIP(addr)) {
      throw new FetchError(
        `Blocked request to private/internal IP ${addr} (resolved from ${hostname})`,
      );
    }
  }
}

/** Read a response body while enforcing a byte-size limit on actual data received. */
async function readBodyWithLimit(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limit) {
      throw new FetchError(`Response body too large (max ${limit} bytes)`);
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let received = 0;

  let result = await reader.read();
  while (!result.done) {
    const chunk = result.value;
    received += chunk.byteLength;
    if (received > limit) {
      await reader.cancel();
      throw new FetchError(`Response body too large: exceeded ${limit} bytes`);
    }
    chunks.push(chunk);
    result = await reader.read();
  }

  const combined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/**
 * Fetch a URL and convert its HTML content to clean markdown-like text.
 * Strips tags, preserves code blocks and headings.
 */
export async function fetchAndConvert(url: string): Promise<FetchedDocument> {
  const log = getLogger();
  log.info({ url }, "Fetching URL");

  try {
    await validateUrl(url);

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

    const contentType = response.headers.get("content-type") ?? "";
    const body = await readBodyWithLimit(response, MAX_BODY_SIZE);

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
    throw new FetchError(
      `Failed to fetch URL: ${url} — ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
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
