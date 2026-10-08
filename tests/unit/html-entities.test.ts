import { describe, it, expect } from "vitest";
import { decodeHtmlEntities } from "../../src/core/html-entities.js";

describe("decodeHtmlEntities", () => {
  it.each([
    ["The Python Tutorial &#8212; Python 3", "The Python Tutorial — Python 3"],
    ["A &#x2014; B", "A — B"],
    ["Q&amp;A &lt;tags&gt; &quot;quoted&quot; it&#39;s", `Q&A <tags> "quoted" it's`],
    ["Docs &mdash; Guide&hellip;", "Docs — Guide…"],
    ["Unknown &foo; stays, so does a bare & sign", "Unknown &foo; stays, so does a bare & sign"],
    ["Out of range &#99999999; stays", "Out of range &#99999999; stays"],
  ])("decodes %j", (input, expected) => {
    expect(decodeHtmlEntities(input)).toBe(expected);
  });
});
