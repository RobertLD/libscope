import { describe, it, expect, vi, beforeEach } from "vitest";
import { FetchError } from "../../src/errors.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// Import after mocking fetch
const { fetchAndConvert } = await import("../../src/core/url-fetcher.js");

describe("fetchAndConvert", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("should fetch HTML and convert to text with title from <title> tag", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/html" }),
      text: () =>
        Promise.resolve(
          "<html><head><title>My Page</title></head><body><h1>Hello</h1><p>World</p></body></html>",
        ),
    });

    const result = await fetchAndConvert("https://example.com/page");
    expect(result.title).toBe("My Page");
    expect(result.content).toContain("# Hello");
    expect(result.content).toContain("World");
  });

  it("should return markdown/plain text as-is", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/markdown" }),
      text: () => Promise.resolve("# Markdown Title\n\nSome content here."),
    });

    const result = await fetchAndConvert("https://example.com/readme.md");
    expect(result.title).toBe("Markdown Title");
    expect(result.content).toBe("# Markdown Title\n\nSome content here.");
  });

  it("should return plain text as-is", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/plain" }),
      text: () => Promise.resolve("Just plain text without headings."),
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
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/markdown" }),
      text: () => Promise.resolve("Some preamble\n# The Real Title\n\nBody text."),
    });

    const result = await fetchAndConvert("https://example.com/doc");
    expect(result.title).toBe("The Real Title");
  });

  it("should fall back to URL path for title when no heading or title tag", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/plain" }),
      text: () => Promise.resolve("No headings here at all."),
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
