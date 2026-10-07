import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PizZip from "pizzip";
import type Database from "better-sqlite3";
import { createTestDbWithVec } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { batchImport } from "../../src/core/batch.js";
import { FileWatcher, readWatchedFile } from "../../src/core/watcher.js";
import { initLogger } from "../../src/logger.js";

const DOCX_TEXT = "Quarterly revenue grew in the northern region";

/** Build a minimal but valid .docx (Office Open XML) containing one paragraph. */
function buildDocx(text: string): Buffer {
  const zip = new PizZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>",
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>",
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>` +
      "</w:document>",
  );
  return zip.generate({ type: "nodebuffer" });
}

function documentContent(db: Database.Database, id: string): { content: string; source: string } {
  return db
    .prepare("SELECT content, source_type AS source FROM documents WHERE id = ?")
    .get(id) as { content: string; source: string };
}

describe("integration: import-batch and watch use the parser registry", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;
  let dir: string;
  let docxPath: string;

  beforeEach(() => {
    initLogger("silent");
    db = createTestDbWithVec();
    provider = new MockEmbeddingProvider();
    dir = mkdtempSync(join(tmpdir(), "libscope-parsed-import-"));
    docxPath = join(dir, "report.docx");
    writeFileSync(docxPath, buildDocx(DOCX_TEXT));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("batchImport indexes parsed DOCX text and skips unsupported files", async () => {
    const pngPath = join(dir, "logo.png");
    writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await batchImport(db, provider, [docxPath, pngPath], {
      sourceType: "model-generated",
    });

    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);

    const doc = documentContent(db, result.results[0]!.documentId!);
    expect(doc.content).toContain(DOCX_TEXT);
    expect(doc.content).not.toContain("word/document.xml");
    expect(doc.source).toBe("model-generated");
  });

  it("readWatchedFile parses binary formats and reads .rst as text", async () => {
    const rstPath = join(dir, "guide.rst");
    writeFileSync(rstPath, "Title\n=====\n\nSome reStructuredText.");

    expect((await readWatchedFile(docxPath))?.trim()).toBe(DOCX_TEXT);
    expect(await readWatchedFile(rstPath)).toContain("Some reStructuredText.");
    expect(await readWatchedFile(join(dir, "logo.png"))).toBeNull();
  });

  it("FileWatcher indexes the parsed DOCX text for a changed file", async () => {
    const indexed: string[] = [];
    const watcher = new FileWatcher(db, provider, {
      directory: dir,
      onIndex: (path): void => {
        indexed.push(path);
      },
    });

    // Drive the change handler directly instead of waiting on fs.watch events.
    await (watcher as unknown as { processFile(p: string): Promise<void> }).processFile(docxPath);

    expect(indexed).toEqual([docxPath]);
    const row = db.prepare("SELECT content FROM documents WHERE url = ?").get(docxPath) as {
      content: string;
    };
    expect(row.content).toContain(DOCX_TEXT);
    expect(row.content).not.toContain("word/document.xml");
  });
});
