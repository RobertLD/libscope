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
    expect(chunks[1]).toContain("Context: Introduction");
    expect(chunks[2]).toContain("Section Two");
    expect(chunks[2]).toContain("Context: Introduction");
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
    expect(chunks[2]).toContain("Context: H1 > H2");
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

  it("should deduplicate chunks from overlap regions", () => {
    // Create content where overlap will produce duplicate chunks
    const block = "Repeated block of text that appears in the overlap region.\n";
    const content = block.repeat(200);
    const chunks = chunkContentStreaming(content, { windowSize: 1024 });

    // All chunks should be unique
    const uniqueChunks = new Set(chunks);
    expect(uniqueChunks.size).toBe(chunks.length);
  });

  it("should preserve all unique chunks", () => {
    const sections = Array.from(
      { length: 100 },
      (_, i) => `## Section ${i}\nUnique content for section number ${i}.`,
    );
    const content = sections.join("\n\n");
    const chunks = chunkContentStreaming(content, { windowSize: 2048 });

    // Every section's unique content should appear somewhere
    for (let i = 0; i < 100; i++) {
      const found = chunks.some((c) => c.includes(`Unique content for section number ${i}`));
      expect(found).toBe(true);
    }
  });

  it("should deduplicate chunks that differ only in whitespace", () => {
    // Build content where the same logical text appears with different whitespace
    const line = "Hello world this is a test line.";
    const variant1 = line + "\n";
    const variant2 = line.replace(/ /g, "  ") + "\n"; // double spaces
    // Interleave so overlap might pick up both
    const content = (variant1.repeat(50) + variant2.repeat(50)).repeat(2);
    const chunks = chunkContentStreaming(content, { windowSize: 512 });

    // After whitespace normalization, duplicates should be removed
    const seen = new Set<string>();
    for (const chunk of chunks) {
      const normalized = chunk.replace(/\s+/g, " ").trim();
      expect(seen.has(normalized)).toBe(false);
      seen.add(normalized);
    }
  });

  it("should use configurable window size", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `Line ${i}: content`);
    const content = lines.join("\n");

    const smallWindow = chunkContentStreaming(content, { windowSize: 1024 });
    const largeWindow = chunkContentStreaming(content, { windowSize: 8192 });

    // Both window sizes should produce chunks covering the content
    expect(smallWindow.length).toBeGreaterThan(0);
    expect(largeWindow.length).toBeGreaterThan(0);
    // Smaller window produces different chunk boundaries but should still cover the content
    const smallJoined = smallWindow.join("\n");
    const largeJoined = largeWindow.join("\n");
    expect(smallJoined).toContain("Line 0");
    expect(largeJoined).toContain("Line 0");
    expect(smallJoined).toContain("Line 499");
    expect(largeJoined).toContain("Line 499");
  });
});

describe("chunkContent with overlap", () => {
  it("should add overlap between consecutive chunks", () => {
    const content = `# Section A
Content of section A with enough text to form a meaningful chunk.

## Section B
Content of section B with different information.

## Section C
Content of section C wraps up the document.`;

    const chunks = chunkContent(content, { maxChunkSize: 1500, overlapFraction: 0.1 });

    // With overlap, later chunks should contain trailing text from previous chunks
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // First chunk should not have overlap prefix
    expect(chunks[0]).toContain("Section A");
  });

  it("should produce no overlap when overlapFraction is 0", () => {
    const content = `# Part 1
First part content.

## Part 2
Second part content.`;

    const withOverlap = chunkContent(content, { maxChunkSize: 1500, overlapFraction: 0 });
    const withoutOverlap = chunkContent(content, 1500);

    // With 0 overlap, results should match the no-overlap behavior
    expect(withOverlap.length).toBe(withoutOverlap.length);
  });

  it("should clamp overlapFraction to valid range", () => {
    const content = `# Title
Some content here.

## Section
More content here.`;

    // Should not throw with out-of-range values
    const chunksNeg = chunkContent(content, { overlapFraction: -0.5 });
    const chunksHigh = chunkContent(content, { overlapFraction: 0.9 });

    expect(chunksNeg.length).toBeGreaterThan(0);
    expect(chunksHigh.length).toBeGreaterThan(0);
  });
});

describe("chunkContent paragraph-boundary splitting", () => {
  it("should split oversized sections at paragraph boundaries", () => {
    // Create content with paragraphs that exceeds maxChunkSize within one section
    const paragraphs = Array.from(
      { length: 10 },
      (_, i) => `Paragraph ${i}: ${"word ".repeat(40)}`,
    );
    const content = paragraphs.join("\n\n");

    const chunks = chunkContent(content, 300);

    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be under the max size
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(300 + 50); // small tolerance for overlap
    }
  });
});

describe("plain-text breadcrumbs", () => {
  it("should use 'Context:' prefix instead of HTML comments", () => {
    const content = `# Parent
Intro.

## Child
Detail.`;

    const chunks = chunkContent(content);
    const childChunk = chunks.find((c) => c.includes("Child"));
    expect(childChunk).toBeDefined();
    expect(childChunk).toContain("Context: Parent");
    expect(childChunk).not.toContain("<!--");
  });
});

describe("STREAMING_THRESHOLD", () => {
  it("should be 1MB", () => {
    expect(STREAMING_THRESHOLD).toBe(1024 * 1024);
  });
});
