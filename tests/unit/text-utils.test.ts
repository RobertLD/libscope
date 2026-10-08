import { describe, expect, it } from "vitest";
import { firstMarkdownHeading } from "../../src/utils/markdown.js";
import { trimTrailingSlashes } from "../../src/utils/strings.js";

describe("firstMarkdownHeading", () => {
  it.each([
    ["a heading on the first line", "# Title\ntext", "Title"],
    ["a heading on a later line", "intro\n## not this\n# Real  \nmore", "Real  "],
    ["a heading after \\r", "intro\r# Title", "Title"],
    ["a heading after a Unicode line separator", "intro # Title", "Title"],
    ["the text after several spaces and tabs", "#  \t Spaced", "Spaced"],
    ["text on the next line when # is alone", "#\n\nNext line\nother", "Next line"],
    ["a later heading when the first # is not a heading", "#tag\n# Heading", "Heading"],
    ["the last space when only whitespace follows #", "#  \n\n", " "],
    ["the last tab before trailing line breaks", "#  \t\n", "\t"],
  ])("returns %s", (_case, text, expected) => {
    expect(firstMarkdownHeading(text)).toBe(expected);
  });

  it.each([
    ["no heading", "plain text"],
    ["# that is not at a line start", "text # not a heading"],
    ["# followed by text without a space", "#hashtag"],
    ["# followed only by line breaks", "#\n\n"],
    ["# followed by one space only", "# "],
    ["# followed by one space and line breaks", "# \n\n"],
    ["an empty string", ""],
  ])("returns undefined for %s", (_case, text) => {
    expect(firstMarkdownHeading(text)).toBeUndefined();
  });

  it("scans long whitespace runs quickly", () => {
    const started = Date.now();
    expect(firstMarkdownHeading("#" + " \n".repeat(100_000))).toBe(" ");
    expect(firstMarkdownHeading("#x\n".repeat(100_000))).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("trimTrailingSlashes", () => {
  it.each([
    ["https://x.org///", "https://x.org"],
    ["https://x.org", "https://x.org"],
    ["/", ""],
    ["", ""],
    ["a/b/", "a/b"],
  ])("%j -> %j", (input, expected) => {
    expect(trimTrailingSlashes(input)).toBe(expected);
  });
});
