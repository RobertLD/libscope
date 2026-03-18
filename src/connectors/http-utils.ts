import { Agent } from "undici";
import { getLogger } from "../logger.js";
import { FetchError } from "../errors.js";
import { loadConfig } from "../config.js";

/** Lazy singleton undici Agent that skips TLS certificate verification. */
let _insecureAgent: Agent | undefined;
function getInsecureAgent(): Agent {
  _insecureAgent ??= new Agent({ connect: { rejectUnauthorized: false } });
  return _insecureAgent;
}

export interface RetryConfig {
  maxRetries?: number;
  baseDelay?: number;
}

/** Check if a response status is retryable (429 or 5xx). */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/** Compute the retry delay in ms, using Retry-After header for 429 responses or exponential backoff. */
function computeRetryDelay(response: Response, attempt: number, baseDelay: number): number {
  if (response.status !== 429) return baseDelay * 2 ** attempt;

  const retryAfter = response.headers.get("Retry-After");
  if (!retryAfter) return baseDelay * 2 ** attempt;

  const parsed = Number(retryAfter);
  return Number.isNaN(parsed) ? baseDelay * 2 ** attempt : parsed * 1000;
}

/** Build fetch options, merging the base options with an optional TLS-bypassing dispatcher. */
function buildFetchOptions(
  options: RequestInit | undefined,
  dispatcher: Agent | undefined,
): RequestInit {
  return {
    ...(options ?? {}),
    ...(dispatcher ? { dispatcher: dispatcher as unknown } : {}),
  } as RequestInit;
}

/**
 * Fetch wrapper with retry logic for 429 (rate-limit) and 5xx responses.
 * Uses Retry-After header when available, otherwise exponential backoff.
 * Respects `indexing.allowSelfSignedCerts` config for corporate TLS.
 */
export async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  retryConfig?: RetryConfig,
): Promise<Response> {
  const maxRetries = retryConfig?.maxRetries ?? 3;
  const baseDelay = retryConfig?.baseDelay ?? 1000;
  const log = getLogger();

  const config = loadConfig();
  const dispatcher = config.indexing.allowSelfSignedCerts ? getInsecureAgent() : undefined;
  const fetchOptions = buildFetchOptions(options, dispatcher);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, fetchOptions);

    if (!isRetryableStatus(response.status)) return response;

    if (attempt >= maxRetries) {
      const body = await response.text().catch(() => "");
      throw new FetchError(`HTTP ${response.status} after ${maxRetries + 1} attempts: ${body}`);
    }

    const delayMs = computeRetryDelay(response, attempt, baseDelay);
    log.warn(
      { status: response.status, attempt: attempt + 1, delayMs },
      "Retrying after transient error",
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  // Unreachable, but satisfies TypeScript
  throw new FetchError("fetchWithRetry: unexpected code path");
}
