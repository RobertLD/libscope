import { describe, it, expect, vi, beforeEach } from "vitest";
import { FetchError } from "../../src/errors.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// Mock dns.promises so we can control IP resolution
const mockResolve4 = vi.fn();
const mockResolve6 = vi.fn();
const mockLookup = vi.fn();
vi.mock("node:dns", () => ({
  promises: {
    resolve4: (...args: unknown[]): Promise<string[]> => mockResolve4(...args) as Promise<string[]>,
    resolve6: (...args: unknown[]): Promise<string[]> => mockResolve6(...args) as Promise<string[]>,
  },
  lookup: (...args: unknown[]): void => {
    mockLookup(...args);
  },
}));

// Import after mocking fetch and dns
const { fetchAndConvert, isPrivateIP, DEFAULT_FETCH_OPTIONS } =
  await import("../../src/core/url-fetcher.js");

/** Helper: create a readable stream from a string. */
function bodyStream(text: string): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
}

describe("isPrivateIP", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.255",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "192.168.255.255",
    "169.254.1.1",
    "0.0.0.0",
    "::1",
    "fc00::1",
    "fd12::1",
    "fe80::1",
  ])("should detect %s as private", (ip) => {
    expect(isPrivateIP(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "2607:f8b0:4004:800::200e"])(
    "should detect %s as public",
    (ip) => {
      expect(isPrivateIP(ip)).toBe(false);
    },
  );
});

describe("fetchAndConvert", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockResolve4.mockReset();
    mockResolve6.mockReset();
    mockLookup.mockReset();
    // Default: resolve to a public IP
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
    mockResolve6.mockRejectedValue(new Error("no AAAA"));
    // Default: lookup also fails (callback style)
    mockLookup.mockImplementation(
      (_hostname: unknown, cb: (err: Error | null, address?: string, family?: number) => void) => {
        cb(new Error("ENOTFOUND"));
      },
    );
  });

  it("should fetch HTML and convert to text with title from <title> tag", async () => {
    const html =
      "<html><head><title>My Page</title></head><body><h1>Hello</h1><p>World</p></body></html>";
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/html" }),
      body: bodyStream(html),
      text: () => Promise.resolve(html),
    });

    const result = await fetchAndConvert("https://example.com/page");
    expect(result.title).toBe("My Page");
    expect(result.content).toContain("# Hello");
    expect(result.content).toContain("World");
  });

  it("should return markdown/plain text as-is", async () => {
    const md = "# Markdown Title\n\nSome content here.";
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/markdown" }),
      body: bodyStream(md),
      text: () => Promise.resolve(md),
    });

    const result = await fetchAndConvert("https://example.com/readme.md");
    expect(result.title).toBe("Markdown Title");
    expect(result.content).toBe("# Markdown Title\n\nSome content here.");
  });

  it("should return plain text as-is", async () => {
    const txt = "Just plain text without headings.";
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/plain" }),
      body: bodyStream(txt),
      text: () => Promise.resolve(txt),
    });

    const result = await fetchAndConvert("https://example.com/notes.txt");
    expect(result.title).toBe("notes");
    expect(result.content).toBe("Just plain text without headings.");
  });

  it("should throw FetchError on HTTP error response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: new Headers(),
    });

    await expect(fetchAndConvert("https://example.com/missing")).rejects.toThrow(FetchError);
  });

  it("should throw FetchError on network error", async () => {
    mockFetch.mockRejectedValue(new TypeError("fetch failed"));

    await expect(fetchAndConvert("https://example.com/down")).rejects.toThrow(FetchError);
  });

  it("should extract title from first markdown heading", async () => {
    const md = "Some preamble\n# The Real Title\n\nBody text.";
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/markdown" }),
      body: bodyStream(md),
      text: () => Promise.resolve(md),
    });

    const result = await fetchAndConvert("https://example.com/doc");
    expect(result.title).toBe("The Real Title");
  });

  it("should fall back to URL path for title when no heading or title tag", async () => {
    const txt = "No headings here at all.";
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/plain" }),
      body: bodyStream(txt),
      text: () => Promise.resolve(txt),
    });

    const result = await fetchAndConvert("https://example.com/my-doc-page");
    expect(result.title).toBe("my doc page");
  });

  it("should convert HTML headings, code blocks, lists, and links", async () => {
    const html = `
      <html><body>
        <h2>Section</h2>
        <pre><code>const x = 1;</code></pre>
        <ul><li>Item one</li><li>Item two</li></ul>
        <a href="https://link.com">Click here</a>
      </body></html>
    `;
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/html" }),
      body: bodyStream(html),
      text: () => Promise.resolve(html),
    });

    const result = await fetchAndConvert("https://example.com/page");
    expect(result.content).toContain("## Section");
    expect(result.content).toContain("```");
    expect(result.content).toContain("const x = 1;");
    expect(result.content).toContain("Item one");
    expect(result.content).toContain("[Click here](https://link.com)");
  });
});

describe("SSRF protection", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockResolve4.mockReset();
    mockResolve6.mockReset();
    mockLookup.mockReset();
    mockLookup.mockImplementation(
      (_hostname: unknown, cb: (err: Error | null, address?: string, family?: number) => void) => {
        cb(new Error("ENOTFOUND"));
      },
    );
  });

  it("should block file:// URLs", async () => {
    await expect(fetchAndConvert("file:///etc/passwd")).rejects.toThrow(/Blocked scheme/);
  });

  it("should block ftp:// URLs", async () => {
    await expect(fetchAndConvert("ftp://evil.com/data")).rejects.toThrow(/Blocked scheme/);
  });

  it("should block requests resolving to 127.0.0.1", async () => {
    mockResolve4.mockResolvedValue(["127.0.0.1"]);
    mockResolve6.mockRejectedValue(new Error("no AAAA"));

    await expect(fetchAndConvert("https://evil.com/steal")).rejects.toThrow(/private\/internal IP/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("should block requests resolving to 10.x.x.x", async () => {
    mockResolve4.mockResolvedValue(["10.0.0.5"]);
    mockResolve6.mockRejectedValue(new Error("no AAAA"));

    await expect(fetchAndConvert("https://sneaky.com/")).rejects.toThrow(/private\/internal IP/);
  });

  it("should block requests resolving to 192.168.x.x", async () => {
    mockResolve4.mockResolvedValue(["192.168.1.1"]);
    mockResolve6.mockRejectedValue(new Error("no AAAA"));

    await expect(fetchAndConvert("https://internal.com/")).rejects.toThrow(/private\/internal IP/);
  });

  it("should block requests resolving to ::1", async () => {
    mockResolve4.mockRejectedValue(new Error("no A"));
    mockResolve6.mockResolvedValue(["::1"]);

    await expect(fetchAndConvert("https://ipv6loop.com/")).rejects.toThrow(/private\/internal IP/);
  });

  it("should allow requests resolving to public IPs", async () => {
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
    mockResolve6.mockRejectedValue(new Error("no AAAA"));

    const txt = "safe content";
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/plain" }),
      body: bodyStream(txt),
      text: () => Promise.resolve(txt),
    });

    const result = await fetchAndConvert("https://example.com/page");
    expect(result.content).toBe("safe content");
  });

  it("should throw if DNS resolution fails completely", async () => {
    mockResolve4.mockRejectedValue(new Error("ENOTFOUND"));
    mockResolve6.mockRejectedValue(new Error("ENOTFOUND"));

    await expect(fetchAndConvert("https://nonexistent.invalid/")).rejects.toThrow(
      /DNS resolution failed/,
    );
  });
});

describe("streaming body size limit", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockResolve4.mockReset();
    mockResolve6.mockReset();
    mockLookup.mockReset();
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
    mockResolve6.mockRejectedValue(new Error("no AAAA"));
    mockLookup.mockImplementation(
      (_hostname: unknown, cb: (err: Error | null, address?: string, family?: number) => void) => {
        cb(new Error("ENOTFOUND"));
      },
    );
  });

  it("should abort when streamed body exceeds 10 MB regardless of Content-Length header", async () => {
    // Content-Length claims 100 bytes, but body is actually huge
    const bigChunk = new Uint8Array(11 * 1024 * 1024); // 11 MB
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bigChunk);
        controller.close();
      },
    });

    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/plain", "content-length": "100" }),
      body: stream,
    });

    await expect(fetchAndConvert("https://example.com/big")).rejects.toThrow(
      /Response body too large/,
    );
  });

  it("should accept body under the limit", async () => {
    const txt = "Small body";
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/plain" }),
      body: bodyStream(txt),
      text: () => Promise.resolve(txt),
    });

    const result = await fetchAndConvert("https://example.com/small");
    expect(result.content).toBe("Small body");
  });
});

describe("FetchOptions configuration", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockResolve4.mockReset();
    mockResolve6.mockReset();
    mockLookup.mockReset();
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
    mockResolve6.mockRejectedValue(new Error("no AAAA"));
    mockLookup.mockImplementation(
      (_hostname: unknown, cb: (err: Error | null, address?: string, family?: number) => void) => {
        cb(new Error("ENOTFOUND"));
      },
    );
  });

  it("should expose sensible DEFAULT_FETCH_OPTIONS", () => {
    expect(DEFAULT_FETCH_OPTIONS).toEqual({
      timeout: 30_000,
      maxRedirects: 5,
      maxBodySize: 10 * 1024 * 1024,
      allowPrivateUrls: false,
      allowSelfSignedCerts: false,
    });
  });

  it("should respect a custom timeout passed via options", async () => {
    const txt = "ok";
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/plain" }),
      body: bodyStream(txt),
      text: () => Promise.resolve(txt),
    });

    await fetchAndConvert("https://example.com/page", { timeout: 5000 });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/page",
      expect.objectContaining({
        signal: expect.any(AbortSignal) as AbortSignal,
      }),
    );
  });

  it("should enforce custom maxBodySize", async () => {
    const bigChunk = new Uint8Array(200);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bigChunk);
        controller.close();
      },
    });

    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/plain" }),
      body: stream,
    });

    await expect(fetchAndConvert("https://example.com/big", { maxBodySize: 100 })).rejects.toThrow(
      /Response body too large/,
    );
  });

  it("should enforce custom maxRedirects", async () => {
    mockFetch.mockImplementation((url: string) => {
      return Promise.resolve({
        status: 302,
        headers: new Headers({ location: `${url}/next` }),
      });
    });

    await expect(fetchAndConvert("https://example.com/loop", { maxRedirects: 2 })).rejects.toThrow(
      /Too many redirects/,
    );

    // 1 original + 2 redirects = 3 calls
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should follow redirects up to the limit and succeed", async () => {
    const txt = "final";
    let callCount = 0;
    mockFetch.mockImplementation(() => {
      callCount++;
      if (callCount < 3) {
        return Promise.resolve({
          status: 302,
          headers: new Headers({ location: "https://example.com/dest" }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        body: bodyStream(txt),
        text: () => Promise.resolve(txt),
      });
    });

    const result = await fetchAndConvert("https://example.com/start", { maxRedirects: 5 });
    expect(result.content).toBe("final");
  });

  it("should validate redirect targets for SSRF", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 302,
      headers: new Headers({ location: "https://internal.local/secret" }),
    });

    // Make the redirect target resolve to a private IP
    mockResolve4
      .mockResolvedValueOnce(["93.184.216.34"]) // original URL is fine
      .mockResolvedValueOnce(["10.0.0.1"]); // redirect target is private

    await expect(fetchAndConvert("https://example.com/redir", { maxRedirects: 3 })).rejects.toThrow(
      /private\/internal IP/,
    );
  });
});
