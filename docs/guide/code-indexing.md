# Code Indexing

`libscope/lite` includes a tree-sitter code chunker that splits source files at function and class boundaries. These chunks embed much better than splits at a fixed line count. Use `createCodeChunker()` to index code with `LibScope`, or `TreeSitterChunker` to get the chunks with line numbers.

## Why Code-Aware Chunking Matters

The default LibScope chunker is paragraph- and heading-aware, which works well for documentation. For source code, it produces poor-quality chunks because:

- Code has no paragraph boundaries — it's one continuous text
- A 500-line class split arbitrarily at line 100 loses the method signatures that give it meaning
- A function split in the middle loses the return statement (the most semantically important part)

The tree-sitter chunker uses the Abstract Syntax Tree (AST) to split at **semantic boundaries** — each chunk is a complete, self-contained unit (a function, a class, a method) with its full signature and body.

## Installation

Tree-sitter is an **optional peer dependency**. Install the packages for the languages you need, with the versions that libscope supports (the latest grammar releases need a newer tree-sitter, and npm refuses to install them next to libscope):

```bash
# Core tree-sitter parser
npm install tree-sitter@0.21

# Language grammars (install only what you need)
npm install tree-sitter-typescript@0.21   # TypeScript + TSX
npm install tree-sitter-javascript@0.21   # JavaScript, JSX, MJS, CJS
npm install tree-sitter-python@0.21       # Python
npm install tree-sitter-c-sharp@0.21      # C#
npm install tree-sitter-cpp@0.22          # C++ (also used for .h/.hpp headers)
npm install tree-sitter-c@0.21            # C
npm install tree-sitter-go@0.21           # Go
```

If tree-sitter is not installed, `TreeSitterChunker.chunk()` throws a `ValidationError` with the install command, and `createCodeChunker()` falls back to the built-in chunker. Everything else works without tree-sitter.

## Supported Languages

| Language   | Aliases                                 | Grammar Package          |
| ---------- | --------------------------------------- | ------------------------ |
| TypeScript | `typescript`, `ts`, `tsx`               | `tree-sitter-typescript` |
| JavaScript | `javascript`, `js`, `jsx`, `mjs`, `cjs` | `tree-sitter-javascript` |
| Python     | `python`, `py`                          | `tree-sitter-python`     |
| C#         | `csharp`, `cs`                          | `tree-sitter-c-sharp`    |
| C++        | `cpp`, `cc`, `cxx`, `hpp`, `h`          | `tree-sitter-cpp`        |
| C          | `c`                                     | `tree-sitter-c`          |
| Go         | `go`                                    | `tree-sitter-go`         |

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
    return "tok_" + userId + "_" + Date.now();
  }
}
`;

const chunks = await chunker.chunk(source, "typescript");
```

Each chunk in the result:

```ts
interface CodeChunk {
  content: string; // source text of the chunk
  startLine: number; // 1-based start line in the original file
  endLine: number; // 1-based end line in the original file
  nodeType: string; // tree-sitter node type (see below)
}
```

For the example above, the class fits in one chunk (under 1500 characters). The import before it is prepended to it as a preamble:

```
chunk[0]: "import { EventEmitter } from \"events\";\n\nexport class AuthService ... }"
          startLine: 2, endLine: 23, nodeType: "export_statement"
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

**C#:**

- `method_declaration` — `public void Foo() {}`
- `class_declaration` — `class Foo {}`
- `interface_declaration` — `interface IFoo {}`
- `struct_declaration` — `struct Point {}`
- `enum_declaration` — `enum Color {}`
- `constructor_declaration` — `public Foo() {}`

**C++:**

- `function_definition` — `void foo() {}`
- `class_specifier` — `class Foo {}`
- `struct_specifier` — `struct Point {}`
- `namespace_definition` — `namespace MyNS {}`

**C:**

- `function_definition` — `void foo() {}`
- `struct_specifier` — `struct Point {}`

**Go:**

- `function_declaration` — `func Foo() {}`
- `method_declaration` — `func (r *Receiver) Foo() {}`
- `type_declaration` — `type Foo struct {}` / `type Bar interface {}`

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

## Indexing code with LibScope

`createCodeChunker()` returns a `Chunker` for `createLite()` or `LibScope.create()`. `add()` then splits each document with tree-sitter. The language comes from the extension of the file path, URL or title (or the `language` option). Documents in other languages use the built-in chunker.

```ts
import { createLite, createCodeChunker } from "libscope/lite";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const scope = createLite({ dbPath: "./my-project.db", chunker: createCodeChunker() });

const entries = await readdir("./src", { recursive: true, withFileTypes: true });
await Promise.all(
  entries
    .filter((e) => e.isFile())
    .map(async (e) => {
      const path = join(e.parentPath, e.name);
      await scope.add({ title: path, content: await readFile(path, "utf8"), library: "src" });
    }),
);

const { items } = await scope.search("authentication token generation");
for (const r of items) console.log(`${r.title} (score: ${r.score.toFixed(3)})`);

scope.close();
```

`scope.add(path)` does not accept source-code extensions such as `.ts` or `.py` (only document formats). Read the file and pass its `content` with the path as `title`, as above.

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
  const chunks = await chunker.chunk(source, "rust");
} catch (err) {
  if (err instanceof ValidationError) {
    // Unsupported language for code chunking: "rust"
    // Code chunking requires the "tree-sitter" package. Install it with: ...
    console.warn(err.message);
  }
}
```

Two error conditions:

1. **Unsupported language** — throws immediately (the aliases are in [Supported Languages](#supported-languages))
2. **tree-sitter not installed** — throws with the exact `npm install` command

Both are `ValidationError` from LibScope's error hierarchy.

## See Also

- [LibScope Lite Guide](/guide/lite) — full LibScope Lite documentation
- [LibScope Lite API Reference](/reference/lite-api) — TypeScript API reference
