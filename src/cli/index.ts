#!/usr/bin/env node

import { Command } from "commander";
import { loadConfig, saveUserConfig } from "../config.js";
import { getDatabase, runMigrations, createVectorTable, closeDatabase } from "../db/index.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "../providers/index.js";
import { indexDocument, indexFile } from "../core/indexing.js";
import { getSupportedExtensions } from "../core/parsers/index.js";
import { searchDocuments } from "../core/search.js";
import { askQuestion, createLlmProvider } from "../core/rag.js";
import { getDocumentRatings, listRatings } from "../core/ratings.js";
import { createTopic, listTopics } from "../core/topics.js";
import { getDocument, listDocuments, deleteDocument, updateDocument } from "../core/documents.js";
import { createLink, getDocumentLinks, deleteLink, getPrerequisiteChain } from "../core/links.js";
import type { LinkType } from "../core/links.js";
import { getVersionHistory, rollbackToVersion } from "../core/versioning.js";
import { initLogger, type LogLevel } from "../logger.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { fetchAndConvert } from "../core/url-fetcher.js";
import { exportKnowledgeBase, importFromBackup } from "../core/export.js";
import { batchImport } from "../core/batch.js";
import { findDuplicates } from "../core/dedup.js";
import {
  getStats,
  getPopularDocuments,
  getStaleDocuments,
  getTopQueries,
  getSearchTrends,
  getSearchAnalytics,
  getKnowledgeGaps,
} from "../core/analytics.js";
import { startRepl } from "./repl.js";
import { confirmAction } from "./confirm.js";
import {
  addTagsToDocument,
  removeTagFromDocument,
  listTags,
  getDocumentTags,
  suggestTags,
} from "../core/tags.js";
import { bulkDelete, bulkRetag, bulkMove } from "../core/bulk.js";
import type { BulkSelector } from "../core/bulk.js";
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  getActiveWorkspace,
  setActiveWorkspace,
  getWorkspacePath,
} from "../core/workspace.js";
import {
  installPack,
  removePack,
  listInstalledPacks,
  listAvailablePacks,
  createPack,
} from "../core/packs.js";

import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { FileWatcher, DEFAULT_WATCH_EXTENSIONS } from "../core/watcher.js";
import { indexRepository, parseRepoUrl } from "../core/repo.js";
import {
  authenticateDeviceCode,
  refreshAccessToken,
  syncOneNote,
  disconnectOneNote,
} from "../connectors/onenote.js";
import { loadConnectorConfig, saveConnectorConfig } from "../connectors/index.js";
import { syncNotion, disconnectNotion } from "../connectors/notion.js";
import type { NotionConfig } from "../connectors/notion.js";
import { syncSlack, disconnectSlack, type SlackConfig } from "../connectors/slack.js";
import {
  saveNamedConnectorConfig,
  loadNamedConnectorConfig,
  hasNamedConnectorConfig,
} from "../connectors/index.js";
import {
  createSavedSearch,
  listSavedSearches,
  runSavedSearch,
  deleteSavedSearch,
} from "../core/saved-searches.js";
import {
  createWebhook,
  listWebhooks,
  deleteWebhook,
  getWebhook,
  buildPayload,
  signPayload,
} from "../core/webhooks.js";
import type { WebhookEvent } from "../core/webhooks.js";

// Graceful shutdown
const handleShutdown = (): void => {
  closeDatabase();
  process.exit(0);
};
process.on("SIGINT", handleShutdown);
process.on("SIGTERM", handleShutdown);

const _require = createRequire(import.meta.url);
const _pkg = _require("../../package.json") as { version: string };

/** Parse a CLI option string as an integer, exiting with an error if the value is not a valid number. */
function parseIntOption(value: string, name: string): number {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) {
    console.error(`Error: "${value}" is not a valid number for ${name}`);
    process.exit(1);
  }
  return n;
}

const program = new Command();

program
  .name("libscope")
  .description("AI-powered knowledge base with MCP integration")
  .version(_pkg.version)
  .option("--verbose", "Enable verbose logging")
  .option("--log-level <level>", "Set log level (debug, info, warn, error, silent)")
  .option("--workspace <name>", "Use a specific workspace");

// init
program
  .command("init")
  .description("Initialize the LibScope database")
  .action(() => {
    const { config, db } = initializeApp();
    try {
      // Only create vector table if provider can be initialized without download
      try {
        const provider = createEmbeddingProvider(config);
        createVectorTable(db, provider.dimensions);
      } catch {
        console.log("  ℹ Vector table skipped (embedding provider not available)");
      }
      console.log(`✓ Database initialized at ${config.database.path}`);
    } finally {
      closeDatabase();
    }
  });

// add
program
  .command("add <fileOrUrl>")
  .description(
    "Index a document from a file or URL (supports: " + getSupportedExtensions().join(", ") + ")",
  )
  .option("--topic <topicId>", "Assign to a topic")
  .option("--library <name>", "Mark as library documentation")
  .option("--version <version>", "Library version")
  .option("--title <title>", "Override document title")
  .option("--format <ext>", "Force file format (e.g. .pdf, .csv, .yaml)")
  .option("--dedup <mode>", "Dedup mode: skip, warn, or force")
  .action(
    async (
      fileOrUrl: string,
      opts: {
        topic?: string;
        library?: string;
        version?: string;
        title?: string;
        format?: string;
        dedup?: string;
      },
    ) => {
      const { config, db, provider } = initializeAppWithEmbedding();
      try {
        let result;

        if (fileOrUrl.startsWith("http://") || fileOrUrl.startsWith("https://")) {
          console.log(`Fetching ${fileOrUrl}...`);
          const fetched = await fetchAndConvert(fileOrUrl, {
            allowPrivateUrls: config.indexing.allowPrivateUrls,
            allowSelfSignedCerts: config.indexing.allowSelfSignedCerts,
          });
          const title = opts.title ?? fetched.title;
          result = await indexDocument(db, provider, {
            title,
            content: fetched.content,
            sourceType: opts.library ? "library" : opts.topic ? "topic" : "manual",
            library: opts.library,
            version: opts.version,
            topicId: opts.topic,
            url: fileOrUrl,
            dedup: opts.dedup as "skip" | "warn" | "force" | undefined,
          });
          console.log(`✓ Indexed "${title}" (${result.chunkCount} chunks)`);
        } else {
          result = await indexFile(db, provider, fileOrUrl, {
            title: opts.title,
            topic: opts.topic,
            library: opts.library,
            version: opts.version,
            format: opts.format,
            dedup: opts.dedup as "skip" | "warn" | "force" | undefined,
          });
          const title = opts.title ?? basename(fileOrUrl).replace(/\.[^.]+$/, "");
          console.log(`✓ Indexed "${title}" (${result.chunkCount} chunks)`);
        }

        console.log(`  ID: ${result.id}`);
      } finally {
        closeDatabase();
      }
    },
  );

// import
program
  .command("import <directory>")
  .description("Bulk import files from a directory (supports all document formats)")
  .option("--topic <topicId>", "Assign all to a topic")
  .option("--library <name>", "Mark all as library documentation")
  .option("--version <version>", "Library version")
  .option(
    "--extensions <exts>",
    "Comma-separated file extensions to include",
    ".md,.mdx,.txt,.pdf,.docx,.csv,.yaml,.yml,.json",
  )
  .option("--dedup <mode>", "Dedup mode: skip, warn, or force")
  .action(
    async (
      directory: string,
      opts: {
        topic?: string;
        library?: string;
        version?: string;
        extensions: string;
        dedup?: string;
      },
    ) => {
      const { db, provider } = initializeAppWithEmbedding();
      try {
        const extensions = new Set(opts.extensions.split(",").map((e) => e.trim().toLowerCase()));
        const files = findFiles(directory, extensions);

        if (files.length === 0) {
          console.log(`No matching files found in ${directory}`);
          return;
        }

        console.log(`Found ${files.length} files to import...`);
        const startTime = Date.now();
        let indexed = 0;
        let failed = 0;

        for (const file of files) {
          try {
            const result = await indexFile(db, provider, file, {
              topic: opts.topic,
              library: opts.library,
              version: opts.version,
              dedup: opts.dedup as "skip" | "warn" | "force" | undefined,
            });

            indexed++;
            console.log(
              `  [${indexed + failed}/${files.length}] ✓ ${file} (${result.chunkCount} chunks)`,
            );
          } catch (err) {
            failed++;
            console.error(
              `  [${indexed + failed}/${files.length}] ✗ ${file}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\nDone: ${indexed} indexed, ${failed} failed in ${elapsed}s`);
      } finally {
        closeDatabase();
      }
    },
  );

// import-batch
program
  .command("import-batch <directory>")
  .description("Batch import files with parallel processing")
  .option("--concurrency <n>", "Number of parallel imports", "5")
  .option("--filter <glob>", "Glob pattern for file selection", "**/*.{md,mdx,txt}")
  .option("--dry-run", "Preview files without importing")
  .option("--topic <topicId>", "Assign all to a topic")
  .option("--library <name>", "Mark all as library documentation")
  .option("--version <version>", "Library version")
  .action(
    async (
      directory: string,
      opts: {
        concurrency: string;
        filter: string;
        dryRun?: boolean;
        topic?: string;
        library?: string;
        version?: string;
      },
    ) => {
      const { db, provider } = initializeAppWithEmbedding();
      try {
        const { globSync } = await import("node:fs");
        const files = globSync(opts.filter, { cwd: directory }).map((f: string) =>
          join(directory, f),
        );
        files.sort();

        if (files.length === 0) {
          console.log(`No files matching "${opts.filter}" found in ${directory}`);
          return;
        }

        if (opts.dryRun) {
          console.log(`Found ${files.length} files (dry run):\n`);
          for (const f of files) {
            console.log(`  ${f}`);
          }
          return;
        }

        console.log(`Importing ${files.length} files (concurrency: ${opts.concurrency})...`);
        const startTime = Date.now();

        const result = await batchImport(db, provider, files, {
          concurrency: parseIntOption(opts.concurrency, "--concurrency"),
          library: opts.library,
          version: opts.version,
          topicId: opts.topic,
          onProgress: (progress) => {
            const done = progress.completed + progress.failed;
            const file = progress.currentFile ?? "";
            console.log(`  [${done}/${progress.total}] ${file}`);
          },
        });

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\nDone: ${result.completed} indexed, ${result.failed} failed in ${elapsed}s`);

        if (result.failed > 0) {
          console.log("\nFailed files:");
          for (const r of result.results) {
            if (!r.success) {
              console.log(`  ✗ ${r.file}: ${r.error}`);
            }
          }
        }
      } finally {
        closeDatabase();
      }
    },
  );

// search
program
  .command("search <query>")
  .description("Search indexed documents")
  .option("--topic <topicId>", "Filter by topic")
  .option("--library <name>", "Filter by library")
  .option(
    "--source <type>",
    "Filter by source type (e.g., 'library', 'topic', 'manual', 'model-generated')",
  )
  .option("--limit <n>", "Max results", "5")
  .option("--offset <n>", "Offset for pagination", "0")
  .option("--max-chunks-per-doc <n>", "Max chunks per document in results (default: no limit)")
  .option("--context <n>", "Include N neighboring chunks before/after each result (0-2)", "0")
  .option("--save <name>", "Save this search with the given name for later re-use")
  .action(
    async (
      query: string,
      opts: {
        topic?: string;
        library?: string;
        source?: string;
        limit: string;
        offset: string;
        maxChunksPerDoc?: string;
        context: string;
        save?: string;
      },
    ) => {
      const { db, provider } = initializeAppWithEmbedding();
      try {
        const contextChunks = parseIntOption(opts.context, "--context");
        const maxChunksPerDoc = opts.maxChunksPerDoc
          ? parseIntOption(opts.maxChunksPerDoc, "--max-chunks-per-doc")
          : undefined;
        const { results, totalCount } = await searchDocuments(db, provider, {
          query,
          topic: opts.topic,
          library: opts.library,
          source: opts.source,
          limit: parseIntOption(opts.limit, "--limit"),
          offset: parseIntOption(opts.offset, "--offset"),
          maxChunksPerDocument: maxChunksPerDoc,
          contextChunks: contextChunks > 0 ? contextChunks : undefined,
        });

        if (results.length === 0) {
          console.log("No results found.");
        } else {
          console.log(`\nShowing ${results.length} of ${totalCount} results:\n`);
          for (const r of results) {
            console.log(`\n── ${r.title} (score: ${r.score.toFixed(2)}) ──`);
            if (r.library) console.log(`  Library: ${r.library}`);
            if (r.url) console.log(`  Source: ${r.url}`);

            if (r.contextBefore && r.contextBefore.length > 0) {
              for (const c of r.contextBefore) {
                const preview = c.content.slice(0, 120);
                console.log(`  ↑ ${preview}${c.content.length > 120 ? "..." : ""}`);
              }
              console.log("  ─ ─ ─");
            }

            console.log(`  ${r.content.slice(0, 200)}${r.content.length > 200 ? "..." : ""}`);

            if (r.contextAfter && r.contextAfter.length > 0) {
              console.log("  ─ ─ ─");
              for (const c of r.contextAfter) {
                const preview = c.content.slice(0, 120);
                console.log(`  ↓ ${preview}${c.content.length > 120 ? "..." : ""}`);
              }
            }
          }
        }

        if (opts.save) {
          const filters: Record<string, unknown> = {};
          if (opts.topic) filters.topic = opts.topic;
          if (opts.library) filters.library = opts.library;
          if (opts.source) filters.source = opts.source;
          const saved = createSavedSearch(
            db,
            opts.save,
            query,
            Object.keys(filters).length > 0 ? filters : undefined,
          );
          console.log(`\n✓ Search saved as "${saved.name}" (${saved.id})`);
        }
      } finally {
        closeDatabase();
      }
    },
  );

// saved searches
const searchesCmd = program.command("searches").description("Manage saved searches");

searchesCmd
  .command("list")
  .description("List all saved searches")
  .action(() => {
    const { db } = initializeApp();
    try {
      const searches = listSavedSearches(db);
      if (searches.length === 0) {
        console.log("No saved searches.");
      } else {
        console.log(`Found ${searches.length} saved searches:\n`);
        for (const s of searches) {
          console.log(`  ${s.name}`);
          console.log(`    ID: ${s.id}`);
          console.log(`    Query: "${s.query}"`);
          if (s.filters) console.log(`    Filters: ${JSON.stringify(s.filters)}`);
          if (s.lastRunAt) console.log(`    Last run: ${s.lastRunAt} (${s.resultCount} results)`);
          console.log();
        }
      }
    } finally {
      closeDatabase();
    }
  });

searchesCmd
  .command("run <nameOrId>")
  .description("Run a saved search")
  .action(async (nameOrId: string) => {
    const { db, provider } = initializeAppWithEmbedding();
    try {
      const { search, results } = await runSavedSearch(db, provider, nameOrId);
      console.log(`\nRunning saved search "${search.name}" (query: "${search.query}"):\n`);
      if (results.length === 0) {
        console.log("No results found.");
      } else {
        console.log(`Found ${results.length} results:\n`);
        for (const r of results) {
          console.log(`── ${r.title} (score: ${r.score.toFixed(2)}) ──`);
          if (r.library) console.log(`  Library: ${r.library}`);
          console.log(`  ${r.content.slice(0, 200)}${r.content.length > 200 ? "..." : ""}`);
        }
      }
    } finally {
      closeDatabase();
    }
  });

searchesCmd
  .command("delete <nameOrId>")
  .description("Delete a saved search")
  .action((nameOrId: string) => {
    const { db } = initializeApp();
    try {
      deleteSavedSearch(db, nameOrId);
      console.log(`✓ Saved search "${nameOrId}" deleted.`);
    } finally {
      closeDatabase();
    }
  });

// ask (RAG question answering)
program
  .command("ask <question>")
  .description("Ask a question and get an LLM-synthesized answer using RAG")
  .option("--top-k <n>", "Number of chunks to retrieve", "5")
  .option("--topic <topic>", "Filter by topic")
  .option("--library <lib>", "Filter by library")
  .option("--model <model>", "Override LLM model")
  .action(
    async (
      question: string,
      opts: { topK: string; topic?: string; library?: string; model?: string },
    ) => {
      const { config, db, provider } = initializeAppWithEmbedding();
      try {
        let llmProvider;
        try {
          if (opts.model) {
            config.llm = { ...config.llm, model: opts.model };
          }
          llmProvider = createLlmProvider(config);
        } catch (err) {
          console.error(
            `\u2717 ${err instanceof Error ? err.message : String(err)}\n\n` +
              `To configure an LLM provider, run:\n` +
              `  libscope config set llm.provider openai   # or ollama\n` +
              `  export LIBSCOPE_LLM_PROVIDER=openai\n`,
          );
          process.exit(1);
        }

        const result = await askQuestion(db, provider, llmProvider, {
          question,
          topK: parseIntOption(opts.topK, "--top-k"),
          topic: opts.topic,
          library: opts.library,
        });

        console.log(`\n${result.answer}\n`);

        if (result.sources.length > 0) {
          console.log("\u2500\u2500 Sources \u2500\u2500");
          for (const src of result.sources) {
            console.log(
              `  \u2022 ${src.title} (score: ${src.score.toFixed(2)}) [${src.documentId}]`,
            );
          }
        }

        if (result.tokensUsed != null) {
          console.log(`\n  Model: ${result.model} | Tokens: ${result.tokensUsed}`);
        }
      } finally {
        closeDatabase();
      }
    },
  );

// topics
const topicsCmd = program.command("topics").description("Manage topics");

topicsCmd
  .command("list")
  .description("List all topics")
  .action(() => {
    const { db } = initializeApp();
    try {
      const topics = listTopics(db);
      if (topics.length === 0) {
        console.log("No topics found. Create one with: libscope topics create <name>");
      } else {
        for (const t of topics) {
          console.log(`  ${t.id} — ${t.name}${t.description ? ` (${t.description})` : ""}`);
        }
      }
    } finally {
      closeDatabase();
    }
  });

topicsCmd
  .command("create <name>")
  .description("Create a new topic")
  .option("--description <desc>", "Topic description")
  .option("--parent <parentId>", "Parent topic ID")
  .action((name: string, opts: { description?: string; parent?: string }) => {
    const { db } = initializeApp();
    try {
      const topic = createTopic(db, {
        name,
        description: opts.description,
        parentId: opts.parent,
      });
      console.log(`✓ Topic created: ${topic.id} (${topic.name})`);
    } finally {
      closeDatabase();
    }
  });

// ratings
const ratingsCmd = program.command("ratings").description("View document ratings");

ratingsCmd
  .command("show <documentId>")
  .description("Show ratings for a document")
  .action((documentId: string) => {
    const { db } = initializeApp();
    try {
      const doc = getDocument(db, documentId);
      const summary = getDocumentRatings(db, documentId);
      const ratings = listRatings(db, documentId);

      console.log(`\nRatings for: ${doc.title}`);
      console.log(
        `  Average: ${summary.averageRating.toFixed(1)}/5 (${summary.totalRatings} ratings)`,
      );
      console.log(`  Corrections suggested: ${summary.corrections}`);

      if (ratings.length > 0) {
        console.log("\nRecent ratings:");
        for (const r of ratings.slice(0, 10)) {
          console.log(`  ${r.rating}/5 by ${r.ratedBy} — ${r.feedback ?? "(no feedback)"}`);
        }
      }
    } finally {
      closeDatabase();
    }
  });

// links (document cross-references)
program
  .command("link <sourceId> <targetId>")
  .description("Create a cross-reference link between two documents")
  .option("--type <type>", "Link type: see_also, prerequisite, supersedes, related", "related")
  .option("--label <text>", "Human-readable description of the link")
  .action((sourceId: string, targetId: string, opts: { type: string; label?: string }) => {
    const validTypes = ["see_also", "prerequisite", "supersedes", "related"];
    if (!validTypes.includes(opts.type)) {
      console.error(`Invalid link type: ${opts.type}. Must be one of: ${validTypes.join(", ")}`);
      process.exit(1);
    }
    const { db } = initializeApp();
    try {
      const link = createLink(db, sourceId, targetId, opts.type as LinkType, opts.label);
      console.log(`✓ Link created: ${link.linkType} (${link.id})`);
    } finally {
      closeDatabase();
    }
  });

program
  .command("links <documentId>")
  .description("Show all cross-reference links for a document")
  .action((documentId: string) => {
    const { db } = initializeApp();
    try {
      const { outgoing, incoming } = getDocumentLinks(db, documentId);
      if (outgoing.length === 0 && incoming.length === 0) {
        console.log("No links found for this document.");
        return;
      }
      if (outgoing.length > 0) {
        console.log("\nOutgoing links:");
        for (const l of outgoing) {
          console.log(`  → [${l.linkType}] ${l.targetTitle}${l.label ? ` — ${l.label}` : ""}`);
          console.log(`    ID: ${l.id}  Target: ${l.targetId}`);
        }
      }
      if (incoming.length > 0) {
        console.log("\nIncoming links:");
        for (const l of incoming) {
          console.log(`  ← [${l.linkType}] ${l.sourceTitle}${l.label ? ` — ${l.label}` : ""}`);
          console.log(`    ID: ${l.id}  Source: ${l.sourceId}`);
        }
      }
    } finally {
      closeDatabase();
    }
  });

program
  .command("unlink <linkId>")
  .description("Remove a cross-reference link")
  .action((linkId: string) => {
    const { db } = initializeApp();
    try {
      deleteLink(db, linkId);
      console.log(`✓ Link ${linkId} deleted.`);
    } finally {
      closeDatabase();
    }
  });

program
  .command("prereqs <documentId>")
  .description("Show prerequisite reading chain for a document")
  .action((documentId: string) => {
    const { db } = initializeApp();
    try {
      const chain = getPrerequisiteChain(db, documentId);
      if (chain.length === 0) {
        console.log("No prerequisites found for this document.");
        return;
      }
      console.log("\nPrerequisite reading order:");
      for (let i = 0; i < chain.length; i++) {
        const doc = chain[i]!;
        console.log(`  ${i + 1}. ${doc.title} (${doc.id})`);
      }
      console.log(`  ${chain.length + 1}. [this document]`);
    } finally {
      closeDatabase();
    }
  });

// docs
const docsCmd = program.command("docs").description("Manage documents");

docsCmd
  .command("list")
  .description("List indexed documents")
  .option("--library <name>", "Filter by library")
  .option("--topic <topicId>", "Filter by topic")
  .option("--source-type <type>", "Filter by source type")
  .option("--limit <n>", "Max results", "50")
  .action((opts: { library?: string; topic?: string; sourceType?: string; limit: string }) => {
    const { db } = initializeApp();
    try {
      const docs = listDocuments(db, {
        library: opts.library,
        topicId: opts.topic,
        sourceType: opts.sourceType,
        limit: parseIntOption(opts.limit, "--limit"),
      });

      if (docs.length === 0) {
        console.log("No documents found.");
      } else {
        console.log(`Found ${docs.length} documents:\n`);
        for (const d of docs) {
          console.log(`  ${d.id}  ${d.title}`);
          if (d.library)
            console.log(`    Library: ${d.library}${d.version ? ` v${d.version}` : ""}`);
          if (d.url) console.log(`    URL: ${d.url}`);
          console.log(`    Type: ${d.sourceType}  |  Updated: ${d.updatedAt}`);
          console.log();
        }
      }
    } finally {
      closeDatabase();
    }
  });

docsCmd
  .command("show <documentId>")
  .description("Show a specific document")
  .action((documentId: string) => {
    const { db } = initializeApp();
    try {
      const doc = getDocument(db, documentId);
      console.log(`\n# ${doc.title}\n`);
      console.log(`ID: ${doc.id}`);
      console.log(`Type: ${doc.sourceType}`);
      if (doc.library)
        console.log(`Library: ${doc.library}${doc.version ? ` v${doc.version}` : ""}`);
      if (doc.url) console.log(`URL: ${doc.url}`);
      console.log(`Submitted by: ${doc.submittedBy}`);
      console.log(`Created: ${doc.createdAt}`);
      console.log(`Updated: ${doc.updatedAt}`);
      const tags = getDocumentTags(db, documentId);
      if (tags.length > 0) {
        console.log(`Tags: ${tags.map((t) => t.name).join(", ")}`);
      }
      console.log(`\n---\n`);
      console.log(doc.content);
    } finally {
      closeDatabase();
    }
  });

docsCmd
  .command("delete <documentId>")
  .description("Delete a document by ID")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (documentId: string, opts: { yes?: boolean }) => {
    const { db } = initializeApp();
    try {
      const doc = getDocument(db, documentId);
      if (
        !(await confirmAction(
          `Delete document "${doc.title}" (${documentId})? This cannot be undone.`,
          !!opts.yes,
        ))
      ) {
        console.log("Cancelled.");
        return;
      }
      deleteDocument(db, documentId);
      console.log(`✓ Deleted "${doc.title}" (${documentId})`);
    } finally {
      closeDatabase();
    }
  });

docsCmd
  .command("update <documentId>")
  .description("Update an existing document")
  .option("--title <title>", "New title")
  .option("--content <content>", "New content (will re-chunk and re-index)")
  .option("--library <name>", "New library name")
  .option("--version <ver>", "New version")
  .option("--url <url>", "New URL")
  .option("--topic <topicId>", "New topic ID")
  .action(
    async (
      documentId: string,
      opts: {
        title?: string;
        content?: string;
        library?: string;
        version?: string;
        url?: string;
        topic?: string;
      },
    ) => {
      const { db, provider } = initializeAppWithEmbedding();
      try {
        const metadata: Record<string, string | null | undefined> = {};
        if (opts.library !== undefined) metadata.library = opts.library;
        if (opts.version !== undefined) metadata.version = opts.version;
        if (opts.url !== undefined) metadata.url = opts.url;
        if (opts.topic !== undefined) metadata.topicId = opts.topic;

        const doc = await updateDocument(db, provider, documentId, {
          title: opts.title,
          content: opts.content,
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
        console.log(`✓ Updated "${doc.title}" (${doc.id})`);
      } finally {
        closeDatabase();
      }
    },
  );

// tag
const tagCmd = program.command("tag").description("Manage document tags");

tagCmd
  .command("add <docId> <tags...>")
  .description("Add tags to a document (comma or space separated)")
  .action((docId: string, tags: string[]) => {
    const { db } = initializeApp();
    try {
      const tagNames = tags
        .flatMap((t) => t.split(","))
        .map((t) => t.trim())
        .filter(Boolean);
      const created = addTagsToDocument(db, docId, tagNames);
      console.log(`✓ Added ${created.length} tag(s) to document ${docId}`);
      for (const t of created) {
        console.log(`  • ${t.name}`);
      }
    } finally {
      closeDatabase();
    }
  });

tagCmd
  .command("remove <docId> <tag>")
  .description("Remove a tag from a document")
  .action((docId: string, tagName: string) => {
    const { db } = initializeApp();
    try {
      const docTags = getDocumentTags(db, docId);
      const tag = docTags.find((t) => t.name === tagName.trim().toLowerCase());
      if (!tag) {
        console.log(`Tag "${tagName}" not found on document ${docId}`);
        return;
      }
      removeTagFromDocument(db, docId, tag.id);
      console.log(`✓ Removed tag "${tag.name}" from document ${docId}`);
    } finally {
      closeDatabase();
    }
  });

tagCmd
  .command("list")
  .description("List all tags with document counts")
  .action(() => {
    const { db } = initializeApp();
    try {
      const allTags = listTags(db);
      if (allTags.length === 0) {
        console.log("No tags found. Add tags with: libscope tag add <docId> <tags...>");
      } else {
        for (const t of allTags) {
          console.log(`  ${t.name} (${t.documentCount} doc${t.documentCount !== 1 ? "s" : ""})`);
        }
      }
    } finally {
      closeDatabase();
    }
  });

tagCmd
  .command("suggest <documentId>")
  .description("Suggest tags for a document based on content analysis")
  .option("-l, --limit <n>", "Max number of suggestions", "5")
  .action((documentId: string, opts: { limit: string }) => {
    const { db } = initializeApp();
    try {
      const limit = parseInt(opts.limit, 10);
      const suggestions = suggestTags(db, documentId, limit);
      if (suggestions.length === 0) {
        console.log("No tag suggestions found for this document.");
      } else {
        console.log(`Suggested tags for ${documentId}:`);
        for (const tag of suggestions) {
          console.log(`  • ${tag}`);
        }
      }
    } finally {
      closeDatabase();
    }
  });

docsCmd
  .command("history <documentId>")
  .description("Show version history of a document")
  .action((documentId: string) => {
    const { db } = initializeApp();
    try {
      const versions = getVersionHistory(db, documentId);
      if (versions.length === 0) {
        console.log("No version history found.");
      } else {
        console.log(`Version history for ${documentId}:\n`);
        for (const v of versions) {
          console.log(`  v${v.version}  ${v.title}  (${v.createdAt})`);
        }
      }
    } finally {
      closeDatabase();
    }
  });

docsCmd
  .command("rollback <documentId> <version>")
  .description("Rollback a document to a specific version")
  .action(async (documentId: string, version: string) => {
    const { db, provider } = initializeAppWithEmbedding();
    try {
      const restored = await rollbackToVersion(
        db,
        provider,
        documentId,
        parseIntOption(version, "<version>"),
      );
      console.log(`✓ Rolled back to version ${version}, saved as v${restored.version}`);
    } finally {
      closeDatabase();
    }
  });

// export
program
  .command("export <outputPath>")
  .description("Export the knowledge base to a JSON file")
  .action((outputPath: string) => {
    const { db } = initializeApp();
    try {
      const data = exportKnowledgeBase(db, outputPath);
      console.log(`✓ Exported ${data.metadata.counts.documents} documents to ${outputPath}`);
    } finally {
      closeDatabase();
    }
  });

// import-backup
program
  .command("import-backup <backupPath>")
  .description("Import knowledge base data from a backup file")
  .action((backupPath: string) => {
    const { db } = initializeApp();
    try {
      const data = importFromBackup(db, backupPath);
      console.log(`✓ Imported ${data.metadata.counts.documents} documents from ${backupPath}`);
    } finally {
      closeDatabase();
    }
  });

// serve
program
  .command("serve")
  .description("Start the MCP server, REST API (--api), or web dashboard (--dashboard)")
  .option("--api", "Start the REST API server instead of MCP")
  .option("--dashboard", "Start the web dashboard UI")
  .option("--port <port>", "Server port (default: 3378 for API, 3377 for dashboard)")
  .option("--host <host>", "Server host", "localhost")
  .action(async (opts: { api?: boolean; dashboard?: boolean; port?: string; host: string }) => {
    if (opts.dashboard) {
      const { db, provider } = initializeAppWithEmbedding();
      const { startWebServer } = await import("../web/server.js");
      const defaultPort = 3377;
      const port = opts.port ? parseIntOption(opts.port, "--port") : defaultPort;
      await startWebServer(db, provider, { port, host: opts.host });
      console.log(`LibScope dashboard running at http://${opts.host}:${port}`);
      console.log("Press Ctrl+C to stop");
    } else if (opts.api) {
      const { db, provider } = initializeAppWithEmbedding();
      const { startApiServer } = await import("../api/server.js");
      const defaultPort = 3378;
      const port = opts.port ? parseIntOption(opts.port, "--port") : defaultPort;
      const result = await startApiServer(db, provider, { port, host: opts.host });
      console.log(`LibScope API server listening on http://${opts.host}:${result.port}`);
      console.log("Press Ctrl+C to stop");
    } else {
      await import("../mcp/server.js");
    }
  });

// config
const configCmd = program.command("config").description("Manage configuration");

configCmd
  .command("set <key> <value>")
  .description("Set a configuration value (e.g., embedding.provider local)")
  .action((key: string, value: string) => {
    if (key === "embedding.provider") {
      if (value !== "local" && value !== "ollama" && value !== "openai") {
        console.error("Invalid provider. Must be: local, ollama, or openai");
        process.exit(1);
      }
      saveUserConfig({ embedding: { provider: value } });
      console.log(`✓ Embedding provider set to: ${value}`);
    } else if (key === "indexing.allowPrivateUrls") {
      const bool = value === "true";
      saveUserConfig({ indexing: { ...loadConfig().indexing, allowPrivateUrls: bool } });
      console.log(`✓ indexing.allowPrivateUrls set to: ${bool}`);
    } else if (key === "indexing.allowSelfSignedCerts") {
      const bool = value === "true";
      saveUserConfig({ indexing: { ...loadConfig().indexing, allowSelfSignedCerts: bool } });
      console.log(`✓ indexing.allowSelfSignedCerts set to: ${bool}`);
    } else {
      console.error(`Unknown config key: ${key}`);
      process.exit(1);
    }
  });

configCmd
  .command("show")
  .description("Show current configuration")
  .action(() => {
    const config = loadConfig();
    console.log(JSON.stringify(config, null, 2));
  });

interface ProgramOpts {
  verbose?: boolean;
  logLevel?: string;
  workspace?: string;
}

function setupLogging(opts: ProgramOpts): void {
  const level: LogLevel = opts.verbose
    ? "debug"
    : ((opts.logLevel as LogLevel | undefined) ?? loadConfig().logging.level);
  initLogger(level);
}

/** Shared CLI initialization: loadConfig → setupLogging → getDatabase → runMigrations. */
function initializeApp(): {
  config: ReturnType<typeof loadConfig>;
  db: ReturnType<typeof getDatabase>;
} {
  const config = loadConfig();
  const opts = program.opts<ProgramOpts>();
  setupLogging(opts);

  if (opts.workspace) {
    process.env["LIBSCOPE_WORKSPACE"] = opts.workspace;
  }

  const workspace = getActiveWorkspace();
  const dbPath = getWorkspacePath(workspace);
  const db = getDatabase(dbPath);
  runMigrations(db);
  return { config, db };
}

/** Initialization with an embedding provider and vector table. */
function initializeAppWithEmbedding(): {
  config: ReturnType<typeof loadConfig>;
  db: ReturnType<typeof getDatabase>;
  provider: EmbeddingProvider;
} {
  const { config, db } = initializeApp();
  const provider = createEmbeddingProvider(config);
  createVectorTable(db, provider.dimensions);
  return { config, db, provider };
}

/** Recursively find files matching given extensions. */
function findFiles(dir: string, extensions: Set<string>): string[] {
  const results: string[] = [];

  function walk(currentDir: string): void {
    const entries = readdirSync(currentDir);
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (extensions.has(extname(entry).toLowerCase())) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results.sort();
}

// watch
program
  .command("watch <directory>")
  .description("Watch a directory for file changes and automatically re-index")
  .option(
    "--extensions <exts>",
    "Comma-separated file extensions to watch",
    DEFAULT_WATCH_EXTENSIONS.join(","),
  )
  .option("--debounce <ms>", "Debounce interval in milliseconds", "300")
  .action(async (directory: string, opts: { extensions: string; debounce: string }) => {
    const { db, provider } = initializeAppWithEmbedding();
    const extensions = opts.extensions.split(",").map((e) => e.trim().toLowerCase());
    const debounceMs = parseIntOption(opts.debounce, "--debounce");

    // Initial scan
    const extensionSet = new Set(extensions);
    const files = findFiles(directory, extensionSet);
    console.log(`Found ${files.length} matching files in ${directory}`);

    let indexed = 0;
    let skipped = 0;
    for (const file of files) {
      try {
        const content = readFileSync(file, "utf-8");
        const title = basename(file).replace(/\.[^.]+$/, "");
        const result = await indexDocument(db, provider, {
          title,
          content,
          sourceType: "manual",
          url: file,
        });
        if (result.chunkCount > 0) {
          indexed++;
        } else {
          skipped++;
        }
      } catch {
        skipped++;
      }
    }
    console.log(`Initial scan: ${indexed} indexed, ${skipped} skipped (unchanged or failed)`);
    console.log(`\nWatching for changes (extensions: ${extensions.join(", ")})...\n`);

    const watcher = new FileWatcher(db, provider, {
      directory,
      extensions,
      debounceMs,
      onIndex: (path: string): void => {
        console.log(`  ✓ Indexed: ${path}`);
      },
      onRemove: (path: string): void => {
        console.log(`  ✗ Removed: ${path}`);
      },
      onError: (err: Error): void => {
        console.error(`  ⚠ Error: ${err.message}`);
      },
    });

    const cleanup = (): void => {
      watcher.stop();
      closeDatabase();
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    watcher.start();

    // Keep the process alive
    await new Promise(() => {});
  });

// reindex
program
  .command("reindex")
  .description("Re-embed all chunks with the current embedding provider")
  .option("--doc <documentId...>", "Only reindex specific document IDs")
  .option("--since <date>", "Only reindex documents created on or after this ISO-8601 date")
  .option("--before <date>", "Only reindex documents created on or before this ISO-8601 date")
  .option("--batch-size <n>", "Chunks per embedding batch", "50")
  .action(async (opts: { doc?: string[]; since?: string; before?: string; batchSize: string }) => {
    const { reindex } = await import("../core/reindex.js");
    const { db, provider } = initializeAppWithEmbedding();
    try {
      console.log("Re-embedding chunks...");
      const startTime = Date.now();

      const result = await reindex(db, provider, {
        documentIds: opts.doc,
        since: opts.since,
        before: opts.before,
        batchSize: parseIntOption(opts.batchSize, "--batch-size"),
        onProgress: (progress) => {
          const done = progress.completed + progress.failed;
          console.log(`  [${done}/${progress.total}] chunks processed`);
        },
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `\n✓ Reindex complete: ${result.completed} updated, ${result.failed} failed (${result.total} total) in ${elapsed}s`,
      );

      if (result.failedChunkIds.length > 0) {
        console.log("\nFailed chunks:");
        for (const id of result.failedChunkIds) {
          console.log(`  ✗ ${id}`);
        }
      }
    } finally {
      closeDatabase();
    }
  });

// repl (interactive search)
program
  .command("repl")
  .description("Start an interactive search REPL")
  .option("--limit <n>", "Max results per search", "5")
  .action(async (opts: { limit: string }) => {
    const { db, provider } = initializeAppWithEmbedding();
    try {
      await startRepl({ db, provider, limit: parseIntOption(opts.limit, "--limit") });
    } finally {
      closeDatabase();
    }
  });

// dedupe — scan and report duplicates
program
  .command("dedupe")
  .description("Scan the knowledge base for duplicate documents")
  .option("--threshold <n>", "Similarity threshold (0-1)", "0.95")
  .option("--strategy <type>", "Detection strategy: exact, semantic, or both", "both")
  .action(async (opts: { threshold: string; strategy: string }) => {
    const { db, provider } = initializeAppWithEmbedding();
    try {
      console.log("Scanning for duplicates...\n");
      const groups = await findDuplicates(db, provider, {
        threshold: parseFloat(opts.threshold),
        strategy: opts.strategy as "exact" | "semantic" | "both",
      });

      if (groups.length === 0) {
        console.log("No duplicates found.");
        return;
      }

      console.log(`Found ${groups.length} duplicate group(s):\n`);

      const groupCol = 7;
      const typeCol = 10;
      const idCol = 38;
      const titleCol = 40;

      const header =
        "Group".padEnd(groupCol) + "Type".padEnd(typeCol) + "Document ID".padEnd(idCol) + "Title";
      console.log(header);
      console.log("\u2500".repeat(header.length + titleCol));

      for (let i = 0; i < groups.length; i++) {
        const group = groups[i]!;
        for (let j = 0; j < group.documentIds.length; j++) {
          const gLabel = j === 0 ? String(i + 1) : "";
          const tLabel = j === 0 ? group.matchType : "";
          const docId = group.documentIds[j] ?? "";
          const title = group.titles[j] ?? "";
          console.log(
            gLabel.padEnd(groupCol) +
              tLabel.padEnd(typeCol) +
              docId.padEnd(idCol) +
              title.slice(0, titleCol),
          );
        }
        console.log();
      }
    } finally {
      closeDatabase();
    }
  });

// stats
const statsCmd = program.command("stats").description("Usage analytics and content health metrics");

statsCmd
  .command("overview", { isDefault: true })
  .description("Show overview dashboard")
  .action(() => {
    const { config, db } = initializeApp();
    try {
      const s = getStats(db, config.database.path);
      console.log("\n\u{1f4ca} Knowledge Base Overview\n");
      console.log(`  Documents:      ${s.totalDocuments}`);
      console.log(`  Chunks:         ${s.totalChunks}`);
      console.log(`  Topics:         ${s.totalTopics}`);
      console.log(`  Database size:  ${(s.databaseSizeBytes / 1024).toFixed(1)} KB`);
      console.log(`  Total searches: ${s.totalSearches}`);
      console.log(`  Avg latency:    ${s.avgLatencyMs} ms`);

      const trends = getSearchTrends(db, 7);
      if (trends.length > 0) {
        console.log("\n  Recent search activity (last 7 days):");
        for (const t of trends) {
          const bar = "\u2588".repeat(Math.min(t.count, 40));
          console.log(`    ${t.date}  ${bar} ${t.count}`);
        }
      }
      console.log();
    } finally {
      closeDatabase();
    }
  });

statsCmd
  .command("popular")
  .description("Most-returned documents in search results")
  .option("--limit <n>", "Number of results", "10")
  .action((opts: { limit: string }) => {
    const { db } = initializeApp();
    try {
      const docs = getPopularDocuments(db, parseIntOption(opts.limit, "--limit"));
      if (docs.length === 0) {
        console.log("No search data yet.");
        return;
      }
      console.log("\n\u{1f525} Most Popular Documents\n");
      console.log("  Hits  Document");
      console.log("  " + "\u2500".repeat(50));
      for (const d of docs) {
        console.log(
          `  ${String(d.hitCount).padStart(4)}  ${d.title} (${d.documentId.slice(0, 8)}\u2026)`,
        );
      }
      console.log();
    } finally {
      closeDatabase();
    }
  });

statsCmd
  .command("stale")
  .description("Documents with no search hits")
  .option("--days <n>", "Look-back period in days", "90")
  .action((opts: { days: string }) => {
    const { db } = initializeApp();
    try {
      const docs = getStaleDocuments(db, parseIntOption(opts.days, "--days"));
      if (docs.length === 0) {
        console.log("No stale documents found.");
        return;
      }
      console.log(`\n\u{1f4ed} Stale Documents (no hits in ${opts.days} days)\n`);
      console.log("  Updated     Title");
      console.log("  " + "\u2500".repeat(50));
      for (const d of docs) {
        const date = d.updatedAt.slice(0, 10);
        console.log(`  ${date}  ${d.title}`);
      }
      console.log();
    } finally {
      closeDatabase();
    }
  });

statsCmd
  .command("queries")
  .description("Top search queries")
  .option("--limit <n>", "Number of results", "10")
  .action((opts: { limit: string }) => {
    const { db } = initializeApp();
    try {
      const queries = getTopQueries(db, parseIntOption(opts.limit, "--limit"));
      if (queries.length === 0) {
        console.log("No search data yet.");
        return;
      }
      console.log("\n\u{1f50d} Top Search Queries\n");
      console.log("  Count  Avg ms  Query");
      console.log("  " + "\u2500".repeat(50));
      for (const q of queries) {
        console.log(
          `  ${String(q.count).padStart(5)}  ${String(q.avgLatencyMs).padStart(6)}  ${q.query}`,
        );
      }
      console.log();
    } finally {
      closeDatabase();
    }
  });

statsCmd
  .command("search-analytics")
  .description("Search analytics dashboard with knowledge gap detection")
  .option("--days <n>", "Look-back period in days", "30")
  .action((opts: { days: string }) => {
    const { db } = initializeApp();
    try {
      const days = parseIntOption(opts.days, "--days");
      const analytics = getSearchAnalytics(db, days);
      const gaps = getKnowledgeGaps(db, days);

      console.log(`\n\u{1f50d} Search Analytics (last ${days} days)\n`);
      console.log(`  Total searches:    ${analytics.totalSearches}`);
      console.log(`  Avg result count:  ${analytics.avgResultCount}`);

      if (analytics.topQueries.length > 0) {
        console.log("\n  Top queries:");
        for (const q of analytics.topQueries) {
          console.log(`    ${String(q.count).padStart(5)}x  ${q.query}`);
        }
      }

      if (analytics.zeroResultQueries.length > 0) {
        console.log("\n  Zero-result queries:");
        for (const q of analytics.zeroResultQueries) {
          console.log(`    ${String(q.count).padStart(5)}x  ${q.query}`);
        }
      }

      if (gaps.length > 0) {
        console.log("\n  \u26a0\ufe0f Knowledge Gaps:");
        for (const g of gaps) {
          console.log(`    ${String(g.count).padStart(5)}x  ${g.query}  (last: ${g.lastSearched})`);
        }
      }

      if (analytics.queriesPerDay.length > 0) {
        console.log("\n  Queries per day:");
        for (const d of analytics.queriesPerDay) {
          const bar = "\u2588".repeat(Math.min(d.count, 40));
          console.log(`    ${d.date}  ${bar} ${d.count}`);
        }
      }
      console.log();
    } finally {
      closeDatabase();
    }
  });

// add-repo
program
  .command("add-repo <url>")
  .description("Index documentation from a GitHub or GitLab repository")
  .option("--branch <name>", "Branch to index (default: main or from URL)")
  .option("--path <subdir>", "Only index files under this subdirectory")
  .option("--extensions <ext1,ext2>", "Comma-separated file extensions", ".md,.mdx,.txt,.rst")
  .option("--token <pat>", "Personal access token for private repos")
  .action(
    async (
      url: string,
      opts: { branch?: string; path?: string; extensions: string; token?: string },
    ) => {
      const { db, provider } = initializeAppWithEmbedding();
      try {
        const parsed = parseRepoUrl(url);
        console.log(`Repository: ${parsed.owner}/${parsed.repo} (${parsed.host})`);

        const extensions = opts.extensions.split(",").map((e) => {
          const trimmed = e.trim();
          return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
        });

        const startTime = Date.now();
        const result = await indexRepository(
          db,
          provider,
          {
            url,
            branch: opts.branch,
            paths: opts.path ? [opts.path] : undefined,
            extensions,
            token: opts.token,
          },
          (message: string) => {
            console.log(`  ${message}`);
          },
        );

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(``);
        console.log(`┌─────────────────────────────┐`);
        console.log(`│ Repository Indexing Summary  │`);
        console.log(`├─────────────────────────────┤`);
        console.log(`│ Indexed: ${String(result.indexed).padStart(17)} │`);
        console.log(`│ Skipped: ${String(result.skipped).padStart(17)} │`);
        console.log(`│ Errors:  ${String(result.errors.length).padStart(17)} │`);
        console.log(`│ Time:    ${(elapsed + "s").padStart(17)} │`);
        console.log(`└─────────────────────────────┘`);

        if (result.errors.length > 0) {
          console.log("\nErrors:");
          for (const err of result.errors) {
            console.log(`  ✗ ${err}`);
          }
        }
      } finally {
        closeDatabase();
      }
    },
  );

// workspace
const workspaceCmd = program.command("workspace").description("Manage workspaces");

workspaceCmd
  .command("create <name>")
  .description("Create a new workspace")
  .action((name: string) => {
    const ws = createWorkspace(name);
    console.log(`✓ Workspace "${ws.name}" created at ${ws.path}`);
  });

workspaceCmd
  .command("list")
  .description("List all workspaces")
  .action(() => {
    const workspaces = listWorkspaces();
    const active = getActiveWorkspace();

    if (workspaces.length === 0) {
      console.log("No workspaces found.");
      return;
    }

    console.log("Workspaces:\n");
    for (const ws of workspaces) {
      const marker = ws.name === active ? " (active)" : "";
      console.log(`  ${ws.name}${marker}`);
      console.log(`    Path: ${ws.path}`);
      console.log(`    Created: ${ws.createdAt}`);
      console.log();
    }
  });

workspaceCmd
  .command("use <name>")
  .description("Switch active workspace")
  .action((name: string) => {
    setActiveWorkspace(name);
    console.log(`✓ Switched to workspace "${name}"`);
  });

workspaceCmd
  .command("delete <name>")
  .description("Delete a workspace")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (name: string, opts: { yes?: boolean }) => {
    if (!(await confirmAction(`Delete workspace "${name}"? This cannot be undone.`, !!opts.yes))) {
      console.log("Cancelled.");
      return;
    }
    deleteWorkspace(name);
    console.log(`✓ Workspace "${name}" deleted.`);
  });

// pack
const packCmd = program.command("pack").description("Manage knowledge packs");

packCmd
  .command("install <nameOrPath>")
  .description("Install a knowledge pack from registry or local .json file")
  .option("--registry <url>", "Custom registry URL")
  .action(async (nameOrPath: string, opts: { registry?: string }) => {
    const { db, provider } = initializeAppWithEmbedding();
    const result = await installPack(db, provider, nameOrPath, {
      registryUrl: opts.registry,
    });
    if (result.alreadyInstalled) {
      console.log(`Pack "${result.packName}" is already installed.`);
    } else {
      console.log(
        `✓ Pack "${result.packName}" installed (${result.documentsInstalled} documents).`,
      );
    }
  });

packCmd
  .command("remove <name>")
  .description("Remove a pack and its documents")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (name: string, opts: { yes?: boolean }) => {
    if (
      !(await confirmAction(
        `Remove pack "${name}" and its documents? This cannot be undone.`,
        !!opts.yes,
      ))
    ) {
      console.log("Cancelled.");
      return;
    }
    const { db } = initializeApp();
    try {
      removePack(db, name);
      console.log(`✓ Pack "${name}" removed.`);
    } finally {
      closeDatabase();
    }
  });

packCmd
  .command("list")
  .description("List installed or available packs")
  .option("--available", "List packs available in the registry")
  .option("--registry <url>", "Custom registry URL")
  .action(async (opts: { available?: boolean; registry?: string }) => {
    if (opts.available) {
      const packs = await listAvailablePacks(opts.registry);
      if (packs.length === 0) {
        console.log("No packs available in the registry.");
        return;
      }
      console.log("Available packs:\n");
      for (const p of packs) {
        console.log(`  ${p.name} v${p.version} — ${p.description} (${p.docCount} docs)`);
      }
    } else {
      const { db } = initializeApp();
      try {
        const packs = listInstalledPacks(db);
        if (packs.length === 0) {
          console.log("No packs installed.");
          return;
        }
        console.log("Installed packs:\n");
        for (const p of packs) {
          console.log(`  ${p.name} v${p.version} — ${p.description ?? ""} (${p.docCount} docs)`);
        }
      } finally {
        closeDatabase();
      }
    }
  });

packCmd
  .command("create")
  .description("Export current documents as a pack file")
  .requiredOption("--name <name>", "Pack name")
  .option("--topic <topic>", "Filter documents by topic ID")
  .option("--version <version>", "Pack version (default: 1.0.0)")
  .option("--description <desc>", "Pack description")
  .option("--author <author>", "Pack author")
  .option("--output <path>", "Output file path")
  .action(
    (opts: {
      name: string;
      topic?: string;
      version?: string;
      description?: string;
      author?: string;
      output?: string;
    }) => {
      const { db } = initializeApp();
      try {
        const outputPath = opts.output ?? `${opts.name}.json`;
        const pack = createPack(db, {
          name: opts.name,
          version: opts.version,
          description: opts.description,
          author: opts.author,
          topic: opts.topic,
          outputPath,
        });
        console.log(
          `✓ Pack "${pack.name}" created with ${pack.documents.length} documents → ${outputPath}`,
        );
      } finally {
        closeDatabase();
      }
    },
  );

// connect onenote
const connectCmd = program.command("connect").description("Connect external services");

connectCmd
  .command("onenote")
  .description("Connect and sync OneNote notebooks via Microsoft Graph API")
  .option("--token <accessToken>", "Use a pre-existing access token")
  .option("--sync", "Incremental re-sync only")
  .option("--notebook <name>", "Sync a specific notebook")
  .action(async (opts: { token?: string; sync?: boolean; notebook?: string }) => {
    const config = loadConfig();
    const logLevel =
      (program.opts().logLevel as LogLevel) ?? (program.opts().verbose ? "debug" : "info");
    initLogger(logLevel);

    const workspace = program.opts().workspace as string | undefined;
    if (workspace) {
      process.env["LIBSCOPE_WORKSPACE"] = workspace;
    }
    const wsName = getActiveWorkspace();
    const wsPath = getWorkspacePath(wsName);
    const dbPath = join(wsPath, config.database.path);
    const db = getDatabase(dbPath);
    runMigrations(db);
    const provider = createEmbeddingProvider(config);
    createVectorTable(db, provider.dimensions);

    try {
      const connConfig = loadConnectorConfig();
      let onenoteConf = (connConfig.onenote ?? {}) as Record<string, unknown>;

      let accessToken = opts.token;

      if (!accessToken && !opts.sync) {
        const clientId =
          (onenoteConf.clientId as string | undefined) ?? process.env.ONENOTE_CLIENT_ID;
        if (!clientId) {
          console.error("Error: No client ID. Set ONENOTE_CLIENT_ID env var or provide --token.");
          process.exit(1);
        }
        const tenantId =
          (onenoteConf.tenantId as string | undefined) ?? process.env.ONENOTE_TENANT_ID ?? "common";

        console.log("Starting device code authentication...");
        const auth = await authenticateDeviceCode(clientId, tenantId);
        accessToken = auth.accessToken;
        onenoteConf = {
          ...onenoteConf,
          clientId,
          tenantId,
          accessToken: auth.accessToken,
          refreshToken: auth.refreshToken,
          tokenExpiry: auth.expiresAt,
        };
        connConfig.onenote = onenoteConf;
        saveConnectorConfig(connConfig);
        console.log("✓ Authenticated successfully");
      }

      if (opts.sync && !accessToken) {
        // Try to refresh token
        const clientId = onenoteConf.clientId as string | undefined;
        const refreshTok = onenoteConf.refreshToken as string | undefined;
        if (clientId && refreshTok) {
          const tenantId = (onenoteConf.tenantId as string | undefined) ?? "common";
          const auth = await refreshAccessToken(clientId, refreshTok, tenantId);
          accessToken = auth.accessToken;
          onenoteConf.accessToken = auth.accessToken;
          onenoteConf.refreshToken = auth.refreshToken;
          onenoteConf.tokenExpiry = auth.expiresAt;
          connConfig.onenote = onenoteConf;
          saveConnectorConfig(connConfig);
        } else {
          accessToken = onenoteConf.accessToken as string | undefined;
        }
      }

      if (!accessToken) {
        console.error("Error: No access token available. Run without --sync to authenticate.");
        process.exit(1);
      }

      const notebooks = opts.notebook ? [opts.notebook] : ["all"];
      const syncResult = await syncOneNote(db, provider, {
        clientId: (onenoteConf.clientId as string) ?? "",
        tenantId: (onenoteConf.tenantId as string) ?? "common",
        accessToken,
        notebooks,
        excludeSections: (onenoteConf.excludeSections as string[]) ?? [],
        lastSync: opts.sync ? (onenoteConf.lastSync as string | undefined) : undefined,
      });

      console.log(`\n✓ OneNote sync complete:`);
      console.log(`  Notebooks: ${syncResult.notebooks}`);
      console.log(`  Sections:  ${syncResult.sections}`);
      console.log(`  Added:     ${syncResult.pagesAdded}`);
      console.log(`  Updated:   ${syncResult.pagesUpdated}`);
      console.log(`  Deleted:   ${syncResult.pagesDeleted}`);
      if (syncResult.errors.length > 0) {
        console.log(`  Errors:    ${syncResult.errors.length}`);
        for (const e of syncResult.errors) {
          console.log(`    - ${e.page}: ${e.error}`);
        }
      }
    } finally {
      db.close();
    }
  });

// disconnect commands
const disconnectCmd = program.command("disconnect").description("Disconnect external sources");

disconnectCmd
  .command("onenote")
  .description("Disconnect OneNote and remove its data")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (opts: { yes?: boolean }) => {
    if (
      !(await confirmAction(
        "Disconnect OneNote and remove all its data? This cannot be undone.",
        !!opts.yes,
      ))
    ) {
      console.log("Cancelled.");
      return;
    }
    const config = loadConfig();
    const logLevel =
      (program.opts().logLevel as LogLevel) ?? (program.opts().verbose ? "debug" : "info");
    initLogger(logLevel);

    const workspace2 = program.opts().workspace as string | undefined;
    if (workspace2) {
      process.env["LIBSCOPE_WORKSPACE"] = workspace2;
    }
    const wsName2 = getActiveWorkspace();
    const wsPath = getWorkspacePath(wsName2);
    const dbPath = join(wsPath, config.database.path);
    const db = getDatabase(dbPath);
    runMigrations(db);

    try {
      const removed = disconnectOneNote(db);
      console.log(`✓ Disconnected OneNote. Removed ${removed} documents.`);
    } finally {
      db.close();
    }
  });

connectCmd
  .command("obsidian <vault-path>")
  .description("Sync an Obsidian vault into the knowledge base")
  .option("--sync", "Incremental re-sync (only changed files)")
  .option(
    "--topic-mapping <mode>",
    "Map topics from 'folder' or 'frontmatter' (default: folder)",
    "folder",
  )
  .option("--exclude <patterns...>", "Additional exclude patterns")
  .action(
    async (
      vaultPath: string,
      cmdOpts: { sync?: boolean; topicMapping?: string; exclude?: string[] },
    ) => {
      const { config, db } = initializeApp();
      const provider = createEmbeddingProvider(config);
      createVectorTable(db, provider.dimensions);

      try {
        const { syncObsidianVault } = await import("../connectors/obsidian.js");

        const topicMapping: "folder" | "frontmatter" =
          cmdOpts.topicMapping === "frontmatter" ? "frontmatter" : "folder";
        const obsConfig = {
          vaultPath: join(process.cwd(), vaultPath).replace(/\/+$/, ""),
          topicMapping,
          excludePatterns: cmdOpts.exclude ?? [],
        };

        // Use absolute path if provided
        if (vaultPath.startsWith("/")) {
          obsConfig.vaultPath = vaultPath;
        }

        console.log(`Syncing Obsidian vault: ${obsConfig.vaultPath}`);
        const result = await syncObsidianVault(db, provider, obsConfig);

        console.log(`✓ Sync complete:`);
        console.log(`  Added:   ${result.added}`);
        console.log(`  Updated: ${result.updated}`);
        console.log(`  Deleted: ${result.deleted}`);
        if (result.errors.length > 0) {
          console.log(`  Errors:  ${result.errors.length}`);
          for (const e of result.errors) {
            console.log(`    - ${e.file}: ${e.error}`);
          }
        }
      } finally {
        closeDatabase();
      }
    },
  );

connectCmd
  .command("slack")
  .description("Connect a Slack workspace")
  .option("--token <token>", "Slack bot or user token (xoxb-... or xoxp-...)")
  .option("--channels <channels>", "Comma-separated channel names or IDs, or 'all'", "all")
  .option("--exclude <channels>", "Comma-separated channel names to exclude")
  .option(
    "--thread-mode <mode>",
    "Thread handling: aggregate (full thread as one doc) or separate",
    "aggregate",
  )
  .option("--sync", "Sync using saved configuration")
  .action(
    async (opts: {
      token?: string;
      channels: string;
      exclude?: string;
      threadMode: string;
      sync?: boolean;
    }) => {
      const { db, provider } = initializeAppWithEmbedding();
      try {
        let slackConfig: SlackConfig;

        if (opts.sync) {
          if (!hasNamedConnectorConfig("slack")) {
            console.error(
              "No Slack configuration found. Run 'libscope connect slack --token ...' first.",
            );
            process.exit(1);
          }
          slackConfig = loadNamedConnectorConfig<SlackConfig>("slack");
        } else {
          if (!opts.token) {
            console.error("--token is required for initial Slack connection.");
            process.exit(1);
          }
          slackConfig = {
            token: opts.token,
            channels: opts.channels.split(",").map((c) => c.trim()),
            threadMode: opts.threadMode === "separate" ? "separate" : "aggregate",
          };
          if (opts.exclude) {
            slackConfig = {
              ...slackConfig,
              excludeChannels: opts.exclude.split(",").map((c) => c.trim()),
            };
          }
        }

        console.log("Syncing Slack messages...");
        const result = await syncSlack(db, provider, slackConfig);

        const updatedConfig: SlackConfig = {
          ...slackConfig,
          lastSync: new Date().toISOString(),
        };
        saveNamedConnectorConfig("slack", updatedConfig);

        console.log(`✓ Slack sync complete:`);
        console.log(`  Channels: ${result.channels}`);
        console.log(`  Messages indexed: ${result.messagesIndexed}`);
        console.log(`  Threads indexed: ${result.threadsIndexed}`);
        if (result.errors.length > 0) {
          console.log(`  Errors: ${result.errors.length}`);
          for (const err of result.errors) {
            console.log(`    - #${err.channel}: ${err.error}`);
          }
        }
      } finally {
        closeDatabase();
      }
    },
  );

connectCmd
  .command("confluence")
  .description("Sync Confluence spaces and pages")
  .option("--url <url>", "Confluence base URL (e.g. https://acme.atlassian.net)")
  .option("--type <type>", "Confluence type: cloud or server (Data Center)", "cloud")
  .option("--email <email>", "Confluence user email (Cloud only)")
  .option("--token <token>", "API token (Cloud) or Personal Access Token (Server/Data Center)")
  .option("--spaces <keys>", "Comma-separated space keys, or 'all'", "all")
  .option("--exclude-spaces <keys>", "Comma-separated space keys to exclude")
  .option("--sync", "Sync using previously saved config")
  .action(
    async (opts: {
      url?: string;
      type?: string;
      email?: string;
      token?: string;
      spaces?: string;
      excludeSpaces?: string;
      sync?: boolean;
    }) => {
      const { syncConfluence } = await import("../connectors/confluence.js");
      const { db, provider } = initializeAppWithEmbedding();
      try {
        const url = opts.url ?? process.env["CONFLUENCE_URL"] ?? "";
        const confluenceType = opts.type === "server" ? "server" : ("cloud" as "cloud" | "server");
        const email = opts.email ?? process.env["CONFLUENCE_EMAIL"] ?? undefined;
        const token = opts.token ?? process.env["CONFLUENCE_TOKEN"] ?? "";

        const spaces = (opts.spaces ?? "all").split(",").map((s) => s.trim());
        const excludeSpaces = opts.excludeSpaces
          ? opts.excludeSpaces.split(",").map((s) => s.trim())
          : undefined;

        const result = await syncConfluence(db, provider, {
          baseUrl: url,
          type: confluenceType,
          ...(email ? { email } : {}),
          token,
          spaces,
          excludeSpaces,
        });

        console.log(`✓ Confluence sync complete`);
        console.log(`  Spaces: ${result.spaces}`);
        console.log(`  Pages indexed: ${result.pagesIndexed}`);
        console.log(`  Pages updated: ${result.pagesUpdated}`);
        if (result.errors.length > 0) {
          console.log(`  Errors: ${result.errors.length}`);
          for (const e of result.errors) {
            console.log(`    - ${e.page}: ${e.error}`);
          }
        }
      } finally {
        closeDatabase();
      }
    },
  );

disconnectCmd
  .command("obsidian <vault-path>")
  .description("Remove all documents from an Obsidian vault")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (vaultPath: string, opts: { yes?: boolean }) => {
    if (
      !(await confirmAction(
        `Disconnect Obsidian vault "${vaultPath}" and remove its documents? This cannot be undone.`,
        !!opts.yes,
      ))
    ) {
      console.log("Cancelled.");
      return;
    }
    const { db } = initializeApp();
    try {
      const { disconnectVault } = await import("../connectors/obsidian.js");

      let resolvedPath = vaultPath;
      if (!vaultPath.startsWith("/")) {
        resolvedPath = join(process.cwd(), vaultPath);
      }

      const removed = disconnectVault(db, resolvedPath);
      console.log(`✓ Disconnected vault. Removed ${removed} documents.`);
    } finally {
      closeDatabase();
    }
  });

connectCmd
  .command("notion")
  .description("Connect and sync Notion pages and databases")
  .option("--token <token>", "Notion integration token (secret_...)")
  .option("--sync", "Sync pages using a previously stored token")
  .option("--exclude <ids...>", "Page/database IDs to exclude")
  .action(async (opts: { token?: string; sync?: boolean; exclude?: string[] }) => {
    const { db, provider } = initializeAppWithEmbedding();
    let token = opts.token;

    if (opts.sync && !token) {
      token = process.env["NOTION_TOKEN"];
      if (!token) {
        console.error("Error: --token is required, or set NOTION_TOKEN environment variable.");
        process.exitCode = 1;
        return;
      }
    }

    if (!token) {
      console.error("Error: --token <token> is required.");
      process.exitCode = 1;
      return;
    }

    const config: NotionConfig = { token };
    if (opts.exclude) {
      config.excludePages = opts.exclude;
    }

    console.log("Syncing Notion...");
    const result = await syncNotion(db, provider, config);
    console.log(
      `✓ Synced: ${result.pagesIndexed} pages, ${result.databasesIndexed} databases` +
        (result.errors.length > 0 ? `, ${result.errors.length} errors` : ""),
    );
    for (const err of result.errors) {
      console.log(`  ⚠ ${err.page}: ${err.error}`);
    }
  });

disconnectCmd
  .command("notion")
  .description("Remove all Notion documents")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (opts: { yes?: boolean }) => {
    if (
      !(await confirmAction(
        "Disconnect Notion and remove all its documents? This cannot be undone.",
        !!opts.yes,
      ))
    ) {
      console.log("Cancelled.");
      return;
    }
    const { db } = initializeApp();
    try {
      const removed = await disconnectNotion(db);
      console.log(`✓ Removed ${removed} Notion documents.`);
    } finally {
      closeDatabase();
    }
  });

disconnectCmd
  .command("slack")
  .description("Remove all Slack data from the knowledge base")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (opts: { yes?: boolean }) => {
    if (
      !(await confirmAction(
        "Disconnect Slack and remove all its data? This cannot be undone.",
        !!opts.yes,
      ))
    ) {
      console.log("Cancelled.");
      return;
    }
    const { db } = initializeApp();
    try {
      const count = disconnectSlack(db);
      console.log(`✓ Removed ${count} Slack documents from the knowledge base.`);
    } finally {
      closeDatabase();
    }
  });

disconnectCmd
  .command("confluence")
  .description("Remove all Confluence-synced content")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (opts: { yes?: boolean }) => {
    if (
      !(await confirmAction(
        "Disconnect Confluence and remove all synced content? This cannot be undone.",
        !!opts.yes,
      ))
    ) {
      console.log("Cancelled.");
      return;
    }
    const { disconnectConfluence } = await import("../connectors/confluence.js");
    const { db } = initializeApp();
    try {
      const removed = disconnectConfluence(db);
      console.log(`✓ Removed ${removed} Confluence documents`);
    } finally {
      closeDatabase();
    }
  });

// update
program
  .command("update")
  .description("Update libscope to the latest version")
  .action(() => {
    const currentVersion = _pkg.version;
    console.log(`Current version: ${currentVersion}`);

    try {
      const latest = execSync("npm view libscope version", { encoding: "utf-8" }).trim();
      if (latest === currentVersion) {
        console.log("✓ Already up to date.");
        return;
      }
      console.log(`Latest version:  ${latest}`);
      console.log("Updating...");
      execSync("npm install -g libscope@latest", { stdio: "inherit" });
      console.log(`✓ Updated to ${latest}`);
    } catch {
      console.error("Failed to update. Try manually: npm install -g libscope@latest");
      process.exit(1);
    }
  });

// bulk
const bulkCmd = program.command("bulk").description("Bulk operations on documents");

bulkCmd
  .command("delete")
  .description("Delete multiple documents matching filters")
  .option("--topic <topicId>", "Filter by topic ID")
  .option("--library <name>", "Filter by library name")
  .option("--source-type <type>", "Filter by source type")
  .option("--tags <tags>", "Filter by tags (comma-separated)")
  .option("--dry-run", "Show what would be affected without making changes")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(
    async (opts: {
      topic?: string;
      library?: string;
      sourceType?: string;
      tags?: string;
      dryRun?: boolean;
      yes?: boolean;
    }) => {
      const { db } = initializeApp();
      try {
        const selector: BulkSelector = {};
        if (opts.topic) selector.topicId = opts.topic;
        if (opts.library) selector.library = opts.library;
        if (opts.sourceType) selector.sourceType = opts.sourceType;
        if (opts.tags) selector.tags = opts.tags.split(",").map((t) => t.trim());

        const result = bulkDelete(db, selector, true);
        console.log(`Found ${result.affected} document(s) matching filters.`);

        if (result.affected === 0) return;

        if (opts.dryRun) {
          for (const id of result.documentIds) {
            console.log(`  - ${id}`);
          }
          console.log("(dry run — no changes made)");
          return;
        }

        if (
          !(await confirmAction(
            `Delete ${result.affected} document(s)? This cannot be undone.`,
            !!opts.yes,
          ))
        ) {
          console.log("Cancelled.");
          return;
        }

        const actual = bulkDelete(db, selector);
        console.log(`✓ Deleted ${actual.affected} document(s).`);
      } finally {
        closeDatabase();
      }
    },
  );

bulkCmd
  .command("retag")
  .description("Add or remove tags from multiple documents")
  .option("--topic <topicId>", "Filter by topic ID")
  .option("--library <name>", "Filter by library name")
  .option("--source-type <type>", "Filter by source type")
  .option("--tags <tags>", "Filter by tags (comma-separated)")
  .option("--add-tags <tags>", "Tags to add (comma-separated)")
  .option("--remove-tags <tags>", "Tags to remove (comma-separated)")
  .option("--dry-run", "Show what would be affected without making changes")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(
    async (opts: {
      topic?: string;
      library?: string;
      sourceType?: string;
      tags?: string;
      addTags?: string;
      removeTags?: string;
      dryRun?: boolean;
      yes?: boolean;
    }) => {
      const { db } = initializeApp();
      try {
        const selector: BulkSelector = {};
        if (opts.topic) selector.topicId = opts.topic;
        if (opts.library) selector.library = opts.library;
        if (opts.sourceType) selector.sourceType = opts.sourceType;
        if (opts.tags) selector.tags = opts.tags.split(",").map((t) => t.trim());

        const addTags = opts.addTags ? opts.addTags.split(",").map((t) => t.trim()) : undefined;
        const removeTags = opts.removeTags
          ? opts.removeTags.split(",").map((t) => t.trim())
          : undefined;

        const result = bulkRetag(db, selector, addTags, removeTags, true);
        console.log(`Found ${result.affected} document(s) matching filters.`);

        if (result.affected === 0) return;

        if (opts.dryRun) {
          for (const id of result.documentIds) {
            console.log(`  - ${id}`);
          }
          console.log("(dry run — no changes made)");
          return;
        }

        if (!(await confirmAction(`Retag ${result.affected} document(s)?`, !!opts.yes))) {
          console.log("Cancelled.");
          return;
        }

        const actual = bulkRetag(db, selector, addTags, removeTags);
        console.log(`✓ Retagged ${actual.affected} document(s).`);
      } finally {
        closeDatabase();
      }
    },
  );

bulkCmd
  .command("move")
  .description("Move multiple documents to a different topic")
  .option("--topic <topicId>", "Filter by topic ID")
  .option("--library <name>", "Filter by library name")
  .option("--source-type <type>", "Filter by source type")
  .option("--tags <tags>", "Filter by tags (comma-separated)")
  .requiredOption("--to <targetTopicId>", "Target topic ID to move documents to")
  .option("--dry-run", "Show what would be affected without making changes")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(
    async (opts: {
      topic?: string;
      library?: string;
      sourceType?: string;
      tags?: string;
      to: string;
      dryRun?: boolean;
      yes?: boolean;
    }) => {
      const { db } = initializeApp();
      try {
        const selector: BulkSelector = {};
        if (opts.topic) selector.topicId = opts.topic;
        if (opts.library) selector.library = opts.library;
        if (opts.sourceType) selector.sourceType = opts.sourceType;
        if (opts.tags) selector.tags = opts.tags.split(",").map((t) => t.trim());

        const result = bulkMove(db, selector, opts.to, true);
        console.log(`Found ${result.affected} document(s) matching filters.`);

        if (result.affected === 0) return;

        if (opts.dryRun) {
          for (const id of result.documentIds) {
            console.log(`  - ${id}`);
          }
          console.log("(dry run — no changes made)");
          return;
        }

        if (
          !(await confirmAction(
            `Move ${result.affected} document(s) to topic "${opts.to}"?`,
            !!opts.yes,
          ))
        ) {
          console.log("Cancelled.");
          return;
        }

        const actual = bulkMove(db, selector, opts.to);
        console.log(`✓ Moved ${actual.affected} document(s) to topic "${opts.to}".`);
      } finally {
        closeDatabase();
      }
    },
  );

// Webhooks
const webhookCmd = program.command("webhooks").description("Manage webhooks");

webhookCmd
  .command("list")
  .description("List all registered webhooks")
  .action(() => {
    const { db } = initializeApp();
    try {
      const hooks = listWebhooks(db);
      if (hooks.length === 0) {
        console.log("No webhooks registered.");
      } else {
        console.log(`Found ${hooks.length} webhook(s):\n`);
        for (const h of hooks) {
          console.log(`  ${h.url}`);
          console.log(`    ID: ${h.id}`);
          console.log(`    Events: ${h.events.join(", ")}`);
          console.log(`    Active: ${h.active ? "yes" : "no"}`);
          if (h.lastTriggeredAt) console.log(`    Last triggered: ${h.lastTriggeredAt}`);
          if (h.failureCount > 0) console.log(`    Failures: ${h.failureCount}`);
          console.log();
        }
      }
    } finally {
      closeDatabase();
    }
  });

webhookCmd
  .command("create <url>")
  .description("Register a new webhook")
  .requiredOption(
    "--events <events>",
    "Comma-separated event types (e.g. document.created,document.updated)",
  )
  .option("--secret <secret>", "Secret for HMAC-SHA256 signature")
  .action((url: string, opts: { events: string; secret?: string }) => {
    const { db } = initializeApp();
    try {
      const events = opts.events.split(",").map((e) => e.trim()) as WebhookEvent[];
      const webhook = createWebhook(db, url, events, opts.secret);
      console.log(`✓ Webhook created: ${webhook.id}`);
      console.log(`  URL: ${webhook.url}`);
      console.log(`  Events: ${webhook.events.join(", ")}`);
    } finally {
      closeDatabase();
    }
  });

webhookCmd
  .command("delete <id>")
  .description("Delete a webhook")
  .action((id: string) => {
    const { db } = initializeApp();
    try {
      deleteWebhook(db, id);
      console.log(`✓ Webhook "${id}" deleted.`);
    } finally {
      closeDatabase();
    }
  });

webhookCmd
  .command("test <id>")
  .description("Send a test ping to a webhook")
  .action(async (id: string) => {
    const { db } = initializeApp();
    try {
      const webhook = getWebhook(db, id);
      const body = buildPayload("document.created", { test: true, message: "Webhook test ping" });
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (webhook.secret) {
        headers["X-LibScope-Signature"] = signPayload(body, webhook.secret);
      }
      console.log(`Sending test ping to ${webhook.url}...`);
      const resp = await fetch(webhook.url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(5000),
      });
      console.log(`✓ Response: ${resp.status} ${resp.statusText}`);
    } finally {
      closeDatabase();
    }
  });

// schedule
const scheduleCmd = program.command("schedule").description("Manage connector sync schedules");

scheduleCmd
  .command("list")
  .description("List all configured connector sync schedules")
  .action(async () => {
    const { loadScheduleEntries: loadEntries } = await import("../core/scheduler.js");
    const entries = loadEntries();
    if (entries.length === 0) {
      console.log("No scheduled syncs configured.");
      console.log(
        'Add a schedule to a connector config: libscope schedule set <connector> "<cron>"',
      );
      return;
    }
    console.log("Connector sync schedules:\n");
    for (const entry of entries) {
      console.log(`  ${entry.connectorName} (${entry.connectorType})`);
      console.log(`    Cron: ${entry.cronExpression}`);
      console.log();
    }
  });

scheduleCmd
  .command("set <connector> <cron>")
  .description('Set a sync schedule for a connector (e.g. schedule set notion "0 */6 * * *")')
  .action(async (connector: string, cronExpr: string) => {
    const nodeCron = await import("node-cron");
    if (!nodeCron.validate(cronExpr)) {
      console.error(`Invalid cron expression: "${cronExpr}"`);
      console.error("Examples: '0 */6 * * *' (every 6h), '0 0 * * *' (daily at midnight)");
      process.exit(1);
    }

    const {
      loadNamedConnectorConfig: loadCfg,
      saveNamedConnectorConfig: saveCfg,
      hasNamedConnectorConfig: hasCfg,
    } = await import("../connectors/index.js");

    if (!hasCfg(connector)) {
      console.error(
        `No connector config found for "${connector}". Run 'libscope connect ${connector}' first.`,
      );
      process.exit(1);
    }

    const config = loadCfg<Record<string, unknown>>(connector);
    config.schedule = { cronExpression: cronExpr };
    saveCfg(connector, config);
    console.log(`✓ Schedule set for ${connector}: ${cronExpr}`);
    console.log(
      "The schedule will be active when the API server is running (libscope serve --api)",
    );
  });

scheduleCmd
  .command("remove <connector>")
  .description("Remove the sync schedule for a connector")
  .action(async (connector: string) => {
    const {
      loadNamedConnectorConfig: loadCfg,
      saveNamedConnectorConfig: saveCfg,
      hasNamedConnectorConfig: hasCfg,
    } = await import("../connectors/index.js");

    if (!hasCfg(connector)) {
      console.error(`No connector config found for "${connector}".`);
      process.exit(1);
    }

    const config = loadCfg<Record<string, unknown>>(connector);
    if (!config.schedule) {
      console.error(`No schedule configured for "${connector}". Nothing to remove.`);
      process.exit(1);
    }
    delete config.schedule;
    saveCfg(connector, config);
    console.log(`✓ Schedule removed for ${connector}`);
  });

program.parse();
