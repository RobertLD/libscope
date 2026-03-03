import type { DocumentParser } from "./index.js";
import { ValidationError } from "../../errors.js";

/** Parses JSON files, outputting a fenced code block. */
export class JsonParser implements DocumentParser {
  readonly extensions = [".json"];

  parse(content: Buffer): Promise<string> {
    const text = content.toString("utf-8");
    try {
      const parsed: unknown = JSON.parse(text);
      const formatted = JSON.stringify(parsed, null, 2);
      return Promise.resolve("```json\n" + formatted + "\n```");
    } catch (err) {
      return Promise.reject(
        new ValidationError(
          `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
          err,
        ),
      );
    }
  }
}
