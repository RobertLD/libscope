import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { getParserForFile } from "../core/parsers/index.js";
import { fetchAndConvert } from "../core/url-fetcher.js";

/** Raw input that normalizeRawInput turns into a title and markdown content. */
export type RawInput =
  | { type: "file"; path: string; title?: string | undefined }
  | { type: "url"; url: string; title?: string | undefined }
  | { type: "text"; content: string; title: string }
  | { type: "buffer"; buffer: Buffer; filename: string; title?: string | undefined };

export interface NormalizedInput {
  title: string;
  content: string;
}

/** Parse a file's bytes with the registered parser for its extension, else as UTF-8 text. */
async function normalizeBuffer(
  buf: Buffer,
  filename: string,
  explicitTitle: string | undefined,
): Promise<NormalizedInput> {
  const title = explicitTitle ?? basename(filename, extname(filename));
  const parser = getParserForFile(filename);
  const content = parser ? await parser.parse(buf) : buf.toString("utf-8");
  return { title, content };
}

/**
 * Turn a file, buffer, URL or text into `{ title, content }` for `scope.add({ title, content })`.
 * Files and buffers use the parser for their extension (PDF, DOCX, HTML, ...); other files
 * (e.g. source code) are read as UTF-8 text.
 */
export async function normalizeRawInput(input: RawInput): Promise<NormalizedInput> {
  switch (input.type) {
    case "text":
      return { title: input.title, content: input.content };

    case "file":
      return normalizeBuffer(readFileSync(input.path), input.path, input.title);

    case "buffer":
      return normalizeBuffer(input.buffer, input.filename, input.title);

    case "url": {
      const fetched = await fetchAndConvert(input.url);
      return { title: input.title ?? fetched.title, content: fetched.content };
    }
  }
}
