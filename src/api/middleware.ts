import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { LibScopeError } from "../errors.js";

/** An error with its own HTTP status (bad body, payload too large, forbidden origin). */
export class HttpError extends LibScopeError {
  constructor(
    public readonly status: number,
    code: string,
    message: string,
  ) {
    super(message, code);
    this.name = "HttpError";
  }
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True when `origin` is the origin the request was sent to (same scheme-less host and port). */
function isSameOrigin(req: IncomingMessage, origin: string): boolean {
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * Set CORS headers and answer OPTIONS preflight. Returns true when the request was handled.
 * `origins` lists the allowed browser origins. "*" allows any origin to read (GET) only:
 * write methods are offered only to origins listed by name.
 */
export function corsMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  origins: string[],
): boolean {
  const origin = req.headers.origin;
  if (origin !== undefined && origins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  } else if (origins.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

/**
 * Reject a write request (POST, PATCH, PUT, DELETE) sent by a browser page from another origin
 * that is not listed by name in `origins`. Browsers send such requests without a preflight
 * when they have no body or a "simple" content type, so CORS headers alone do not stop them.
 * Returns true when the request was rejected (403 sent).
 */
export function rejectForeignWrite(
  req: IncomingMessage,
  res: ServerResponse,
  origins: string[],
): boolean {
  const origin = req.headers.origin;
  if (READ_METHODS.has(req.method ?? "GET") || origin === undefined) return false;
  if (origins.includes(origin) || isSameOrigin(req, origin)) return false;
  sendError(res, 403, "FORBIDDEN_ORIGIN", "Write requests from this origin are not allowed");
  return true;
}

/**
 * Set standard security response headers. `contentSecurityPolicy` false leaves CSP unset
 * (the dashboard loads d3 from a CDN).
 */
export function setSecurityHeaders(res: ServerResponse, contentSecurityPolicy = true): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (contentSecurityPolicy) {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
    );
  }
}

/** Maximum request body size in bytes (default 1 MB). */
const MAX_BODY_SIZE = 1 * 1024 * 1024;

/** Sliding window counter entry for rate limiting. */
interface RateLimitEntry {
  count: number;
  windowStart: number;
}

/** Simple in-memory rate limiter per IP address. */
export const MAX_RATE_LIMIT_ENTRIES = 10_000;
const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120;

/** Evict expired and oldest entries from the rate limit map when it reaches capacity. */
function evictRateLimitEntries(now: number): void {
  // First pass: delete expired entries
  for (const [key, val] of rateLimitMap) {
    if (now - val.windowStart >= RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(key);
    }
  }
  // If still over limit, evict oldest entries
  if (rateLimitMap.size >= MAX_RATE_LIMIT_ENTRIES) {
    const sorted = [...rateLimitMap.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart);
    const toDelete = sorted.slice(0, 1000);
    for (const [key] of toDelete) {
      rateLimitMap.delete(key);
    }
  }
}

/** Check rate limit for a given IP. Returns true if request is allowed. */
export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (entry) {
    if (now - entry.windowStart < RATE_LIMIT_WINDOW_MS) {
      entry.count++;
      return entry.count <= RATE_LIMIT_MAX_REQUESTS;
    }
    // Window expired — reset
    entry.count = 1;
    entry.windowStart = now;
    return true;
  }

  // New IP — evict expired/oldest entries if map is full
  if (rateLimitMap.size >= MAX_RATE_LIMIT_ENTRIES) {
    evictRateLimitEntries(now);
  }

  rateLimitMap.set(ip, { count: 1, windowStart: now });
  return true;
}

/** Expose map size for testing. */
export function getRateLimitMapSize(): number {
  return rateLimitMap.size;
}

/** Periodically clean up stale rate-limit entries (every 5 minutes). */
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60_000).unref();

/** Check API key authentication. Returns true if request is authorized. */
export function checkApiKey(req: IncomingMessage, res: ServerResponse): boolean {
  const apiKey = process.env.LIBSCOPE_API_KEY;
  if (!apiKey) return true;

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    sendError(res, 401, "UNAUTHORIZED", "Missing or invalid Authorization header");
    return false;
  }

  const token = authHeader.slice(7);
  // Use fixed-size buffers for constant-time comparison that doesn't leak key length.
  const COMPARE_LEN = 256;
  const tokenBuf = Buffer.alloc(COMPARE_LEN);
  const keyBuf = Buffer.alloc(COMPARE_LEN);
  Buffer.from(token).copy(tokenBuf);
  Buffer.from(apiKey).copy(keyBuf);
  if (!timingSafeEqual(tokenBuf, keyBuf)) {
    sendError(res, 401, "UNAUTHORIZED", "Invalid API key");
    return false;
  }

  return true;
}

/** Parse the request body as JSON. Resolves null for an empty body; rejects with HttpError. */
export async function parseJsonBody(
  req: IncomingMessage,
  maxBytes: number = MAX_BODY_SIZE,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        req.destroy();
        reject(
          new HttpError(413, "PAYLOAD_TOO_LARGE", `Request body too large (max ${maxBytes} bytes)`),
        );
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, "INVALID_JSON", "Request body contains invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** Send a JSON success response with consistent envelope. */
export function sendJson(res: ServerResponse, status: number, data: unknown, took?: number): void {
  const body: Record<string, unknown> = { data };
  if (took !== undefined) {
    body["meta"] = { took };
  }
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

/** Send a JSON error response with consistent envelope. */
export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  const json = JSON.stringify({ error: { code, message } });
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}
