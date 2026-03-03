import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

/** Set CORS headers and handle OPTIONS preflight. Returns true if request was handled (preflight). */
export function corsMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  origins: string[],
): boolean {
  const origin = req.headers["origin"] ?? "*";
  const allowedOrigin = origins.includes("*") ? "*" : origins.includes(origin) ? origin : "";

  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  setSecurityHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

/** Set standard security response headers. */
export function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
  );
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

/** Check rate limit for a given IP. Returns true if request is allowed. */
export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (entry) {
    if (now - entry.windowStart < RATE_LIMIT_WINDOW_MS) {
      entry.count++;
      if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
        return false;
      }
      return true;
    }
    // Window expired — reset
    entry.count = 1;
    entry.windowStart = now;
    return true;
  }

  // New IP — evict oldest entries if map is full
  if (rateLimitMap.size >= MAX_RATE_LIMIT_ENTRIES) {
    const iter = rateLimitMap.keys();
    for (let i = 0; i < 1000; i++) {
      const key = iter.next().value;
      if (key !== undefined) rateLimitMap.delete(key);
    }
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
  if (token.length !== apiKey.length || !timingSafeEqual(tokenBuf, keyBuf)) {
    sendError(res, 401, "UNAUTHORIZED", "Invalid API key");
    return false;
  }

  return true;
}

/** Parse the request body as JSON. Returns the parsed object or null on failure. */
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
        reject(new Error(`Request body too large (max ${maxBytes} bytes)`));
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
        reject(new Error("Invalid JSON body"));
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
