/**
 * `libscope/lite`: LibScope for embedding in an application. Everything from the package
 * root, plus a preset that ignores config files, a tree-sitter code chunker and input
 * normalization. Must not import the CLI, MCP server or connectors
 * (tests/unit/lite-import-graph.test.ts).
 */
export * from "../core/index.js";
export { createLite, createCodeChunker, type LiteOptions } from "./core.js";
export { TreeSitterChunker, type CodeChunk } from "./chunker-treesitter.js";
export { normalizeRawInput, type RawInput, type NormalizedInput } from "./normalize.js";
