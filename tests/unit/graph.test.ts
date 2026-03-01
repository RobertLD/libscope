import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../fixtures/test-db.js";
import { buildKnowledgeGraph, detectClusters } from "../../src/core/graph.js";
import type { KnowledgeGraph } from "../../src/core/graph.js";

function insertTopic(db: Database.Database, id: string, name: string): void {
  db.prepare("INSERT INTO topics (id, name) VALUES (?, ?)").run(id, name);
}

function insertDocument(
  db: Database.Database,
  id: string,
  title: string,
  topicId: string | null,
): void {
  db.prepare(
    `INSERT INTO documents (id, source_type, title, content, topic_id) VALUES (?, 'manual', ?, 'content', ?)`,
  ).run(id, title, topicId);
}

function insertTag(db: Database.Database, id: string, name: string): void {
  db.prepare("INSERT INTO tags (id, name) VALUES (?, ?)").run(id, name);
}

function insertDocTag(db: Database.Database, docId: string, tagId: string): void {
  db.prepare("INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)").run(docId, tagId);
}

function insertChunkWithEmbedding(
  db: Database.Database,
  chunkId: string,
  docId: string,
  vec: number[],
): void {
  db.prepare("INSERT INTO chunks (id, document_id, content, chunk_index) VALUES (?, ?, '', 0)").run(
    chunkId,
    docId,
  );
  // Create chunk_embeddings table if needed (not created by migrations in test DB)
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunk_embeddings (
      chunk_id TEXT PRIMARY KEY,
      embedding BLOB
    )
  `);
  const buf = Buffer.from(new Float32Array(vec).buffer);
  db.prepare("INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)").run(chunkId, buf);
}

describe("buildKnowledgeGraph", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns empty graph for empty database", async () => {
    const graph = await buildKnowledgeGraph(db);
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });

  it("builds graph with documents, topics, and tags", async () => {
    insertTopic(db, "t1", "JavaScript");
    insertDocument(db, "d1", "Doc One", "t1");
    insertDocument(db, "d2", "Doc Two", "t1");
    insertTag(db, "tag1", "tutorial");
    insertDocTag(db, "d1", "tag1");

    const graph = await buildKnowledgeGraph(db);

    // Should have 2 documents + 1 topic + 1 tag = 4 nodes
    expect(graph.nodes.length).toBe(4);

    const docNodes = graph.nodes.filter((n) => n.type === "document");
    expect(docNodes).toHaveLength(2);

    const topicNodes = graph.nodes.filter((n) => n.type === "topic");
    expect(topicNodes).toHaveLength(1);
    expect(topicNodes[0]!.label).toBe("JavaScript");

    const tagNodes = graph.nodes.filter((n) => n.type === "tag");
    expect(tagNodes).toHaveLength(1);
    expect(tagNodes[0]!.label).toBe("tutorial");

    // Should have 2 belongs_to_topic edges + 1 has_tag edge
    const topicEdges = graph.edges.filter((e) => e.type === "belongs_to_topic");
    expect(topicEdges).toHaveLength(2);

    const tagEdges = graph.edges.filter((e) => e.type === "has_tag");
    expect(tagEdges).toHaveLength(1);
    expect(tagEdges[0]!.source).toBe("d1");
  });

  it("generates similarity edges from embeddings", async () => {
    insertDocument(db, "d1", "Doc One", null);
    insertDocument(db, "d2", "Doc Two", null);
    insertDocument(db, "d3", "Doc Three", null);

    // d1 and d2 have similar vectors, d3 is different
    insertChunkWithEmbedding(db, "c1", "d1", [1, 0, 0, 0]);
    insertChunkWithEmbedding(db, "c2", "d2", [0.99, 0.1, 0, 0]);
    insertChunkWithEmbedding(db, "c3", "d3", [0, 0, 1, 0]);

    const graph = await buildKnowledgeGraph(db, { similarityThreshold: 0.9 });

    const simEdges = graph.edges.filter((e) => e.type === "similar_to");
    // d1 and d2 should be similar (cosine ~ 0.995), d3 should not match
    expect(simEdges.length).toBeGreaterThanOrEqual(1);
    expect(simEdges.every((e) => e.weight >= 0.9)).toBe(true);

    // d3 should not be connected via similarity
    const d3SimEdges = simEdges.filter((e) => e.source === "d3" || e.target === "d3");
    expect(d3SimEdges).toHaveLength(0);
  });

  it("skips similarity edges when includeSimilarityEdges is false", async () => {
    insertDocument(db, "d1", "Doc One", null);
    insertDocument(db, "d2", "Doc Two", null);
    insertChunkWithEmbedding(db, "c1", "d1", [1, 0, 0, 0]);
    insertChunkWithEmbedding(db, "c2", "d2", [1, 0, 0, 0]);

    const graph = await buildKnowledgeGraph(db, { includeSimilarityEdges: false });

    const simEdges = graph.edges.filter((e) => e.type === "similar_to");
    expect(simEdges).toHaveLength(0);
  });

  it("respects maxNodes limit", async () => {
    insertDocument(db, "d1", "Doc One", null);
    insertDocument(db, "d2", "Doc Two", null);
    insertDocument(db, "d3", "Doc Three", null);

    const graph = await buildKnowledgeGraph(db, { maxNodes: 2 });

    const docNodes = graph.nodes.filter((n) => n.type === "document");
    expect(docNodes).toHaveLength(2);
  });

  it("filters by topic", async () => {
    insertTopic(db, "t1", "JavaScript");
    insertTopic(db, "t2", "Python");
    insertDocument(db, "d1", "JS Doc", "t1");
    insertDocument(db, "d2", "Python Doc", "t2");

    const graph = await buildKnowledgeGraph(db, { topicFilter: "t1" });

    const docNodes = graph.nodes.filter((n) => n.type === "document");
    expect(docNodes).toHaveLength(1);
    expect(docNodes[0]!.label).toBe("JS Doc");
  });

  it("filters by tag", async () => {
    insertDocument(db, "d1", "Tagged Doc", null);
    insertDocument(db, "d2", "Untagged Doc", null);
    insertTag(db, "tag1", "important");
    insertDocTag(db, "d1", "tag1");

    const graph = await buildKnowledgeGraph(db, { tagFilter: "important" });

    const docNodes = graph.nodes.filter((n) => n.type === "document");
    expect(docNodes).toHaveLength(1);
    expect(docNodes[0]!.label).toBe("Tagged Doc");
  });

  it("applies threshold filtering for similarity edges", async () => {
    insertDocument(db, "d1", "Doc One", null);
    insertDocument(db, "d2", "Doc Two", null);

    // Vectors that are moderately similar (~0.7 cosine)
    insertChunkWithEmbedding(db, "c1", "d1", [1, 0, 0, 0]);
    insertChunkWithEmbedding(db, "c2", "d2", [0.7, 0.7, 0, 0]);

    // High threshold should exclude them
    const graphHigh = await buildKnowledgeGraph(db, { similarityThreshold: 0.95 });
    const simHigh = graphHigh.edges.filter((e) => e.type === "similar_to");
    expect(simHigh).toHaveLength(0);

    // Low threshold should include them
    const graphLow = await buildKnowledgeGraph(db, { similarityThreshold: 0.5 });
    const simLow = graphLow.edges.filter((e) => e.type === "similar_to");
    expect(simLow.length).toBeGreaterThanOrEqual(1);
  });
});

describe("detectClusters", () => {
  it("detects separate clusters", () => {
    const graph: KnowledgeGraph = {
      nodes: [
        { id: "d1", label: "Doc 1", type: "document", metadata: {} },
        { id: "topic:t1", label: "JavaScript", type: "topic", metadata: {} },
        { id: "d2", label: "Doc 2", type: "document", metadata: {} },
        { id: "tag:tag1", label: "python", type: "tag", metadata: {} },
      ],
      edges: [
        { source: "d1", target: "topic:t1", type: "belongs_to_topic", weight: 1 },
        { source: "d2", target: "tag:tag1", type: "has_tag", weight: 1 },
      ],
    };

    const clusters = detectClusters(graph);
    expect(clusters.size).toBe(2);

    // One cluster should contain d1 + topic:t1
    let foundD1Cluster = false;
    let foundD2Cluster = false;
    for (const [, members] of clusters) {
      if (members.includes("d1") && members.includes("topic:t1")) foundD1Cluster = true;
      if (members.includes("d2") && members.includes("tag:tag1")) foundD2Cluster = true;
    }
    expect(foundD1Cluster).toBe(true);
    expect(foundD2Cluster).toBe(true);
  });

  it("names clusters after topic nodes when present", () => {
    const graph: KnowledgeGraph = {
      nodes: [
        { id: "d1", label: "Doc 1", type: "document", metadata: {} },
        { id: "topic:t1", label: "JavaScript", type: "topic", metadata: {} },
      ],
      edges: [{ source: "d1", target: "topic:t1", type: "belongs_to_topic", weight: 1 }],
    };

    const clusters = detectClusters(graph);
    expect(clusters.has("JavaScript")).toBe(true);
  });

  it("handles empty graph", () => {
    const graph: KnowledgeGraph = { nodes: [], edges: [] };
    const clusters = detectClusters(graph);
    expect(clusters.size).toBe(0);
  });

  it("groups connected components transitively", () => {
    const graph: KnowledgeGraph = {
      nodes: [
        { id: "d1", label: "Doc 1", type: "document", metadata: {} },
        { id: "d2", label: "Doc 2", type: "document", metadata: {} },
        { id: "d3", label: "Doc 3", type: "document", metadata: {} },
      ],
      edges: [
        { source: "d1", target: "d2", type: "similar_to", weight: 0.9 },
        { source: "d2", target: "d3", type: "similar_to", weight: 0.9 },
      ],
    };

    const clusters = detectClusters(graph);
    expect(clusters.size).toBe(1);
    const members = [...clusters.values()][0]!;
    expect(members).toHaveLength(3);
    expect(members).toContain("d1");
    expect(members).toContain("d2");
    expect(members).toContain("d3");
  });
});
