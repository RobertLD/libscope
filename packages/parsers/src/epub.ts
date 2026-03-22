import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { DocumentParser } from "./index.js";
import { ParseError } from "./errors.js";

/** Parses EPUB files using epub2. */
export class EpubParser implements DocumentParser {
  readonly extensions = [".epub"];

  async parse(content: Buffer): Promise<string> {
    let EPub: typeof import("epub2").EPub;
    try {
      const mod = await import("epub2");
      EPub = mod.EPub;
    } catch (err) {
      throw new ParseError(
        'EPUB parsing requires the "epub2" package. Install it with: npm install epub2',
        err,
      );
    }

    // epub2 needs a file path, so write buffer to a temp file
    const tmpPath = join(tmpdir(), `libscope-epub-${randomUUID()}.epub`);
    try {
      writeFileSync(tmpPath, content);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const epub = await EPub.createAsync(tmpPath);

      const chapters: string[] = [];
      for (const item of (epub as { flow: Array<{ id?: string }> }).flow) {
        if (!item.id) continue;
        try {
          const getChapter = (epub as Record<string, (...args: unknown[]) => Promise<string>>)
            .getChapterAsync;
          if (!getChapter) continue;
          const html: string = await getChapter.call(epub, item.id);
          // Strip HTML tags to get plain text
          const text = html
            .replaceAll(/<[^>]+>/g, " ")
            .replaceAll(/\s+/g, " ")
            .trim();
          if (text.length > 0) {
            chapters.push(text);
          }
        } catch {
          // Skip unreadable chapters
        }
      }

      if (chapters.length === 0) {
        throw new ParseError("EPUB file contains no readable chapters");
      }

      return chapters.join("\n\n");
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore cleanup errors */
      }
    }
  }
}
