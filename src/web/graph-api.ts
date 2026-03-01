import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { buildKnowledgeGraph } from "../core/graph.js";

/** HTTP handler for graph data requests. */
export async function handleGraphRequest(
  db: Database.Database,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  const threshold = parseFloat(url.searchParams.get("threshold") ?? "0.85");
  const maxNodes = parseInt(url.searchParams.get("maxNodes") ?? "200", 10);
  const topic = url.searchParams.get("topic") ?? undefined;
  const tag = url.searchParams.get("tag") ?? undefined;

  const graph = await buildKnowledgeGraph(db, {
    similarityThreshold: threshold,
    maxNodes,
    topicFilter: topic ?? undefined,
    tagFilter: tag ?? undefined,
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(graph));
}
