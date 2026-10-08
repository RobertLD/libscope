import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ConfigError,
  LibScope,
  ValidationError,
  createCodeChunker,
  createLite,
  normalizeRawInput,
  type LlmProvider,
} from "../../src/lite/index.js";
import { TreeSitterChunker } from "../../src/lite/chunker-treesitter.js";
import { initLogger } from "../../src/logger.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";

const corpus = [
  { title: "React Hooks", content: "useState and useEffect are the most common React hooks." },
  { title: "Vue Composition", content: "Vue 3 composition API uses the setup function." },
  { title: "Angular DI", content: "Angular uses the dependency injection pattern extensively." },
];

async function seed(scope: LibScope): Promise<void> {
  for (const doc of corpus) await scope.add(doc);
}

/** Search results without the per-database IDs and timestamps. */
function comparable(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return items.map(({ documentId: _d, chunkId: _c, ...rest }) => rest);
}

beforeAll(() => {
  initLogger("silent");
});

describe("createLite", () => {
  const open: LibScope[] = [];
  const lite = (options: Parameters<typeof createLite>[0]): LibScope => {
    const scope = createLite(options);
    open.push(scope);
    return scope;
  };

  afterEach(() => {
    for (const scope of open.splice(0)) scope.close();
    vi.restoreAllMocks();
  });

  it("returns a LibScope", () => {
    expect(lite({ dbPath: ":memory:", provider: new MockEmbeddingProvider() })).toBeInstanceOf(
      LibScope,
    );
  });

  it("needs dbPath or db", () => {
    expect(() => createLite({ provider: new MockEmbeddingProvider() })).toThrow(ValidationError);
  });

  it("gives the same results as LibScope.create with useConfigFile: false", async () => {
    const preset = lite({ dbPath: ":memory:", provider: new MockEmbeddingProvider() });
    const full = LibScope.create({
      dbPath: ":memory:",
      provider: new MockEmbeddingProvider(),
      useConfigFile: false,
    });
    open.push(full);
    await seed(preset);
    await seed(full);

    const a = await preset.search({ query: "React hooks", limit: 2 });
    const b = await full.search({ query: "React hooks", limit: 2 });
    expect(a.total).toBe(b.total);
    expect(comparable(a.items as unknown as Array<Record<string, unknown>>)).toEqual(
      comparable(b.items as unknown as Array<Record<string, unknown>>),
    );
    expect(a.items[0]).toHaveProperty("documentId");

    const listA = await preset.docs.list();
    const listB = await full.docs.list();
    expect(listA.items.map((d) => d.title)).toEqual(listB.items.map((d) => d.title));
  });

  it("ask without an LLM throws ConfigError; with one returns a RagResult", async () => {
    const noLlm = lite({ dbPath: ":memory:", provider: new MockEmbeddingProvider() });
    await seed(noLlm);
    await expect(noLlm.ask("What are hooks?")).rejects.toBeInstanceOf(ConfigError);

    const complete = vi.fn().mockResolvedValue({ text: "Hooks are functions." });
    const llm: LlmProvider = { model: "test-model", complete };
    const withLlm = lite({
      dbPath: ":memory:",
      provider: new MockEmbeddingProvider(),
      llmProvider: llm,
    });
    await seed(withLlm);
    const result = await withLlm.ask("What are hooks?");
    expect(result).toMatchObject({
      mode: "answer",
      answer: "Hooks are functions.",
      model: "test-model",
    });
    if (result.mode === "answer") expect(result.sources.length).toBeGreaterThan(0);
    expect(String(complete.mock.calls[0]?.[0])).toContain("What are hooks?");
  });

  it("ignores config files: llm.provider can be set through config", async () => {
    const scope = lite({
      dbPath: ":memory:",
      provider: new MockEmbeddingProvider(),
      config: { llm: { provider: "passthrough" } },
    });
    await seed(scope);
    expect((await scope.ask("What are hooks?")).mode).toBe("context");
  });
});

describe("createCodeChunker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const chunks = [
    { content: "function foo() {}", startLine: 1, endLine: 1, nodeType: "function_declaration" },
    { content: "function bar() {}", startLine: 2, endLine: 2, nodeType: "function_declaration" },
  ];

  it("chunks code by the extension of the title", async () => {
    const chunkSpy = vi.spyOn(TreeSitterChunker.prototype, "chunk").mockResolvedValue(chunks);
    const chunker = createCodeChunker();
    const result = await chunker({ content: "src", title: "main.ts", source: "" });
    expect(result).toEqual(["function foo() {}", "function bar() {}"]);
    expect(chunkSpy).toHaveBeenCalledWith("src", "ts");
  });

  it("uses a fixed language when given", async () => {
    const chunkSpy = vi.spyOn(TreeSitterChunker.prototype, "chunk").mockResolvedValue(chunks);
    await createCodeChunker({ language: "python" })({ content: "x", title: "Doc", source: "" });
    expect(chunkSpy).toHaveBeenCalledWith("x", "python");
  });

  it("returns undefined for prose, unsupported languages and parse failures", async () => {
    vi.spyOn(TreeSitterChunker.prototype, "chunk").mockRejectedValue(new Error("not installed"));
    const chunker = createCodeChunker();
    expect(await chunker({ content: "x", title: "Guide", source: "" })).toBeUndefined();
    expect(await chunker({ content: "x", title: "main.rb", source: "" })).toBeUndefined();
    expect(await chunker({ content: "x", title: "main.go", source: "" })).toBeUndefined();
  });

  it("is used by add when passed to createLite", async () => {
    vi.spyOn(TreeSitterChunker.prototype, "chunk").mockResolvedValue(chunks);
    const scope = createLite({
      dbPath: ":memory:",
      provider: new MockEmbeddingProvider(),
      chunker: createCodeChunker(),
    });
    try {
      const result = await scope.add({ content: "function foo() {}", title: "main.ts" });
      expect(result.documents[0]!.chunkCount).toBe(2);
    } finally {
      scope.close();
    }
  });
});

describe("normalizeRawInput", () => {
  it("passes text through", async () => {
    expect(await normalizeRawInput({ type: "text", title: "T", content: "C" })).toEqual({
      title: "T",
      content: "C",
    });
  });

  it("reads a buffer with the parser for its extension, else as text", async () => {
    const md = await normalizeRawInput({
      type: "buffer",
      buffer: Buffer.from("# Heading\n\nBody"),
      filename: "notes.md",
    });
    expect(md.title).toBe("notes");
    expect(md.content).toContain("Body");

    const code = await normalizeRawInput({
      type: "buffer",
      buffer: Buffer.from("const x = 1;"),
      filename: "x.ts",
      title: "x.ts",
    });
    expect(code).toEqual({ title: "x.ts", content: "const x = 1;" });
  });
});
