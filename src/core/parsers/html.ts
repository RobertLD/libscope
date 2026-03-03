import { NodeHtmlMarkdown } from "node-html-markdown";
import { ValidationError } from "../../errors.js";
import type { DocumentParser } from "./index.js";

const nhm = new NodeHtmlMarkdown({ ignore: ["script", "style", "nav"] });

/** Parser for HTML files — converts to Markdown via node-html-markdown. */
export class HtmlParser implements DocumentParser {
  readonly extensions = [".html", ".htm"];

  parse(content: Buffer): Promise<string> {
    try {
      const html = content.toString("utf-8");
      const markdown = nhm.translate(html);

      // Collapse excessive blank lines left by ignored elements
      return Promise.resolve(markdown.replace(/\n{3,}/g, "\n\n").trimEnd());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown HTML parsing error";
      throw new ValidationError(`Failed to parse HTML: ${message}`);
    }
  }
}
