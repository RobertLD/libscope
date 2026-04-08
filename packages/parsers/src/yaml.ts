import type { DocumentParser } from "./index.js";
import { ParseError } from "./errors.js";
import yaml from "js-yaml";

/** Parses YAML files, outputting a fenced code block. */
export class YamlParser implements DocumentParser {
  readonly extensions = [".yaml", ".yml"];

  parse(content: Buffer): Promise<string> {
    const text = content.toString("utf-8");
    try {
      // Validate by parsing, then output the original text in a fenced block
      yaml.load(text);
      return Promise.resolve("```yaml\n" + text.trimEnd() + "\n```");
    } catch (err) {
      return Promise.reject(
        new ParseError(`Invalid YAML: ${err instanceof Error ? err.message : String(err)}`, err),
      );
    }
  }
}
