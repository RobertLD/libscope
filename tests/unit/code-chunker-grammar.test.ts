import { describe, it, expect, vi } from "vitest";
import { TreeSitterChunker } from "../../src/lite/chunker-treesitter.js";

// The grammar packages are CommonJS. import() of them yields a namespace whose `default` is
// module.exports, with no named exports (tree-sitter-typescript's are not statically detectable).
const typescriptLanguage = { name: "typescript" };
const tsxLanguage = { name: "tsx" };
const pythonLanguage = { name: "python", language: {} };

vi.mock("tree-sitter-typescript", () => ({
  default: { typescript: typescriptLanguage, tsx: tsxLanguage },
}));
vi.mock("tree-sitter-python", () => ({ default: pythonLanguage }));

interface GrammarLoader {
  loadGrammar(language: string): Promise<unknown>;
}

describe("TreeSitterChunker grammar loading", () => {
  it("picks the typescript language out of tree-sitter-typescript's default export", async () => {
    const loader = new TreeSitterChunker() as unknown as GrammarLoader;
    await expect(loader.loadGrammar("typescript")).resolves.toBe(typescriptLanguage);
  });

  it("uses the default export of other grammar packages", async () => {
    const loader = new TreeSitterChunker() as unknown as GrammarLoader;
    await expect(loader.loadGrammar("python")).resolves.toBe(pythonLanguage);
  });
});
