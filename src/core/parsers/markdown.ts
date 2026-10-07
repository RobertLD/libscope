import { PlainTextParser } from "./text.js";

/** Pass-through parser for Markdown files (same UTF-8 decoding as plain text). */
export class MarkdownParser extends PlainTextParser {
  override readonly extensions = [".md", ".markdown", ".mdx"];
}
