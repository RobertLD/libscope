import { NodeHtmlMarkdown } from "node-html-markdown";
import type { DocumentParser } from "./index.js";

/** Parser for HTML files — converts to Markdown via node-html-markdown. */
export class HtmlParser implements DocumentParser {
  readonly extensions = [".html", ".htm"];

  parse(content: Buffer): Promise<string> {
    const html = content.toString("utf-8");

    // Strip <script> and <style> blocks before conversion to avoid noise
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "");

    const markdown = NodeHtmlMarkdown.translate(cleaned);

    // Collapse excessive blank lines from stripped blocks
    return Promise.resolve(markdown.replace(/\n{3,}/g, "\n\n").trim());
  }
}
