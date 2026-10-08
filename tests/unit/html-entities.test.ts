import { describe, it, expect } from "vitest";
import { decodeHtmlEntities } from "../../src/core/html-entities.js";

describe("decodeHtmlEntities", () => {
  it.each([
    ["decimal reference", "textwrap &#8212; Python docs", "textwrap — Python docs"],
    ["hex reference", "A &#x2014; B &#X41;", "A — B A"],
    [
      "named references",
      "Tom &amp; Jerry &lt;3 &quot;hi&quot; &mdash; ok",
      'Tom & Jerry <3 "hi" — ok',
    ],
    ["named reference in upper case", "A &AMP; B", "A & B"],
    ["decodes only once", "&amp;lt;", "&lt;"],
    ["unknown named reference kept", "&unknownent; x", "&unknownent; x"],
    ["out-of-range code point kept", "&#1114112; &#0;", "&#1114112; &#0;"],
    ["text without references", "Plain title", "Plain title"],
  ])("%s", (_label, input, expected) => {
    expect(decodeHtmlEntities(input)).toBe(expected);
  });
});
