import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { getDatabase, runMigrations, createVectorTable } from "../db/index.js";
import { getActiveWorkspace, getWorkspacePath } from "../core/workspace.js";
import { createEmbeddingProvider } from "../providers/index.js";
import { searchDocuments } from "../core/search.js";
import { askQuestion, createLlmProvider, type LlmProvider } from "../core/rag.js";
import { getDocument, listDocuments, deleteDocument } from "../core/documents.js";
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

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Wraps a tool handler so that thrown errors are converted to MCP error responses. */
function withErrorHandling<P>(
  handler: (params: P) => ToolResult | Promise<ToolResult>,
): (params: P) => Promise<ToolResult> {
  return async (params: P) => {
    try {
      return await handler(params);
    } catch (err) {
      return errorResponse(err);
    }
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
    db = getDatabase(getWorkspacePath(getActiveWorkspace()));
    runMigrations(db);
  } catch (err) {
    console.error("Failed to initialize database:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  let provider;
  let llmProvider: LlmProvider | undefined;
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

  try {
    llmProvider = createLlmProvider(config);
  } catch {
    // LLM provider is optional; ask-question tool will report the error
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
      offset: z.number().min(0).optional().describe("Offset for pagination (default: 0)"),
      limit: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe("Maximum results to return (default: 10)"),
    },
    withErrorHandling(async (params) => {
      const { results, totalCount } = await searchDocuments(db, provider, {
        query: params.query,
        topic: params.topic,
        library: params.library,
        version: params.version,
        minRating: params.minRating,
        limit: params.limit,
        offset: params.offset,
      });

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No documents found matching your query." }],
        };
      }

      const text =
        `**Total results: ${totalCount}**\n\n` +
        results
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
    }),
  );

  // Tool: get-document
  server.tool(
    "get-document",
    "Retrieve a specific document by its ID",
    {
      documentId: z.string().describe("The document ID"),
    },
    withErrorHandling((params) => {
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
    }),
  );

  // Tool: delete-document
  server.tool(
    "delete-document",
    "Delete a document from the knowledge base by its ID",
    {
      documentId: z.string().describe("The document ID to delete"),
    },
    withErrorHandling((params) => {
      deleteDocument(db, params.documentId);

      return {
        content: [
          {
            type: "text" as const,
            text: `Document ${params.documentId} has been deleted successfully.`,
          },
        ],
      };
    }),
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
    withErrorHandling((params) => {
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
    }),
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
    withErrorHandling(async (params) => {
      let { title, content } = params;
      const { url, library, version, topic } = params;

      // If URL is provided and no content, fetch it
      if (url && !content) {
        const fetched = await fetchAndConvert(url, {
          allowPrivateUrls: config.indexing.allowPrivateUrls,
          allowSelfSignedCerts: config.indexing.allowSelfSignedCerts,
        });
        content = fetched.content;
        title ??= fetched.title;
      }

      if (!title) {
        throw new ValidationError("A title is required when not providing a URL");
      }
      if (!content) {
        throw new ValidationError("Either content or a URL must be provided");
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
    }),
  );

  // Tool: list-topics
  server.tool(
    "list-topics",
    "List available documentation topics",
    {
      parentId: z.string().optional().describe("Filter by parent topic ID for subtopics"),
    },
    withErrorHandling((params) => {
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
    }),
  );

  // Tool: health-check
  server.tool(
    "health-check",
    "Check the health of the LibScope server, including database connectivity, document and chunk counts, and FTS5 index status",
    {},
    () => {
      try {
        const health: Record<string, unknown> = {};

        // Check database connectivity
        try {
          db.prepare("SELECT 1").get();
          health.database = "ok";
        } catch {
          health.database = "error";
        }

        // Document count
        try {
          const row = db.prepare("SELECT COUNT(*) as count FROM documents").get() as {
            count: number;
          };
          health.documents = row.count;
        } catch {
          health.documents = "error";
        }

        // Chunk count
        try {
          const row = db.prepare("SELECT COUNT(*) as count FROM chunks").get() as {
            count: number;
          };
          health.chunks = row.count;
        } catch {
          health.chunks = "error";
        }

        // FTS5 index status
        try {
          db.prepare("SELECT COUNT(*) FROM chunks_fts").get();
          health.fts5 = "ok";
        } catch {
          health.fts5 = "error";
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(health, null, 2) }],
        };
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
    withErrorHandling((params) => {
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
    }),
  );

  // Tool: ask-question (RAG)
  server.tool(
    "ask-question",
    "Ask a question and get an LLM-synthesized answer based on indexed documentation (RAG)",
    {
      question: z.string().describe("The question to answer"),
      topK: z
        .number()
        .min(1)
        .max(20)
        .optional()
        .describe("Number of chunks to retrieve for context (default: 5)"),
      topic: z.string().optional().describe("Filter by topic ID"),
      library: z.string().optional().describe("Filter by library name"),
    },
    withErrorHandling(async (params) => {
      if (!llmProvider) {
        throw new Error(
          "No LLM provider configured. Set llm.provider to 'openai' or 'ollama' in your config.",
        );
      }

      const result = await askQuestion(db, provider, llmProvider, {
        question: params.question,
        topK: params.topK,
        topic: params.topic,
        library: params.library,
      });

      const sourcesText =
        result.sources.length > 0
          ? "\n\n**Sources:**\n" +
            result.sources
              .map((s) => `- ${s.title} (score: ${s.score.toFixed(2)}) [${s.documentId}]`)
              .join("\n")
          : "";

      const metaText =
        result.tokensUsed != null
          ? `\n\n_Model: ${result.model} | Tokens: ${result.tokensUsed}_`
          : "";

      return {
        content: [{ type: "text" as const, text: result.answer + sourcesText + metaText }],
      };
    }),
  );

  // Tool: reindex-documents
  server.tool(
    "reindex-documents",
    "Re-embed all document chunks with the current embedding model. Use after switching embedding providers to update vectors without re-fetching content.",
    {
      documentIds: z
        .array(z.string())
        .optional()
        .describe("Only reindex chunks belonging to these document IDs"),
      since: z
        .string()
        .optional()
        .describe("Only reindex documents created on or after this ISO-8601 date"),
      before: z
        .string()
        .optional()
        .describe("Only reindex documents created on or before this ISO-8601 date"),
      batchSize: z
        .number()
        .min(1)
        .max(500)
        .optional()
        .describe("Chunks per embedding batch (default: 50)"),
    },
    withErrorHandling(async (params) => {
      const { reindex } = await import("../core/reindex.js");

      const result = await reindex(db, provider, {
        documentIds: params.documentIds,
        since: params.since,
        before: params.before,
        batchSize: params.batchSize,
      });

      const text =
        `Reindex complete.\n` +
        `Total chunks: ${result.total}\n` +
        `Updated: ${result.completed}\n` +
        `Failed: ${result.failed}` +
        (result.failedChunkIds.length > 0
          ? `\nFailed chunk IDs: ${result.failedChunkIds.join(", ")}`
          : "");

      return { content: [{ type: "text" as const, text }] };
    }),
  );

  // Tool: sync-slack
  server.tool(
    "sync-slack",
    "Sync Slack channel messages and threads into the knowledge base",
    {
      token: z.string().describe("Slack bot token (xoxb-...) or user token (xoxp-...)"),
      channels: z
        .array(z.string())
        .describe("Channel names or IDs to sync, or ['all'] for all channels"),
      excludeChannels: z
        .array(z.string())
        .optional()
        .describe("Channel names to exclude from sync"),
      threadMode: z
        .enum(["aggregate", "separate"])
        .optional()
        .describe(
          "Thread handling: aggregate (default) combines thread into one doc, separate creates one doc per reply",
        ),
    },
    withErrorHandling(async (params) => {
      const { syncSlack: doSyncSlack } = await import("../connectors/slack.js");

      const slackConfig = {
        token: params.token,
        channels: params.channels,
        excludeChannels: params.excludeChannels,
        threadMode: params.threadMode ?? ("aggregate" as const),
      };

      const result = await doSyncSlack(db, provider, slackConfig);

      const text =
        `Slack sync complete.\n` +
        `Channels: ${result.channels}\n` +
        `Messages indexed: ${result.messagesIndexed}\n` +
        `Threads indexed: ${result.threadsIndexed}` +
        (result.errors.length > 0
          ? `\nErrors:\n${result.errors.map((e) => `  #${e.channel}: ${e.error}`).join("\n")}`
          : "");

      return { content: [{ type: "text" as const, text }] };
    }),
  );

  // Tool: install-pack
  server.tool(
    "install-pack",
    "Install a knowledge pack from the registry or a local file path",
    {
      nameOrPath: z.string().describe("Pack name (from registry) or local .json file path"),
      registryUrl: z.string().optional().describe("Custom registry URL"),
    },
    withErrorHandling(async (params) => {
      const { installPack } = await import("../core/packs.js");
      const result = await installPack(db, provider, params.nameOrPath, {
        registryUrl: params.registryUrl,
      });

      if (result.alreadyInstalled) {
        return {
          content: [
            { type: "text" as const, text: `Pack "${result.packName}" is already installed.` },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Pack "${result.packName}" installed successfully (${result.documentsInstalled} documents).`,
          },
        ],
      };
    }),
  );

  // Tool: list-packs
  server.tool(
    "list-packs",
    "List installed knowledge packs or available packs from the registry",
    {
      available: z
        .boolean()
        .optional()
        .describe("If true, list available packs from registry instead of installed packs"),
      registryUrl: z.string().optional().describe("Custom registry URL"),
    },
    withErrorHandling(async (params) => {
      if (params.available) {
        const { listAvailablePacks } = await import("../core/packs.js");
        const packs = await listAvailablePacks(params.registryUrl);
        if (packs.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No packs available in the registry." }],
          };
        }
        const text = packs
          .map((p) => `- **${p.name}** v${p.version} — ${p.description} (${p.docCount} docs)`)
          .join("\n");
        return { content: [{ type: "text" as const, text: `## Available Packs\n\n${text}` }] };
      }

      const { listInstalledPacks } = await import("../core/packs.js");
      const packs = listInstalledPacks(db);
      if (packs.length === 0) {
        return { content: [{ type: "text" as const, text: "No packs installed." }] };
      }
      const text = packs
        .map(
          (p) =>
            `- **${p.name}** v${p.version} — ${p.description ?? ""} (${p.docCount} docs, installed ${p.installedAt})`,
        )
        .join("\n");
      return { content: [{ type: "text" as const, text: `## Installed Packs\n\n${text}` }] };
    }),
  );

  // Tool: sync-onenote
  server.tool(
    "sync-onenote",
    "Sync OneNote notebooks via Microsoft Graph API",
    {
      accessToken: z.string().describe("Microsoft Graph API access token"),
      notebookName: z.string().optional().describe("Specific notebook name to sync (default: all)"),
    },
    withErrorHandling(async (params) => {
      const { syncOneNote } = await import("../connectors/onenote.js");

      const result = await syncOneNote(db, provider, {
        clientId: "",
        tenantId: "common",
        accessToken: params.accessToken,
        notebooks: params.notebookName ? [params.notebookName] : ["all"],
        excludeSections: [],
      });

      const text =
        `OneNote sync complete.\n` +
        `Notebooks: ${result.notebooks}\n` +
        `Sections: ${result.sections}\n` +
        `Pages added: ${result.pagesAdded}\n` +
        `Pages updated: ${result.pagesUpdated}\n` +
        `Pages deleted: ${result.pagesDeleted}` +
        (result.errors.length > 0
          ? `\nErrors: ${result.errors.map((e) => `${e.page}: ${e.error}`).join("; ")}`
          : "");

      return { content: [{ type: "text" as const, text }] };
    }),
  );

  // Tool: sync-notion
  server.tool(
    "sync-notion",
    "Sync pages and databases from a connected Notion workspace into the knowledge base",
    {
      token: z.string().describe("Notion integration token (secret_... or ntn_...)"),
      lastSync: z
        .string()
        .optional()
        .describe("ISO-8601 timestamp — only sync pages edited after this time"),
      excludePages: z
        .array(z.string())
        .optional()
        .describe("List of Notion page/database IDs to exclude from sync"),
    },
    withErrorHandling(async (params) => {
      const { syncNotion } = await import("../connectors/notion.js");
      const result = await syncNotion(db, provider, {
        token: params.token,
        lastSync: params.lastSync,
        excludePages: params.excludePages,
      });

      const text =
        `Notion sync complete.\n` +
        `Pages indexed: ${result.pagesIndexed}\n` +
        `Databases indexed: ${result.databasesIndexed}` +
        (result.errors.length > 0
          ? `\nErrors: ${result.errors.map((e) => `${e.page}: ${e.error}`).join("; ")}`
          : "");

      return { content: [{ type: "text" as const, text }] };
    }),
  );

  // Tool: sync-obsidian-vault
  server.tool(
    "sync-obsidian-vault",
    "Sync an Obsidian vault into the knowledge base. Parses wikilinks, frontmatter, embeds, and tags with incremental sync support.",
    {
      vaultPath: z.string().describe("Absolute path to the Obsidian vault directory"),
    },
    withErrorHandling(async (params) => {
      const { syncObsidianVault } = await import("../connectors/obsidian.js");

      const result = await syncObsidianVault(db, provider, {
        vaultPath: params.vaultPath,
        topicMapping: "folder",
        excludePatterns: [],
      });

      const text =
        `Obsidian vault sync complete.\n` +
        `Added: ${result.added}\n` +
        `Updated: ${result.updated}\n` +
        `Deleted: ${result.deleted}` +
        (result.errors.length > 0
          ? `\nErrors: ${result.errors.map((e) => `${e.file}: ${e.error}`).join(", ")}`
          : "");

      return { content: [{ type: "text" as const, text }] };
    }),
  );

  // Tool: sync-confluence
  server.tool(
    "sync-confluence",
    "Sync Confluence spaces and pages into the knowledge base",
    {
      baseUrl: z.string().describe("Confluence base URL (e.g. https://acme.atlassian.net)"),
      email: z.string().describe("Confluence user email"),
      token: z.string().describe("API token or PAT"),
      spaces: z
        .array(z.string())
        .optional()
        .describe("Space keys to sync, or ['all'] (default: ['all'])"),
      excludeSpaces: z.array(z.string()).optional().describe("Space keys to exclude"),
    },
    withErrorHandling(async (params) => {
      const { syncConfluence } = await import("../connectors/confluence.js");
      const result = await syncConfluence(db, provider, {
        baseUrl: params.baseUrl,
        email: params.email,
        token: params.token,
        spaces: params.spaces ?? ["all"],
        excludeSpaces: params.excludeSpaces,
      });

      const text =
        `Confluence sync complete.\n` +
        `Spaces: ${result.spaces}\n` +
        `Pages indexed: ${result.pagesIndexed}\n` +
        `Pages updated: ${result.pagesUpdated}` +
        (result.errors.length > 0
          ? `\nErrors: ${result.errors.map((e) => `${e.page}: ${e.error}`).join(", ")}`
          : "");

      return { content: [{ type: "text" as const, text }] };
    }),
  );

  // Tool: search-analytics
  server.tool(
    "search-analytics",
    "View search analytics dashboard and knowledge gap detection",
    {
      days: z.number().optional().describe("Look-back period in days (default: 30)"),
    },
    withErrorHandling(async (params) => {
      const { getSearchAnalytics, getKnowledgeGaps } = await import("../core/analytics.js");
      const days = params.days ?? 30;
      const analytics = getSearchAnalytics(db, days);
      const gaps = getKnowledgeGaps(db, days);

      const lines: string[] = [
        `Search Analytics (last ${days} days)`,
        `Total searches: ${analytics.totalSearches}`,
        `Avg result count: ${analytics.avgResultCount}`,
        "",
        "Top queries:",
        ...analytics.topQueries.map((q) => `  ${q.count}x  ${q.query}`),
        "",
        "Zero-result queries:",
        ...analytics.zeroResultQueries.map((q) => `  ${q.count}x  ${q.query}`),
        "",
        "Knowledge gaps:",
        ...gaps.map((g) => `  ${g.count}x  ${g.query} (last: ${g.lastSearched})`),
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error("Fatal error starting LibScope MCP server:", err);
  process.exit(1);
});
