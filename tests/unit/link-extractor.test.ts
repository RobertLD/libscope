import { describe, it, expect } from "vitest";
import { extractLinks } from "../../src/core/link-extractor.js";

const BASE = "https://example.com/docs/intro";

describe("extractLinks", () => {
  it("extracts absolute http links", () => {
    const html = `<a href="https://example.com/page">link</a>`;
    expect(extractLinks(html, BASE)).toEqual(["https://example.com/page"]);
  });

  it("resolves relative links against base URL", () => {
    const html = `<a href="../guide">guide</a>`;
    const links = extractLinks(html, BASE);
    expect(links).toEqual(["https://example.com/guide"]);
  });

  it("resolves root-relative links", () => {
    const html = `<a href="/about">about</a>`;
    expect(extractLinks(html, BASE)).toEqual(["https://example.com/about"]);
  });

  it("strips fragment-only links", () => {
    const html = `<a href="#section">jump</a>`;
    expect(extractLinks(html, BASE)).toEqual([]);
  });

  it("strips fragments from full URLs", () => {
    const html = `<a href="https://example.com/page#section">link</a>`;
    expect(extractLinks(html, BASE)).toEqual(["https://example.com/page"]);
  });

  it("deduplicates links", () => {
    const html = `
      <a href="https://example.com/page">first</a>
      <a href="https://example.com/page">second</a>
    `;
    expect(extractLinks(html, BASE)).toEqual(["https://example.com/page"]);
  });

  it("deduplicates after fragment stripping", () => {
    const html = `
      <a href="https://example.com/page#a">a</a>
      <a href="https://example.com/page#b">b</a>
    `;
    expect(extractLinks(html, BASE)).toEqual(["https://example.com/page"]);
  });

  it("filters out mailto: links", () => {
    const html = `<a href="mailto:user@example.com">email</a>`;
    expect(extractLinks(html, BASE)).toEqual([]);
  });

  it("filters out javascript: links", () => {
    const html = `<a href="javascript:void(0)">noop</a>`;
    expect(extractLinks(html, BASE)).toEqual([]);
  });

  it("filters out tel: links", () => {
    const html = `<a href="tel:+15555555555">call</a>`;
    expect(extractLinks(html, BASE)).toEqual([]);
  });

  it("filters out ftp: links", () => {
    const html = `<a href="ftp://files.example.com/data">ftp</a>`;
    expect(extractLinks(html, BASE)).toEqual([]);
  });

  it("filters out data: links", () => {
    const html = `<a href="data:text/plain;base64,abc">data</a>`;
    expect(extractLinks(html, BASE)).toEqual([]);
  });

  it("handles single-quoted href attributes", () => {
    const html = `<a href='https://example.com/single'>link</a>`;
    expect(extractLinks(html, BASE)).toEqual(["https://example.com/single"]);
  });

  it("handles unquoted href attributes", () => {
    const html = `<a href=https://example.com/noquote>link</a>`;
    expect(extractLinks(html, BASE)).toEqual(["https://example.com/noquote"]);
  });

  it("ignores tags that aren't <a>", () => {
    const html = `
      <img src="https://example.com/img.png">
      <link href="https://example.com/style.css">
      <a href="https://example.com/real">real</a>
    `;
    expect(extractLinks(html, BASE)).toEqual(["https://example.com/real"]);
  });

  it("handles <a> tags with extra attributes", () => {
    const html = `<a class="nav" id="main" href="https://example.com/page" target="_blank">link</a>`;
    expect(extractLinks(html, BASE)).toEqual(["https://example.com/page"]);
  });

  it("handles href before other attributes", () => {
    const html = `<a href="https://example.com/page" class="nav">link</a>`;
    expect(extractLinks(html, BASE)).toEqual(["https://example.com/page"]);
  });

  it("strips trailing slash from non-root paths", () => {
    const html = `<a href="https://example.com/docs/">docs</a>`;
    expect(extractLinks(html, BASE)).toEqual(["https://example.com/docs"]);
  });

  it("preserves trailing slash on root path", () => {
    const html = `<a href="https://example.com/">home</a>`;
    expect(extractLinks(html, BASE)).toEqual(["https://example.com/"]);
  });

  it("returns empty array for HTML with no links", () => {
    const html = `<p>No links here at all.</p>`;
    expect(extractLinks(html, BASE)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(extractLinks("", BASE)).toEqual([]);
  });

  it("handles multiple links preserving discovery order", () => {
    const html = `
      <a href="https://example.com/a">a</a>
      <a href="https://example.com/b">b</a>
      <a href="https://example.com/c">c</a>
    `;
    expect(extractLinks(html, BASE)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
  });

  it("handles malformed href gracefully", () => {
    const html = `<a href="not a valid [url]">bad</a>`;
    // Should not throw; just skip
    expect(() => extractLinks(html, BASE)).not.toThrow();
  });

  it("skips <abbr> and <article> tags (not <a>)", () => {
    const html = `<abbr href="https://example.com/x">X</abbr>`;
    expect(extractLinks(html, BASE)).toEqual([]);
  });

  it("handles https links alongside http", () => {
    const html = `
      <a href="http://example.com/http">http</a>
      <a href="https://example.com/https">https</a>
    `;
    const links = extractLinks(html, BASE);
    expect(links).toContain("http://example.com/http");
    expect(links).toContain("https://example.com/https");
  });
});
