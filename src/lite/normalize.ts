import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { getParserForFile } from "../core/parsers/index.js";
import { fetchAndConvert } from "../core/url-fetcher.js";
import type { RawInput } from "./types.js";

export interface NormalizedInput {
  title: string;
  content: string;
  chunks?: string[];
}

// Code extensions that trigger tree-sitter attempt
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);

type TreeSitterChunkerType = import("./chunker-treesitter.js").TreeSitterChunker;
let treeSitterChunker: TreeSitterChunkerType | null = null;
let treeSitterLoaded = false;

async function getTreeSitterChunker(): Promise<TreeSitterChunkerType | null> {
  if (treeSitterLoaded) return treeSitterChunker;
  treeSitterLoaded = true;
  try {
    const { TreeSitterChunker } = await import("./chunker-treesitter.js");
    treeSitterChunker = new TreeSitterChunker();
  } catch {
    /* optional dep not installed — graceful fallback */
  }
  return treeSitterChunker;
}

function extToLang(ext: string): string {
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
  };
  return map[ext.slice(1)] ?? ext.slice(1);
}

export async function normalizeRawInput(input: RawInput): Promise<NormalizedInput> {
  switch (input.type) {
    case "text":
      return { title: input.title, content: input.content };

    case "file": {
      const ext = extname(input.path).toLowerCase();
      const buf = readFileSync(input.path);
      const title = input.title ?? basename(input.path, ext);

      if (CODE_EXTENSIONS.has(ext)) {
        const chunker = await getTreeSitterChunker();
        const lang = extToLang(ext);
        if (chunker?.supports(lang)) {
          const codeChunks = await chunker.chunk(buf.toString("utf-8"), lang);
          return {
            title,
            content: codeChunks[0]?.content ?? "",
            chunks: codeChunks.map((c) => c.content),
          };
        }
      }

      const parser = getParserForFile(input.path);
      const content = parser ? await parser.parse(buf) : buf.toString("utf-8");
      return { title, content };
    }

    case "buffer": {
      const ext = extname(input.filename).toLowerCase();
      const title = input.title ?? basename(input.filename, ext);

      if (CODE_EXTENSIONS.has(ext)) {
        const chunker = await getTreeSitterChunker();
        const lang = extToLang(ext);
        if (chunker?.supports(lang)) {
          const codeChunks = await chunker.chunk(input.buffer.toString("utf-8"), lang);
          return {
            title,
            content: codeChunks[0]?.content ?? "",
            chunks: codeChunks.map((c) => c.content),
          };
        }
      }

      const parser = getParserForFile(input.filename);
      const content = parser ? await parser.parse(input.buffer) : input.buffer.toString("utf-8");
      return { title, content };
    }

    case "url": {
      const fetched = await fetchAndConvert(input.url);
      return { title: input.title ?? fetched.title, content: fetched.content };
    }
  }
}
