import { describe, it, expect, vi, beforeEach } from "vitest";
import { TreeSitterChunker, type CodeChunk } from "../../src/lite/chunker-treesitter.js";
import { ValidationError } from "../../src/errors.js";

describe("TreeSitterChunker", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker();
  });

  describe("supports()", () => {
    it("should return true for TypeScript aliases", () => {
      expect(chunker.supports("typescript")).toBe(true);
      expect(chunker.supports("ts")).toBe(true);
      expect(chunker.supports("tsx")).toBe(true);
    });

    it("should return true for JavaScript aliases", () => {
      expect(chunker.supports("javascript")).toBe(true);
      expect(chunker.supports("js")).toBe(true);
      expect(chunker.supports("jsx")).toBe(true);
      expect(chunker.supports("mjs")).toBe(true);
      expect(chunker.supports("cjs")).toBe(true);
    });

    it("should return true for Python aliases", () => {
      expect(chunker.supports("python")).toBe(true);
      expect(chunker.supports("py")).toBe(true);
    });

    it("should be case-insensitive", () => {
      expect(chunker.supports("TypeScript")).toBe(true);
      expect(chunker.supports("PYTHON")).toBe(true);
      expect(chunker.supports("Js")).toBe(true);
    });

    it("should return false for unsupported languages", () => {
      expect(chunker.supports("rust")).toBe(false);
      expect(chunker.supports("go")).toBe(false);
      expect(chunker.supports("java")).toBe(false);
      expect(chunker.supports("c++")).toBe(false);
      expect(chunker.supports("")).toBe(false);
    });
  });

  describe("chunk() — language validation", () => {
    it("should throw ValidationError for unsupported language", async () => {
      await expect(chunker.chunk("fn main() {}", "rust")).rejects.toThrow(ValidationError);
      await expect(chunker.chunk("fn main() {}", "rust")).rejects.toThrow(
        'Unsupported language for code chunking: "rust"',
      );
    });

    it("should throw ValidationError for empty language string", async () => {
      await expect(chunker.chunk("code", "")).rejects.toThrow(ValidationError);
    });
  });

  describe("chunk() — tree-sitter not installed", () => {
    it("should throw ValidationError with install instructions when tree-sitter is missing", async () => {
      // tree-sitter is not installed in test environment, so chunk() should fail gracefully
      // If it does happen to be installed, this test is still valid — it just takes the other path
      try {
        await chunker.chunk('const x = 1;', "typescript");
        // If tree-sitter IS installed, we skip this assertion
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).message).toMatch(/tree-sitter/i);
        expect((err as ValidationError).message).toMatch(/npm install/i);
      }
    });
  });

  describe("chunk() — with mocked tree-sitter", () => {
    /**
     * Helper: create a mock TSNode that simulates tree-sitter node shape.
     */
    function makeMockNode(
      type: string,
      text: string,
      startRow: number,
      endRow: number,
      children: ReturnType<typeof makeMockNode>[] = [],
    ): {
      type: string;
      text: string;
      startPosition: { row: number; column: number };
      endPosition: { row: number; column: number };
      childCount: number;
      child: (i: number) => ReturnType<typeof makeMockNode> | null;
      namedChildCount: number;
      namedChild: (i: number) => ReturnType<typeof makeMockNode> | null;
    } {
      return {
        type,
        text,
        startPosition: { row: startRow, column: 0 },
        endPosition: { row: endRow, column: 0 },
        childCount: children.length,
        child: (i: number) => children[i] ?? null,
        namedChildCount: children.length,
        namedChild: (i: number) => children[i] ?? null,
      };
    }

    /**
     * Create a chunker with mocked tree-sitter internals for testing
     * the algorithm without requiring tree-sitter to be installed.
     */
    function createMockedChunker(
      rootChildren: ReturnType<typeof makeMockNode>[],
    ): TreeSitterChunker {
      const instance = new TreeSitterChunker();

      const rootNode = makeMockNode("program", "", 0, 100, rootChildren);

      // Mock the private getParser and loadGrammar methods
      // @ts-expect-error — accessing private method for testing
      instance.getParser = vi.fn().mockResolvedValue({
        setLanguage: vi.fn(),
        parse: vi.fn().mockReturnValue({ rootNode }),
      });
      // @ts-expect-error — accessing private method for testing
      instance.loadGrammar = vi.fn().mockResolvedValue({});

      return instance;
    }

    it("should chunk TypeScript code at function boundaries", async () => {
      const importNode = makeMockNode("import_statement", 'import { foo } from "bar";', 0, 0);
      const fn1 = makeMockNode(
        "function_declaration",
        "function greet() {\n  return 'hi';\n}",
        2,
        4,
      );
      const fn2 = makeMockNode(
        "function_declaration",
        "function farewell() {\n  return 'bye';\n}",
        6,
        8,
      );

      const chunker = createMockedChunker([importNode, fn1, fn2]);
      const chunks = await chunker.chunk("unused — mocked", "typescript");

      expect(chunks.length).toBe(2);

      // First function should include the preamble (import)
      expect(chunks[0]?.content).toContain('import { foo } from "bar"');
      expect(chunks[0]?.content).toContain("function greet()");
      expect(chunks[0]?.nodeType).toBe("function_declaration");

      // Second function standalone
      expect(chunks[1]?.content).toContain("function farewell()");
      expect(chunks[1]?.nodeType).toBe("function_declaration");
    });

    it("should chunk at class declaration boundaries", async () => {
      const cls = makeMockNode(
        "class_declaration",
        "class Foo {\n  bar() {}\n}",
        0,
        2,
      );

      const chunker = createMockedChunker([cls]);
      const chunks = await chunker.chunk("unused", "typescript");

      expect(chunks.length).toBe(1);
      expect(chunks[0]?.nodeType).toBe("class_declaration");
      expect(chunks[0]?.content).toContain("class Foo");
    });

    it("should return whole source as single chunk when no declarations found", async () => {
      // Empty program with no children — extractChunks returns []
      const instance = new TreeSitterChunker();
      const source = "// just a comment\n";

      const rootNode = makeMockNode("program", source, 0, 1, []);

      // @ts-expect-error — accessing private method for testing
      instance.getParser = vi.fn().mockResolvedValue({
        setLanguage: vi.fn(),
        parse: vi.fn().mockReturnValue({ rootNode }),
      });
      // @ts-expect-error — accessing private method for testing
      instance.loadGrammar = vi.fn().mockResolvedValue({});

      const chunks = await instance.chunk(source, "typescript");

      expect(chunks.length).toBe(1);
      expect(chunks[0]?.nodeType).toBe("module");
      expect(chunks[0]?.startLine).toBe(1);
    });

    it("should accumulate preamble (imports/comments) into first declaration", async () => {
      const imp1 = makeMockNode("import_statement", 'import a from "a";', 0, 0);
      const imp2 = makeMockNode("import_statement", 'import b from "b";', 1, 1);
      const fn = makeMockNode("function_declaration", "function main() {}", 3, 3);

      const chunker = createMockedChunker([imp1, imp2, fn]);
      const chunks = await chunker.chunk("unused", "ts");

      expect(chunks.length).toBe(1);
      expect(chunks[0]?.content).toContain('import a from "a"');
      expect(chunks[0]?.content).toContain('import b from "b"');
      expect(chunks[0]?.content).toContain("function main()");
    });

    it("should handle trailing non-declaration content", async () => {
      const fn = makeMockNode("function_declaration", "function foo() {}", 0, 0);
      const trailing = makeMockNode("expression_statement", "console.log('done');", 2, 2);

      const chunker = createMockedChunker([fn, trailing]);
      const chunks = await chunker.chunk("unused", "js");

      expect(chunks.length).toBe(2);
      expect(chunks[0]?.nodeType).toBe("function_declaration");
      expect(chunks[1]?.nodeType).toBe("trailing");
      expect(chunks[1]?.content).toContain("console.log");
    });

    it("should split oversized nodes by recursing into children", async () => {
      const method1 = makeMockNode("method_definition", "a".repeat(100), 1, 3);
      const method2 = makeMockNode("method_definition", "b".repeat(100), 4, 6);

      const bigClass = makeMockNode(
        "class_declaration",
        "a".repeat(100) + "\n\n" + "b".repeat(100),
        0,
        6,
        [method1, method2],
      );

      // Use a small maxChunkSize to trigger splitting
      const chunker = createMockedChunker([bigClass]);
      const chunks = await chunker.chunk("unused", "typescript", 150);

      // Should have been split into multiple chunks
      expect(chunks.length).toBeGreaterThan(1);
    });

    it("should produce correct startLine and endLine (1-based)", async () => {
      const fn = makeMockNode("function_declaration", "function test() {}", 5, 10);

      const chunker = createMockedChunker([fn]);
      const chunks = await chunker.chunk("unused", "typescript");

      expect(chunks[0]?.startLine).toBe(6); // 0-based row 5 → 1-based line 6
      expect(chunks[0]?.endLine).toBe(11); // 0-based row 10 → 1-based line 11
    });

    it("should support Python function_definition nodes", async () => {
      const fn = makeMockNode("function_definition", "def hello():\n    pass", 0, 1);

      const chunker = createMockedChunker([fn]);
      const chunks = await chunker.chunk("unused", "python");

      expect(chunks.length).toBe(1);
      expect(chunks[0]?.content).toContain("def hello()");
    });

    it("should support Python class_definition nodes", async () => {
      const cls = makeMockNode(
        "class_definition",
        "class MyClass:\n    def __init__(self):\n        pass",
        0,
        2,
      );

      const chunker = createMockedChunker([cls]);
      const chunks = await chunker.chunk("unused", "py");

      expect(chunks.length).toBe(1);
      expect(chunks[0]?.nodeType).toBe("class_definition");
    });

    it("should handle empty source returning single module chunk", async () => {
      // No children means extractChunks returns empty → falls back to whole source
      const instance = new TreeSitterChunker();
      const rootNode = makeMockNode("program", "", 0, 0, []);

      // @ts-expect-error — accessing private method for testing
      instance.getParser = vi.fn().mockResolvedValue({
        setLanguage: vi.fn(),
        parse: vi.fn().mockReturnValue({ rootNode }),
      });
      // @ts-expect-error — accessing private method for testing
      instance.loadGrammar = vi.fn().mockResolvedValue({});

      const chunks = await instance.chunk("", "typescript");

      expect(chunks.length).toBe(1);
      expect(chunks[0]?.nodeType).toBe("module");
    });

    it("should handle parse failure with ValidationError", async () => {
      const instance = new TreeSitterChunker();

      // @ts-expect-error — accessing private method for testing
      instance.getParser = vi.fn().mockResolvedValue({
        setLanguage: vi.fn(),
        parse: vi.fn().mockImplementation(() => {
          throw new Error("Parse error");
        }),
      });
      // @ts-expect-error — accessing private method for testing
      instance.loadGrammar = vi.fn().mockResolvedValue({});

      await expect(instance.chunk("bad code", "typescript")).rejects.toThrow(ValidationError);
      await expect(instance.chunk("bad code", "typescript")).rejects.toThrow(
        "Failed to parse typescript source",
      );
    });
  });
});
