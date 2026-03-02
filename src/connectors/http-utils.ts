import { getLogger } from "../logger.js";
import { FetchError } from "../errors.js";
import { loadConfig } from "../config.js";

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
  const prevTls = process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
  if (config.indexing.allowSelfSignedCerts) {
    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
  }

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await fetch(url, options);

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
  } finally {
    if (config.indexing.allowSelfSignedCerts) {
      if (prevTls === undefined) {
        delete process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
      } else {
        process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = prevTls;
      }
    }
  }
}
