import type { DocumentParser } from "./index.js";

/** Pass-through parser for plain text files. */
export class PlainTextParser implements DocumentParser {
  readonly extensions = [".txt"];

  parse(content: Buffer): Promise<string> {
    return Promise.resolve(content.toString("utf-8"));
  }
}
