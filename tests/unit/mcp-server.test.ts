import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpToolsetSetting } from "../../src/config.js";
import type { LlmProvider } from "../../src/core/rag.js";
import { createDatabase } from "../../src/db/connection.js";
import { createVectorTable, runMigrations } from "../../src/db/schema.js";
import { LibScopeError, ValidationError, DocumentNotFoundError } from "../../src/errors.js";
import { initLogger } from "../../src/logger.js";
import { errorResponse, withErrorHandling, type ToolResult } from "../../src/mcp/errors.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { addDoc, makeContext, testConfig, type TestContext } from "./operations/helpers.js";

// Saved connector settings live under a temp HOME, never the real ~/.libscope.
let tempHome = join(tmpdir(), `libscope-mcp-${process.pid}`);
vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: (): string => tempHome };
});

const { createMcpServer, resolveToolsets, buildInstructions } =
  await import("../../src/mcp/server.js");
const { saveConnectorSettings } = await import("../../src/connectors/saved-config.js");
const { taskRegistry } = await import("../../src/core/tasks.js");

initLogger("silent");

const CORE_TOOLS = [
  "search",
  "ask",
  "get-document",
  "list-documents",
  "overview",
  "submit-document",
  "update-document",
  "delete-document",
  "rate-document",
  "link-documents",
  "task",
];
const ADMIN_TOOLS = ["sync", "install-pack", "list-packs", "reindex-documents"];

const fakeLlm: LlmProvider = {
  model: "fake-model",
  complete: () => Promise.resolve({ text: "The answer is 42.", tokensUsed: 9 }),
};

interface CallResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

/**
 * MCP context where `ask` is passthrough (llm.provider "auto" on the MCP surface), on a
 * database with a real sqlite-vec table so `search {relatedTo}` works.
 */
function passthroughContext(): TestContext {
  const db = createDatabase(":memory:");
  runMigrations(db);
  createVectorTable(db, new MockEmbeddingProvider());
  return makeContext({ db, surface: "mcp", llm: undefined });
}

async function connect(
  t: TestContext,
  toolsets: McpToolsetSetting[] = [],
): Promise<{ client: Client; close: () => Promise<void> }> {
  const mcp = createMcpServer({ ctx: t.ctx, toolsets });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async (): Promise<void> => {
      await client.close();
      await mcp.close();
    },
  };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; text: string }> {
  const result = (await client.callTool({ name, arguments: args })) as CallResult;
  const text = result.content.map((c) => c.text ?? "").join("\n");
  return { isError: result.isError === true, text };
}

async function callOk(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = await call(client, name, args);
  expect(result.isError, result.text).toBe(false);
  return result.text;
}

async function callError(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = await call(client, name, args);
  expect(result.isError, result.text).toBe(true);
  return result.text;
}

/** documentId from a submit-document result. */
function idFrom(text: string, key = "documentId"): string {
  const match = new RegExp(`${key}: ([\\w-]+)`).exec(text);
  if (!match?.[1]) throw new Error(`no ${key} in: ${text}`);
  return match[1];
}

async function waitForTask(taskId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const status = taskRegistry.get(taskId)?.status;
    if (status && status !== "pending" && status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`task ${taskId} did not finish`);
}

describe("MCP error helpers", () => {
  it("errorResponse formats LibScopeError, Error and other values", () => {
    expect(errorResponse(new ValidationError("invalid input")).content[0]!.text).toBe(
      "Error: invalid input",
    );
    expect(errorResponse(new TypeError("bad type")).content[0]!.text).toBe(
      "Error: TypeError: bad type",
    );
    expect(errorResponse("raw").content[0]!.text).toContain("raw");
    expect(errorResponse(new LibScopeError("base")).isError).toBe(true);
    expect(() => errorResponse(undefined)).not.toThrow();
  });

  it("withErrorHandling passes results through and converts throws and rejections", async () => {
    const ok: ToolResult = { content: [{ type: "text", text: "ok" }] };
    expect(await withErrorHandling(() => ok)({})).toEqual(ok);
    const thrown = await withErrorHandling(() => {
      throw new ValidationError("bad input");
    })({});
    expect(thrown.isError).toBe(true);
    const rejected = await withErrorHandling(() =>
      Promise.reject(new DocumentNotFoundError("doc-123")),
    )({});
    expect(rejected.content[0]!.text).toContain("doc-123");
  });
});

describe("MCP server: tool list", () => {
  let t: TestContext;

  beforeEach(() => {
    t = passthroughContext();
  });

  afterEach(() => {
    t.db.close();
    vi.unstubAllEnvs();
  });

  it("registers the 11 core tools with annotations", async () => {
    const { client, close } = await connect(t);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(CORE_TOOLS);

    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of ["search", "ask", "get-document", "list-documents", "overview"]) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
    }
    expect(byName.get("delete-document")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(byName.get("update-document")?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(byName.get("submit-document")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(byName.get("link-documents")?.annotations).toMatchObject({ destructiveHint: true });
    expect(byName.get("task")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    for (const tool of tools) expect(tool.description, tool.name).toBeTruthy();
    await close();
  });

  it("generates input schemas from the operations", async () => {
    const { client, close } = await connect(t);
    const { tools } = await client.listTools();
    const props = (name: string): Record<string, { enum?: string[] }> =>
      (tools.find((tool) => tool.name === name)?.inputSchema.properties ?? {}) as Record<
        string,
        { enum?: string[] }
      >;

    expect(Object.keys(props("search"))).toEqual(
      expect.arrayContaining(["query", "relatedTo", "topic", "library", "version", "sourceType"]),
    );
    expect(Object.keys(props("search"))).toEqual(
      expect.arrayContaining(["tags", "minRating", "limit", "offset"]),
    );
    const submit = Object.keys(props("submit-document"));
    expect(submit).toEqual(expect.arrayContaining(["content", "title", "url", "spider", "async"]));
    for (const local of ["source", "kind", "format", "include", "exclude", "token"]) {
      expect(submit).not.toContain(local);
    }
    expect(Object.keys(props("update-document"))).toContain("tags");
    expect(Object.keys(props("get-document"))).toEqual(
      expect.arrayContaining(["documentId", "offset", "maxLength"]),
    );
    expect(props("link-documents")["action"]?.enum).toEqual(["create", "delete"]);
    expect(Object.keys(props("link-documents"))).toEqual(
      expect.arrayContaining(["documentId", "targetDocumentId", "linkType", "linkId"]),
    );
    expect(props("task")["action"]?.enum).toEqual(["status", "cancel", "list"]);
    expect(Object.keys(props("search"))).not.toContain("async");
    await close();
  });

  it("adds the admin toolset only when enabled", async () => {
    const settings: McpToolsetSetting[][] = [["admin"], ["all"], ["core", "admin"]];
    for (const toolsets of settings) {
      const { client, close } = await connect(t, toolsets);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([...CORE_TOOLS, ...ADMIN_TOOLS]);
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      expect(byName.get("list-packs")?.annotations?.readOnlyHint).toBe(true);
      expect(byName.get("sync")?.inputSchema.properties).not.toHaveProperty("token");
      await close();
    }
  });

  it("reads mcp.toolsets from config when no toolsets are passed", () => {
    const withAdmin = makeContext({
      db: t.db,
      surface: "mcp",
      llm: undefined,
      config: { ...testConfig(), mcp: { toolsets: ["admin"] } },
    });
    expect(createMcpServer({ ctx: withAdmin.ctx }).tools).toEqual([...CORE_TOOLS, ...ADMIN_TOOLS]);
    expect(createMcpServer({ ctx: t.ctx }).tools).toEqual(CORE_TOOLS);
  });

  it("resolveToolsets expands 'all' and ignores 'core'", () => {
    expect([...resolveToolsets(["admin"])]).toEqual(["admin"]);
    expect([...resolveToolsets(["all"])]).toEqual(["admin"]);
    expect([...resolveToolsets(["core"])]).toEqual([]);
    expect([...resolveToolsets([])]).toEqual([]);
  });

  it("omits ask when no LLM is configured and passthrough is off", async () => {
    const noLlm = makeContext({ db: t.db, surface: "mcp", llm: null });
    const { client, close } = await connect(noLlm);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("ask");
    expect(names).toHaveLength(10);
    expect(client.getInstructions()).not.toContain("ask {question}");
    await close();
  });

  it("registers ask with a configured LLM and returns its answer", async () => {
    await addDoc(t, "Answers", "The answer to everything is documented here");
    const withLlm = makeContext({ db: t.db, surface: "mcp", llm: fakeLlm });
    const { client, close } = await connect(withLlm);
    const text = await callOk(client, "ask", { question: "What is the answer?" });
    expect(text).toContain("The answer is 42.");
    expect(text).toContain("model: fake-model");
    expect(client.getInstructions()).toContain("configured LLM");
    await close();
  });

  it("sends instructions and the package version", async () => {
    const { client, close } = await connect(t, ["admin"]);
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };
    expect(client.getServerVersion()).toEqual({ name: "libscope", version: pkg.version });
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("search {query}");
    expect(instructions).toContain("get-document {documentId}");
    expect(instructions).toContain("rate-document");
    expect(instructions).toContain("without calling an LLM");
    expect(instructions).toContain("Admin tools");
    await close();
  });

  it("buildInstructions leaves out ask and admin when unavailable", () => {
    const text = buildInstructions({ ask: false, passthrough: false, admin: false });
    expect(text).not.toContain("ask {question}");
    expect(text).not.toContain("Admin tools");
  });
});

describe("MCP server: tool calls", () => {
  let t: TestContext;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    tempHome = join(tmpdir(), `libscope-mcp-${randomUUID()}`);
    mkdirSync(tempHome, { recursive: true });
    t = passthroughContext();
    ({ client, close } = await connect(t, ["admin"]));
  });

  afterEach(async () => {
    await close();
    t.db.close();
    rmSync(tempHome, { recursive: true, force: true });
  });

  async function submit(title: string, content: string): Promise<string> {
    return idFrom(await callOk(client, "submit-document", { title, content }));
  }

  it("search: finds by query and relatedTo, with IDs; rejects bad input", async () => {
    const id = await submit("Kubernetes", "Kubernetes pods and deployments explained");
    await submit("Pods", "More about kubernetes pods");

    const text = await callOk(client, "search", { query: "kubernetes pods" });
    expect(text).toMatch(/^Results 1-2 of 2/);
    expect(text).toContain(`documentId: ${id}`);
    expect(text).toContain("chunkId: ");

    const related = await callOk(client, "search", { relatedTo: id });
    expect(related).not.toContain(`documentId: ${id}`);

    expect(await callOk(client, "search", { query: "kubernetes", library: "none" })).toBe(
      "No results found.",
    );
    expect(await callError(client, "search", {})).toContain("Give either query or relatedTo");
    expect(await callError(client, "search", { query: 5 })).toMatch(/query/);
    expect(await callError(client, "search", { query: "x", limit: 0 })).toMatch(/limit/);
  });

  it("ask: passthrough returns the retrieved context; rejects a missing question", async () => {
    const id = await submit("Deploys", "Deploy with kubectl apply");
    const text = await callOk(client, "ask", { question: "How do I deploy?" });
    expect(text).toContain("Passthrough mode");
    expect(text).toContain("How do I deploy?");
    expect(text).toContain(`documentId: ${id}`);
    expect(await callError(client, "ask", {})).toMatch(/question/);
  });

  it("get-document: returns metadata, tags, links and paged content", async () => {
    const id = await submit("Guide", "abcdefghij".repeat(5));
    const other = await submit("Other", "Other content");
    const linkText = await callOk(client, "link-documents", {
      action: "create",
      documentId: id,
      targetDocumentId: other,
      linkType: "see_also",
    });
    const linkId = idFrom(linkText, "linkId");
    await callOk(client, "update-document", { documentId: id, tags: ["k8s"] });

    const full = await callOk(client, "get-document", { documentId: id });
    expect(full).toContain("# Guide");
    expect(full).toContain(`documentId: ${id}`);
    expect(full).toContain("tags: k8s");
    expect(full).toContain(`linkId: ${linkId}`);

    const page = await callOk(client, "get-document", { documentId: id, maxLength: 20 });
    expect(page).toContain("characters 0-20 of 50; next page: offset 20");
    const last = await callOk(client, "get-document", { documentId: id, offset: 40 });
    expect(last).toContain("characters 40-50 of 50]");

    expect(await callError(client, "get-document", { documentId: "missing" })).toContain("missing");
    expect(await callError(client, "get-document", {})).toMatch(/documentId/);
  });

  it("list-documents: pages with offset and total", async () => {
    const a = await submit("Doc A", "Content A");
    await submit("Doc B", "Content B");
    const first = await callOk(client, "list-documents", { limit: 1 });
    expect(first).toContain("Documents 1-1 of 2 — next page: offset 1");
    const second = await callOk(client, "list-documents", { limit: 1, offset: 1 });
    expect(second).toContain("Documents 2-2 of 2");
    expect(first + second).toContain(`documentId: ${a}`);
    expect(await callError(client, "list-documents", { limit: 0 })).toMatch(/limit/);
  });

  it("overview: shows counts, health and index", async () => {
    await submit("Doc", "Content");
    const text = await callOk(client, "overview");
    expect(text).toContain("Documents: 1");
    expect(text).toContain("Health: database ok");
    expect(text).toContain("Index embeddings:");
  });

  it("submit-document: content, async task, and invalid input", async () => {
    const text = await callOk(client, "submit-document", {
      title: "Inline",
      content: "Inline content",
      tags: ["a"],
    });
    expect(text).toContain("Added 1 document(s).");
    expect(text).toMatch(/documentId: [\w-]+, 1 chunks/);

    const started = await callOk(client, "submit-document", {
      title: "Background",
      content: "Background content",
      async: true,
    });
    const taskId = idFrom(started, "taskId");
    await waitForTask(taskId);
    const status = await callOk(client, "task", { action: "status", taskId });
    expect(status).toContain("completed");
    expect(status).toContain("Added 1 document(s).");
    expect(status).toContain("Background (documentId: ");

    expect(await callError(client, "submit-document", {})).toContain("Provide content");
    // Checked before a background task starts: the error comes back at once, with no taskId.
    const background = await callError(client, "submit-document", { async: true });
    expect(background).toContain("Provide content");
    expect(background).not.toContain("taskId");
    expect(await callError(client, "submit-document", { url: "/etc/passwd" })).toMatch(/url/);
    expect(await callError(client, "submit-document", { title: "T", content: "" })).toMatch(
      /content/,
    );
  });

  it("update-document: changes fields and tags; rejects empty updates", async () => {
    const id = await submit("Old", "Old content");
    const text = await callOk(client, "update-document", {
      documentId: id,
      title: "New",
      tags: ["x", "y"],
    });
    expect(text).toContain("# New");
    expect(text).toContain("tags: x, y");
    expect(await callError(client, "update-document", { documentId: id })).toContain(
      "Nothing to update",
    );
    expect(
      await callError(client, "update-document", { documentId: "missing", title: "x" }),
    ).toContain("missing");
  });

  it("delete-document: deletes; errors for unknown IDs", async () => {
    const id = await submit("Gone", "Soon gone");
    expect(await callOk(client, "delete-document", { documentId: id })).toBe(
      `Deleted document ${id}.`,
    );
    await callError(client, "get-document", { documentId: id });
    await callError(client, "delete-document", { documentId: id });
    await callError(client, "delete-document", {});
  });

  it("rate-document: records a rating; rejects out-of-range ratings", async () => {
    const id = await submit("Rated", "Rated content");
    const text = await callOk(client, "rate-document", {
      documentId: id,
      rating: 4,
      feedback: "useful",
    });
    expect(text).toContain(`Rated 4/5 (documentId: ${id})`);
    expect(text).toContain("feedback saved");
    expect(await callOk(client, "get-document", { documentId: id })).toContain(
      "rating: 4.0/5 (1 ratings)",
    );
    await callError(client, "rate-document", { documentId: id, rating: 6 });
    await callError(client, "rate-document", { documentId: "missing", rating: 3 });
  });

  it("link-documents: creates and deletes links; validates per action", async () => {
    const a = await submit("A", "Doc A");
    const b = await submit("B", "Doc B");
    const created = await callOk(client, "link-documents", {
      action: "create",
      documentId: a,
      targetDocumentId: b,
      linkType: "prerequisite",
      label: "read first",
    });
    expect(created).toContain(`Linked ${a} -> ${b} (prerequisite) "read first"`);
    const linkId = idFrom(created, "linkId");
    expect(await callOk(client, "link-documents", { action: "delete", linkId })).toBe(
      `Deleted link ${linkId}.`,
    );

    expect(await callError(client, "link-documents", { action: "create", documentId: a })).toMatch(
      /targetDocumentId/,
    );
    expect(await callError(client, "link-documents", { action: "delete" })).toMatch(/linkId/);
    await callError(client, "link-documents", { action: "rename", linkId });
    await callError(client, "link-documents", { action: "delete", linkId: "missing" });
  });

  it("task: status, cancel and list; errors for unknown tasks", async () => {
    const { task } = taskRegistry.run(
      "operation",
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason as Error));
        }),
      "add",
    );
    const running = await callOk(client, "task", { action: "status", taskId: task.id });
    expect(running).toContain(`taskId: ${task.id}`);
    expect(running).toContain("running");
    expect(await callOk(client, "task", { action: "list" })).toContain(task.id);

    const cancelled = await callOk(client, "task", { action: "cancel", taskId: task.id });
    expect(cancelled).toContain(`Cancellation requested for task ${task.id}`);
    await waitForTask(task.id);
    expect(await callOk(client, "task", { action: "cancel", taskId: task.id })).toContain(
      "already cancelled",
    );

    expect(await callError(client, "task", { action: "status", taskId: "nope" })).toContain(
      "not found",
    );
    await callError(client, "task", { action: "cancel", taskId: "nope" });
    await callError(client, "task", { action: "status" });
    await callError(client, "task", {});
  });

  it("sync (admin): syncs saved connections without secrets as parameters", async () => {
    expect(await callOk(client, "sync", { all: true })).toBe("No saved connections to sync.");

    const vault = join(tempHome, "vault");
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, "note.md"), "# Note\n\nA note in the vault.");
    saveConnectorSettings("obsidian", "notes", {
      vaultPath: vault,
      topicMapping: "folder",
      excludePatterns: [],
    });
    expect(await callOk(client, "sync", { name: "notes" })).toBe(
      "- notes (obsidian): 1 added, 0 updated, 0 deleted",
    );

    expect(await callError(client, "sync", {})).toContain("Give either a connection name");
    await callError(client, "sync", { name: "missing" });
    await callError(client, "sync", { name: "bad name!" });
  });

  it("install-pack and list-packs (admin): install from a file and list", async () => {
    const path = join(tempHome, "demo.json");
    writeFileSync(
      path,
      JSON.stringify({
        name: "demo",
        version: "1.0.0",
        description: "Test pack",
        documents: [{ title: "Pack doc", content: "Content from a pack", source: "test" }],
        metadata: { author: "tests", license: "MIT", createdAt: new Date().toISOString() },
      }),
    );
    expect(await callOk(client, "list-packs")).toBe("No packs found.");
    expect(await callOk(client, "install-pack", { pack: path })).toBe(
      "Installed pack demo: 1 documents.",
    );
    expect(await callOk(client, "install-pack", { pack: path })).toBe(
      "Pack demo is already installed.",
    );
    expect(await callOk(client, "list-packs")).toMatch(/^- demo v1\.0\.0 \(1 docs, installed /);
    expect(await callOk(client, "overview")).toContain("Packs:\n- demo v1.0.0");

    await callError(client, "install-pack", {});
    await callError(client, "list-packs", { available: "yes" });
  });

  it("reindex-documents (admin): re-embeds chunks, inline or as a task", async () => {
    await submit("Doc", "Reindex me");
    expect(await callOk(client, "reindex-documents")).toBe("Re-embedded 1 of 1 chunks.");
    const started = await callOk(client, "reindex-documents", { async: true });
    const taskId = idFrom(started, "taskId");
    await waitForTask(taskId);
    expect(await callOk(client, "task", { action: "status", taskId })).toContain(
      "Re-embedded 1 of 1 chunks.",
    );
    await callError(client, "reindex-documents", { batchSize: 0 });
    await callError(client, "reindex-documents", { rebuild: true, documentIds: ["x"] });
  });
});

describe("createMcpServer without a context", () => {
  it("bootstraps its own database and closes it", async () => {
    const mcp = createMcpServer({
      dbPath: ":memory:",
      config: testConfig(),
      provider: new MockEmbeddingProvider(),
      vectorTable: "skip",
      toolsets: [],
    });
    expect(mcp.tools).toEqual(CORE_TOOLS);
    expect(mcp.ctx.surface).toBe("mcp");
    expect(mcp.ctx.db.open).toBe(true);
    await mcp.close();
    expect(mcp.ctx.db.open).toBe(false);
  });
});
