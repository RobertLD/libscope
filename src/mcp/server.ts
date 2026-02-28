import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { getDatabase, runMigrations, createVectorTable } from "../db/index.js";
import { createEmbeddingProvider } from "../providers/index.js";
import { searchDocuments } from "../core/search.js";
import { getDocument } from "../core/documents.js";
import { rateDocument, getDocumentRatings } from "../core/ratings.js";
import { indexDocument } from "../core/indexing.js";
import { listTopics } from "../core/topics.js";
import { initLogger } from "../logger.js";
import { LibScopeError } from "../errors.js";

const config = loadConfig();
initLogger(config.logging.level);

const db = getDatabase(config.database.path);
runMigrations(db);

const provider = createEmbeddingProvider(config);
createVectorTable(db, provider.dimensions);

const server = new McpServer({
  name: "libscope",
  version: "0.1.0",
});

// Tool: search-docs
server.tool(
  "search-docs",
  "Semantic search across all indexed documentation, library docs, and topics",
  {
    query: z.string().describe("The search query"),
    topic: z.string().optional().describe("Filter by topic ID"),
    library: z.string().optional().describe("Filter by library name"),
    version: z.string().optional().describe("Filter by library version"),
    minRating: z.number().min(1).max(5).optional().describe("Minimum average rating filter"),
    limit: z.number().min(1).max(50).optional().describe("Maximum results to return (default: 10)"),
  },
  async (params) => {
    try {
      const results = await searchDocuments(db, provider, {
        query: params.query,
        topic: params.topic,
        library: params.library,
        version: params.version,
        minRating: params.minRating,
        limit: params.limit,
      });

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No documents found matching your query." }],
        };
      }

      const text = results
        .map(
          (r, i) =>
            `## Result ${i + 1}: ${r.title}\n` +
            (r.library ? `**Library:** ${r.library}${r.version ? ` v${r.version}` : ""}\n` : "") +
            (r.url ? `**Source:** ${r.url}\n` : "") +
            (r.avgRating ? `**Rating:** ${r.avgRating.toFixed(1)}/5\n` : "") +
            `\n${r.content}\n`,
        )
        .join("\n---\n\n");

      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

// Tool: get-document
server.tool(
  "get-document",
  "Retrieve a specific document by its ID",
  {
    documentId: z.string().describe("The document ID"),
  },
  (params) => {
    try {
      const doc = getDocument(db, params.documentId);
      const ratings = getDocumentRatings(db, params.documentId);

      const text =
        `# ${doc.title}\n\n` +
        `**Type:** ${doc.sourceType}\n` +
        (doc.library ? `**Library:** ${doc.library}${doc.version ? ` v${doc.version}` : ""}\n` : "") +
        (doc.url ? `**Source:** ${doc.url}\n` : "") +
        `**Rating:** ${ratings.averageRating.toFixed(1)}/5 (${ratings.totalRatings} ratings)\n\n` +
        doc.content;

      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

// Tool: rate-document
server.tool(
  "rate-document",
  "Rate a document or suggest corrections. Use this when documentation appears outdated, incorrect, or particularly helpful.",
  {
    documentId: z.string().describe("The document ID to rate"),
    chunkId: z.string().optional().describe("Optional specific chunk ID to rate"),
    rating: z.number().min(1).max(5).describe("Rating from 1 (poor) to 5 (excellent)"),
    feedback: z.string().optional().describe("Text feedback about the document"),
    suggestedCorrection: z
      .string()
      .optional()
      .describe("Suggested replacement content if the doc is wrong"),
  },
  (params) => {
    try {
      const result = rateDocument(db, {
        documentId: params.documentId,
        chunkId: params.chunkId,
        rating: params.rating,
        feedback: params.feedback,
        suggestedCorrection: params.suggestedCorrection,
        ratedBy: "model",
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Rating submitted: ${result.rating}/5 for document ${result.documentId}` +
              (result.feedback ? `\nFeedback: ${result.feedback}` : "") +
              (result.suggestedCorrection ? `\nCorrection suggested.` : ""),
          },
        ],
      };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

// Tool: submit-document
server.tool(
  "submit-document",
  "Submit a new document for indexing into the knowledge base",
  {
    title: z.string().describe("Document title"),
    content: z.string().describe("Document content in markdown"),
    sourceType: z
      .enum(["library", "topic", "manual", "model-generated"])
      .describe("Type of document"),
    topic: z.string().optional().describe("Topic ID to categorize under"),
    library: z.string().optional().describe("Library name (for library docs)"),
    version: z.string().optional().describe("Library version"),
    url: z.string().optional().describe("Source URL"),
  },
  async (params) => {
    try {
      const result = await indexDocument(db, provider, {
        title: params.title,
        content: params.content,
        sourceType: params.sourceType,
        library: params.library,
        version: params.version,
        topicId: params.topic,
        url: params.url,
        submittedBy: "model",
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Document indexed successfully.\nID: ${result.id}\nChunks: ${result.chunkCount}`,
          },
        ],
      };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

// Tool: list-topics
server.tool(
  "list-topics",
  "List available documentation topics",
  {
    parentId: z.string().optional().describe("Filter by parent topic ID for subtopics"),
  },
  (params) => {
    try {
      const topics = listTopics(db, params.parentId);

      if (topics.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No topics found." }],
        };
      }

      const text = topics
        .map(
          (t) =>
            `- **${t.name}** (\`${t.id}\`)${t.description ? `: ${t.description}` : ""}`,
        )
        .join("\n");

      return { content: [{ type: "text" as const, text: `## Topics\n\n${text}` }] };
    } catch (err) {
      return errorResponse(err);
    }
  },
);

function errorResponse(err: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const message = err instanceof LibScopeError ? err.message : "An unexpected error occurred";
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// Start the server
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error("Fatal error starting LibScope MCP server:", err);
  process.exit(1);
});
