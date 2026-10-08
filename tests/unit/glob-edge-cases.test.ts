import { describe, expect, it } from "vitest";
import { globToRegExp, toPosixPath } from "../../src/utils/glob.js";

describe("globToRegExp edge cases", () => {
  it.each([
    ["**/ also matches zero directories", "**/a.md", "^(?:.*/)?a\\.md$"],
    ["** without a slash", "a/**", "^a/.*$"],
    ["a single *", "*.md", "^[^/]*\\.md$"],
    ["? as one character", "a?", "^a[^/]$"],
    ["{ inside braces is literal", "{a{b}", "^(?:a\\{b)$"],
    ["} outside braces is literal", "a}", "^a\\}$"],
    [", outside braces is literal", "a,b", "^a,b$"],
    ["an unclosed brace group is closed", "{a,b", "^(?:a|b)$"],
    ["a backslash is escaped", "a\\b", "^a\\\\b$"],
  ])("%s", (_case, glob, source) => {
    expect(globToRegExp(glob).source).toBe(new RegExp(source).source);
  });
});

describe("toPosixPath edge cases", () => {
  it("leaves forward slashes alone and converts every backslash", () => {
    expect(toPosixPath("a/b\\c\\\\d")).toBe("a/b/c//d");
  });
});
