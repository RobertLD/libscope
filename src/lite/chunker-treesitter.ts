/**
 * Tree-sitter based code-aware chunker.
 *
 * Splits source code at function/class boundaries using tree-sitter AST parsing.
 * tree-sitter and its grammar packages are optional peer dependencies —
 * this module is only loaded dynamically when available.
 */

import { ValidationError } from "../errors.js";

/** A semantically meaningful chunk of source code. */
export interface CodeChunk {
  /** The source text of this chunk. */
  content: string;
  /** 1-based start line in the original file. */
  startLine: number;
  /** 1-based end line in the original file. */
  endLine: number;
  /** The tree-sitter node type (e.g. "function_declaration", "class_definition"). */
  nodeType: string;
}

/** Minimal tree-sitter node shape for type safety without importing tree-sitter types. */
interface TSNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childCount: number;
  child(index: number): TSNode | null;
  namedChildCount: number;
  namedChild(index: number): TSNode | null;
}

/** Minimal tree-sitter tree shape. */
interface TSTree {
  rootNode: TSNode;
}

/** Minimal tree-sitter parser shape. */
interface TSParser {
  setLanguage(language: unknown): void;
  parse(input: string): TSTree;
}

/** Canonical language name used internally. */
type SupportedLanguage = "typescript" | "javascript" | "python";

/** Map from user-facing aliases to canonical names. */
const LANGUAGE_ALIASES: Record<string, SupportedLanguage> = {
  typescript: "typescript",
  ts: "typescript",
  tsx: "typescript",
  javascript: "javascript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  python: "python",
  py: "python",
};

/** Node types to treat as chunk boundaries per language. */
const CHUNK_NODE_TYPES: Record<SupportedLanguage, ReadonlySet<string>> = {
  typescript: new Set([
    "function_declaration",
    "class_declaration",
    "method_definition",
    "export_statement",
    "lexical_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
  ]),
  javascript: new Set([
    "function_declaration",
    "class_declaration",
    "method_definition",
    "export_statement",
    "lexical_declaration",
  ]),
  python: new Set(["function_definition", "class_definition", "decorated_definition"]),
};

const DEFAULT_MAX_CHUNK_SIZE = 1500;

/**
 * Code-aware chunker using tree-sitter.
 *
 * Parses source code into an AST and splits at function/class boundaries,
 * producing semantically meaningful chunks suitable for embedding.
 */
export class TreeSitterChunker {
  private parserCache: TSParser | undefined;
  private readonly grammarCache = new Map<SupportedLanguage, unknown>();

  /** Returns true if the given language (or alias) is supported. */
  supports(language: string): boolean {
    return language.toLowerCase() in LANGUAGE_ALIASES;
  }

  /** Resolve a language alias to its canonical name, or undefined if unsupported. */
  private resolveLanguage(language: string): SupportedLanguage | undefined {
    return LANGUAGE_ALIASES[language.toLowerCase()];
  }

  /**
   * Chunk source code into semantically meaningful pieces using tree-sitter.
   *
   * @param source - The raw source code string.
   * @param language - Language name or alias (e.g. "typescript", "ts", "py").
   * @param maxChunkSize - Maximum characters per chunk (default 1500).
   * @returns Array of CodeChunk with content, line range, and AST node type.
   * @throws ValidationError if tree-sitter is not installed or parsing fails.
   */
  async chunk(
    source: string,
    language: string,
    maxChunkSize: number = DEFAULT_MAX_CHUNK_SIZE,
  ): Promise<CodeChunk[]> {
    const canonical = this.resolveLanguage(language);
    if (canonical === undefined) {
      throw new ValidationError(`Unsupported language for code chunking: "${language}"`);
    }

    const parser = await this.getParser();
    const grammar = await this.loadGrammar(canonical);
    parser.setLanguage(grammar);

    let tree: TSTree;
    try {
      tree = parser.parse(source);
    } catch (err: unknown) {
      throw new ValidationError(
        `Failed to parse ${canonical} source with tree-sitter: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    const root = tree.rootNode;
    const chunkNodeTypes = CHUNK_NODE_TYPES[canonical];
    const rawChunks = this.extractChunks(root, chunkNodeTypes, maxChunkSize);

    // If no declaration nodes found, return the whole source as a single chunk
    if (rawChunks.length === 0) {
      return [
        {
          content: source,
          startLine: 1,
          endLine: source.split("\n").length,
          nodeType: "module",
        },
      ];
    }

    return rawChunks;
  }

  /**
   * Walk top-level children and extract chunks at declaration boundaries.
   * Consecutive non-declaration nodes (imports, comments) are accumulated
   * and prepended to the next declaration chunk for context.
   */
  private extractChunks(
    root: TSNode,
    chunkNodeTypes: ReadonlySet<string>,
    maxChunkSize: number,
  ): CodeChunk[] {
    const chunks: CodeChunk[] = [];
    let preamble = "";
    let preambleStartLine: number | undefined;

    for (let i = 0; i < root.childCount; i++) {
      const child = root.child(i);
      if (child === null) continue;

      if (chunkNodeTypes.has(child.type)) {
        this.flushDeclaration(child, preamble, preambleStartLine, maxChunkSize, chunks);
        preamble = "";
        preambleStartLine = undefined;
      } else {
        const text = child.text.trim();
        if (text) {
          preambleStartLine ??= child.startPosition.row + 1;
          preamble = preamble ? preamble + "\n" + child.text : child.text;
        }
      }
    }

    if (preamble) {
      chunks.push({
        content: preamble,
        startLine: preambleStartLine ?? 1,
        endLine: root.endPosition.row + 1,
        nodeType: "trailing",
      });
    }

    return chunks;
  }

  /** Emit one or more chunks for a declaration node, prepending any accumulated preamble. */
  private flushDeclaration(
    child: TSNode,
    preamble: string,
    preambleStartLine: number | undefined,
    maxChunkSize: number,
    chunks: CodeChunk[],
  ): void {
    const content = preamble ? preamble + "\n\n" + child.text : child.text;
    const startLine = preambleStartLine ?? child.startPosition.row + 1;

    if (content.length <= maxChunkSize) {
      chunks.push({ content, startLine, endLine: child.endPosition.row + 1, nodeType: child.type });
      return;
    }

    // Large node — flush preamble separately, then split by children
    if (preamble) {
      chunks.push({
        content: preamble,
        startLine: preambleStartLine ?? startLine,
        endLine: child.startPosition.row,
        nodeType: "preamble",
      });
    }
    chunks.push(...this.splitLargeNode(child, maxChunkSize));
  }

  /**
   * Split a large declaration node into smaller chunks by recursing into
   * its named children (e.g. methods inside a class).
   */
  private splitLargeNode(node: TSNode, maxChunkSize: number): CodeChunk[] {
    if (node.namedChildCount > 1) {
      const chunks = this.accumulateNamedChildren(node, maxChunkSize);
      if (chunks.length > 0) return chunks;
    }
    // Node has ≤1 child or accumulation produced nothing — return as-is
    return [
      {
        content: node.text,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        nodeType: node.type,
      },
    ];
  }

  /** Accumulate named children of a node into size-bounded chunks. */
  private accumulateNamedChildren(node: TSNode, maxChunkSize: number): CodeChunk[] {
    const chunks: CodeChunk[] = [];
    let accumulated = "";
    let accStartLine = node.startPosition.row + 1;

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child === null) continue;

      const childText = child.text;
      if (accumulated && accumulated.length + childText.length + 2 > maxChunkSize) {
        chunks.push({
          content: accumulated,
          startLine: accStartLine,
          endLine: child.startPosition.row,
          nodeType: node.type,
        });
        accumulated = childText;
        accStartLine = child.startPosition.row + 1;
      } else {
        if (!accumulated) accStartLine = child.startPosition.row + 1;
        accumulated = accumulated ? accumulated + "\n\n" + childText : childText;
      }
    }

    if (accumulated) {
      chunks.push({
        content: accumulated,
        startLine: accStartLine,
        endLine: node.endPosition.row + 1,
        nodeType: node.type,
      });
    }

    return chunks;
  }

  /** Lazily create or return the cached tree-sitter Parser instance. */
  private async getParser(): Promise<TSParser> {
    if (this.parserCache !== undefined) {
      return this.parserCache;
    }

    try {
      // @ts-expect-error — tree-sitter is an optional peer dependency, not installed at compile time
      const TreeSitter = (await import("tree-sitter")) as Record<string, unknown>;
      // tree-sitter exports vary: could be default export or named
      const resolved = "default" in TreeSitter ? TreeSitter["default"] : TreeSitter;
      const ParserClass = resolved as new () => TSParser;
      this.parserCache = new ParserClass();
      return this.parserCache;
    } catch (err: unknown) {
      throw new ValidationError(
        'Code chunking requires the "tree-sitter" package. ' +
          "Install it with: npm install tree-sitter tree-sitter-typescript tree-sitter-javascript tree-sitter-python",
        err,
      );
    }
  }

  /** Lazily load and cache a tree-sitter grammar for the given language. */
  private async loadGrammar(language: SupportedLanguage): Promise<unknown> {
    const cached = this.grammarCache.get(language);
    if (cached !== undefined) {
      return cached;
    }

    const packageName = this.grammarPackageName(language);

    try {
      const mod = (await import(packageName)) as Record<string, unknown>;
      // Grammar packages typically export the language as the default export.
      // tree-sitter-typescript exports { typescript, tsx } as named exports.
      let grammar: unknown;
      if (language === "typescript" && "typescript" in mod) {
        grammar = mod["typescript"];
      } else if ("default" in mod) {
        grammar = mod["default"];
      } else {
        // Fallback: use the module itself (some packages export the grammar directly)
        grammar = mod;
      }

      this.grammarCache.set(language, grammar);
      return grammar;
    } catch (err: unknown) {
      throw new ValidationError(
        `Code chunking for ${language} requires the "${packageName}" package. ` +
          `Install it with: npm install ${packageName}`,
        err,
      );
    }
  }

  /** Map canonical language name to its npm grammar package. */
  private grammarPackageName(language: SupportedLanguage): string {
    switch (language) {
      case "typescript":
        return "tree-sitter-typescript";
      case "javascript":
        return "tree-sitter-javascript";
      case "python":
        return "tree-sitter-python";
    }
  }
}
