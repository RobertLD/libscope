import type { DocumentParser } from "./index.js";
import { ValidationError } from "../../errors.js";
import { parse } from "csv-parse/sync";

/** Parses CSV files, converting to a Markdown table. */
export class CsvParser implements DocumentParser {
  readonly extensions = [".csv"];

  parse(content: Buffer): Promise<string> {
    const text = content.toString("utf-8");
    try {
      const records: string[][] = parse(text, { relax_column_count: true });
      if (records.length === 0) {
        return Promise.resolve("");
      }

      const header = records[0]!;
      const colCount = header.length;
      const rows = records.slice(1);

      const escapeCell = (cell: string): string =>
        cell.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", " ");

      const lines: string[] = [];
      lines.push("| " + header.map(escapeCell).join(" | ") + " |");
      lines.push("| " + header.map(() => "---").join(" | ") + " |");
      for (const row of rows) {
        // Normalize row length to match header
        const normalized = Array.from({ length: colCount }, (_, i) => row[i] ?? "");
        lines.push("| " + normalized.map(escapeCell).join(" | ") + " |");
      }

      return Promise.resolve(lines.join("\n"));
    } catch (err) {
      return Promise.reject(
        new ValidationError(
          `Invalid CSV: ${err instanceof Error ? err.message : String(err)}`,
          err,
        ),
      );
    }
  }
}
