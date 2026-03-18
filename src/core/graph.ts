import type Database from "better-sqlite3";
import { getLogger } from "../logger.js";

export interface GraphNode {
  id: string;
  label: string;
  type: "document" | "topic" | "tag";
  metadata: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  type:
    | "belongs_to_topic"
    | "has_tag"
    | "similar_to"
    | "see_also"
    | "prerequisite"
    | "supersedes"
    | "related"
    | "references";
  weight: number; // 0-1
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphOptions {
  similarityThreshold?: number | undefined; // default 0.85
  maxNodes?: number | undefined; // default 200
  includeSimilarityEdges?: boolean | undefined; // default true
  topicFilter?: string | undefined;
  tagFilter?: string | undefined;
}

interface DocumentRow {
  id: string;
  title: string;
  topic_id: string | null;
  library: string | null;
  version: string | null;
  source_type: string;
  updated_at: string;
  avg_rating: number | null;
}

interface TopicRow {
  id: string;
  name: string;
  description: string | null;
}

interface TagRow {
  id: string;
  name: string;
}

interface DocTagRow {
  document_id: string;
  tag_id: string;
}

interface ChunkEmbeddingRow {
  document_id: string;
  embedding: Buffer;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

function bufferToFloatArray(buf: Buffer): number[] {
  const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(floats);
}

/** Query filtered documents from the database. */
function queryDocuments(
  db: Database.Database,
  maxNodes: number,
  topicFilter: string | undefined,
  tagFilter: string | undefined,
): DocumentRow[] {
  let docSql = `
    SELECT d.id, d.title, d.topic_id, d.library, d.version, d.source_type, d.updated_at,
           (SELECT AVG(r.rating) FROM ratings r WHERE r.document_id = d.id) AS avg_rating
    FROM documents d
    WHERE 1=1
  `;
  const docParams: unknown[] = [];

  if (topicFilter) {
    docSql += " AND d.topic_id = ?";
    docParams.push(topicFilter);
  }

  if (tagFilter) {
    docSql += ` AND d.id IN (
      SELECT dt.document_id FROM document_tags dt
      JOIN tags t ON t.id = dt.tag_id
      WHERE t.name = ?
    )`;
    docParams.push(tagFilter);
  }

  docSql += " ORDER BY avg_rating DESC, d.updated_at DESC LIMIT ?";
  docParams.push(maxNodes);

  return db.prepare(docSql).all(...docParams) as DocumentRow[];
}

/** Convert document rows to graph nodes and collect their IDs. */
function buildDocumentNodes(documents: DocumentRow[]): { nodes: GraphNode[]; docIds: Set<string> } {
  const nodes: GraphNode[] = [];
  const docIds = new Set<string>();
  for (const doc of documents) {
    docIds.add(doc.id);
    nodes.push({
      id: doc.id,
      label: doc.title,
      type: "document",
      metadata: {
        library: doc.library,
        version: doc.version,
        sourceType: doc.source_type,
        updatedAt: doc.updated_at,
        avgRating: doc.avg_rating,
      },
    });
  }
  return { nodes, docIds };
}

/** Build topic nodes and document→topic edges. */
function buildTopicNodesAndEdges(
  db: Database.Database,
  documents: DocumentRow[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const topics = db
    .prepare("SELECT id, name, description FROM topics ORDER BY name")
    .all() as TopicRow[];

  const topicIds = new Set<string>();
  const nodes: GraphNode[] = [];
  for (const topic of topics) {
    topicIds.add(topic.id);
    nodes.push({
      id: `topic:${topic.id}`,
      label: topic.name,
      type: "topic",
      metadata: { description: topic.description },
    });
  }

  const edges: GraphEdge[] = [];
  for (const doc of documents) {
    if (doc.topic_id && topicIds.has(doc.topic_id)) {
      edges.push({
        source: doc.id,
        target: `topic:${doc.topic_id}`,
        type: "belongs_to_topic",
        weight: 1,
      });
    }
  }

  return { nodes, edges };
}

/** Build tag nodes and document→tag edges. */
function buildTagNodesAndEdges(
  db: Database.Database,
  docIds: Set<string>,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const tags = db.prepare("SELECT id, name FROM tags ORDER BY name").all() as TagRow[];
  const tagIdMap = new Map<string, string>();
  const nodes: GraphNode[] = [];
  for (const tag of tags) {
    tagIdMap.set(tag.id, tag.name);
    nodes.push({ id: `tag:${tag.id}`, label: tag.name, type: "tag", metadata: {} });
  }

  const docTags = db.prepare("SELECT document_id, tag_id FROM document_tags").all() as DocTagRow[];
  const edges: GraphEdge[] = [];
  for (const dt of docTags) {
    if (docIds.has(dt.document_id) && tagIdMap.has(dt.tag_id)) {
      edges.push({
        source: dt.document_id,
        target: `tag:${dt.tag_id}`,
        type: "has_tag",
        weight: 1,
      });
    }
  }

  return { nodes, edges };
}

/** Build edges from explicit document links. */
function buildDocLinkEdges(db: Database.Database, docIds: Set<string>): GraphEdge[] {
  const docLinks = db
    .prepare("SELECT source_id, target_id, link_type FROM document_links")
    .all() as Array<{ source_id: string; target_id: string; link_type: string }>;

  const edges: GraphEdge[] = [];
  for (const link of docLinks) {
    if (docIds.has(link.source_id) && docIds.has(link.target_id)) {
      edges.push({
        source: link.source_id,
        target: link.target_id,
        type: link.link_type as GraphEdge["type"],
        weight: 1,
      });
    }
  }
  return edges;
}

/** Accumulate embeddings per document, averaging across chunks. */
function computeAveragedEmbeddings(rows: ChunkEmbeddingRow[]): Map<string, number[]> {
  const docEmbeddings = new Map<string, number[]>();
  const docCounts = new Map<string, number>();

  for (const row of rows) {
    const vec = bufferToFloatArray(row.embedding);
    const existing = docEmbeddings.get(row.document_id);
    if (existing) {
      for (let i = 0; i < vec.length; i++) {
        existing[i] = (existing[i] ?? 0) + (vec[i] ?? 0);
      }
      docCounts.set(row.document_id, (docCounts.get(row.document_id) ?? 0) + 1);
    } else {
      docEmbeddings.set(row.document_id, [...vec]);
      docCounts.set(row.document_id, 1);
    }
  }

  for (const [docId, vec] of docEmbeddings) {
    const count = docCounts.get(docId) ?? 1;
    for (let i = 0; i < vec.length; i++) {
      vec[i] = (vec[i] ?? 0) / count;
    }
  }

  return docEmbeddings;
}

/** Compute pairwise similarity edges from averaged document embeddings. */
function computeSimilarityEdges(
  docEmbeddings: Map<string, number[]>,
  threshold: number,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const docIdList = [...docEmbeddings.keys()];
  for (let i = 0; i < docIdList.length; i++) {
    const idA = docIdList[i];
    if (!idA) continue;
    const vecA = docEmbeddings.get(idA);
    if (!vecA) continue;
    for (let j = i + 1; j < docIdList.length; j++) {
      const idB = docIdList[j];
      if (!idB) continue;
      const vecB = docEmbeddings.get(idB);
      if (!vecB) continue;
      const sim = cosineSimilarity(vecA, vecB);
      if (sim >= threshold) {
        edges.push({ source: idA, target: idB, type: "similar_to", weight: sim });
      }
    }
  }
  return edges;
}

/** Build similarity edges from chunk embeddings. */
function buildSimilarityEdges(
  db: Database.Database,
  documents: DocumentRow[],
  threshold: number,
): GraphEdge[] {
  const log = getLogger();
  if (documents.length <= 1) return [];

  try {
    const embeddingRows = db
      .prepare(
        `SELECT c.document_id, ce.embedding
         FROM chunk_embeddings ce
         JOIN chunks c ON c.id = ce.chunk_id
         WHERE c.document_id IN (${documents.map(() => "?").join(",")})`,
      )
      .all(...documents.map((d) => d.id)) as ChunkEmbeddingRow[];

    const docEmbeddings = computeAveragedEmbeddings(embeddingRows);
    return computeSimilarityEdges(docEmbeddings, threshold);
  } catch {
    log.debug("chunk_embeddings table not available, skipping similarity edges");
    return [];
  }
}

/** Build a knowledge graph from the database. */
export function buildKnowledgeGraph(
  db: Database.Database,
  options?: GraphOptions,
): Promise<KnowledgeGraph> {
  const log = getLogger();
  const threshold = options?.similarityThreshold ?? 0.85;
  const maxNodes = options?.maxNodes ?? 200;
  const includeSimilarity = options?.includeSimilarityEdges ?? true;

  const documents = queryDocuments(db, maxNodes, options?.topicFilter, options?.tagFilter);
  const { nodes: docNodes, docIds } = buildDocumentNodes(documents);
  const { nodes: topicNodes, edges: topicEdges } = buildTopicNodesAndEdges(db, documents);
  const { nodes: tagNodes, edges: tagEdges } = buildTagNodesAndEdges(db, docIds);
  const linkEdges = buildDocLinkEdges(db, docIds);
  const similarityEdges = includeSimilarity ? buildSimilarityEdges(db, documents, threshold) : [];

  const nodes = [...docNodes, ...topicNodes, ...tagNodes];
  const edges = [...topicEdges, ...tagEdges, ...linkEdges, ...similarityEdges];

  log.info({ nodeCount: nodes.length, edgeCount: edges.length }, "Knowledge graph built");
  return Promise.resolve({ nodes, edges });
}

/** Build an adjacency map from graph nodes and edges. */
function buildAdjacencyMap(graph: KnowledgeGraph): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    adjacency.set(node.id, new Set());
  }
  for (const edge of graph.edges) {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }
  return adjacency;
}

/** Traverse a connected component starting from a seed node using BFS. */
function traverseComponent(
  seedId: string,
  adjacency: Map<string, Set<string>>,
  visited: Set<string>,
): string[] {
  const component: string[] = [];
  const queue = [seedId];

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    component.push(current);

    const neighbors = adjacency.get(current);
    if (!neighbors) continue;
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        queue.push(neighbor);
      }
    }
  }

  return component;
}

/** Name a cluster after the first topic node, or use a numeric label. */
function nameCluster(component: string[], nodes: GraphNode[], index: number): string {
  const topicNode = component.find((id) => id.startsWith("topic:"));
  if (!topicNode) return `cluster-${index}`;
  return nodes.find((n) => n.id === topicNode)?.label ?? `cluster-${index}`;
}

/** Detect clusters of related nodes using connected components. */
export function detectClusters(graph: KnowledgeGraph): Map<string, string[]> {
  const adjacency = buildAdjacencyMap(graph);
  const visited = new Set<string>();
  const clusters = new Map<string, string[]>();
  let clusterIndex = 0;

  for (const node of graph.nodes) {
    if (visited.has(node.id)) continue;
    const component = traverseComponent(node.id, adjacency, visited);
    const clusterName = nameCluster(component, graph.nodes, clusterIndex);
    clusters.set(clusterName, component);
    clusterIndex++;
  }

  return clusters;
}
