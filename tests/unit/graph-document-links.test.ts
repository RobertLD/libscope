import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../fixtures/test-db.js";
import { buildKnowledgeGraph } from "../../src/core/graph.js";
import { createLink } from "../../src/core/links.js";

function insertDocument(db: Database.Database, id: string, title: string): void {
  db.prepare(
    `INSERT INTO documents (id, source_type, title, content) VALUES (?, 'manual', ?, 'content')`,
  ).run(id, title);
}

describe("buildKnowledgeGraph with document_links", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("should include document_links edges with type references", async () => {
    insertDocument(db, "d1", "Doc One");
    insertDocument(db, "d2", "Doc Two");
    createLink(db, "d1", "d2", "references");

    const graph = await buildKnowledgeGraph(db, { includeSimilarityEdges: false });

    const refEdges = graph.edges.filter((e) => e.type === "references");
    expect(refEdges).toHaveLength(1);
    expect(refEdges[0]!.source).toBe("d1");
    expect(refEdges[0]!.target).toBe("d2");
    expect(refEdges[0]!.weight).toBe(1);
  });
});
