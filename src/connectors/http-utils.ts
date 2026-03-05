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
  // Use a per-request undici Agent when self-signed certs are allowed.
  // This is scoped to this fetch chain and does not affect concurrent requests.
  const dispatcher = config.indexing.allowSelfSignedCerts ? getInsecureAgent() : undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const fetchOptions = {
      ...(options ?? {}),
      ...(dispatcher ? { dispatcher: dispatcher as unknown } : {}),
    } as RequestInit;
    const response = await fetch(url, fetchOptions);

    if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
      if (attempt >= maxRetries) {
        const body = await response.text().catch(() => "");
        throw new FetchError(`HTTP ${response.status} after ${maxRetries + 1} attempts: ${body}`);
      }

      let delayMs = baseDelay * 2 ** attempt;
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        if (retryAfter) {
          const parsed = Number(retryAfter);
          if (!Number.isNaN(parsed)) {
            delayMs = parsed * 1000;
          }
        }
      }

      log.warn(
        { status: response.status, attempt: attempt + 1, delayMs },
        "Retrying after transient error",
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    return response;
  }

  // Unreachable, but satisfies TypeScript
  throw new FetchError("fetchWithRetry: unexpected code path");
}
