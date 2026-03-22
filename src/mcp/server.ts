import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { getDatabase, runMigrations, createVectorTable } from "../db/index.js";
import { getActiveWorkspace, getWorkspacePath } from "../core/workspace.js";
import { createEmbeddingProvider } from "../providers/index.js";
import { searchDocuments, getRelatedChunks } from "../core/search.js";
import {
  askQuestion,
  createLlmProvider,
  getContextForQuestion,
  isPassthroughMode,
  type LlmProvider,
} from "../core/rag.js";
import { getDocument, listDocuments, deleteDocument, updateDocument } from "../core/documents.js";
import { rateDocument, getDocumentRatings } from "../core/ratings.js";
import { indexDocument } from "../core/indexing.js";
import { listTopics } from "../core/topics.js";
import { createLink, getDocumentLinks, deleteLink } from "../core/links.js";
import type { LinkType } from "../core/links.js";
import {
  createSavedSearch,
  listSavedSearches,
  runSavedSearch,
  deleteSavedSearch,
} from "../core/saved-searches.js";
import { createWebhook, listWebhooks, deleteWebhook, redactWebhook } from "../core/webhooks.js";
import type { WebhookEvent } from "../core/webhooks.js";
import { suggestTags } from "../core/tags.js";
import { fetchAndConvert } from "../core/url-fetcher.js";
import { spiderUrl } from "../core/spider.js";
import type { SpiderOptions } from "../core/spider.js";
import { initLogger, getLogger } from "../logger.js";
import { ConfigError, ValidationError } from "../errors.js";
import { errorResponse, withErrorHandling } from "./errors.js";
export { errorResponse, withErrorHandling, type ToolResult } from "./errors.js";
import { taskRegistry } from "./tasks.js";
import type { TaskType } from "./tasks.js";

/** Build SpiderOptions from submit-document params. */
function buildSpiderOptions(
  params: {
    maxPages?: number | undefined;
    maxDepth?: number | undefined;
    sameDomain?: boolean | undefined;
    pathPrefix?: string | undefined;
    excludePatterns?: string[] | undefined;
  },
  fetchOptions: { allowPrivateUrls: boolean; allowSelfSignedCerts: boolean },
): SpiderOptions {
  const opts: SpiderOptions = { fetchOptions };
  if (params.maxPages !== undefined) opts.maxPages = params.maxPages;
  if (params.maxDepth !== undefined) opts.maxDepth = params.maxDepth;
  if (params.sameDomain !== undefined) opts.sameDomain = params.sameDomain;
  if (params.pathPrefix !== undefined) opts.pathPrefix = params.pathPrefix;
  if (params.excludePatterns !== undefined) opts.excludePatterns = params.excludePatterns;
  return opts;
}

/** Handle spider mode for submit-document. */
async function handleSpiderSubmit(
  db: import("better-sqlite3").Database,
  provider: import("../providers/embedding.js").EmbeddingProvider,
  params: {
    url?: string | undefined;
    library?: string | undefined;
    version?: string | undefined;
    topic?: string | undefined;
    sourceType?: "library" | "topic" | "manual" | "model-generated" | undefined;
    maxPages?: number | undefined;
    maxDepth?: number | undefined;
    sameDomain?: boolean | undefined;
    pathPrefix?: string | undefined;
    excludePatterns?: string[] | undefined;
  },
  fetchOptions: { allowPrivateUrls: boolean; allowSelfSignedCerts: boolean },
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { url, library, version, topic } = params;
  if (!url) {
    throw new ValidationError("Field 'url' is required when spider is true");
  }

  const spiderOptions = buildSpiderOptions(params, fetchOptions);
  const indexed: Array<{ id: string; title: string }> = [];
  const errors: Array<{ url: string; error: string }> = [];
  const sourceType = params.sourceType ?? (library ? "library" : "manual");

  const gen = spiderUrl(url, spiderOptions);
  let result = await gen.next();
  while (!result.done) {
    const page = result.value;
    try {
      const doc = await indexDocument(db, provider, {
        title: page.title,
        content: page.content,
        sourceType,
        library,
        version,
        topicId: topic,
        url: page.url,
        submittedBy: "model",
      });
      indexed.push({ id: doc.id, title: page.title });
    } catch (err) {
      errors.push({ url: page.url, error: err instanceof Error ? err.message : String(err) });
    }
    result = await gen.next();
  }
  const stats = result.value;

  const summary = [
    `Spider complete.`,
    `Pages indexed: ${indexed.length}`,
    `Pages crawled: ${stats?.pagesCrawled ?? indexed.length}`,
    `Pages skipped: ${stats?.pagesSkipped ?? 0}`,
    errors.length > 0 ? `Errors: ${errors.length}` : null,
    stats?.abortReason ? `Stopped early: ${stats.abortReason}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return { content: [{ type: "text" as const, text: summary }] };
}

/** Handle single-document submission for submit-document. */
async function handleSingleDocSubmit(
  db: import("better-sqlite3").Database,
  provider: import("../providers/embedding.js").EmbeddingProvider,
  params: {
    title?: string | undefined;
    content?: string | undefined;
    url?: string | undefined;
    library?: string | undefined;
    version?: string | undefined;
    topic?: string | undefined;
    sourceType?: "library" | "topic" | "manual" | "model-generated" | undefined;
  },
  fetchOptions: { allowPrivateUrls: boolean; allowSelfSignedCerts: boolean },
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  let { title, content } = params;
  const { url, library, version, topic } = params;

  if (url && !content) {
    const fetched = await fetchAndConvert(url, fetchOptions);
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
}

/** Fire-and-forget helper: creates a task, runs `work` in background, returns task ID response. */
function startAsyncTask(
  type: TaskType,
  work: () => Promise<string>,
): { content: Array<{ type: "text"; text: string }> } {
  const { task, signal } = taskRegistry.create(type);
  taskRegistry.update(task.id, { status: "running", startedAt: new Date() });
  void work().then(
    (result) => {
      if (signal.aborted) {
        taskRegistry.update(task.id, { status: "cancelled", completedAt: new Date() });
      } else {
        taskRegistry.update(task.id, { status: "completed", completedAt: new Date(), result });
      }
    },
    (err: unknown) => {
      if (signal.aborted) {
        taskRegistry.update(task.id, { status: "cancelled", completedAt: new Date() });
      } else {
        taskRegistry.update(task.id, {
          status: "failed",
          completedAt: new Date(),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
  return {
    content: [
      { type: "text" as const, text: `Task queued. ID: ${task.id}\nUse get-task to check status.` },
    ],
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
  } catch (err) {
    getLogger().warn({ err }, "LLM provider unavailable — ask-question tool will not work");
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
      source: z
        .string()
        .optional()
        .describe("Filter by source type (e.g., 'library', 'topic', 'manual', 'model-generated')"),
      minRating: z.number().min(1).max(5).optional().describe("Minimum average rating filter"),
      offset: z.number().min(0).optional().describe("Offset for pagination (default: 0)"),
      limit: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe("Maximum results to return (default: 10)"),
      maxChunksPerDocument: z
        .number()
        .min(0)
        .max(50)
        .optional()
        .describe(
          "Maximum chunks per document in results (default: no limit, set to 2 for diversity)",
        ),
      contextChunks: z
        .number()
        .min(0)
        .max(2)
        .optional()
        .describe(
          "Number of neighboring chunks to include before/after each result for context (0-2, default: 0)",
        ),
    },
    withErrorHandling(async (params) => {
      const { results, totalCount } = await searchDocuments(db, provider, {
        query: params.query,
        topic: params.topic,
        library: params.library,
        version: params.version,
        source: params.source,
        minRating: params.minRating,
        limit: params.limit,
        offset: params.offset,
        maxChunksPerDocument: params.maxChunksPerDocument,
        contextChunks: params.contextChunks,
      });

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No documents found matching your query." }],
        };
      }

      const text =
        `**Total results: ${totalCount}**\n\n` +
        results
          .map((r, i) => {
            const libraryVersion = r.version ? ` v${r.version}` : "";
            let entry =
              `## Result ${i + 1}: ${r.title} (score: ${r.score.toFixed(2)})\n` +
              (r.library ? `**Library:** ${r.library}${libraryVersion}\n` : "") +
              (r.url ? `**Source:** ${r.url}\n` : "") +
              (r.avgRating ? `**Rating:** ${r.avgRating.toFixed(1)}/5\n` : "");

            if (r.contextBefore && r.contextBefore.length > 0) {
              entry += `\n**Context (before):**\n${r.contextBefore.map((c) => c.content).join("\n\n")}\n`;
            }

            entry += `\n${r.content}\n`;

            if (r.contextAfter && r.contextAfter.length > 0) {
              entry += `\n**Context (after):**\n${r.contextAfter.map((c) => c.content).join("\n\n")}\n`;
            }

            return entry;
          })
          .join("\n---\n\n");

      return { content: [{ type: "text" as const, text }] };
    }),
  );

  // Tool: get-related
  server.tool(
    "get-related",
    "Find chunks semantically similar to a given chunk (more-like-this). Returns related content seeded from an existing chunk's stored embedding without requiring a text query.",
    {
      chunkId: z.string().describe("ID of the source chunk to find related content for"),
      limit: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe("Number of results to return (default 10)"),
      topic: z.string().optional().describe("Filter results to a specific topic"),
      library: z.string().optional().describe("Filter results to a specific library"),
      tags: z.array(z.string()).optional().describe("Filter results to documents with these tags"),
      minScore: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Minimum similarity score threshold (0-1)"),
      includeLinkedDocuments: z
        .boolean()
        .optional()
        .describe("Also include explicitly linked documents even if below similarity threshold"),
    },
    withErrorHandling(
      ({ chunkId, limit, topic, library, tags, minScore, includeLinkedDocuments }) => {
        const result = getRelatedChunks(db, {
          chunkId,
          ...(limit !== undefined && { limit }),
          ...(topic !== undefined && { topic }),
          ...(library !== undefined && { library }),
          ...(tags !== undefined && { tags }),
          ...(minScore !== undefined && { minScore }),
          ...(includeLinkedDocuments !== undefined && { includeLinkedDocuments }),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    ),
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

      const docVersion = doc.version ? ` v${doc.version}` : "";
      const text =
        `# ${doc.title}\n\n` +
        `**Type:** ${doc.sourceType}\n` +
        (doc.library ? `**Library:** ${doc.library}${docVersion}\n` : "") +
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

  // Tool: update-document
  server.tool(
    "update-document",
    "Update an existing document's title, content, or metadata",
    {
      documentId: z.string().describe("The document ID to update"),
      title: z.string().optional().describe("New title"),
      content: z.string().optional().describe("New content (will re-chunk and re-index)"),
      library: z.string().nullable().optional().describe("New library name (null to clear)"),
      version: z.string().nullable().optional().describe("New version (null to clear)"),
      url: z.string().nullable().optional().describe("New URL (null to clear)"),
      topicId: z.string().nullable().optional().describe("New topic ID (null to clear)"),
    },
    withErrorHandling(async (params) => {
      const metadata: Record<string, string | null | undefined> = {};
      if (params.library !== undefined) metadata.library = params.library;
      if (params.version !== undefined) metadata.version = params.version;
      if (params.url !== undefined) metadata.url = params.url;
      if (params.topicId !== undefined) metadata.topicId = params.topicId;

      const doc = await updateDocument(db, provider, params.documentId, {
        title: params.title,
        content: params.content,
        metadata:
          Object.keys(metadata).length > 0
            ? (metadata as {
                library?: string | null;
                version?: string | null;
                url?: string | null;
                topicId?: string | null;
              })
            : undefined,
      });
      return {
        content: [{ type: "text" as const, text: `Document updated: ${doc.title} (${doc.id})` }],
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
    "Submit a new document for indexing into the knowledge base. You can provide content directly, or provide a URL to fetch and index automatically. Set spider=true to crawl linked pages from the URL.",
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
      spider: z
        .boolean()
        .optional()
        .describe("When true, crawl pages linked from the URL. Requires 'url'. Default: false."),
      maxPages: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum pages to index during a spider run (default: 25, hard cap: 200)."),
      maxDepth: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Maximum link-hop depth from the seed URL (default: 2, hard cap: 5). 0 = seed only.",
        ),
      sameDomain: z
        .boolean()
        .optional()
        .describe("Only follow links on the same domain as the seed URL (default: true)."),
      pathPrefix: z
        .string()
        .optional()
        .describe("Only follow links whose path starts with this prefix (e.g. '/docs/')."),
      excludePatterns: z
        .array(z.string())
        .optional()
        .describe("Glob patterns for URLs to skip (e.g. ['*/changelog*', '*/api/v1/*'])."),
      async: z
        .boolean()
        .optional()
        .describe(
          "When true, start indexing in the background and return a task ID immediately. Use get-task to poll for completion.",
        ),
    },
    withErrorHandling(async (params) => {
      const fetchOptions = {
        allowPrivateUrls: config.indexing.allowPrivateUrls,
        allowSelfSignedCerts: config.indexing.allowSelfSignedCerts,
      };

      if (params.async) {
        return startAsyncTask("index_document", async () => {
          if (params.spider) {
            const r = await handleSpiderSubmit(db, provider, params, fetchOptions);
            return r.content[0]?.text ?? "Done";
          }
          const r = await handleSingleDocSubmit(db, provider, params, fetchOptions);
          return r.content[0]?.text ?? "Done";
        });
      }

      if (params.spider) {
        return handleSpiderSubmit(db, provider, params, fetchOptions);
      }

      return handleSingleDocSubmit(db, provider, params, fetchOptions);
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
        .map((t) => {
          const topicDesc = t.description ? `: ${t.description}` : "";
          return `- **${t.name}** (\`${t.id}\`)${topicDesc}`;
        })
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
        } catch (err: unknown) {
          health.database = "error";
          getLogger().warn({ err }, "Health check: database connectivity failed");
        }

        // Document count
        try {
          const row = db.prepare("SELECT COUNT(*) as count FROM documents").get() as {
            count: number;
          };
          health.documents = row.count;
        } catch (err: unknown) {
          health.documents = "error";
          getLogger().warn({ err }, "Health check: document count query failed");
        }

        // Chunk count
        try {
          const row = db.prepare("SELECT COUNT(*) as count FROM chunks").get() as {
            count: number;
          };
          health.chunks = row.count;
        } catch (err: unknown) {
          health.chunks = "error";
          getLogger().warn({ err }, "Health check: chunk count query failed");
        }

        // FTS5 index status
        try {
          db.prepare("SELECT COUNT(*) FROM chunks_fts").get();
          health.fts5 = "ok";
        } catch (err: unknown) {
          health.fts5 = "error";
          getLogger().warn({ err }, "Health check: FTS5 index query failed");
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
        .map((d) => {
          const docLibVersion = d.version ? ` v${d.version}` : "";
          return (
            `- **${d.title}** (\`${d.id}\`)` +
            (d.library ? ` — ${d.library}${docLibVersion}` : "") +
            (d.url ? ` — [source](${d.url})` : "") +
            ` (${d.sourceType})`
          );
        })
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
      if (isPassthroughMode(config)) {
        const { contextPrompt, sources } = await getContextForQuestion(db, provider, {
          question: params.question,
          topK: params.topK,
          topic: params.topic,
          library: params.library,
        });

        const sourcesText =
          sources.length > 0
            ? "\n\n**Sources:**\n" +
              sources
                .map((s) => `- ${s.title} (score: ${s.score.toFixed(2)}) [${s.documentId}]`)
                .join("\n")
            : "";

        return {
          content: [{ type: "text" as const, text: contextPrompt + sourcesText }],
        };
      }

      if (!llmProvider) {
        throw new ConfigError(
          "No LLM provider configured. Set llm.provider to 'openai', 'ollama', or 'passthrough' in your config.",
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
      async: z
        .boolean()
        .optional()
        .describe(
          "When true, run reindexing in the background and return a task ID immediately. Use get-task to poll for completion.",
        ),
    },
    withErrorHandling(async (params) => {
      const { reindex } = await import("../core/reindex.js");

      if (params.async) {
        const { task, signal } = taskRegistry.create("reindex_library");
        taskRegistry.update(task.id, { status: "running", startedAt: new Date() });

        void reindex(db, provider, {
          documentIds: params.documentIds,
          since: params.since,
          before: params.before,
          batchSize: params.batchSize,
          onProgress: (p) => {
            if (signal.aborted) throw new Error("Task cancelled");
            taskRegistry.update(task.id, { progress: { current: p.completed, total: p.total } });
          },
        }).then(
          (result) => {
            const text =
              `Reindex complete.\n` +
              `Total chunks: ${result.total}\n` +
              `Updated: ${result.completed}\n` +
              `Failed: ${result.failed}` +
              (result.failedChunkIds.length > 0
                ? `\nFailed chunk IDs: ${result.failedChunkIds.join(", ")}`
                : "");
            if (signal.aborted) {
              taskRegistry.update(task.id, { status: "cancelled", completedAt: new Date() });
            } else {
              taskRegistry.update(task.id, {
                status: "completed",
                completedAt: new Date(),
                result: text,
              });
            }
          },
          (err: unknown) => {
            if (signal.aborted) {
              taskRegistry.update(task.id, { status: "cancelled", completedAt: new Date() });
            } else {
              taskRegistry.update(task.id, {
                status: "failed",
                completedAt: new Date(),
                error: err instanceof Error ? err.message : String(err),
              });
            }
          },
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `Task queued. ID: ${task.id}\nUse get-task to check status.`,
            },
          ],
        };
      }

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
      async: z
        .boolean()
        .optional()
        .describe(
          "When true, run the sync in the background and return a task ID immediately. Use get-task to poll for completion.",
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

      if (params.async) {
        return startAsyncTask("sync_connector", async () => {
          const result = await doSyncSlack(db, provider, slackConfig);
          const slackErrorLines = result.errors
            .map((e) => `  #${e.channel}: ${e.error}`)
            .join("\n");
          const slackErrors = result.errors.length > 0 ? `\nErrors:\n${slackErrorLines}` : "";
          return (
            `Slack sync complete.\n` +
            `Channels: ${result.channels}\n` +
            `Messages indexed: ${result.messagesIndexed}\n` +
            `Threads indexed: ${result.threadsIndexed}` +
            slackErrors
          );
        });
      }

      const result = await doSyncSlack(db, provider, slackConfig);

      const slackErrorLines = result.errors.map((e) => `  #${e.channel}: ${e.error}`).join("\n");
      const slackErrors = result.errors.length > 0 ? `\nErrors:\n${slackErrorLines}` : "";
      const text =
        `Slack sync complete.\n` +
        `Channels: ${result.channels}\n` +
        `Messages indexed: ${result.messagesIndexed}\n` +
        `Threads indexed: ${result.threadsIndexed}` +
        slackErrors;

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
      async: z
        .boolean()
        .optional()
        .describe(
          "When true, run installation in the background and return a task ID immediately. Use get-task to poll for completion.",
        ),
    },
    withErrorHandling(async (params) => {
      const { installPack } = await import("../core/packs.js");

      if (params.async) {
        const { task, signal } = taskRegistry.create("install_pack");
        taskRegistry.update(task.id, { status: "running", startedAt: new Date() });

        void installPack(db, provider, params.nameOrPath, {
          registryUrl: params.registryUrl,
          onProgress: (current, total) => {
            if (signal.aborted) throw new Error("Task cancelled");
            taskRegistry.update(task.id, { progress: { current, total } });
          },
        }).then(
          (result) => {
            const text = result.alreadyInstalled
              ? `Pack "${result.packName}" is already installed.`
              : `Pack "${result.packName}" installed successfully (${result.documentsInstalled} documents).`;
            if (signal.aborted) {
              taskRegistry.update(task.id, { status: "cancelled", completedAt: new Date() });
            } else {
              taskRegistry.update(task.id, {
                status: "completed",
                completedAt: new Date(),
                result: text,
              });
            }
          },
          (err: unknown) => {
            if (signal.aborted) {
              taskRegistry.update(task.id, { status: "cancelled", completedAt: new Date() });
            } else {
              taskRegistry.update(task.id, {
                status: "failed",
                completedAt: new Date(),
                error: err instanceof Error ? err.message : String(err),
              });
            }
          },
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `Task queued. ID: ${task.id}\nUse get-task to check status.`,
            },
          ],
        };
      }

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
      async: z
        .boolean()
        .optional()
        .describe(
          "When true, run the sync in the background and return a task ID immediately. Use get-task to poll for completion.",
        ),
    },
    withErrorHandling(async (params) => {
      const { syncOneNote } = await import("../connectors/onenote.js");

      const oneNoteConfig = {
        clientId: "",
        tenantId: "common",
        accessToken: params.accessToken,
        notebooks: params.notebookName ? [params.notebookName] : ["all"],
        excludeSections: [] as string[],
      };

      if (params.async) {
        return startAsyncTask("sync_connector", async () => {
          const result = await syncOneNote(db, provider, oneNoteConfig);
          const oneNoteErrorLines = result.errors.map((e) => `${e.page}: ${e.error}`).join("; ");
          const oneNoteErrors = result.errors.length > 0 ? `\nErrors: ${oneNoteErrorLines}` : "";
          return (
            `OneNote sync complete.\n` +
            `Notebooks: ${result.notebooks}\n` +
            `Sections: ${result.sections}\n` +
            `Pages added: ${result.pagesAdded}\n` +
            `Pages updated: ${result.pagesUpdated}\n` +
            `Pages deleted: ${result.pagesDeleted}` +
            oneNoteErrors
          );
        });
      }

      const result = await syncOneNote(db, provider, oneNoteConfig);

      const oneNoteErrorLines = result.errors.map((e) => `${e.page}: ${e.error}`).join("; ");
      const oneNoteErrors = result.errors.length > 0 ? `\nErrors: ${oneNoteErrorLines}` : "";
      const text =
        `OneNote sync complete.\n` +
        `Notebooks: ${result.notebooks}\n` +
        `Sections: ${result.sections}\n` +
        `Pages added: ${result.pagesAdded}\n` +
        `Pages updated: ${result.pagesUpdated}\n` +
        `Pages deleted: ${result.pagesDeleted}` +
        oneNoteErrors;

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
      async: z
        .boolean()
        .optional()
        .describe(
          "When true, run the sync in the background and return a task ID immediately. Use get-task to poll for completion.",
        ),
    },
    withErrorHandling(async (params) => {
      const { syncNotion } = await import("../connectors/notion.js");

      const notionConfig = {
        token: params.token,
        lastSync: params.lastSync,
        excludePages: params.excludePages,
      };

      if (params.async) {
        return startAsyncTask("sync_connector", async () => {
          const result = await syncNotion(db, provider, notionConfig);
          const notionErrorLines = result.errors.map((e) => `${e.page}: ${e.error}`).join("; ");
          const notionErrors = result.errors.length > 0 ? `\nErrors: ${notionErrorLines}` : "";
          return (
            `Notion sync complete.\n` +
            `Pages indexed: ${result.pagesIndexed}\n` +
            `Databases indexed: ${result.databasesIndexed}` +
            notionErrors
          );
        });
      }

      const result = await syncNotion(db, provider, notionConfig);

      const notionErrorLines = result.errors.map((e) => `${e.page}: ${e.error}`).join("; ");
      const notionErrors = result.errors.length > 0 ? `\nErrors: ${notionErrorLines}` : "";
      const text =
        `Notion sync complete.\n` +
        `Pages indexed: ${result.pagesIndexed}\n` +
        `Databases indexed: ${result.databasesIndexed}` +
        notionErrors;

      return { content: [{ type: "text" as const, text }] };
    }),
  );

  // Tool: sync-obsidian-vault
  server.tool(
    "sync-obsidian-vault",
    "Sync an Obsidian vault into the knowledge base. Parses wikilinks, frontmatter, embeds, and tags with incremental sync support.",
    {
      vaultPath: z.string().describe("Absolute path to the Obsidian vault directory"),
      async: z
        .boolean()
        .optional()
        .describe(
          "When true, run the sync in the background and return a task ID immediately. Use get-task to poll for completion.",
        ),
    },
    withErrorHandling(async (params) => {
      const { syncObsidianVault } = await import("../connectors/obsidian.js");

      const obsidianConfig = {
        vaultPath: params.vaultPath,
        topicMapping: "folder" as const,
        excludePatterns: [] as string[],
      };

      if (params.async) {
        return startAsyncTask("sync_connector", async () => {
          const result = await syncObsidianVault(db, provider, obsidianConfig);
          const obsidianErrorLines = result.errors.map((e) => `${e.file}: ${e.error}`).join(", ");
          const obsidianErrors = result.errors.length > 0 ? `\nErrors: ${obsidianErrorLines}` : "";
          return (
            `Obsidian vault sync complete.\n` +
            `Added: ${result.added}\n` +
            `Updated: ${result.updated}\n` +
            `Deleted: ${result.deleted}` +
            obsidianErrors
          );
        });
      }

      const result = await syncObsidianVault(db, provider, obsidianConfig);

      const obsidianErrorLines = result.errors.map((e) => `${e.file}: ${e.error}`).join(", ");
      const obsidianErrors = result.errors.length > 0 ? `\nErrors: ${obsidianErrorLines}` : "";
      const text =
        `Obsidian vault sync complete.\n` +
        `Added: ${result.added}\n` +
        `Updated: ${result.updated}\n` +
        `Deleted: ${result.deleted}` +
        obsidianErrors;

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
      async: z
        .boolean()
        .optional()
        .describe(
          "When true, run the sync in the background and return a task ID immediately. Use get-task to poll for completion.",
        ),
    },
    withErrorHandling(async (params) => {
      const { syncConfluence } = await import("../connectors/confluence.js");

      const confluenceConfig = {
        baseUrl: params.baseUrl,
        email: params.email,
        token: params.token,
        spaces: params.spaces ?? ["all"],
        excludeSpaces: params.excludeSpaces,
      };

      if (params.async) {
        return startAsyncTask("sync_connector", async () => {
          const result = await syncConfluence(db, provider, confluenceConfig);
          const confluenceErrorLines = result.errors.map((e) => `${e.page}: ${e.error}`).join(", ");
          const confluenceErrors =
            result.errors.length > 0 ? `\nErrors: ${confluenceErrorLines}` : "";
          return (
            `Confluence sync complete.\n` +
            `Spaces: ${result.spaces}\n` +
            `Pages indexed: ${result.pagesIndexed}\n` +
            `Pages updated: ${result.pagesUpdated}` +
            confluenceErrors
          );
        });
      }

      const result = await syncConfluence(db, provider, confluenceConfig);

      const confluenceErrorLines = result.errors.map((e) => `${e.page}: ${e.error}`).join(", ");
      const confluenceErrors = result.errors.length > 0 ? `\nErrors: ${confluenceErrorLines}` : "";
      const text =
        `Confluence sync complete.\n` +
        `Spaces: ${result.spaces}\n` +
        `Pages indexed: ${result.pagesIndexed}\n` +
        `Pages updated: ${result.pagesUpdated}` +
        confluenceErrors;

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

  // Tool: link-documents
  server.tool(
    "link-documents",
    "Create a relationship between two documents (see_also, prerequisite, supersedes, related)",
    {
      sourceId: z.string().describe("The source document ID"),
      targetId: z.string().describe("The target document ID"),
      linkType: z
        .enum(["see_also", "prerequisite", "supersedes", "related"])
        .describe("Type of relationship"),
      label: z.string().optional().describe("Optional human-readable description of the link"),
    },
    withErrorHandling((params) => {
      const link = createLink(
        db,
        params.sourceId,
        params.targetId,
        params.linkType as LinkType,
        params.label,
      );
      const linkLabel = link.label ? ` — ${link.label}` : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `✓ Link created: ${link.sourceId} → ${link.targetId} (${link.linkType})${linkLabel}`,
          },
        ],
      };
    }),
  );

  // Tool: get-document-links
  server.tool(
    "get-document-links",
    "Get all cross-reference links for a document (both outgoing and incoming)",
    {
      documentId: z.string().describe("The document ID"),
    },
    withErrorHandling((params) => {
      const { outgoing, incoming } = getDocumentLinks(db, params.documentId);
      if (outgoing.length === 0 && incoming.length === 0) {
        return { content: [{ type: "text" as const, text: "No links found for this document." }] };
      }

      const lines: string[] = [];
      if (outgoing.length > 0) {
        lines.push("**Outgoing links:**");
        for (const l of outgoing) {
          const outLabel = l.label ? ` — ${l.label}` : "";
          lines.push(`  → [${l.linkType}] ${l.targetTitle} (${l.targetId})${outLabel}`);
        }
      }
      if (incoming.length > 0) {
        lines.push("**Incoming links:**");
        for (const l of incoming) {
          const inLabel = l.label ? ` — ${l.label}` : "";
          lines.push(`  ← [${l.linkType}] ${l.sourceTitle} (${l.sourceId})${inLabel}`);
        }
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }),
  );

  // Tool: delete-link
  server.tool(
    "delete-link",
    "Remove a cross-reference link between documents",
    {
      linkId: z.string().describe("The link ID to delete"),
    },
    withErrorHandling((params) => {
      deleteLink(db, params.linkId);
      return { content: [{ type: "text" as const, text: `✓ Link ${params.linkId} deleted.` }] };
    }),
  );

  // Tool: save-search
  server.tool(
    "save-search",
    "Save a search query with optional filters for later re-use",
    {
      name: z.string().describe("A unique name for this saved search"),
      query: z.string().describe("The search query"),
      topic: z.string().optional().describe("Filter by topic ID"),
      library: z.string().optional().describe("Filter by library name"),
      version: z.string().optional().describe("Filter by library version"),
      source: z.string().optional().describe("Filter by source type"),
      minRating: z.number().min(1).max(5).optional().describe("Minimum average rating filter"),
      limit: z.number().min(1).max(50).optional().describe("Maximum results to return"),
      tags: z.array(z.string()).optional().describe("Filter by tags"),
    },
    withErrorHandling((params) => {
      const { name, query, ...rest } = params;
      const filters: Record<string, unknown> = {};
      if (rest.topic !== undefined) filters.topic = rest.topic;
      if (rest.library !== undefined) filters.library = rest.library;
      if (rest.version !== undefined) filters.version = rest.version;
      if (rest.source !== undefined) filters.source = rest.source;
      if (rest.minRating !== undefined) filters.minRating = rest.minRating;
      if (rest.limit !== undefined) filters.limit = rest.limit;
      if (rest.tags !== undefined) filters.tags = rest.tags;
      const saved = createSavedSearch(
        db,
        name,
        query,
        Object.keys(filters).length > 0 ? filters : undefined,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(saved, null, 2),
          },
        ],
      };
    }),
  );

  // Tool: suggest-tags
  server.tool(
    "suggest-tags",
    "Suggest tags for a document based on content analysis",
    {
      documentId: z.string().describe("Document ID"),
      maxSuggestions: z.number().min(1).max(20).optional().describe("Max suggestions (default: 5)"),
    },
    withErrorHandling((params) => {
      const suggestions = suggestTags(db, params.documentId, params.maxSuggestions);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ documentId: params.documentId, suggestions }, null, 2),
          },
        ],
      };
    }),
  );

  // Tool: list-saved-searches
  server.tool(
    "list-saved-searches",
    "List all saved searches",
    {},
    withErrorHandling(() => {
      const searches = listSavedSearches(db);
      return {
        content: [
          {
            type: "text" as const,
            text: searches.length === 0 ? "No saved searches." : JSON.stringify(searches, null, 2),
          },
        ],
      };
    }),
  );

  // Tool: run-saved-search
  server.tool(
    "run-saved-search",
    "Execute a saved search by name or ID and return results",
    {
      nameOrId: z.string().describe("The name or ID of the saved search to run"),
    },
    withErrorHandling(async (params) => {
      const { search, results } = await runSavedSearch(db, provider, params.nameOrId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ search, resultCount: results.length, results }, null, 2),
          },
        ],
      };
    }),
  );

  // Tool: delete-saved-search
  server.tool(
    "delete-saved-search",
    "Delete a saved search by name or ID",
    {
      nameOrId: z.string().describe("The name or ID of the saved search to delete"),
    },
    withErrorHandling((params) => {
      deleteSavedSearch(db, params.nameOrId);
      return {
        content: [{ type: "text" as const, text: `✓ Saved search "${params.nameOrId}" deleted.` }],
      };
    }),
  );

  // Tool: create-webhook
  server.tool(
    "create-webhook",
    "Register a webhook to receive notifications for document events",
    {
      url: z.string().describe("The URL to send webhook POST requests to (http:// or https://)"),
      events: z
        .array(z.string())
        .describe(
          "Event types to subscribe to: document.created, document.updated, document.deleted, document.rated, search.executed",
        ),
      secret: z
        .string()
        .optional()
        .describe("Optional secret for HMAC-SHA256 signature verification"),
    },
    withErrorHandling(async (params) => {
      const webhook = await createWebhook(
        db,
        params.url,
        params.events as WebhookEvent[],
        params.secret,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(redactWebhook(webhook), null, 2) }],
      };
    }),
  );

  // Tool: list-webhooks
  server.tool(
    "list-webhooks",
    "List all registered webhooks",
    {},
    withErrorHandling(() => {
      const webhooks = listWebhooks(db);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(webhooks.map(redactWebhook), null, 2) },
        ],
      };
    }),
  );

  // Tool: delete-webhook
  server.tool(
    "delete-webhook",
    "Remove a registered webhook by ID",
    {
      id: z.string().describe("The webhook ID to delete"),
    },
    withErrorHandling((params) => {
      deleteWebhook(db, params.id);
      return {
        content: [{ type: "text" as const, text: `✓ Webhook "${params.id}" deleted.` }],
      };
    }),
  );

  // Tool: get-task
  server.tool(
    "get-task",
    "Get the current status, progress, and result of an async background task",
    {
      taskId: z.string().describe("Task ID returned by an async operation"),
    },
    withErrorHandling((params) => {
      const task = taskRegistry.get(params.taskId);
      if (!task) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Task ${params.taskId} not found or has expired (tasks are kept for 1 hour after completion).`,
            },
          ],
        };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] };
    }),
  );

  // Tool: cancel-task
  server.tool(
    "cancel-task",
    "Request cancellation of a pending or running async background task",
    {
      taskId: z.string().describe("Task ID to cancel"),
    },
    withErrorHandling((params) => {
      const outcome = taskRegistry.cancel(params.taskId);
      if (outcome === "not_found") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Task ${params.taskId} not found or has expired.`,
            },
          ],
        };
      }
      if (outcome === "already_terminal") {
        const task = taskRegistry.get(params.taskId);
        const status = task?.status ?? "unknown";
        return {
          content: [
            {
              type: "text" as const,
              text: `Task ${params.taskId} cannot be cancelled (current status: ${status}).`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Cancellation requested for task ${params.taskId}. Running operations will stop at the next checkpoint.`,
          },
        ],
      };
    }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error("Fatal error starting LibScope MCP server:", err);
  process.exit(1);
});
