import type { DocumentParser } from "./index.js";
import { ParseError } from "./errors.js";

/** Parses PDF files using pdf-parse. */
export class PdfParser implements DocumentParser {
  readonly extensions = [".pdf"];

  async parse(content: Buffer): Promise<string> {
    let PDFParse: typeof import("pdf-parse").PDFParse;
    try {
      const mod = await import("pdf-parse");
      PDFParse = mod.PDFParse;
    } catch (err) {
      throw new ParseError(
        'PDF parsing requires the "pdf-parse" package. Install it with: npm install pdf-parse',
        err,
      );
    }

    try {
      const parser = new PDFParse({ data: new Uint8Array(content) });
      const result = await parser.getText();
      return result.text;
    } catch (err) {
      throw new ParseError(
        `Failed to parse PDF: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }
}
