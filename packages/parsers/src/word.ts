import type { DocumentParser } from "./index.js";
import { ParseError } from "./errors.js";

/** Parses Word (.docx) files using mammoth. */
export class WordParser implements DocumentParser {
  readonly extensions = [".docx"];

  async parse(content: Buffer): Promise<string> {
    let mammoth: typeof import("mammoth");
    try {
      mammoth = await import("mammoth");
    } catch (err) {
      throw new ParseError(
        'Word document parsing requires the "mammoth" package. Install it with: npm install mammoth',
        err,
      );
    }

    try {
      const result = await mammoth.extractRawText({ buffer: content });
      return result.value;
    } catch (err) {
      throw new ParseError(
        `Failed to parse Word document: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }
}
