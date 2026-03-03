import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FetchError } from "../../src/errors.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock logger
vi.mock("../../src/logger.js", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock config
vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    indexing: { allowSelfSignedCerts: false, allowPrivateUrls: false, maxDocumentSize: 104857600 },
  }),
}));

const { fetchWithRetry } = await import("../../src/connectors/http-utils.js");

function jsonResponse(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 429 ? "Too Many Requests" : "OK",
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: new Headers(headers ?? {}),
  } as unknown as Response;
}

describe("fetchWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should return response on success", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const res = await fetchWithRetry("https://example.com/api");
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should retry on 429 with Retry-After header", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({}, 429, { "Retry-After": "1" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const promise = fetchWithRetry("https://example.com/api", undefined, {
      maxRetries: 3,
      baseDelay: 100,
    });

    // Advance past the Retry-After delay (1s)
    await vi.advanceTimersByTimeAsync(1000);

    const res = await promise;
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should retry on 500 with exponential backoff", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({}, 502))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const promise = fetchWithRetry("https://example.com/api", undefined, {
      maxRetries: 3,
      baseDelay: 100,
    });

    // First retry: 100ms * 2^0 = 100ms
    await vi.advanceTimersByTimeAsync(100);
    // Second retry: 100ms * 2^1 = 200ms
    await vi.advanceTimersByTimeAsync(200);

    const res = await promise;
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("should not retry on 400", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "bad request" }, 400));
    const res = await fetchWithRetry("https://example.com/api");
    expect(res.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should throw FetchError after max retries exceeded", async () => {
    vi.useRealTimers();
    mockFetch.mockResolvedValue(jsonResponse({}, 500));

    await expect(
      fetchWithRetry("https://example.com/api", undefined, {
        maxRetries: 2,
        baseDelay: 10,
      }),
    ).rejects.toThrow(FetchError);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    vi.useFakeTimers();
  });

  it("should pass through request options", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await fetchWithRetry("https://example.com/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "value" }),
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/api",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "value" }),
      }),
    );
  });
});
