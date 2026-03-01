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
    // Only create vector table if provider can be initialized without download
    try {
      const provider = createEmbeddingProvider(config);
      createVectorTable(db, provider.dimensions);
    } catch {
      console.log("  ℹ Vector table skipped (embedding provider not available)");
    }
    console.log(`✓ Database initialized at ${config.database.path}`);
    closeDatabase();
  });

// add
program
  .command("add <fileOrUrl>")
  .description("Index a document from a file or URL")
  .option("--topic <topicId>", "Assign to a topic")
  .option("--library <name>", "Mark as library documentation")
  .option("--version <version>", "Library version")
  .option("--title <title>", "Override document title")
  .action(
    async (
      fileOrUrl: string,
      opts: { topic?: string; library?: string; version?: string; title?: string },
    ) => {
      const { db, provider } = initializeAppWithEmbedding();

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
      });

      console.log(`✓ Indexed "${title}" (${result.chunkCount} chunks)`);
      console.log(`  ID: ${result.id}`);
      closeDatabase();
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
  .action(
    async (
      directory: string,
      opts: { topic?: string; library?: string; version?: string; extensions: string },
    ) => {
      const { db, provider } = initializeAppWithEmbedding();

      const extensions = new Set(opts.extensions.split(",").map((e) => e.trim().toLowerCase()));
      const files = findFiles(directory, extensions);

      if (files.length === 0) {
        console.log(`No matching files found in ${directory}`);
        closeDatabase();
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
      closeDatabase();
    },
  );

// search
program
  .command("search <query>")
  .description("Search indexed documents")
  .option("--topic <topicId>", "Filter by topic")
  .option("--library <name>", "Filter by library")
  .option("--limit <n>", "Max results", "5")
  .action(async (query: string, opts: { topic?: string; library?: string; limit: string }) => {
    const { db, provider } = initializeAppWithEmbedding();

    const results = await searchDocuments(db, provider, {
      query,
      topic: opts.topic,
      library: opts.library,
      limit: parseInt(opts.limit, 10),
    });

    if (results.length === 0) {
      console.log("No results found.");
    } else {
      for (const r of results) {
        console.log(`\n── ${r.title} (score: ${r.score.toFixed(2)}) ──`);
        if (r.library) console.log(`  Library: ${r.library}`);
        if (r.url) console.log(`  Source: ${r.url}`);
        console.log(`  ${r.content.slice(0, 200)}${r.content.length > 200 ? "..." : ""}`);
      }
    }
    closeDatabase();
  });

// topics
const topicsCmd = program.command("topics").description("Manage topics");

topicsCmd
  .command("list")
  .description("List all topics")
  .action(() => {
    const { db } = initializeApp();

    const topics = listTopics(db);
    if (topics.length === 0) {
      console.log("No topics found. Create one with: libscope topics create <name>");
    } else {
      for (const t of topics) {
        console.log(`  ${t.id} — ${t.name}${t.description ? ` (${t.description})` : ""}`);
      }
    }
    closeDatabase();
  });

topicsCmd
  .command("create <name>")
  .description("Create a new topic")
  .option("--description <desc>", "Topic description")
  .option("--parent <parentId>", "Parent topic ID")
  .action((name: string, opts: { description?: string; parent?: string }) => {
    const { db } = initializeApp();

    const topic = createTopic(db, {
      name,
      description: opts.description,
      parentId: opts.parent,
    });
    console.log(`✓ Topic created: ${topic.id} (${topic.name})`);
    closeDatabase();
  });

// ratings
const ratingsCmd = program.command("ratings").description("View document ratings");

ratingsCmd
  .command("show <documentId>")
  .description("Show ratings for a document")
  .action((documentId: string) => {
    const { db } = initializeApp();

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
    closeDatabase();
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
        if (d.library) console.log(`    Library: ${d.library}${d.version ? ` v${d.version}` : ""}`);
        if (d.url) console.log(`    URL: ${d.url}`);
        console.log(`    Type: ${d.sourceType}  |  Updated: ${d.updatedAt}`);
        console.log();
      }
    }
    closeDatabase();
  });

docsCmd
  .command("show <documentId>")
  .description("Show a specific document")
  .action((documentId: string) => {
    const { db } = initializeApp();

    const doc = getDocument(db, documentId);
    console.log(`\n# ${doc.title}\n`);
    console.log(`ID: ${doc.id}`);
    console.log(`Type: ${doc.sourceType}`);
    if (doc.library) console.log(`Library: ${doc.library}${doc.version ? ` v${doc.version}` : ""}`);
    if (doc.url) console.log(`URL: ${doc.url}`);
    console.log(`Submitted by: ${doc.submittedBy}`);
    console.log(`Created: ${doc.createdAt}`);
    console.log(`Updated: ${doc.updatedAt}`);
    console.log(`\n---\n`);
    console.log(doc.content);
    closeDatabase();
  });

docsCmd
  .command("delete <documentId>")
  .description("Delete a document by ID")
  .action((documentId: string) => {
    const { db } = initializeApp();

    const doc = getDocument(db, documentId);
    deleteDocument(db, documentId);
    console.log(`✓ Deleted "${doc.title}" (${documentId})`);
    closeDatabase();
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

program.parse();
