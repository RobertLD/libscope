import type { DocumentParser } from "./index.js";

/** Pass-through parser for Markdown files. */
export class MarkdownParser implements DocumentParser {
  readonly extensions = [".md", ".markdown", ".mdx"];

  parse(content: Buffer): Promise<string> {
    return Promise.resolve(content.toString("utf-8"));
  }
}
