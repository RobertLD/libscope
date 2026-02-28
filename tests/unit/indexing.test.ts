import { describe, it, expect } from "vitest";
import { chunkContent } from "../../src/core/indexing.js";

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
    expect(chunks[2]).toContain("Section Two");
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
  });
});
