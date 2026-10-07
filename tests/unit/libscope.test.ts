import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibScope, sdkOperationNames, type LibScopeOptions } from "../../src/LibScope.js";
import { OPERATIONS } from "../../src/core/operations/index.js";
import type { LlmProvider } from "../../src/core/rag.js";
import { ConfigError, NotFoundError, ValidationError } from "../../src/errors.js";
import { initLogger } from "../../src/logger.js";
import { createTestDb } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";

function create(options: LibScopeOptions = {}): LibScope {
  return LibScope.create({
    dbPath: ":memory:",
    provider: new MockEmbeddingProvider(),
    useConfigFile: false,
    ...options,
  });
}

function mockLlm(text = "Mocked answer"): { llm: LlmProvider; complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn().mockResolvedValue({ text, tokensUsed: 3 });
  return { llm: { model: "mock-llm", complete }, complete };
}

async function addDoc(scope: LibScope, title: string, content?: string): Promise<string> {
  const result = await scope.add({
    content: content ?? `${title} explains testing the LibScope SDK end to end`,
    title,
  });
  return result.documents[0]!.documentId;
}

let tempHome: string;
let savedHome: string | undefined;

beforeAll(() => {
  initLogger("silent");
  savedHome = process.env["HOME"];
  tempHome = mkdtempSync(join(tmpdir(), "libscope-sdk-home-"));
  process.env["HOME"] = tempHome;
});

afterAll(() => {
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
  rmSync(tempHome, { recursive: true, force: true });
});

describe("LibScope SDK surface", () => {
  it("reaches every operation exactly once", () => {
    const names = sdkOperationNames();
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(OPERATIONS.map((op) => op.name).sort());
  });

  it("types namespace methods from the operation schemas", () => {
    const scope = create();
    try {
      expectTypeOf(scope.docs.get).parameter(0).toMatchTypeOf<{ documentId: string }>();
      expectTypeOf(scope.tags.list).parameter(0).toEqualTypeOf<Record<string, never> | undefined>();
      expectTypeOf<Awaited<ReturnType<LibScope["search"]>>["items"][number]>().toHaveProperty(
        "chunkId",
      );
    } finally {
      scope.close();
    }
  });
});

describe("LibScope", () => {
  let scope: LibScope;

  beforeEach(() => {
    scope = create();
  });

  afterEach(() => {
    scope.close();
  });

  it("add + search + overview", async () => {
    const added = await scope.add({ content: "Vitest runs fast unit tests", title: "Vitest" });
    expect(added.kind).toBe("content");
    expect(added.documents[0]!.title).toBe("Vitest");

    const byString = await scope.search("unit tests");
    const byObject = await scope.search({ query: "unit tests", limit: 5, diversity: 0.5 });
    expect(byString.items.length).toBeGreaterThan(0);
    expect(byObject).toMatchObject({ limit: 5, offset: 0 });
    expect(byObject.total).toBeGreaterThan(0);
    expect(byString.items[0]!.documentId).toBe(added.documents[0]!.documentId);

    const overview = await scope.overview();
    expect(overview.stats.totalDocuments).toBe(1);
    expect(overview.health.database).toBe("ok");
  });

  it("validates input with ValidationError", async () => {
    await expect(scope.search({})).rejects.toBeInstanceOf(ValidationError);
    await expect(scope.docs.get({ documentId: "" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("docs: list, get, update, rate, history, rollback, delete", async () => {
    const id = await addDoc(scope, "Doc One");
    const list = await scope.docs.list();
    expect(list.total).toBe(1);
    expect(list.items[0]!.documentId).toBe(id);

    const view = await scope.docs.get({ documentId: id, maxLength: 5 });
    expect(view.content).toHaveLength(5);
    expect(view.document.documentId).toBe(id);

    await scope.docs.update({ documentId: id, content: "Doc One rewritten content", tags: ["a"] });
    expect((await scope.docs.get({ documentId: id })).tags).toEqual(["a"]);

    const rating = await scope.docs.rate({ documentId: id, rating: 4 });
    expect(rating).toMatchObject({ documentId: id, rating: 4 });

    const history = await scope.docs.history({ documentId: id });
    expect(history.items.length).toBeGreaterThan(0);
    await scope.docs.rollback({ documentId: id, version: history.items[0]!.version });

    await scope.docs.delete({ documentId: id });
    await expect(scope.docs.get({ documentId: id })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("topics, tags and links", async () => {
    const topic = await scope.topics.create({ name: "testing" });
    expect((await scope.topics.list()).items.map((t) => t.id)).toContain(topic.id);

    const a = await addDoc(scope, "Doc A");
    const b = await addDoc(scope, "Doc B");

    expect((await scope.tags.add({ documentId: a, tags: ["x", "y"] })).tags).toEqual(["x", "y"]);
    expect((await scope.tags.remove({ documentId: a, tags: ["y"] })).tags).toEqual(["x"]);
    expect((await scope.tags.list()).items.map((t) => t.name)).toContain("x");
    expect((await scope.tags.suggest({ documentId: a })).documentId).toBe(a);

    const link = await scope.links.create({
      documentId: b,
      targetDocumentId: a,
      linkType: "prerequisite",
    });
    expect((await scope.links.list({ documentId: b })).items).toHaveLength(1);
    expect((await scope.links.prerequisites({ documentId: a })).items[0]!.documentId).toBe(b);
    await scope.links.delete({ linkId: link.linkId });
    expect((await scope.links.list()).items).toHaveLength(0);

    await scope.topics.delete({ topic: "testing" });
    expect((await scope.topics.list()).items).toHaveLength(0);
  });

  it("searches: save, list, run, delete", async () => {
    await addDoc(scope, "Saved Search Doc");
    await scope.searches.save({ name: "mine", query: "SDK" });
    expect((await scope.searches.list()).total).toBe(1);
    const run = await scope.searches.run({ search: "mine" });
    expect(run.items.length).toBeGreaterThan(0);
    await scope.searches.delete({ search: "mine" });
    expect((await scope.searches.list()).total).toBe(0);
  });

  it("packs, tasks, webhooks, analytics", async () => {
    expect((await scope.packs.list()).items).toEqual([]);
    expect(Array.isArray((await scope.tasks.list()).items)).toBe(true);
    await expect(scope.tasks.get({ taskId: "missing" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await scope.webhooks.list()).items).toEqual([]);
    expect((await scope.analytics.popular()).items).toEqual([]);
    expect(await scope.analytics.searches()).toHaveProperty("knowledgeGaps");
  });

  it("connectors are loaded on first use", async () => {
    expect((await scope.connectors.list()).items).toEqual([]);
    expect((await scope.connectors.sync({ all: true })).items).toEqual([]);
    await expect(scope.connectors.sync({})).rejects.toBeInstanceOf(ValidationError);
  });

  it("admin: dedupe, pruneExpired, bulk ops, backup and restore", async () => {
    await addDoc(scope, "Admin Doc");
    expect(Array.isArray((await scope.admin.dedupe()).items)).toBe(true);
    expect(await scope.admin.pruneExpired()).toMatchObject({ pruned: 0 });
    expect((await scope.admin.bulkDelete({ library: "none", dryRun: true })).affected).toBe(0);
    expect(
      (await scope.admin.bulkRetag({ dateFrom: "2000-01-01", addTags: ["t"], dryRun: true }))
        .affected,
    ).toBe(1);
    await scope.topics.create({ name: "target" });
    expect(
      (await scope.admin.bulkMove({ dateFrom: "2000-01-01", targetTopic: "target", dryRun: true }))
        .affected,
    ).toBe(1);

    const file = join(tempHome, "backup.json");
    const backup = await scope.admin.backup({ outputPath: file });
    expect(backup.counts.documents).toBe(1);
    const restored = await scope.admin.restore({ backupPath: file });
    expect(restored.path).toBe(file);

    const reindexed = await scope.admin.reindex({}, { onProgress: () => undefined });
    expect(reindexed.failed).toBe(0);
  });

  it("passes the per-call signal to the operation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(scope.docs.list({}, { signal: controller.signal })).rejects.toThrow();
  });
});

describe("LibScope ask", () => {
  it("throws a ConfigError with a hint when no LLM is configured", async () => {
    const scope = create();
    try {
      await addDoc(scope, "Ask Doc");
      await expect(scope.ask("What is this?")).rejects.toBeInstanceOf(ConfigError);
      await expect(scope.askStream("What is this?").next()).rejects.toBeInstanceOf(ConfigError);
    } finally {
      scope.close();
    }
  });

  it("answers with the given LLM provider", async () => {
    const { llm, complete } = mockLlm();
    const scope = create({ llmProvider: llm });
    try {
      await addDoc(scope, "Ask Doc");
      const result = await scope.ask({
        question: "What is tested?",
        topK: 2,
        systemPrompt: "Be brief.",
      });
      expect(result).toMatchObject({ mode: "answer", answer: "Mocked answer", model: "mock-llm" });
      expect(complete).toHaveBeenCalledOnce();
      expect(complete.mock.calls[0]?.[1]).toBe("Be brief.");
    } finally {
      scope.close();
    }
  });

  it("returns context in passthrough mode", async () => {
    const scope = create({ config: { llm: { provider: "passthrough" } } });
    try {
      await addDoc(scope, "Ask Doc");
      const result = await scope.ask("What is tested?");
      expect(result.mode).toBe("context");
      if (result.mode === "context") expect(result.contextPrompt).toContain("What is tested?");
    } finally {
      scope.close();
    }
  });

  it("streams tokens and then sources", async () => {
    const llm: LlmProvider = {
      model: "stream-llm",
      complete: vi.fn(),
      async *completeStream() {
        await Promise.resolve();
        yield "Hello";
        yield " world";
      },
    };
    const scope = create({ llmProvider: llm });
    try {
      await addDoc(scope, "Stream Doc");
      const events = [];
      for await (const event of scope.askStream("Question?")) events.push(event);
      expect(events.slice(0, 2)).toEqual([{ token: "Hello" }, { token: " world" }]);
      expect(events[2]).toMatchObject({ done: true, model: "stream-llm" });
    } finally {
      scope.close();
    }
  });
});

describe("LibScope options", () => {
  it("uses a custom chunker for added content", async () => {
    const chunker = vi.fn().mockReturnValue(["part one", "part two", "part three"]);
    const scope = create({ chunker });
    try {
      const result = await scope.add({ content: "whole text", title: "Chunked" });
      expect(result.documents[0]!.chunkCount).toBe(3);
      expect(chunker).toHaveBeenCalledWith({ content: "whole text", title: "Chunked", source: "" });

      const file = join(tempHome, "notes.md");
      writeFileSync(file, "# Notes\n\nSome notes.");
      const fromFile = await scope.add(file);
      expect(fromFile.documents[0]!.chunkCount).toBe(3);
      expect(chunker).toHaveBeenLastCalledWith(
        expect.objectContaining({ title: "notes", source: file }),
      );
    } finally {
      scope.close();
    }
  });

  it("leaves an injected database open on close", async () => {
    const db = createTestDb();
    const scope = LibScope.create({
      db,
      provider: new MockEmbeddingProvider(),
      useConfigFile: false,
    });
    await addDoc(scope, "Injected");
    scope.close();
    expect(db.open).toBe(true);
    db.close();
  });
});
