# LibScope — Agent & Copilot Guide

> This file helps AI coding agents (GitHub Copilot, Cursor, Cline, etc.) work effectively in this codebase.

## Project Overview

LibScope is an **AI-powered knowledge base with MCP (Model Context Protocol) integration**. It indexes documentation (library docs, internal wikis, topics) into a local SQLite + vector store and serves them to AI assistants via semantic search.

- **Language:** TypeScript (strict mode, ESM-only)
- **Runtime:** Node.js ≥ 20
- **Package manager:** npm
- **Module system:** ES Modules (`"type": "module"` in package.json)

## Quick Reference — Commands

| Task                    | Command                 |
| ----------------------- | ----------------------- |
| Build                   | `npm run build`         |
| Typecheck (no emit)     | `npm run typecheck`     |
| Run all tests           | `npm test`              |
| Run tests in watch mode | `npm run test:watch`    |
| Run tests with coverage | `npm run test:coverage` |
| Lint                    | `npm run lint`          |
| Lint and auto-fix       | `npm run lint:fix`      |
| Format check            | `npm run format:check`  |
| Format and write        | `npm run format`        |
| Start MCP server        | `npm run serve`         |
| TypeScript watch        | `npm run dev`           |

**Always run `npm run typecheck` and `npm test` before committing.**

## Architecture

```
src/
├── cli/index.ts          # CLI entry point (commander). All commands in one file.
├── mcp/server.ts         # MCP server (stdio transport, @modelcontextprotocol/sdk)
├── core/                 # Business logic — framework-agnostic, no side effects
│   ├── indexing.ts        #   Document parsing, chunking by heading, embedding + storage
│   ├── search.ts          #   Semantic (vector) + FTS5 + LIKE fallback search
│   ├── ratings.ts         #   Rating storage, aggregation, correction suggestions
│   ├── documents.ts       #   Document CRUD
│   ├── topics.ts          #   Topic hierarchy management
│   ├── url-fetcher.ts     #   Fetch URL → convert HTML to markdown-like text
│   └── index.ts           #   Public re-exports (barrel file)
├── db/
│   ├── connection.ts      #   SQLite connection + sqlite-vec extension loading
│   ├── schema.ts          #   Migrations (versioned) + vector table creation
│   └── index.ts           #   Re-exports
├── providers/
│   ├── embedding.ts       #   EmbeddingProvider interface
│   ├── local.ts           #   all-MiniLM-L6-v2 via @xenova/transformers (384 dims)
│   ├── ollama.ts          #   Ollama API provider (768 dims default)
│   ├── openai.ts          #   OpenAI text-embedding-3-small (1536 dims)
│   └── index.ts           #   Factory function + re-exports
├── config.ts              # 3-tier config: env > project .libscope.json > user ~/.libscope/config.json > defaults
├── logger.ts              # pino structured logging wrapper
└── errors.ts              # Custom error hierarchy
```

## Critical Conventions

### ESM + Native Modules

This project is **ESM-only** (`"type": "module"`). All imports must use `.js` extensions:

```typescript
// ✅ Correct
import { getDatabase } from "../db/connection.js";

// ❌ Wrong — will fail at runtime
import { getDatabase } from "../db/connection";
```

**sqlite-vec** is a native CommonJS module. It is loaded via `createRequire(import.meta.url)` in `src/db/connection.ts`. Do not convert this to an ESM import.

### TypeScript Strictness

The tsconfig is maximally strict. Key flags you must respect:

- `strict: true` — includes `noImplicitAny`, `strictNullChecks`, etc.
- `noUncheckedIndexedAccess: true` — array/object index access returns `T | undefined`
- `exactOptionalPropertyTypes: true` — `prop?: string` does NOT accept `undefined` as a value; omit the property instead
- `noUnusedLocals: true` / `noUnusedParameters: true` — prefix unused params with `_`

### Error Handling

All errors extend `LibScopeError` from `src/errors.ts`:

```
LibScopeError (base)
├── DatabaseError
├── EmbeddingError
├── ValidationError
├── ConfigError
├── DocumentNotFoundError
└── ChunkNotFoundError
```

- Public functions should throw typed errors from this hierarchy, never raw `Error`.
- MCP tool handlers catch errors and return structured error responses.
- CLI shows user-friendly messages; `--verbose` enables full stack traces.

### Logging

Uses **pino** for structured JSON logging via `src/logger.ts`.

- Call `initLogger(level)` once at startup.
- Use `getLogger()` everywhere else to obtain the singleton.
- Default level: `info` for CLI, `warn` for MCP server (to avoid polluting stdio).
- Never use `console.log` in `src/core/`, `src/db/`, or `src/providers/`. Use the logger. (`console.log` is acceptable in `src/cli/` for user-facing output.)

### Database

- **SQLite** via `better-sqlite3` (synchronous API — no async needed for DB calls).
- **sqlite-vec** extension for vector similarity search.
- **FTS5** virtual table (`chunks_fts`) for full-text keyword search.
- Schema is versioned via migrations in `src/db/schema.ts`. Increment `SCHEMA_VERSION` and add a new numbered migration entry.
- Vector table (`chunk_embeddings`) is created separately via `createVectorTable()` because it depends on the embedding provider's dimensions.

**Adding a migration:**

1. Increment `SCHEMA_VERSION` at the top of `src/db/schema.ts`.
2. Add a new key to the `MIGRATIONS` record with the SQL.
3. The migration must insert its version into `schema_version`.
4. Update the schema version assertion in `tests/unit/schema.test.ts`.

### Embedding Providers

All providers implement the `EmbeddingProvider` interface from `src/providers/embedding.ts`:

```typescript
interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}
```

The factory in `src/providers/index.ts` selects the provider based on config. Default is `local` (runs in-process, downloads model on first use).

### Config Precedence

Environment variables > project `.libscope.json` > user `~/.libscope/config.json` > hardcoded defaults.

Env vars: `LIBSCOPE_EMBEDDING_PROVIDER`, `LIBSCOPE_OPENAI_API_KEY`, `LIBSCOPE_OLLAMA_URL`, `LIBSCOPE_ALLOW_PRIVATE_URLS`, `LIBSCOPE_ALLOW_SELF_SIGNED_CERTS`.

## Testing

### Framework

**Vitest** — fast, native TypeScript & ESM support. Config in `vitest.config.ts`.

### Structure

```
tests/
├── fixtures/
│   ├── mock-provider.ts      # Deterministic 4D embedding provider (use in all unit tests)
│   ├── test-db.ts             # In-memory SQLite with migrations (no sqlite-vec)
│   ├── sample-api-docs.md     # Sample library documentation
│   └── sample-topic-docs.md   # Sample topic documentation
├── unit/                      # Fast, isolated, no I/O or network
│   ├── chunking.test.ts
│   ├── config.test.ts
│   ├── documents.test.ts
│   ├── errors.test.ts
│   ├── ratings.test.ts
│   ├── schema.test.ts
│   └── topics.test.ts
└── integration/
    └── workflow.test.ts       # Full index → search → rate → query flow
```

### Writing Tests

- **Use `MockEmbeddingProvider`** from `tests/fixtures/mock-provider.ts` for all tests that need embeddings. It returns deterministic 4D vectors — no model download, no network.
- **Use `createTestDb()`** from `tests/fixtures/test-db.ts` for an in-memory SQLite instance with all migrations applied.
- **sqlite-vec is NOT available in tests.** The test DB is plain SQLite. Vector search tests exercise the FTS5/LIKE fallback path. This is by design.
- **Coverage thresholds** (enforced in `vitest.config.ts`): statements ≥ 75%, branches ≥ 74%, functions ≥ 75%, lines ≥ 75%. CLI code (`src/cli/`) is excluded from coverage.
- **Always run `npm run test:coverage`** (not just `npm test`) before pushing. CI runs `test:coverage`, which fails if any threshold is missed. `npm test` alone does NOT check coverage.
- When adding new source files, ensure adequate test coverage so global thresholds are not violated. New files with many uncovered branches will drag the overall percentage down.
- Tests should be fast (< 1 second total), deterministic, and not depend on ordering.

### Common Gotcha

SQLite `datetime('now')` has **second-level precision**. If you insert multiple rows rapidly, they may share the same timestamp. Don't write tests that rely on sub-second ordering — use explicit ordering columns or accept any order within the same second.

## Code Style

- **Formatter:** Prettier (config in `.prettierrc`): double quotes, semicolons, trailing commas, 100 char width.
- **Linter:** ESLint with `@typescript-eslint/recommended-type-checked` rules. Key rules:
  - `no-explicit-any: error` — never use `any`; use `unknown` and narrow.
  - `explicit-function-return-type: warn` — annotate return types on exported functions.
  - `prefer-nullish-coalescing: error` / `prefer-optional-chain: error`.
  - Unused vars must be prefixed with `_`.
- **Husky** pre-commit hook runs `lint-staged` (ESLint fix + Prettier on staged `.ts` files).
- Minimal comments — only add comments when the code isn't self-explanatory.

## CI/CD

Three GitHub Actions workflows in `.github/workflows/`:

| Workflow      | Trigger       | What it does                                        |
| ------------- | ------------- | --------------------------------------------------- |
| `ci.yml`      | Push & PR     | Lint, typecheck, test (Node 18/20/22 matrix), build |
| `release.yml` | Tags `v*.*.*` | Full CI then `npm publish --provenance`             |
| `codeql.yml`  | Weekly + PR   | CodeQL security scanning                            |

## MCP Server

The MCP server (`src/mcp/server.ts`) uses **stdio transport** and exposes 5 tools:

1. `search-docs` — Semantic search with optional topic/library/version/rating filters
2. `get-document` — Retrieve a document by ID
3. `rate-document` — Rate a document or suggest corrections
4. `submit-document` — Submit a new document for indexing
5. `list-topics` — List available topics

To test the MCP server locally: `npm run build && npm run serve`

## Parallel Agent Work — Git Worktrees

When multiple agents work on the repo simultaneously, they **must** use **git worktrees** to avoid stepping on each other's working directory:

```bash
# From the main repo, create a worktree for your branch:
git worktree add ../libscope-<branch-name> -b <branch-name> origin/main

# Work entirely inside the worktree directory:
cd ../libscope-<branch-name>
npm install          # each worktree needs its own node_modules
# ... make changes, run tests, commit, push ...

# Clean up when done:
cd ~/Repos/libscope
git worktree remove ../libscope-<branch-name>
```

**Rules for parallel agents:**

- **Never** `git checkout` branches inside the shared main repo — use a worktree instead.
- Each worktree is an independent working directory with its own `node_modules/`.
- Run `npm install` in the worktree before building/testing (worktrees don't share `node_modules`).
- Push your branch from within the worktree, then create the PR via `gh pr create`.
- After the PR is merged, remove the worktree to keep things clean.
- If you need the latest `main`, run `git pull origin main` from within your worktree (or rebase).

**Why worktrees?** Multiple agents sharing a single working directory cause race conditions — concurrent `git checkout`, conflicting `node_modules`, and dirty working trees that break other agents' builds.

## Pull Request Lifecycle

Every PR must follow this complete lifecycle. **Do not consider a PR done until all steps are complete.**

### 1. Pre-PR (before opening)

1. Run the **full local validation suite**: `npm run typecheck && npm run test:coverage && npm run lint && npm run format:check` — all must pass.
2. Self-review your diff using a `code-review` sub-agent (`git diff main...HEAD`). Fix issues it finds before opening the PR.
3. Ensure the PR description accurately matches the implementation — don't describe features that aren't shipped.

### 2. Open the PR

1. Push the branch and create the PR via `gh pr create`.
2. Add a clear title and description summarizing all changes.

### 3. Wait for CI/CD and verify it passes

1. **After pushing, always check CI status.** Use GitHub Actions API (`actions_list` with `list_workflow_runs` filtered to the branch) to monitor the run.
2. **If CI fails, read the failure logs** (`get_job_logs` with `failed_only: true`), fix the issue, push again, and re-check. Repeat until all checks are green.
3. Common CI failures to watch for:
   - **Prettier formatting** — always run `npm run format:check` locally. If it fails, run `npx prettier --write <file>`.
   - **Coverage thresholds** — use `npm run test:coverage`, not `npm test`. New code that drops coverage below thresholds will fail CI.
   - **CodeQL alerts** — the `CodeQL` and `CodeQL/analyze` checks are separate from the main CI. Both must pass. CodeQL can be aggressive (e.g., flagging hash functions used on API keys). Read the specific alert and fix accordingly.
   - **ESLint errors** — run `npm run lint` locally before pushing.

### 4. Address review comments

1. **Check for review comments** on the PR using the GitHub API (`pull_request_read` with `get_review_comments`).
2. **Read and evaluate every comment** — if valid, implement the fix; if incorrect, reply explaining why.
3. Push fixes and verify CI passes again (go back to step 3).
4. **Reply to each comment thread** confirming the fix with the relevant commit SHA. Never leave review comments unaddressed — they block merge and erode reviewer trust.

### 5. Final verification

1. Confirm all CI checks are green.
2. Confirm all review comment threads are resolved (addressed in code + replied to).
3. Only then is the PR ready for merge.

**Key principle:** A PR is not "done" when you push code. It's done when CI is green, all review comments are addressed, and it's ready to merge.

## Adding a New Feature — Checklist

1. Add business logic in `src/core/` (no framework dependencies).
2. If it needs new DB tables/columns, add a migration in `src/db/schema.ts`.
3. Expose via MCP tool in `src/mcp/server.ts` and/or CLI command in `src/cli/index.ts`.
4. Write unit tests in `tests/unit/` using `MockEmbeddingProvider` and `createTestDb()`.
5. Add integration coverage in `tests/integration/workflow.test.ts` if it's a core flow.
6. Run `npm run typecheck && npm run test:coverage && npm run lint` — all must pass. **Use `test:coverage`, not `test`** — CI enforces coverage thresholds and will fail if new code drops coverage below the configured minimums (see `vitest.config.ts` thresholds).
7. **Update documentation** — see the Documentation section below.
8. **PR description must match implementation.** Don't describe features that aren't implemented yet — only document what actually ships in the PR. If scope is reduced, update the description before opening the PR.
9. **Verify HTTP error handling.** When writing code that calls external services (fetch, HTTP clients), always check response status codes — `fetch()` resolves on 4xx/5xx, so check `resp.ok` or `resp.status`. Never treat a resolved fetch as a success without status checking.
10. **Don't expose secrets in API responses.** If a model stores sensitive fields (tokens, secrets, keys), redact them from API/MCP response payloads.

## Documentation

Every user-facing change **must** update all relevant documentation. Documentation lives in multiple places — check each one:

| Location                          | What it covers                                                     |
| --------------------------------- | ------------------------------------------------------------------ |
| `README.md`                       | Top-level overview, quickstart, config tables, CLI summary         |
| `docs/guide/getting-started.md`   | First-run walkthrough                                              |
| `docs/guide/configuration.md`     | Config guide with env var table and examples                       |
| `docs/reference/cli.md`           | Full CLI command reference                                         |
| `docs/reference/configuration.md` | Complete config key reference, env vars, example config            |
| `agents.md`                       | Agent/Copilot guide — architecture, conventions, config precedence |

**What to update for common change types:**

- **New config key:** `src/config.ts` (interface + defaults + env override) → `README.md` (env var table, example config) → `docs/guide/configuration.md` (env var table) → `docs/reference/configuration.md` (config keys table, env vars table, example config) → `agents.md` (config precedence env var list)
- **New CLI command:** `src/cli/index.ts` → `README.md` (CLI table) → `docs/reference/cli.md` (command reference)
- **New MCP tool:** `src/mcp/server.ts` → `README.md` (MCP tools list) → `agents.md` (MCP Server section)
- **New connector:** `src/connectors/` → `README.md` (connectors section) → `docs/guide/` (new guide page) → `docs/reference/cli.md` (sync/disconnect commands)
- **New env var:** All env var tables: `README.md`, `docs/guide/configuration.md`, `docs/reference/configuration.md`
