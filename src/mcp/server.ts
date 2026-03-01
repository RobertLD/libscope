import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { getDatabase, runMigrations, createVectorTable } from "../db/index.js";
import { createEmbeddingProvider } from "../providers/index.js";
import { searchDocuments } from "../core/search.js";
import { getDocument, listDocuments } from "../core/documents.js";
import { rateDocument, getDocumentRatings } from "../core/ratings.js";
import { indexDocument } from "../core/indexing.js";
import { listTopics } from "../core/topics.js";
import { fetchAndConvert } from "../core/url-fetcher.js";
import { initLogger, getLogger } from "../logger.js";
import { LibScopeError, ValidationError } from "../errors.js";

function errorResponse(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  let message: string;
  if (err instanceof LibScopeError) {
    message = err.message;
  } else if (err instanceof Error) {
    message = `${err.name}: ${err.message}`;
  } else {
    message = `An unexpected error occurred: ${String(err)}`;
  }

  const log = getLogger();
  log.error({ err }, "MCP tool error");

  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// Start the server
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error("Failed to load configuration:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  initLogger(config.logging.level);

  let db;
  try {
    db = getDatabase(config.database.path);
    runMigrations(db);
  } catch (err) {
    console.error("Failed to initialize database:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  let provider;
  try {
    provider = createEmbeddingProvider(config);
    createVectorTable(db, provider.dimensions);
  } catch (err) {
    console.error(
      "Failed to initialize embedding provider:",
      err instanceof Error ? err.message : err,
    );
    db.close();
    process.exit(1);
  }

  process.on("SIGINT", () => {
    db.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    db.close();
    process.exit(0);
  });

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
      limit: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe("Maximum results to return (default: 10)"),
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
          (doc.library
            ? `**Library:** ${doc.library}${doc.version ? ` v${doc.version}` : ""}\n`
            : "") +
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
              text:
                `Rating submitted: ${result.rating}/5 for document ${result.documentId}` +
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
    "Submit a new document for indexing into the knowledge base. You can provide content directly, or provide a URL to fetch and index automatically.",
    {
      title: z
        .string()
        .optional()
        .describe("Document title (auto-detected from URL if not provided)"),
      content: z
        .string()
        .optional()
        .describe("Document content in markdown (omit if providing a URL to fetch)"),
      url: z
        .string()
        .optional()
        .describe(
          "URL to fetch and index. When provided, content is fetched automatically. Title is auto-detected if not specified.",
        ),
      sourceType: z
        .enum(["library", "topic", "manual", "model-generated"])
        .optional()
        .describe("Type of document (default: 'manual', or 'library' if library name is given)"),
      topic: z.string().optional().describe("Topic ID to categorize under"),
      library: z.string().optional().describe("Library name (for library docs)"),
      version: z.string().optional().describe("Library version"),
    },
    async (params) => {
      try {
        let { title, content } = params;
        const { url, library, version, topic } = params;

        // If URL is provided and no content, fetch it
        if (url && !content) {
          const fetched = await fetchAndConvert(url);
          content = fetched.content;
          title ??= fetched.title;
        }

        if (!title) {
          return errorResponse(new ValidationError("A title is required when not providing a URL"));
        }
        if (!content) {
          return errorResponse(new ValidationError("Either content or a URL must be provided"));
        }

        const sourceType = params.sourceType ?? (library ? "library" : "manual");

        const result = await indexDocument(db, provider, {
          title,
          content,
          sourceType,
          library,
          version,
          topicId: topic,
          url,
          submittedBy: "model",
        });

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Document indexed successfully.\n` +
                `Title: ${title}\n` +
                `ID: ${result.id}\n` +
                `Chunks: ${result.chunkCount}` +
                (url ? `\nSource: ${url}` : ""),
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
          .map((t) => `- **${t.name}** (\`${t.id}\`)${t.description ? `: ${t.description}` : ""}`)
          .join("\n");

        return { content: [{ type: "text" as const, text: `## Topics\n\n${text}` }] };
      } catch (err) {
        return errorResponse(err);
      }
    },
  );

  // Tool: list-documents
  server.tool(
    "list-documents",
    "List all indexed documents with optional filters",
    {
      library: z.string().optional().describe("Filter by library name"),
      topic: z.string().optional().describe("Filter by topic ID"),
      sourceType: z
        .enum(["library", "topic", "manual", "model-generated"])
        .optional()
        .describe("Filter by source type"),
      limit: z.number().min(1).max(100).optional().describe("Maximum results (default: 50)"),
    },
    (params) => {
      try {
        const docs = listDocuments(db, {
          library: params.library,
          topicId: params.topic,
          sourceType: params.sourceType,
          limit: params.limit,
        });

        if (docs.length === 0) {
          return { content: [{ type: "text" as const, text: "No documents found." }] };
        }

        const text = docs
          .map(
            (d) =>
              `- **${d.title}** (\`${d.id}\`)` +
              (d.library ? ` — ${d.library}${d.version ? ` v${d.version}` : ""}` : "") +
              (d.url ? ` — [source](${d.url})` : "") +
              ` (${d.sourceType})`,
          )
          .join("\n");

        return {
          content: [{ type: "text" as const, text: `## Documents (${docs.length})\n\n${text}` }],
        };
      } catch (err) {
        return errorResponse(err);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error("Fatal error starting LibScope MCP server:", err);
  process.exit(1);
});
