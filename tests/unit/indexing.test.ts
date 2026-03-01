import { describe, it, expect } from "vitest";
import {
  chunkContent,
  chunkContentStreaming,
  STREAMING_THRESHOLD,
} from "../../src/core/indexing.js";

describe("chunkContent", () => {
  it("should split content by markdown headings", () => {
    const content = `# Introduction
Some intro text.

## Section One
Content of section one.

## Section Two
Content of section two.`;

    const chunks = chunkContent(content);

    expect(chunks.length).toBe(3);
    expect(chunks[0]).toContain("Introduction");
    expect(chunks[1]).toContain("Section One");
    expect(chunks[1]).toContain("<!-- context: Introduction -->");
    expect(chunks[2]).toContain("Section Two");
    expect(chunks[2]).toContain("<!-- context: Introduction -->");
  });

  it("should handle content without headings", () => {
    const content = `This is just plain text.
It has multiple lines.
But no headings at all.`;

    const chunks = chunkContent(content);

    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain("plain text");
  });

  it("should split large chunks by max size", () => {
    // Create content with multiple lines that exceeds maxChunkSize
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}: ${"A".repeat(40)}`);
    const longContent = lines.join("\n");
    const chunks = chunkContent(longContent, 500);

    expect(chunks.length).toBeGreaterThan(1);
  });

  it("should return empty array for empty content", () => {
    const chunks = chunkContent("");
    expect(chunks.length).toBe(0);
  });

  it("should handle content with only whitespace", () => {
    const chunks = chunkContent("   \n\n   ");
    expect(chunks.length).toBe(0);
  });

  it("should scale linearly (not O(n²)) for large inputs", () => {
    // 10k lines without headings — worst case for the old join-per-line approach
    const lines = Array.from({ length: 10_000 }, (_, i) => `Line ${i}: ${"x".repeat(20)}`);
    const content = lines.join("\n");
    const start = performance.now();
    const chunks = chunkContent(content, 1500);
    const elapsed = performance.now() - start;

    expect(chunks.length).toBeGreaterThan(1);
    // Should complete well under 500ms even on slow CI; O(n²) would take seconds
    expect(elapsed).toBeLessThan(500);
  });

  it("should preserve code blocks within chunks", () => {
    const content = `## API Example

\`\`\`javascript
const result = await fetch("/api/users");
const data = await result.json();
\`\`\`

This returns a list of users.`;

    const chunks = chunkContent(content);

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]).toContain("```javascript");
    expect(chunks[0]).toContain("fetch");
  });

  it("should handle deeply nested headings", () => {
    const content = `# H1
Top level.

## H2
Second level.

### H3
Third level.

#### H4 should not split
Fourth level stays with H3.`;

    const chunks = chunkContent(content);

    // H1, H2, H3 split — H4 does NOT split (only h1-h3 trigger splits)
    expect(chunks.length).toBe(3);
    expect(chunks[2]).toContain("H3");
    expect(chunks[2]).toContain("H4");
    expect(chunks[2]).toContain("<!-- context: H1 > H2 -->");
  });
});

describe("chunkContentStreaming", () => {
  it("should chunk small content the same as chunkContent", () => {
    const content = `# Title
Some intro text.

## Section
More content here.`;

    const regular = chunkContent(content);
    const streamed = chunkContentStreaming(content);

    expect(streamed.length).toBeGreaterThanOrEqual(regular.length);
    expect(streamed[0]).toContain("Title");
  });

  it("should process large content in windows", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `Line ${i}: ${"A".repeat(80)}`);
    const largeContent = lines.join("\n");
    expect(largeContent.length).toBeGreaterThan(64 * 1024);

    const chunks = chunkContentStreaming(largeContent, { windowSize: 64 * 1024 });
    expect(chunks.length).toBeGreaterThan(1);

    const joined = chunks.join("\n");
    expect(joined).toContain("Line 0");
    expect(joined).toContain("Line 1999");
  });

  it("should respect maxDocumentSize", () => {
    const content = "A".repeat(200);
    expect(() => chunkContentStreaming(content, { maxDocumentSize: 100 })).toThrow(
      "exceeds maximum allowed size",
    );
  });

  it("should handle empty content", () => {
    const chunks = chunkContentStreaming("");
    expect(chunks.length).toBe(0);
  });

  it("should handle content with sentence boundaries at window edges", () => {
    const sentences = Array.from(
      { length: 500 },
      (_, i) => `Sentence number ${i} has some content.`,
    );
    const content = sentences.join(" ");
    const chunks = chunkContentStreaming(content, { windowSize: 1024 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("should use configurable window size", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `Line ${i}: content`);
    const content = lines.join("\n");

    const smallWindow = chunkContentStreaming(content, { windowSize: 1024 });
    const largeWindow = chunkContentStreaming(content, { windowSize: 8192 });

    expect(smallWindow.length).toBeGreaterThanOrEqual(largeWindow.length);
  });
});

describe("STREAMING_THRESHOLD", () => {
  it("should be 1MB", () => {
    expect(STREAMING_THRESHOLD).toBe(1024 * 1024);
  });
});
