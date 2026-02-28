#!/usr/bin/env node

import { Command } from "commander";
import { loadConfig, saveUserConfig } from "../config.js";
import { getDatabase, runMigrations, createVectorTable, closeDatabase } from "../db/index.js";
import { createEmbeddingProvider } from "../providers/index.js";
import { indexDocument } from "../core/indexing.js";
import { searchDocuments } from "../core/search.js";
import { getDocumentRatings, listRatings } from "../core/ratings.js";
import { createTopic, listTopics } from "../core/topics.js";
import { getDocument } from "../core/documents.js";
import { initLogger, type LogLevel } from "../logger.js";
import { readFileSync } from "node:fs";

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
    const config = loadConfig();
    setupLogging(program.opts() as ProgramOpts);
    const db = getDatabase(config.database.path);
    runMigrations(db);
    const provider = createEmbeddingProvider(config);
    createVectorTable(db, provider.dimensions);
    console.log(`✓ Database initialized at ${config.database.path}`);
    closeDatabase();
  });

// add
program
  .command("add <file>")
  .description("Index a document from a file")
  .option("--topic <topicId>", "Assign to a topic")
  .option("--library <name>", "Mark as library documentation")
  .option("--version <version>", "Library version")
  .option("--url <url>", "Source URL")
  .action(async (file: string, opts: { topic?: string; library?: string; version?: string; url?: string }) => {
    const config = loadConfig();
    setupLogging(program.opts() as ProgramOpts);
    const db = getDatabase(config.database.path);
    runMigrations(db);
    const provider = createEmbeddingProvider(config);
    createVectorTable(db, provider.dimensions);

    const content = readFileSync(file, "utf-8");
    const title = file.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");

    const result = await indexDocument(db, provider, {
      title,
      content,
      sourceType: opts.library ? "library" : opts.topic ? "topic" : "manual",
      library: opts.library,
      version: opts.version,
      topicId: opts.topic,
      url: opts.url,
    });

    console.log(`✓ Indexed "${title}" (${result.chunkCount} chunks)`);
    console.log(`  ID: ${result.id}`);
    closeDatabase();
  });

// search
program
  .command("search <query>")
  .description("Search indexed documents")
  .option("--topic <topicId>", "Filter by topic")
  .option("--library <name>", "Filter by library")
  .option("--limit <n>", "Max results", "5")
  .action(async (query: string, opts: { topic?: string; library?: string; limit: string }) => {
    const config = loadConfig();
    setupLogging(program.opts() as ProgramOpts);
    const db = getDatabase(config.database.path);
    runMigrations(db);
    const provider = createEmbeddingProvider(config);
    createVectorTable(db, provider.dimensions);

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
    const config = loadConfig();
    setupLogging(program.opts() as ProgramOpts);
    const db = getDatabase(config.database.path);
    runMigrations(db);

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
    const config = loadConfig();
    setupLogging(program.opts() as ProgramOpts);
    const db = getDatabase(config.database.path);
    runMigrations(db);

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
    const config = loadConfig();
    setupLogging(program.opts() as ProgramOpts);
    const db = getDatabase(config.database.path);
    runMigrations(db);

    const doc = getDocument(db, documentId);
    const summary = getDocumentRatings(db, documentId);
    const ratings = listRatings(db, documentId);

    console.log(`\nRatings for: ${doc.title}`);
    console.log(`  Average: ${summary.averageRating.toFixed(1)}/5 (${summary.totalRatings} ratings)`);
    console.log(`  Corrections suggested: ${summary.corrections}`);

    if (ratings.length > 0) {
      console.log("\nRecent ratings:");
      for (const r of ratings.slice(0, 10)) {
        console.log(`  ${r.rating}/5 by ${r.ratedBy} — ${r.feedback ?? "(no feedback)"}`);
      }
    }
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
    : (opts.logLevel as LogLevel | undefined) ?? loadConfig().logging.level;
  initLogger(level);
}

program.parse();
