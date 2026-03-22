import { describe, it, expect, beforeAll } from "vitest";
import { getParserForFile, getSupportedExtensions } from "../../src/index.js";
import { MarkdownParser } from "../../src/markdown.js";
import { PlainTextParser } from "../../src/text.js";
import { JsonParser } from "../../src/json-parser.js";
import { YamlParser } from "../../src/yaml.js";
import { CsvParser } from "../../src/csv.js";
import { HtmlParser } from "../../src/html.js";
import { ParseError } from "../../src/errors.js";

describe("getParserForFile", () => {
  it("returns parser for .md files", () => {
    expect(getParserForFile("docs/guide.md")).not.toBeNull();
  });

  it("returns parser for .markdown files", () => {
    expect(getParserForFile("readme.markdown")).not.toBeNull();
  });

  it("returns parser for .txt files", () => {
    expect(getParserForFile("notes.txt")).not.toBeNull();
  });

  it("returns parser for .json files", () => {
    expect(getParserForFile("config.json")).not.toBeNull();
  });

  it("returns parser for .yaml files", () => {
    expect(getParserForFile("config.yaml")).not.toBeNull();
  });

  it("returns parser for .yml files", () => {
    expect(getParserForFile("docker-compose.yml")).not.toBeNull();
  });

  it("returns parser for .csv files", () => {
    expect(getParserForFile("data.csv")).not.toBeNull();
  });

  it("returns parser for .pdf files", () => {
    expect(getParserForFile("report.pdf")).not.toBeNull();
  });

  it("returns parser for .docx files", () => {
    expect(getParserForFile("document.docx")).not.toBeNull();
  });

  it("returns parser for .html files", () => {
    expect(getParserForFile("page.html")).not.toBeNull();
  });

  it("returns parser for .htm files", () => {
    expect(getParserForFile("page.htm")).not.toBeNull();
  });

  it("returns null for unsupported extensions", () => {
    expect(getParserForFile("image.png")).toBeNull();
    expect(getParserForFile("archive.zip")).toBeNull();
    expect(getParserForFile("code.rs")).toBeNull();
  });

  it("is case-insensitive for extensions", () => {
    expect(getParserForFile("README.MD")).not.toBeNull();
    expect(getParserForFile("data.CSV")).not.toBeNull();
  });
});

describe("getSupportedExtensions", () => {
  it("returns a sorted array of extensions", () => {
    const exts = getSupportedExtensions();
    expect(exts).toContain(".md");
    expect(exts).toContain(".json");
    expect(exts).toContain(".csv");
    expect(exts).toContain(".yaml");
    expect(exts).toContain(".pdf");
    expect(exts).toContain(".docx");
    expect(exts).toContain(".txt");
    expect(exts).toContain(".html");
    expect(exts).toContain(".htm");
    // Should be sorted
    const sorted = [...exts].sort((a, b) => a.localeCompare(b));
    expect(exts).toEqual(sorted);
  });
});

describe("MarkdownParser", () => {
  const parser = new MarkdownParser();

  it("returns buffer content as-is", async () => {
    const content = "# Hello\n\nThis is **markdown**.";
    const result = await parser.parse(Buffer.from(content));
    expect(result).toBe(content);
  });
});

describe("PlainTextParser", () => {
  const parser = new PlainTextParser();

  it("returns buffer content as-is", async () => {
    const content = "Just plain text\nwith newlines.";
    const result = await parser.parse(Buffer.from(content));
    expect(result).toBe(content);
  });
});

describe("JsonParser", () => {
  const parser = new JsonParser();

  it("formats valid JSON as a fenced code block", async () => {
    const input = '{"name":"test","value":42}';
    const result = await parser.parse(Buffer.from(input));
    expect(result).toBe('```json\n{\n  "name": "test",\n  "value": 42\n}\n```');
  });

  it("handles arrays", async () => {
    const input = "[1, 2, 3]";
    const result = await parser.parse(Buffer.from(input));
    expect(result).toContain("```json");
    expect(result).toContain("[");
    expect(result).toContain("```");
  });

  it("throws ParseError for invalid JSON", async () => {
    await expect(parser.parse(Buffer.from("{invalid}"))).rejects.toThrow(ParseError);
  });
});

describe("YamlParser", () => {
  const parser = new YamlParser();

  it("wraps valid YAML in a fenced code block", async () => {
    const input = "name: test\nvalue: 42";
    const result = await parser.parse(Buffer.from(input));
    expect(result).toBe("```yaml\nname: test\nvalue: 42\n```");
  });

  it("handles multi-line YAML", async () => {
    const input = "items:\n  - one\n  - two\n  - three";
    const result = await parser.parse(Buffer.from(input));
    expect(result).toContain("```yaml");
    expect(result).toContain("items:");
    expect(result).toContain("```");
  });

  it("throws ParseError for invalid YAML", async () => {
    const input = "invalid: yaml: content: [";
    await expect(parser.parse(Buffer.from(input))).rejects.toThrow(ParseError);
  });
});

describe("CsvParser", () => {
  const parser = new CsvParser();

  it("converts CSV to a markdown table", async () => {
    const input = "name,age,city\nAlice,30,NYC\nBob,25,LA";
    const result = await parser.parse(Buffer.from(input));
    expect(result).toBe(
      "| name | age | city |\n| --- | --- | --- |\n| Alice | 30 | NYC |\n| Bob | 25 | LA |",
    );
  });

  it("handles single-row CSV (header only)", async () => {
    const input = "col1,col2,col3";
    const result = await parser.parse(Buffer.from(input));
    expect(result).toContain("| col1 | col2 | col3 |");
    expect(result).toContain("| --- | --- | --- |");
  });

  it("returns empty string for empty CSV", async () => {
    const result = await parser.parse(Buffer.from(""));
    expect(result).toBe("");
  });

  it("escapes pipe characters in cell values", async () => {
    const input = "col1,col2\nfoo|bar,baz";
    const result = await parser.parse(Buffer.from(input));
    // prettier-ignore
    expect(result).toContain(String.raw`foo\|bar`);
  });

  it("replaces newlines in cell values", async () => {
    const input = 'col1,col2\n"line1\nline2",baz';
    const result = await parser.parse(Buffer.from(input));
    expect(result).toContain("line1 line2");
  });

  it("normalizes row length to match header", async () => {
    const input = "a,b,c\n1,2";
    const result = await parser.parse(Buffer.from(input));
    // Row should have 3 cells even though input only has 2
    const lines = result.split("\n");
    const dataRow = lines[2]!;
    expect(dataRow.split("|").length).toBe(5); // | a | b | c | => 5 parts
  });
});

describe("PdfParser", () => {
  let parser: InstanceType<typeof import("../../src/pdf.js").PdfParser>;

  beforeAll(async () => {
    const { PdfParser } = await import("../../src/pdf.js");
    parser = new PdfParser();
  });

  it("has .pdf extension", () => {
    expect(parser.extensions).toEqual([".pdf"]);
  });

  it("throws ParseError for invalid PDF content", async () => {
    await expect(parser.parse(Buffer.from("not a pdf"))).rejects.toThrow(ParseError);
  });
});

describe("WordParser", () => {
  let parser: InstanceType<typeof import("../../src/word.js").WordParser>;

  beforeAll(async () => {
    const { WordParser } = await import("../../src/word.js");
    parser = new WordParser();
  });

  it("has .docx extension", () => {
    expect(parser.extensions).toEqual([".docx"]);
  });

  it("throws ParseError for invalid Word content", async () => {
    await expect(parser.parse(Buffer.from("not a docx"))).rejects.toThrow(ParseError);
  });
});

describe("HtmlParser", () => {
  const parser = new HtmlParser();

  it("has .html and .htm extensions", () => {
    expect(parser.extensions).toEqual([".html", ".htm"]);
  });

  it("converts basic HTML to markdown", async () => {
    const html = "<h1>Hello</h1><p>This is a <strong>test</strong>.</p>";
    const result = await parser.parse(Buffer.from(html));
    expect(result).toContain("Hello");
    expect(result).toContain("**test**");
  });

  it("strips script tags", async () => {
    const html = '<p>Content</p><script>alert("xss")</script><p>More</p>';
    const result = await parser.parse(Buffer.from(html));
    expect(result).toContain("Content");
    expect(result).toContain("More");
    expect(result).not.toContain("alert");
    expect(result).not.toContain("script");
  });

  it("strips style tags", async () => {
    const html = "<style>body { color: red; }</style><p>Visible</p>";
    const result = await parser.parse(Buffer.from(html));
    expect(result).toContain("Visible");
    expect(result).not.toContain("color");
  });

  it("strips nav tags", async () => {
    const html =
      "<nav><a href='/'>Home</a><a href='/about'>About</a></nav><main><p>Article</p></main>";
    const result = await parser.parse(Buffer.from(html));
    expect(result).toContain("Article");
    expect(result).not.toContain("Home");
  });

  it("handles full HTML documents with doctype and head", async () => {
    const html = `<!DOCTYPE html>
<html><head><title>Test Page</title><style>h1 { color: blue; }</style></head>
<body><h1>Main Title</h1><p>Body text here.</p></body></html>`;
    const result = await parser.parse(Buffer.from(html));
    expect(result).toContain("Main Title");
    expect(result).toContain("Body text here");
    expect(result).not.toContain("color: blue");
  });

  it("converts links to markdown format", async () => {
    const html = '<a href="https://example.com">Click here</a>';
    const result = await parser.parse(Buffer.from(html));
    expect(result).toContain("[Click here]");
    expect(result).toContain("https://example.com");
  });

  it("converts lists to markdown", async () => {
    const html = "<ul><li>One</li><li>Two</li><li>Three</li></ul>";
    const result = await parser.parse(Buffer.from(html));
    expect(result).toContain("One");
    expect(result).toContain("Two");
    expect(result).toContain("Three");
  });

  it("handles empty HTML gracefully", async () => {
    const result = await parser.parse(Buffer.from(""));
    expect(result).toBe("");
  });

  it("collapses excessive blank lines", async () => {
    const html = "<p>First</p><script>removed</script><script>removed</script><p>Second</p>";
    const result = await parser.parse(Buffer.from(html));
    expect(result).not.toMatch(/\n{3,}/);
  });
});
