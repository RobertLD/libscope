#!/usr/bin/env node

import { Command } from "commander";
import { loadConfig, saveUserConfig } from "../config.js";
import { getDatabase, runMigrations, createVectorTable, closeDatabase } from "../db/index.js";
import { createEmbeddingProvider } from "../providers/index.js";
import { indexDocument } from "../core/indexing.js";
import { searchDocuments } from "../core/search.js";
import { getDocumentRatings, listRatings } from "../core/ratings.js";
import { createTopic, listTopics } from "../core/topics.js";
import { getDocument, listDocuments, deleteDocument } from "../core/documents.js";
import { initLogger, type LogLevel } from "../logger.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { fetchAndConvert } from "../core/url-fetcher.js";
import { exportKnowledgeBase, importFromBackup } from "../core/export.js";
import { batchImport } from "../core/batch.js";
import { findDuplicates } from "../core/dedup.js";
import { startRepl } from "./repl.js";
import {
  addTagsToDocument,
  removeTagFromDocument,
  listTags,
  getDocumentTags,
} from "../core/tags.js";

import { FileWatcher, DEFAULT_WATCH_EXTENSIONS } from "../core/watcher.js";

// Graceful shutdown
process.on("SIGINT", () => {
  closeDatabase();
  process.exit(0);
});
process.on("SIGTERM", () => {
  closeDatabase();
  process.exit(0);
});

const program = new Command();

program
  .name("libscope")
  .description("AI-powered knowledge base with MCP integration")
  .version("0.1.0")
  .option("--verbose", "Enable verbose logging")
  .option("--log-level <level>", "Set log level (debug, info, warn, error, silent)");

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
  .description("Index a document from a file or URL")
  .option("--topic <topicId>", "Assign to a topic")
  .option("--library <name>", "Mark as library documentation")
  .option("--version <version>", "Library version")
  .option("--title <title>", "Override document title")
  .option("--dedup <mode>", "Dedup mode: skip, warn, or force")
  .action(
    async (
      fileOrUrl: string,
      opts: { topic?: string; library?: string; version?: string; title?: string; dedup?: string },
    ) => {
      const { db, provider } = initializeAppWithEmbedding();
      try {
        let content: string;
        let title: string;
        let url: string | undefined;

        if (fileOrUrl.startsWith("http://") || fileOrUrl.startsWith("https://")) {
          console.log(`Fetching ${fileOrUrl}...`);
          const fetched = await fetchAndConvert(fileOrUrl);
          content = fetched.content;
          title = opts.title ?? fetched.title;
          url = fileOrUrl;
        } else {
          content = readFileSync(fileOrUrl, "utf-8");
          title = opts.title ?? basename(fileOrUrl).replace(/\.[^.]+$/, "");
        }

        const result = await indexDocument(db, provider, {
          title,
          content,
          sourceType: opts.library ? "library" : opts.topic ? "topic" : "manual",
          library: opts.library,
          version: opts.version,
          topicId: opts.topic,
          url,
          dedup: opts.dedup as "skip" | "warn" | "force" | undefined,
        });

        console.log(`✓ Indexed "${title}" (${result.chunkCount} chunks)`);
        console.log(`  ID: ${result.id}`);
      } finally {
        closeDatabase();
      }
    },
  );

// import
program
  .command("import <directory>")
  .description("Bulk import markdown files from a directory")
  .option("--topic <topicId>", "Assign all to a topic")
  .option("--library <name>", "Mark all as library documentation")
  .option("--version <version>", "Library version")
  .option("--extensions <exts>", "Comma-separated file extensions to include", ".md,.mdx,.txt")
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
            const content = readFileSync(file, "utf-8");
            const title = basename(file).replace(/\.[^.]+$/, "");

            const result = await indexDocument(db, provider, {
              title,
              content,
              sourceType: opts.library ? "library" : opts.topic ? "topic" : "manual",
              library: opts.library,
              version: opts.version,
              topicId: opts.topic,
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
          concurrency: parseInt(opts.concurrency, 10),
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
  .option("--limit <n>", "Max results", "5")
  .option("--offset <n>", "Offset for pagination", "0")
  .action(
    async (
      query: string,
      opts: { topic?: string; library?: string; limit: string; offset: string },
    ) => {
      const { db, provider } = initializeAppWithEmbedding();
      try {
        const { results, totalCount } = await searchDocuments(db, provider, {
          query,
          topic: opts.topic,
          library: opts.library,
          limit: parseInt(opts.limit, 10),
          offset: parseInt(opts.offset, 10),
        });

        if (results.length === 0) {
          console.log("No results found.");
        } else {
          console.log(`\nShowing ${results.length} of ${totalCount} results:\n`);
          for (const r of results) {
            console.log(`\n── ${r.title} (score: ${r.score.toFixed(2)}) ──`);
            if (r.library) console.log(`  Library: ${r.library}`);
            if (r.url) console.log(`  Source: ${r.url}`);
            console.log(`  ${r.content.slice(0, 200)}${r.content.length > 200 ? "..." : ""}`);
          }
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
        limit: parseInt(opts.limit, 10),
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
  .action((documentId: string) => {
    const { db } = initializeApp();
    try {
      const doc = getDocument(db, documentId);
      deleteDocument(db, documentId);
      console.log(`✓ Deleted "${doc.title}" (${documentId})`);
    } finally {
      closeDatabase();
    }
  });

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
  .description("Start the MCP server")
  .action(async () => {
    // Import and run the MCP server
    await import("../mcp/server.js");
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
}

function setupLogging(opts: ProgramOpts): void {
  const level: LogLevel = opts.verbose
    ? "debug"
    : ((opts.logLevel as LogLevel | undefined) ?? loadConfig().logging.level);
  initLogger(level);
}

/** Shared CLI initialization: loadConfig → setupLogging → getDatabase → runMigrations. */
function initializeApp() {
  const config = loadConfig();
  setupLogging(program.opts());
  const db = getDatabase(config.database.path);
  runMigrations(db);
  return { config, db };
}

/** Initialization with an embedding provider and vector table. */
function initializeAppWithEmbedding() {
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
    const debounceMs = parseInt(opts.debounce, 10);

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
      onIndex: (path) => console.log(`  ✓ Indexed: ${path}`),
      onRemove: (path) => console.log(`  ✗ Removed: ${path}`),
      onError: (err) => console.error(`  ⚠ Error: ${err.message}`),
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

// repl (interactive search)
program
  .command("repl")
  .description("Start an interactive search REPL")
  .option("--limit <n>", "Max results per search", "5")
  .action(async (opts: { limit: string }) => {
    const { db, provider } = initializeAppWithEmbedding();
    try {
      await startRepl({ db, provider, limit: parseInt(opts.limit, 10) });
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

program.parse();
