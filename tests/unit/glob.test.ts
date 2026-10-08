import { describe, it, expect } from "vitest";
import { globToRegExp, toPosixPath } from "../../src/utils/glob.js";

describe("globToRegExp", () => {
  it("matches files at any depth with **/ including the root", () => {
    const rx = globToRegExp("**/*.md");
    expect(rx.test("readme.md")).toBe(true);
    expect(rx.test("docs/guide/intro.md")).toBe(true);
    expect(rx.test("docs/intro.txt")).toBe(false);
  });

  it("keeps * within a single path segment", () => {
    const rx = globToRegExp("docs/*.md");
    expect(rx.test("docs/a.md")).toBe(true);
    expect(rx.test("docs/sub/a.md")).toBe(false);
  });

  it("supports brace alternation", () => {
    const rx = globToRegExp("**/*.{md,mdx,txt}");
    expect(rx.test("a.md")).toBe(true);
    expect(rx.test("x/y/b.mdx")).toBe(true);
    expect(rx.test("c.txt")).toBe(true);
    expect(rx.test("d.pdf")).toBe(false);
  });

  it("supports ? and trailing **", () => {
    expect(globToRegExp("file?.txt").test("file1.txt")).toBe(true);
    expect(globToRegExp("file?.txt").test("file12.txt")).toBe(false);
    expect(globToRegExp("node_modules/**").test("node_modules/a/b.js")).toBe(true);
  });

  it("escapes regex metacharacters", () => {
    const rx = globToRegExp("a+b(1).md");
    expect(rx.test("a+b(1).md")).toBe(true);
    expect(rx.test("aab1.md")).toBe(false);
  });

  it("closes an unterminated brace group", () => {
    expect(globToRegExp("*.{md,txt").test("a.txt")).toBe(true);
  });
});

describe("toPosixPath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(toPosixPath(String.raw`docs\guide\a.md`)).toBe("docs/guide/a.md");
  });
});
