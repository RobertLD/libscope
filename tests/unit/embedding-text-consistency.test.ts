import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createTestDbWithVec } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { initLogger } from "../../src/logger.js";
import {
  buildEmbeddingText,
  indexDocument,
  type IndexDocumentInput,
} from "../../src/core/indexing.js";
import { updateDocument } from "../../src/core/documents.js";
import { reindex } from "../../src/core/reindex.js";
import { installPack } from "../../src/core/packs.js";
import { getDocumentLinks } from "../../src/core/links.js";

/** Mock provider that records every text it is asked to embed. */
class CapturingProvider extends MockEmbeddingProvider {
  inputs: string[] = [];

  override embedBatch(texts: string[]): Promise<number[][]> {
    this.inputs.push(...texts);
    return super.embedBatch(texts);
  }
}

const CONTENT = "# Setup\n\nInstall the package.\n\n## Usage\n\nCall the function.";
const DOC: IndexDocumentInput = {
  title: "Widget Guide",
  content: CONTENT,
  sourceType: "library",
  library: "widgets",
  version: "2.1.0",
};

/** Embedding inputs and stored vectors produced by a fresh indexDocument call. */
async function freshIndex(
  input: IndexDocumentInput,
): Promise<{ inputs: string[]; vectors: Buffer[] }> {
  const db = createTestDbWithVec();
  const provider = new CapturingProvider();
  const { id } = await indexDocument(db, provider, input);
  const vectors = storedVectors(db, id);
  db.close();
  return { inputs: provider.inputs, vectors };
}

function storedVectors(db: Database.Database, docId: string): Buffer[] {
  return (
    db
      .prepare(
        `SELECT e.embedding FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.id
         WHERE c.document_id = ? ORDER BY c.chunk_index`,
      )
      .all(docId) as Array<{ embedding: Buffer }>
  ).map((r) => r.embedding);
}

describe("embedding text is the same on every write path", () => {
  let db: Database.Database | undefined;

  beforeAll(() => {
    initLogger("silent");
  });

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("buildEmbeddingText prefixes title, library, and version", () => {
    expect(buildEmbeddingText("body", { title: "T", library: "L", version: "1" })).toBe(
      "T | Library: L | Version: 1\n\nbody",
    );
    expect(buildEmbeddingText("body", { title: "T", library: null, version: undefined })).toBe(
      "T\n\nbody",
    );
    expect(buildEmbeddingText("body", {})).toBe("body");
  });

  it("reindex embeds the same text and stores the same vectors as a fresh index", async () => {
    const fresh = await freshIndex(DOC);
    expect(fresh.inputs[0]).toMatch(/^Widget Guide \| Library: widgets \| Version: 2\.1\.0\n\n/);

    db = createTestDbWithVec();
    const provider = new CapturingProvider();
    const { id } = await indexDocument(db, provider, DOC);
    provider.inputs = [];
    await reindex(db, provider, { documentIds: [id] });

    expect(provider.inputs).toEqual(fresh.inputs);
    expect(storedVectors(db, id)).toEqual(fresh.vectors);
  });

  it("updateDocument with new content embeds the same text as a fresh index", async () => {
    const fresh = await freshIndex(DOC);

    db = createTestDbWithVec();
    const provider = new CapturingProvider();
    const { id } = await indexDocument(db, provider, { ...DOC, content: "Old content." });
    provider.inputs = [];
    await updateDocument(db, provider, id, { content: CONTENT });

    expect(provider.inputs).toEqual(fresh.inputs);
    expect(storedVectors(db, id)).toEqual(fresh.vectors);
  });

  it("updateDocument with new title/library/version re-embeds to match a fresh index", async () => {
    const renamed = { ...DOC, title: "Widget Handbook", library: "gadgets", version: "3.0.0" };
    const fresh = await freshIndex(renamed);

    db = createTestDbWithVec();
    const provider = new CapturingProvider();
    const { id } = await indexDocument(db, provider, DOC);
    provider.inputs = [];
    await updateDocument(db, provider, id, {
      title: renamed.title,
      metadata: { library: renamed.library, version: renamed.version },
    });

    expect(provider.inputs).toEqual(fresh.inputs);
    expect(storedVectors(db, id)).toEqual(fresh.vectors);
  });

  it("installPack embeds the same text as a fresh index of the same document", async () => {
    const fresh = await freshIndex({ title: DOC.title, content: CONTENT, sourceType: "library" });

    db = createTestDbWithVec();
    const provider = new CapturingProvider();
    const dir = mkdtempSync(join(tmpdir(), "libscope-embed-text-"));
    const packPath = join(dir, "pack.json");
    writeFileSync(
      packPath,
      JSON.stringify({
        name: "widgets-pack",
        version: "1.0.0",
        description: "test",
        documents: [{ title: DOC.title, content: CONTENT, source: "" }],
        metadata: { author: "a", license: "MIT", createdAt: "2024-01-01" },
      }),
    );
    await installPack(db, provider, packPath);
    const { id } = db
      .prepare("SELECT id FROM documents WHERE pack_name = ?")
      .get("widgets-pack") as {
      id: string;
    };

    expect(provider.inputs).toEqual(fresh.inputs);
    expect(storedVectors(db, id)).toEqual(fresh.vectors);
  });

  it("updateDocument with new content extracts document links like indexDocument", async () => {
    db = createTestDbWithVec();
    const provider = new CapturingProvider();
    const target = await indexDocument(db, provider, {
      title: "Target Doc",
      content: "Target body.",
      sourceType: "manual",
    });
    const { id } = await indexDocument(db, provider, {
      title: "Source Doc",
      content: "No links yet.",
      sourceType: "manual",
    });
    expect(getDocumentLinks(db, id).outgoing).toHaveLength(0);

    await updateDocument(db, provider, id, { content: "See [[Target Doc]] for details." });

    const outgoing = getDocumentLinks(db, id).outgoing;
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]!.targetId).toBe(target.id);
    expect(outgoing[0]!.linkType).toBe("references");
  });
});
