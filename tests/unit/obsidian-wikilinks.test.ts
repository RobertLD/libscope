import { describe, expect, it } from "vitest";
import { findWikilinks, replaceWikilinks } from "../../src/connectors/obsidian-wikilinks.js";

const links = (text: string): Array<[string, string | undefined]> =>
  findWikilinks(text).map((w) => [w.link, w.display]);

describe("findWikilinks", () => {
  it("finds plain links and links with display text, with their positions", () => {
    expect(findWikilinks("see [[Note]] and [[Other Note|shown]].")).toEqual([
      { start: 4, end: 12, link: "Note", display: undefined },
      { start: 17, end: 37, link: "Other Note", display: "shown" },
    ]);
  });

  it.each([
    ["an embed", "![[image.png]]", []],
    ["an empty link", "[[]]", []],
    ["a link that starts with |", "[[|x]]", []],
    ["an unclosed link", "[[Note", []],
    ["a single ] at the end", "[[Note]", []],
    ["an unclosed display", "[[a|b", []],
    ["a display with a single ]", "[[a|b]c]]", []],
  ])("ignores %s", (_case, text, expected) => {
    expect(links(text)).toEqual(expected);
  });

  it.each([
    ["an empty display", "[[a|]]", [["a", ""]]],
    ["a display with |", "[[a|b|c]]", [["a", "b|c"]]],
    ["a display with [[", "[[a|b [[c]]", [["a", "b [[c"]]],
    ["the innermost [[ of a run", "[[[[a]]", [["[[a", undefined]]],
    ["a link after an embed", "![[e]] [[l]]", [["l", undefined]]],
    ["a link after a failed one", "[[a] [[b]]", [["b", undefined]]],
    ["a link after an unclosed display", "[[a|b] [[c]]", [["c", undefined]]],
    ["a link that spans lines", "[[a\nb]]", [["a\nb", undefined]]],
    ["a [[ right after [", "[[[a]]", [["[a", undefined]]],
  ])("finds %s", (_case, text, expected) => {
    expect(links(text)).toEqual(expected);
  });

  it("scans long runs of brackets and pipes quickly", () => {
    const hostile = "[[".repeat(50_000) + "[[a|".repeat(50_000) + "[[a]".repeat(50_000);
    const started = Date.now();
    expect(findWikilinks(hostile)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("replaceWikilinks", () => {
  it("replaces each link and keeps the text around it", () => {
    const out = replaceWikilinks("a [[x]] b [[y|Y]] ![[z]] c", (w) => `<${w.display ?? w.link}>`);
    expect(out).toBe("a <x> b <Y> ![[z]] c");
  });

  it("returns the text unchanged when there are no links", () => {
    expect(replaceWikilinks("no links [here]", () => "?")).toBe("no links [here]");
  });
});
