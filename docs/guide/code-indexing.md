# Code Indexing

LibScope Lite includes a tree-sitter powered code chunker that splits source files at function and class boundaries. This produces semantically meaningful chunks that are far better for embedding than naive line-count splits.

## Why Code-Aware Chunking Matters

The default LibScope chunker is paragraph- and heading-aware, which works well for documentation. For source code, it produces poor-quality chunks because:

- Code has no paragraph boundaries — it's one continuous text
- A 500-line class split arbitrarily at line 100 loses the method signatures that give it meaning
- A function split in the middle loses the return statement (the most semantically important part)

The tree-sitter chunker uses the Abstract Syntax Tree (AST) to split at **semantic boundaries** — each chunk is a complete, self-contained unit (a function, a class, a method) with its full signature and body.

## Installation

Tree-sitter is an **optional peer dependency**. Install the packages for the languages you need:

```bash
# Core tree-sitter parser
npm install tree-sitter

# Language grammars (install only what you need)
npm install tree-sitter-typescript   # TypeScript + TSX
npm install tree-sitter-javascript   # JavaScript, JSX, MJS, CJS
npm install tree-sitter-python       # Python
```

If tree-sitter is not installed, `TreeSitterChunker.chunk()` throws a `ValidationError` with a clear install message. All other LibScope Lite features work normally without tree-sitter.

## Supported Languages

| Language | Aliases | Grammar Package |
|---|---|---|
| TypeScript | `typescript`, `ts`, `tsx` | `tree-sitter-typescript` |
| JavaScript | `javascript`, `js`, `jsx`, `mjs`, `cjs` | `tree-sitter-javascript` |
| Python | `python`, `py` | `tree-sitter-python` |

Aliases are case-insensitive: `"TS"`, `"ts"`, `"TypeScript"` all resolve to TypeScript.

## Basic Usage

```ts
import { TreeSitterChunker } from "libscope/lite";

const chunker = new TreeSitterChunker();

// Check language support before chunking
if (!chunker.supports("typescript")) {
  console.warn("tree-sitter-typescript not installed, skipping");
}

const source = `
import { EventEmitter } from "events";

export class AuthService extends EventEmitter {
  private tokens = new Map<string, string>();

  async login(userId: string, password: string): Promise<string> {
    const token = await this.generateToken(userId);
    this.tokens.set(userId, token);
    this.emit("login", userId);
    return token;
  }

  logout(userId: string): void {
    this.tokens.delete(userId);
    this.emit("logout", userId);
  }

  private async generateToken(userId: string): Promise<string> {
    // ... token generation logic
    return `tok_${userId}_${Date.now()}`;
  }
}
`;

const chunks = await chunker.chunk(source, "typescript");
```

Each chunk in the result:

```ts
interface CodeChunk {
  content: string;    // source text of the chunk
  startLine: number;  // 1-based start line in the original file
  endLine: number;    // 1-based end line in the original file
  nodeType: string;   // tree-sitter node type (see below)
}
```

For the example above, you'd get chunks like:

```
chunk[0]: "import { EventEmitter } from 'events';"
          startLine: 2, endLine: 2, nodeType: "preamble"

chunk[1]: "export class AuthService extends EventEmitter { ... }"
          startLine: 4, endLine: 25, nodeType: "class_declaration"
```

## Node Types

The chunker extracts these node types per language:

**TypeScript / TSX:**
- `function_declaration` — `function foo() {}`
- `class_declaration` — `class Foo {}`
- `method_definition` — methods inside a class
- `export_statement` — `export const foo = ...`, `export default ...`
- `lexical_declaration` — `const foo = ...` at module scope
- `interface_declaration` — TypeScript interfaces
- `type_alias_declaration` — `type Foo = ...`
- `enum_declaration` — TypeScript enums

**JavaScript / JSX:**
- `function_declaration`, `class_declaration`, `method_definition`, `export_statement`, `lexical_declaration`

**Python:**
- `function_definition` — `def foo():`
- `class_definition` — `class Foo:`
- `decorated_definition` — `@decorator\ndef foo():`

## Preamble Accumulation

Non-declaration nodes at the top of a file (imports, `"use strict"`, module-level comments) are accumulated and prepended to the first declaration chunk as a **preamble**. This preserves context:

```ts
// These lines become the preamble:
import { db } from "./database.js";
const MAX_RETRIES = 3;

// Combined with the first function:
export async function fetchUser(id: string) { ... }
```

The combined chunk gives the embedding model crucial context — it knows about `db` and `MAX_RETRIES` while processing `fetchUser`.

Trailing non-declaration nodes (after the last function/class) are returned as a separate `trailing` chunk.

## Large Node Splitting

If a single declaration (e.g., a 2000-line class) exceeds `maxChunkSize` (default: 1500 characters), the chunker recursively splits it by named children (methods):

```ts
// Override the size limit
const chunks = await chunker.chunk(source, "typescript", 2000);
```

When a class is split, each method becomes its own chunk. If a single method is still over the limit, it's returned as-is (further splitting would break semantics).

## Fallback for Empty Files

If the source has no declaration nodes (e.g., a config file, a `.d.ts` with only type exports), the entire source is returned as a single chunk with `nodeType: "module"`.

## Integrating with LibScope Lite

The typical pattern for indexing a codebase:

```ts
import { LibScopeLite, TreeSitterChunker } from "libscope/lite";
import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const chunker = new TreeSitterChunker();
const lite = new LibScopeLite({ dbPath: "./my-project.db" });

async function indexDirectory(dir: string): Promise<void> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });

  const tasks = entries
    .filter((e) => e.isFile())
    .map(async (entry) => {
      const filePath = join(entry.parentPath, entry.name);
      const ext = extname(entry.name).slice(1); // "ts", "py", etc.
      const source = await readFile(filePath, "utf8");

      if (chunker.supports(ext)) {
        // Code-aware chunking
        const chunks = await chunker.chunk(source, ext);
        return chunks.map((c) => ({
          title: `${filePath}:${c.startLine}-${c.endLine}`,
          content: c.content,
          url: filePath,
          library: "src",
        }));
      }

      // Plain text fallback for unsupported files
      return [{ title: filePath, content: source, url: filePath, library: "src" }];
    });

  const docGroups = await Promise.all(tasks);
  await lite.indexBatch(docGroups.flat(), { concurrency: 4 });
}

await indexDirectory("./src");
console.log("Indexed. Searching...");

const results = await lite.search("authentication token generation");
for (const r of results) {
  console.log(`${r.title} (score: ${r.score.toFixed(3)})`);
}

lite.close();
```

## Caching

`TreeSitterChunker` lazily initializes the tree-sitter parser and grammar modules on first use and caches them for the lifetime of the instance. Create one `TreeSitterChunker` instance and reuse it rather than creating a new one per file:

```ts
// Good — one instance, shared across all files
const chunker = new TreeSitterChunker();
for (const file of files) {
  const chunks = await chunker.chunk(await readFile(file, "utf8"), "typescript");
  // ...
}

// Avoid — new instance per file incurs repeated dynamic import overhead
for (const file of files) {
  const chunks = await new TreeSitterChunker().chunk(...);
}
```

## Error Handling

```ts
import { ValidationError } from "libscope";

try {
  const chunks = await chunker.chunk(source, "go");
} catch (err) {
  if (err instanceof ValidationError) {
    // "Unsupported language for code chunking: 'go'"
    // "Code chunking requires the 'tree-sitter' package. Install it with: ..."
    console.warn(err.message);
  }
}
```

Two error conditions:
1. **Unsupported language** — throws immediately with the list of supported aliases
2. **tree-sitter not installed** — throws with the exact `npm install` command

Both are `ValidationError` from LibScope's error hierarchy.

## See Also

- [LibScope Lite Guide](/guide/lite) — full LibScope Lite documentation
- [LibScope Lite API Reference](/reference/lite-api) — TypeScript API reference
