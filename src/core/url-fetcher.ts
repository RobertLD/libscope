import { promises as dns, lookup as dnsLookup } from "node:dns";
import { promisify } from "node:util";
import { Agent } from "undici";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { FetchError } from "../errors.js";
import { getLogger } from "../logger.js";

/** Lazy singleton undici Agent that skips TLS certificate verification. */
let _insecureAgent: Agent | undefined;
function getInsecureAgent(): Agent {
  _insecureAgent ??= new Agent({ connect: { rejectUnauthorized: false } });
  return _insecureAgent;
}

const lookupAsync = promisify(dnsLookup);

export interface FetchedDocument {
  title: string;
  content: string;
}

/** Options to configure URL fetching behaviour. */
export interface FetchOptions {
  /** Request timeout in milliseconds (default: 30 000). */
  timeout?: number;
  /** Maximum number of HTTP redirects to follow (default: 5). */
  maxRedirects?: number;
  /** Maximum response body size in bytes (default: 10 MB). */
  maxBodySize?: number;
  /** Allow fetching from private/internal IP addresses (default: false). */
  allowPrivateUrls?: boolean;
  /** Accept self-signed or untrusted TLS certificates (default: false). */
  allowSelfSignedCerts?: boolean;
}

export const DEFAULT_FETCH_OPTIONS: Required<FetchOptions> = {
  timeout: 30_000,
  maxRedirects: 5,
  maxBodySize: 10 * 1024 * 1024, // 10 MB
  allowPrivateUrls: false,
  allowSelfSignedCerts: false,
} as const;

/** Check whether an IPv6 address belongs to a private/reserved range. */
function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === "::1") return true;
  if (/^f[cd]/i.test(lower)) return true;
  if (/^fe[89ab]/i.test(lower)) return true;
  return false;
}

/** Check whether an IPv4 address belongs to a private/reserved range. */
function isPrivateIPv4(addr: string): boolean {
  const parts = addr.split(".").map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  return false;
}

/** Check whether an IP address belongs to a private/reserved range. */
export function isPrivateIP(ip: string): boolean {
  const v4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const normalized = v4Mapped ? v4Mapped[1]! : ip;

  return normalized.includes(":") ? isPrivateIPv6(normalized) : isPrivateIPv4(normalized);
}

/**
 * Validate that the URL uses an allowed scheme and does not resolve to a
 * private/internal IP address (SSRF protection).
 * Returns the resolved addresses for DNS pinning.
 */
async function validateUrl(url: string, allowPrivateUrls = false): Promise<string[]> {
  const parsed = new URL(url);

  // Only allow http and https schemes
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new FetchError(`Blocked scheme: ${parsed.protocol} — only http and https are allowed`);
  }

  // Resolve hostname and check every returned address
  const hostname = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  const { resolve4, resolve6 } = dns;
  const results = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);

  const addresses: string[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") addresses.push(...r.value);
  }

  // Fall back to OS resolver (respects /etc/resolv.conf search domains)
  // when dns.resolve4/resolve6 fail — common with short internal hostnames.
  if (addresses.length === 0) {
    try {
      const result = await lookupAsync(hostname);
      if (result.address) addresses.push(result.address);
    } catch {
      // lookup also failed
    }
  }

  if (addresses.length === 0) {
    throw new FetchError(`DNS resolution failed for hostname: ${hostname}`);
  }

  for (const addr of addresses) {
    if (!allowPrivateUrls && isPrivateIP(addr)) {
      throw new FetchError(
        `Blocked request to private/internal IP ${addr} (resolved from ${hostname}). Set LIBSCOPE_ALLOW_PRIVATE_URLS=true to allow.`,
      );
    }
  }

  return addresses;
}

/** Read a response body while enforcing a byte-size limit on actual data received. */
async function readBodyWithLimit(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    // Fallback: body is not streamable
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limit) {
      throw new FetchError(`Response body too large (max ${limit} bytes)`);
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    let result = await reader.read();
    while (!result.done) {
      const chunk = result.value;
      received += chunk.byteLength;
      if (received > limit) {
        throw new FetchError(`Response body too large: exceeded ${limit} bytes`);
      }
      chunks.push(chunk);
      result = await reader.read();
    }
  } finally {
    await reader.cancel();
  }

  const combined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/** Follow redirects manually so we can enforce a configurable limit. DNS-pinned to prevent rebinding. */
async function fetchWithRedirects(
  url: string,
  timeout: number,
  maxRedirects: number,
  allowPrivateUrls: boolean,
  allowSelfSignedCerts: boolean,
): Promise<Response> {
  // Pass a per-request undici Agent when self-signed certs are allowed.
  // This is scoped to this specific request chain and does not affect other
  // concurrent requests (unlike mutating process.env["NODE_TLS_REJECT_UNAUTHORIZED"]).
  const dispatcher = allowSelfSignedCerts ? getInsecureAgent() : undefined;
  return _fetchWithRedirects(url, timeout, maxRedirects, allowPrivateUrls, dispatcher);
}

/** Re-resolve DNS after a fetch to detect DNS rebinding attacks. */
async function checkDnsRebinding(hostname: string, allowPrivateUrls: boolean): Promise<void> {
  const recheck = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
  const currentAddresses: string[] = [];
  for (const r of recheck) {
    if (r.status === "fulfilled") currentAddresses.push(...r.value);
  }

  if (currentAddresses.length === 0) {
    const log = getLogger();
    log.warn({ hostname }, "DNS rebinding check: re-resolution returned no addresses");
    throw new FetchError(
      `DNS rebinding check failed: ${hostname} no longer resolves to any address`,
    );
  }

  if (allowPrivateUrls) return;
  for (const addr of currentAddresses) {
    if (isPrivateIP(addr)) {
      throw new FetchError(
        `DNS rebinding detected: ${hostname} now resolves to private IP ${addr}`,
      );
    }
  }
}

async function _fetchWithRedirects(
  url: string,
  timeout: number,
  maxRedirects: number,
  allowPrivateUrls: boolean,
  dispatcher: Agent | undefined,
): Promise<Response> {
  let current = url;
  for (let i = 0; i < maxRedirects; i++) {
    await validateUrl(current, allowPrivateUrls);

    // codeql[js/request-forgery] -- URL scheme and destination validated by validateUrl() above
    const response = await fetch(current, {
      headers: {
        "User-Agent": "LibScope/0.1.0 (documentation indexer)",
        Accept: "text/html, text/markdown, text/plain, */*",
      },
      signal: AbortSignal.timeout(timeout),
      redirect: "manual",
      ...(dispatcher ? { dispatcher: dispatcher as unknown } : {}),
    } as RequestInit);

    const parsed = new URL(current);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    await checkDnsRebinding(hostname, allowPrivateUrls);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new FetchError(`Redirect ${response.status} with no Location header`);
      }
      current = new URL(location, current).href;
      continue;
    }

    return response;
  }

  throw new FetchError(`Too many redirects (max ${maxRedirects})`);
}

/** Result of a raw fetch — HTML/text body before any conversion, plus resolved final URL. */
export interface FetchedRaw {
  body: string;
  contentType: string;
  finalUrl: string;
}

/**
 * Fetch a URL and return the raw body without converting to markdown.
 * Useful for callers (e.g. the spider) that need access to raw HTML for link extraction.
 * Applies all the same SSRF protection, redirect following, and body-size limits as fetchAndConvert.
 */
export async function fetchRaw(url: string, options?: FetchOptions): Promise<FetchedRaw> {
  const log = getLogger();
  log.debug({ url }, "Fetching raw URL");

  const { timeout, maxRedirects, maxBodySize, allowPrivateUrls, allowSelfSignedCerts } = {
    ...DEFAULT_FETCH_OPTIONS,
    ...options,
  };

  try {
    await validateUrl(url, allowPrivateUrls);

    const response = await fetchWithRedirects(
      url,
      timeout,
      maxRedirects,
      allowPrivateUrls,
      allowSelfSignedCerts,
    );

    if (!response.ok) {
      throw new FetchError(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const body = await readBodyWithLimit(response, maxBodySize);
    // Derive final URL from redirect chain (fetchWithRedirects resolves relative locations)
    const finalUrl = response.url ?? url;

    return { body, contentType, finalUrl };
  } catch (err) {
    if (err instanceof FetchError) throw err;
    throw new FetchError(
      `Failed to fetch URL: ${url} — ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}

/**
 * Fetch a URL and convert its HTML content to clean markdown-like text.
 * Strips tags, preserves code blocks and headings.
 */
export async function fetchAndConvert(
  url: string,
  options?: FetchOptions,
): Promise<FetchedDocument> {
  const log = getLogger();
  log.info({ url }, "Fetching URL");

  const { timeout, maxRedirects, maxBodySize, allowPrivateUrls, allowSelfSignedCerts } = {
    ...DEFAULT_FETCH_OPTIONS,
    ...options,
  };

  try {
    await validateUrl(url, allowPrivateUrls);

    const response = await fetchWithRedirects(
      url,
      timeout,
      maxRedirects,
      allowPrivateUrls,
      allowSelfSignedCerts,
    );

    if (!response.ok) {
      throw new FetchError(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    // Stream the body while enforcing actual byte-size limit
    const body = await readBodyWithLimit(response, maxBodySize);

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
      return last.replaceAll(/[-_]/g, " ").replace(/\.\w+$/, "");
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
