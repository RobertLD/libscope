import { describe, it, expect } from "vitest";
import { getParserForFile, getSupportedExtensions } from "../../src/core/parsers/index.js";
import { MarkdownParser } from "../../src/core/parsers/markdown.js";
import { PlainTextParser } from "../../src/core/parsers/text.js";
import { JsonParser } from "../../src/core/parsers/json-parser.js";
import { YamlParser } from "../../src/core/parsers/yaml.js";
import { CsvParser } from "../../src/core/parsers/csv.js";
import { ValidationError } from "../../src/errors.js";

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
    // Should be sorted
    const sorted = [...exts].sort();
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

  it("throws ValidationError for invalid JSON", async () => {
    await expect(parser.parse(Buffer.from("{invalid}"))).rejects.toThrow(ValidationError);
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

  it("throws ValidationError for invalid YAML", async () => {
    const input = "invalid: yaml: content: [";
    await expect(parser.parse(Buffer.from(input))).rejects.toThrow(ValidationError);
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
});
