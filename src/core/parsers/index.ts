import { extname } from "node:path";
import { MarkdownParser } from "./markdown.js";
import { PlainTextParser } from "./text.js";
import { JsonParser } from "./json-parser.js";
import { YamlParser } from "./yaml.js";
import { CsvParser } from "./csv.js";
import { PdfParser } from "./pdf.js";
import { WordParser } from "./word.js";
import { HtmlParser } from "./html.js";

/** Interface for document format parsers. */
export interface DocumentParser {
  /** File extensions this parser handles (e.g. [".pdf", ".docx"]). */
  readonly extensions: string[];
  /** Parse a file buffer into plain text or markdown suitable for indexing. */
  parse(content: Buffer): Promise<string>;
}

const parsers: DocumentParser[] = [
  new MarkdownParser(),
  new PlainTextParser(),
  new JsonParser(),
  new YamlParser(),
  new CsvParser(),
  new PdfParser(),
  new WordParser(),
  new HtmlParser(),
];

const extensionMap = new Map<string, DocumentParser>();
for (const parser of parsers) {
  for (const ext of parser.extensions) {
    extensionMap.set(ext.toLowerCase(), parser);
  }
}

/** Get a parser for the given filename based on its extension. Returns null if unsupported. */
export function getParserForFile(filename: string): DocumentParser | null {
  const ext = extname(filename).toLowerCase();
  return extensionMap.get(ext) ?? null;
}

/** Get all file extensions supported by the parsers. */
export function getSupportedExtensions(): string[] {
  return [...extensionMap.keys()].sort();
}
