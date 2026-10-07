/**
 * CLI contract tests: each command line maps to one operation with the expected input.
 * runOperation is replaced by a spy that returns a canned result, and bootstrap() by an
 * in-memory database, so nothing touches disk or the network.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { Command } from "commander";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Operation } from "../../src/core/operations/index.js";
import { createTestDb } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { testConfig } from "./operations/helpers.js";

const db = createTestDb();

vi.mock("../../src/core/bootstrap.js", () => ({
  bootstrap: (): unknown => ({
    db,
    provider: new MockEmbeddingProvider(),
    config: testConfig(),
    dbPath: ":memory:",
    close: (): void => {},
  }),
}));

const CANNED: Record<string, unknown> = {
  add: { kind: "file", documents: [], errors: [], skipped: [] },
  "get-document": { document: { title: "Doc" } },
  "bulk-delete": { affected: 2, documentIds: ["d1", "d2"] },
  "bulk-retag": { affected: 2, documentIds: ["d1", "d2"] },
  "bulk-move": { affected: 2, documentIds: ["d1", "d2"] },
  "create-pack": { name: "p", version: "1.0.0", documents: [] },
};

vi.mock("../../src/core/operations/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/operations/index.js")>();
  return {
    ...actual,
    runOperation: vi.fn(
      (op: Operation): Promise<unknown> => Promise.resolve(CANNED[op.name] ?? { items: [] }),
    ),
  };
});

const { runOperation } = await import("../../src/core/operations/index.js");
const { main, program } = await import("../../src/cli/index.js");

/** Run `libscope --json <args>` and return [operation name, input] of each operation call. */
async function invoke(args: string[]): Promise<Array<[string, unknown]>> {
  vi.mocked(runOperation).mockClear();
  await main(["node", "libscope", "--json", ...args]);
  expect(process.exitCode ?? 0).toBe(0);
  return vi.mocked(runOperation).mock.calls.map(([op, , input]) => [op.name, input]);
}

let home: string;
const savedHome = process.env["HOME"];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "libscope-cli-"));
  process.env["HOME"] = home;
});

afterAll(() => {
  process.env["HOME"] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

let stderrWrite: MockInstance;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

/** [argv, operation, expected input] for commands that call exactly one operation. */
const SINGLE: Array<[string[], string, Record<string, unknown>]> = [
  [
    ["add", "a.md", "--topic", "t", "--library", "lib", "--lib-version", "1", "--tags", "x, y"],
    "add",
    { source: "a.md", topic: "t", library: "lib", version: "1", tags: ["x", "y"] },
  ],
  [
    ["add", "https://e.com/docs", "--spider", "--max-pages", "5", "--no-same-domain"],
    "add",
    { source: "https://e.com/docs", spider: true, maxPages: 5, sameDomain: false },
  ],
  [
    ["add", "https://e.com/d", "--spider", "--exclude-urls", "*.pdf", "--path-prefix", "/d"],
    "add",
    { spider: true, sameDomain: true, excludePatterns: ["*.pdf"], pathPrefix: "/d" },
  ],
  [
    ["add", "https://github.com/o/r", "--branch", "dev", "--path", "docs,guide", "--token", "T"],
    "add",
    { source: "https://github.com/o/r", branch: "dev", paths: ["docs", "guide"], token: "T" },
  ],
  [
    ["add", "dir", "--include", "**/*.md", "--exclude", "drafts/**", "--dry-run"],
    "add",
    { source: "dir", include: ["**/*.md"], exclude: ["drafts/**"], dryRun: true },
  ],
  [
    [
      "add",
      "a.md",
      "--title",
      "T",
      "--format",
      ".txt",
      "--dedup",
      "skip",
      "--source-type",
      "topic",
    ],
    "add",
    { title: "T", format: ".txt", dedup: "skip", sourceType: "topic" },
  ],
  [
    ["search", "how", "--topic", "t", "--source-type", "library", "--tags", "a", "-n", "3"],
    "search",
    { query: "how", topic: "t", sourceType: "library", tags: ["a"], limit: 3 },
  ],
  [
    ["search", "q", "--offset", "2", "--min-rating", "4", "--max-per-doc", "1", "--context", "1"],
    "search",
    { query: "q", offset: 2, minRating: 4, maxChunksPerDocument: 1, contextChunks: 1 },
  ],
  [["search", "--related", "doc-1", "-n", "4"], "search", { relatedTo: "doc-1", limit: 4 }],
  [
    ["ask", "why?", "-n", "7", "--library", "lib", "--model", "m"],
    "ask",
    { question: "why?", topK: 7, library: "lib" },
  ],
  [
    ["docs", "list", "--library", "lib", "-n", "5", "--offset", "10"],
    "list-documents",
    { library: "lib", limit: 5, offset: 10 },
  ],
  [
    ["docs", "show", "d1", "--offset", "10", "--max-length", "100"],
    "get-document",
    { documentId: "d1", offset: 10, maxLength: 100 },
  ],
  [
    ["docs", "update", "d1", "--title", "T", "--lib-version", "2", "--tags", "a,b", "--topic", "t"],
    "update-document",
    { documentId: "d1", title: "T", version: "2", tags: ["a", "b"], topic: "t" },
  ],
  [["docs", "history", "d1"], "document-history", { documentId: "d1" }],
  [["docs", "rollback", "d1", "3"], "rollback-document", { documentId: "d1", version: 3 }],
  [
    ["docs", "rate", "d1", "4", "--feedback", "good", "--chunk", "c1"],
    "rate-document",
    { documentId: "d1", rating: 4, feedback: "good", chunkId: "c1" },
  ],
  [
    ["docs", "link", "d1", "d2", "--type", "prerequisite", "--label", "first"],
    "link-documents",
    { documentId: "d1", targetDocumentId: "d2", linkType: "prerequisite", label: "first" },
  ],
  [["docs", "unlink", "l1"], "unlink-documents", { linkId: "l1" }],
  [
    ["docs", "links", "d1", "--type", "related"],
    "list-links",
    { documentId: "d1", linkType: "related" },
  ],
  [["docs", "links"], "list-links", {}],
  [["docs", "prereqs", "d1"], "prerequisites", { documentId: "d1" }],
  [["docs", "tag", "d1", "a", "b,c"], "add-tags", { documentId: "d1", tags: ["a", "b", "c"] }],
  [["docs", "untag", "d1", "a"], "remove-tags", { documentId: "d1", tags: ["a"] }],
  [["docs", "suggest-tags", "d1", "-n", "3"], "suggest-tags", { documentId: "d1", limit: 3 }],
  [["topics", "list", "--parent", "p"], "list-topics", { parent: "p" }],
  [
    ["topics", "create", "n", "--description", "d", "--parent", "p"],
    "create-topic",
    { name: "n", description: "d", parent: "p" },
  ],
  [
    ["topics", "delete", "t", "--delete-documents", "-y"],
    "delete-topic",
    { topic: "t", deleteDocuments: true },
  ],
  [["tags", "list"], "list-tags", {}],
  [
    ["searches", "save", "n", "q", "--topic", "t", "-n", "5", "--min-rating", "3"],
    "save-search",
    { name: "n", query: "q", topic: "t", limit: 5, minRating: 3 },
  ],
  [
    ["searches", "list", "-n", "2", "--offset", "1"],
    "list-saved-searches",
    { limit: 2, offset: 1 },
  ],
  [["searches", "run", "n"], "run-saved-search", { search: "n" }],
  [["searches", "delete", "n"], "delete-saved-search", { search: "n" }],
  [["sync", "conn"], "sync", { name: "conn" }],
  [["sync", "--all"], "sync", { all: true }],
  [
    ["disconnect", "conn", "--type", "slack", "--keep-documents", "-y"],
    "disconnect",
    { name: "conn", type: "slack", keepDocuments: true },
  ],
  [["connections"], "list-connections", {}],
  [
    [
      "pack",
      "install",
      "./p.json",
      "--batch-size",
      "5",
      "--resume-from",
      "2",
      "--concurrency",
      "3",
    ],
    "install-pack",
    { pack: "./p.json", batchSize: 5, resumeFrom: 2, concurrency: 3 },
  ],
  [["pack", "remove", "p", "-y"], "remove-pack", { pack: "p" }],
  [["pack", "list"], "list-packs", {}],
  [
    ["pack", "list", "--available", "--registry", "https://r.example"],
    "list-packs",
    { available: true, registryUrl: "https://r.example" },
  ],
  [
    ["pack", "create", "--name", "p", "--from", "./src", "--exclude", "*.min.js"],
    "create-pack",
    { name: "p", from: ["./src"], outputPath: "p.json.gz", exclude: ["*.min.js"], recursive: true },
  ],
  [
    ["pack", "create", "--name", "p", "--topic", "t", "--pack-version", "2.0.0"],
    "create-pack",
    { name: "p", topic: "t", version: "2.0.0", outputPath: "p.json" },
  ],
  [
    ["webhooks", "create", "https://h.example", "--events", "document.created,document.deleted"],
    "create-webhook",
    { url: "https://h.example", events: ["document.created", "document.deleted"] },
  ],
  [["webhooks", "list"], "list-webhooks", {}],
  [["webhooks", "delete", "w1"], "delete-webhook", { webhookId: "w1" }],
  [["webhooks", "test", "w1"], "test-webhook", { webhookId: "w1" }],
  [["admin", "reindex", "--rebuild"], "reindex", { rebuild: true }],
  [
    ["admin", "reindex", "--doc", "d1", "d2", "--since", "2024-01-01", "--batch-size", "10"],
    "reindex",
    { documentIds: ["d1", "d2"], since: "2024-01-01", batchSize: 10 },
  ],
  [
    ["admin", "dedupe", "--threshold", "0.9", "--strategy", "exact"],
    "dedupe",
    { threshold: 0.9, strategy: "exact" },
  ],
  [["admin", "backup", "kb.json"], "backup", { outputPath: "kb.json" }],
  [["admin", "restore", "kb.json", "-y"], "restore", { backupPath: "kb.json" }],
  [["admin", "prune"], "prune-expired", {}],
];

describe("CLI command -> operation contract", () => {
  it.each(SINGLE)("%j calls %s", async (argv, opName, expected) => {
    const calls = await invoke(argv);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(opName);
    expect(calls[0]?.[1]).toMatchObject(expected);
  });

  it("leaves unset flags out so operation defaults apply", async () => {
    const [[, input]] = (await invoke(["search", "q"])) as [[string, unknown]];
    expect(input).toEqual({ query: "q" });
  });

  it("adds each source with its own operation call", async () => {
    const calls = await invoke(["add", "a.md", "b.md", "--library", "lib"]);
    expect(calls.map(([name, input]) => [name, (input as { source: string }).source])).toEqual([
      ["add", "a.md"],
      ["add", "b.md"],
    ]);
  });

  it("docs delete looks the document up, then deletes it", async () => {
    const calls = await invoke(["docs", "delete", "d1", "-y"]);
    expect(calls).toEqual([
      ["get-document", { documentId: "d1", maxLength: 0 }],
      ["delete-document", { documentId: "d1" }],
    ]);
  });

  it.each([
    [["bulk", "delete", "--topic", "t", "-y"], "bulk-delete", { topic: "t" }],
    [
      ["bulk", "retag", "--tags", "old", "--add", "a,b", "--remove", "c", "-y"],
      "bulk-retag",
      { tags: ["old"], addTags: ["a", "b"], removeTags: ["c"] },
    ],
    [
      ["bulk", "move", "--library", "lib", "--since", "2024-01-01", "--to", "t2", "-y"],
      "bulk-move",
      { library: "lib", dateFrom: "2024-01-01", targetTopic: "t2" },
    ],
  ])("%j previews (dryRun) and then applies %s", async (argv, opName, expected) => {
    const calls = await invoke(argv);
    expect(calls.map(([name]) => name)).toEqual([opName, opName]);
    expect(calls[0]?.[1]).toEqual({ ...expected, dryRun: true });
    expect(calls[1]?.[1]).toEqual(expected);
  });

  it("bulk --dry-run only previews", async () => {
    const calls = await invoke(["bulk", "delete", "--topic", "t", "--dry-run"]);
    expect(calls).toEqual([["bulk-delete", { topic: "t", dryRun: true }]]);
  });

  it("admin stats combines overview, popular, stale and search analytics", async () => {
    const calls = await invoke(["admin", "stats", "--days", "7"]);
    expect(calls).toEqual([
      ["overview", {}],
      ["popular", {}],
      ["stale", { days: 7 }],
      ["search-analytics", { days: 7 }],
    ]);
  });

  it("connect saves the connection (with schedule) and skips the sync with --no-sync", async () => {
    const vault = join(home, "vault");
    const calls = await invoke([
      "connect",
      "obsidian",
      vault,
      "--name",
      "notes",
      "--schedule",
      "0 * * * *",
      "--no-sync",
    ]);
    expect(calls).toEqual([]);
    const saved = JSON.parse(
      readFileSync(join(home, ".libscope", "connectors", "notes.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(saved).toMatchObject({
      connectorType: "obsidian",
      vaultPath: vault,
      topicMapping: "folder",
      excludePatterns: [],
      schedule: { cronExpression: "0 * * * *" },
    });

    // Re-running changes only what is given; "off" removes the schedule; then it syncs.
    const again = await invoke(["connect", "obsidian", "--name", "notes", "--schedule", "off"]);
    expect(again).toEqual([["sync", { name: "notes" }]]);
    const updated = JSON.parse(
      readFileSync(join(home, ".libscope", "connectors", "notes.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(updated["schedule"]).toBeUndefined();
    expect(updated["vaultPath"]).toBe(vault);
  });

  it("connect rejects missing required settings", async () => {
    await main(["node", "libscope", "connect", "slack", "--no-sync"]);
    expect(process.exitCode).toBe(1);
    expect(stderrWrite.mock.calls.join("")).toContain("Invalid Slack settings: token");
  });
});

/** Every leaf command path, e.g. "docs show". */
function leafCommands(cmd: Command, prefix: string[] = []): string[] {
  return cmd.commands.flatMap((sub) => {
    const path = [...prefix, sub.name()];
    return sub.commands.length > 0 ? leafCommands(sub, path) : [path.join(" ")];
  });
}

/** The command path an argv selects, e.g. ["docs", "show", "d1"] -> "docs show". */
function commandPath(argv: string[]): string {
  const path: string[] = [];
  let cmd: Command = program;
  for (const word of argv) {
    const sub = cmd.commands.find((c) => c.name() === word);
    if (!sub) break;
    path.push(word);
    cmd = sub;
  }
  return path.join(" ");
}

describe("CLI command set", () => {
  /** Commands not covered above: they do not call operations (files, servers, registries). */
  const NOT_OPERATIONS = new Set([
    "serve",
    "doctor",
    "config show",
    "config get",
    "config set",
    "config unset",
    "config path",
    "workspace create",
    "workspace list",
    "workspace use",
    "workspace delete",
  ]);

  it("covers every command with a contract test (registry commands are tested elsewhere)", () => {
    const tested = new Set([
      ...SINGLE.map(([argv]) => commandPath(argv)),
      "docs delete",
      "bulk delete",
      "bulk retag",
      "bulk move",
      "admin stats",
      "connect",
    ]);
    const missing = leafCommands(program).filter(
      (c) => !c.startsWith("registry ") && !NOT_OPERATIONS.has(c) && !tested.has(c),
    );
    expect(missing).toEqual([]);
  });

  it.each([
    "init",
    "import",
    "import-batch",
    "add-repo",
    "repl",
    "related",
    "ratings",
    "stats",
    "search-analytics",
    "watch",
    "dedupe",
    "reindex",
    "export",
    "import-backup",
    "link",
    "links",
    "unlink",
    "prereqs",
    "tag",
    "schedule",
    "update",
  ])("has no top-level %s command", (name) => {
    expect(program.commands.map((c) => c.name())).not.toContain(name);
  });
});
