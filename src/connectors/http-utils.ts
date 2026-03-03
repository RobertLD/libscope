import { getLogger } from "../logger.js";
import { FetchError } from "../errors.js";
import { loadConfig } from "../config.js";

let tlsWarningLogged = false;

/**
 * Log a one-time warning when `allowSelfSignedCerts` is enabled but the
 * user has not set `NODE_TLS_REJECT_UNAUTHORIZED=0` in their environment.
 */
function warnIfTlsBypassMissing(): void {
  if (tlsWarningLogged) return;
  if (process.env["NODE_TLS_REJECT_UNAUTHORIZED"] === "0") return;
  tlsWarningLogged = true;
  const log = getLogger();
  log.warn(
    "allowSelfSignedCerts is enabled but NODE_TLS_REJECT_UNAUTHORIZED is not set. " +
      "Set NODE_TLS_REJECT_UNAUTHORIZED=0 in your environment to allow self-signed certificates.",
  );
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
  if (config.indexing.allowSelfSignedCerts) {
    warnIfTlsBypassMissing();
  }

  try {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const timeoutSignal = AbortSignal.timeout(30_000);
      const combinedSignal =
        options?.signal != null ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

      const response = await fetch(url, {
        ...options,
        signal: combinedSignal,
      });

      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        if (attempt >= maxRetries - 1) {
          const body = await response.text().catch(() => "");
          throw new FetchError(`HTTP ${response.status} after ${maxRetries} attempts: ${body}`);
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
    // no-op: TLS state is managed by the user's environment, not this function
  }
}
