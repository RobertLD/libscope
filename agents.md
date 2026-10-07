# LibScope — Agent & Copilot Guide

> This file helps AI coding agents (GitHub Copilot, Cursor, Cline, etc.) work effectively in this codebase.

## Project Overview

LibScope is an **AI-powered knowledge base with MCP (Model Context Protocol) integration**. It indexes documentation (library docs, internal wikis, topics) into a local SQLite + vector store and serves them to AI assistants via semantic search.

- **Language:** TypeScript (strict mode, ESM-only)
- **Runtime:** Node.js ≥ 20
- **Package manager:** npm
- **Module system:** ES Modules (`"type": "module"` in package.json)

## Quick Reference — Commands

| Task                      | Command                             |
| ------------------------- | ----------------------------------- |
| Build                     | `npm run build`                     |
| Typecheck (no emit)       | `npm run typecheck`                 |
| Run all tests             | `npm test`                          |
| Run tests in watch mode   | `npm run test:watch`                |
| Run tests with coverage   | `npm run test:coverage`             |
| Lint                      | `npm run lint`                      |
| Lint and auto-fix         | `npm run lint:fix`                  |
| Format check              | `npm run format:check`              |
| Format and write          | `npm run format`                    |
| Start MCP server          | `npm run serve`                     |
| TypeScript watch          | `npm run dev`                       |
| Regenerate reference docs | `npm run build && npm run docs:gen` |
| Check reference docs      | `npm run docs:check`                |

**Always run `npm run typecheck` and `npm test` before committing.**

## Architecture

One operation layer, four thin surfaces. Every operation (add, search, ask, get-document, ...) is defined once in `src/core/operations/`: a name, a zod input schema (parameter names, defaults, validation, descriptions), annotations, an optional REST mapping (`http`) and a handler. The CLI, the MCP server, the REST API and the SDK are adapters: they parse input, call `runOperation()` (or `startOperationTask()` for long-running operations) and format the result.

```
src/
├── core/
│   ├── operations/        # The operation layer: types.ts (defineOperation, runOperation,
│   │                      #   startOperationTask, createOperationContext), schemas.ts (shared
│   │                      #   input fields), one file per group, index.ts (OPERATIONS)
│   ├── bootstrap.ts       # One startup for every surface: config, database, provider, vector table
│   ├── ingest.ts          # Add inline content, files, directories, URLs, crawls, repositories
│   ├── search.ts, rag.ts  # Hybrid search (vector + FTS5, RRF) and answer() for ask
│   ├── tasks.ts           # In-memory background task registry (AbortSignal, progress)
│   ├── overview.ts, document-view.ts, documents.ts, topics.ts, tags.ts, links.ts, packs.ts, ...
│   └── parsers/           # File format parsers (markdown, pdf, docx, html, epub, pptx, csv, yaml, json)
├── cli/
│   ├── index.ts           # Commander program, global options, one error handler
│   └── commands/          # One file per command group; each exports register(program)
├── mcp/
│   ├── server.ts          # createMcpServer(): tools generated from operations (core + admin toolsets)
│   ├── format.ts          # Compact text output for tools
│   └── main.ts            # Executable entry point (stdio)
├── api/
│   ├── routes.ts          # API_ROUTES: one route per operation with `http`, plus /openapi.json and /health
│   ├── openapi.ts         # buildOpenApiSpec() from the same routes
│   ├── adapter.ts         # Request to operation input; response and error mapping
│   ├── middleware.ts      # Auth, rate limiting, CORS, body parsing
│   └── server.ts          # HTTP server
├── web/                   # Dashboard server; dashboard.ts is one large template literal (do not edit)
├── LibScope.ts            # SDK: LibScope.create(), add/search/ask/askStream/overview and namespaces
│                          #   (docs, topics, tags, links, searches, packs, registries, connectors,
│                          #   tasks, admin, analytics, webhooks) bound to operations
├── lite/                  # libscope/lite: createLite() preset, tree-sitter code chunker, normalizeRawInput
├── connectors/            # Notion, Slack, Confluence, Obsidian, OneNote, docs sites; registry.ts lists them
├── registry/              # Git-backed pack registries
├── db/                    # better-sqlite3 + sqlite-vec; schema.ts has the migrations (schema version 19)
├── providers/             # Embedding providers: local (384 dims), ollama, openai
├── config-schema.ts       # One zod schema: keys, defaults, env var names, docs table
├── config.ts              # loadConfig(), secrets.json, config set/unset
├── logger.ts              # pino
└── errors.ts              # Error hierarchy
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
├── ValidationError     (REST 400)
├── FetchError          (REST 502)
├── ConfigError
└── NotFoundError       (REST 404; the code names the resource, e.g. LINK_NOT_FOUND)
    ├── DocumentNotFoundError
    ├── ChunkNotFoundError
    └── TopicNotFoundError
```

- Public functions should throw typed errors from this hierarchy, never raw `Error`.
- MCP tools return the error message with `isError: true`. REST answers `{ "error": { "code", "message" } }`.
- The CLI prints `✗ <message>` and a next step; `--verbose` adds the stack trace.

### Logging

Uses **pino** for structured JSON logging via `src/logger.ts`.

- Call `initLogger(level)` once at startup.
- Use `getLogger()` everywhere else to obtain the singleton.
- The CLI logs nothing by default (`--verbose` or `--log-level` turns logs on). The MCP server logs at `logging.level` to stderr, so stdout carries only JSON-RPC.
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
4. Update the tests that assert the schema version.

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

### Configuration

One zod schema (`src/config-schema.ts`) defines every key, its default, its validation and its environment variable (`LIBSCOPE_<SECTION>_<FIELD>`, for example `embedding.model` becomes `LIBSCOPE_EMBEDDING_MODEL`). The key table in `docs/reference/configuration.md` is generated from it.

Precedence: environment variables > `~/.libscope/secrets.json` (API keys only) > project `.libscope.json` > user `~/.libscope/config.json` > defaults.

Main env vars: `LIBSCOPE_EMBEDDING_PROVIDER`, `LIBSCOPE_EMBEDDING_MODEL`, `LIBSCOPE_EMBEDDING_URL`, `LIBSCOPE_LLM_PROVIDER`, `LIBSCOPE_LLM_MODEL`, `LIBSCOPE_LLM_URL`, `LIBSCOPE_OPENAI_API_KEY` (or `OPENAI_API_KEY`), `LIBSCOPE_ANTHROPIC_API_KEY` (or `ANTHROPIC_API_KEY`), `LIBSCOPE_INDEXING_ALLOW_PRIVATE_URLS`, `LIBSCOPE_INDEXING_ALLOW_SELF_SIGNED_CERTS`, `LIBSCOPE_MCP_TOOLSETS`. Not config keys: `LIBSCOPE_WORKSPACE`, `LIBSCOPE_API_KEY` (REST auth), `LIBSCOPE_SECRET_KEY`.

## Security Patterns

### Authentication — use constant-time comparison

The API key check in `src/api/middleware.ts` must use `crypto.timingSafeEqual` to prevent timing attacks. Direct string equality (`===` / `!==`) short-circuits on the first differing byte, leaking information about the key length and value.

```typescript
import { timingSafeEqual } from "node:crypto";

// ✅ Correct
const tokenBuf = Buffer.from(token);
const keyBuf = Buffer.from(apiKey);
if (tokenBuf.length !== keyBuf.length || !timingSafeEqual(tokenBuf, keyBuf)) {
  return sendError(res, 401, "UNAUTHORIZED", "Invalid API key");
}

// ❌ Wrong — timing-attack vulnerable
if (token !== apiKey) { ... }
```

### TLS — use per-request undici Agent, not process-wide env var

When self-signed certificates must be accepted (controlled by `config.indexing.allowSelfSignedCerts`), configure TLS per-request via an `undici.Agent` passed as `dispatcher`. Do **not** mutate `process.env["NODE_TLS_REJECT_UNAUTHORIZED"]` — it is process-global and creates a race condition with concurrent requests.

```typescript
import { Agent } from "undici";

// ✅ Correct — scoped to this request chain only
let _insecureAgent: Agent | undefined;
const getInsecureAgent = (): Agent =>
  (_insecureAgent ??= new Agent({ connect: { rejectUnauthorized: false } }));

const response = await fetch(url, {
  // @ts-expect-error — Node.js undici-based fetch accepts dispatcher for per-request TLS config
  dispatcher: allowSelfSigned ? getInsecureAgent() : undefined,
});

// ❌ Wrong — affects all concurrent requests until restored
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
```

## Testing

### Framework

**Vitest** — fast, native TypeScript & ESM support. Config in `vitest.config.ts`.

### Structure

```
tests/
├── fixtures/
│   ├── mock-provider.ts       # Deterministic 4D embedding provider (use in all unit tests)
│   ├── test-db.ts             # createTestDb(): in-memory SQLite with migrations; createTestDbWithVec()
│   ├── helpers.ts             # insertDoc, insertChunk, seedTestDocument
│   └── sample-*.md            # Sample documents
├── unit/                      # Fast, isolated, no network (unit/operations/ tests the operations)
└── integration/               # Real SQLite, full workflows (index, search, rate)
```

### Writing Tests

- **Use `MockEmbeddingProvider`** from `tests/fixtures/mock-provider.ts` for all tests that need embeddings. It returns deterministic 4D vectors — no model download, no network.
- **Use `createTestDb()`** from `tests/fixtures/test-db.ts` for an in-memory SQLite instance with all migrations applied.
- **`createTestDb()` does not load sqlite-vec.** Vector search tests use `createTestDbWithVec()` or exercise the FTS5/keyword path.
- **Coverage thresholds** (enforced in `vitest.config.ts`): statements ≥ 75%, branches ≥ 74%, functions ≥ 75%, lines ≥ 75%. `src/cli/`, `src/mcp/main.ts` and the network embedding providers are excluded from coverage.
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

Workflows in `.github/workflows/`:

| Workflow                       | What it does                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`                       | Lint, format check, typecheck, `test:coverage` (Node 20 and 22), build, `docs:check` (the generated reference docs must be current) |
| `codeql.yml`                   | CodeQL security scanning                                                                                                            |
| `release-please.yml`           | Release PRs and the changelog                                                                                                       |
| `docker.yml`                   | Docker image                                                                                                                        |
| `sdk-python.yml`, `sdk-go.yml` | Python and Go client SDKs                                                                                                           |
| `release-python.yml`           | Python SDK release                                                                                                                  |

## Surfaces

- **MCP** (`src/mcp/server.ts`): 11 core tools (`search`, `ask`, `get-document`, `list-documents`, `overview`, `submit-document`, `update-document`, `delete-document`, `rate-document`, `link-documents`, `task`). `ask` is registered only with passthrough or a configured LLM. The admin toolset (`mcp.toolsets` or `LIBSCOPE_MCP_TOOLSETS=admin`) adds `sync`, `install-pack`, `list-packs` and `reindex-documents`. See `docs/reference/mcp-tools.md`. Test locally: `npm run build && npm run serve`.
- **CLI** (`src/cli/commands/*`): see `docs/reference/cli.md` or `libscope --help`.
- **REST** (`src/api/routes.ts`): every route under `/api/v1` comes from an operation's `http` mapping. Long-running operations answer `202` with a task ID. See `docs/reference/rest-api.md`.
- **SDK** (`src/LibScope.ts`): methods call the same operations. The package root exports only the class, its types, the provider interfaces and the errors.

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

1. Add business logic in `src/core/` (no surface dependencies).
2. If it needs new DB tables/columns, add a migration in `src/db/schema.ts`.
3. Add or extend an operation in `src/core/operations/` (an input schema with `.describe()` on every field, defaults only in the schema, an `http` mapping for REST). The REST route and the OpenAPI entry follow from it. Add it to an SDK namespace in `src/LibScope.ts`, a CLI command in `src/cli/commands/`, and, only if assistants need it, an MCP tool in `src/mcp/server.ts`.
4. Write unit tests in `tests/unit/` using `MockEmbeddingProvider` and `createTestDb()`.
5. Add integration coverage in `tests/integration/workflow.test.ts` if it's a core flow.
6. Run `npm run typecheck && npm run test:coverage && npm run lint` — all must pass. **Use `test:coverage`, not `test`** — CI enforces coverage thresholds and will fail if new code drops coverage below the configured minimums (see `vitest.config.ts` thresholds).
7. **Update documentation** — see the Documentation section below.
8. **PR description must match implementation.** Don't describe features that aren't implemented yet — only document what actually ships in the PR. If scope is reduced, update the description before opening the PR.
9. **Verify HTTP error handling.** When writing code that calls external services (fetch, HTTP clients), always check response status codes — `fetch()` resolves on 4xx/5xx, so check `resp.ok` or `resp.status`. Never treat a resolved fetch as a success without status checking.
10. **Don't expose secrets in API responses.** If a model stores sensitive fields (tokens, secrets, keys), redact them from API/MCP response payloads.

## Documentation

Every user-facing change **must** update the documentation. The CLI, MCP tool, config key and REST route tables in `docs/reference/` are generated from the code: run `npm run build && npm run docs:gen` and commit the result. CI runs `npm run docs:check`, which fails when a generated block is out of date.

| Location                          | What it covers                                                               |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `README.md`                       | Pitch and quick start (CLI, MCP, SDK); links to the docs site                |
| `docs/guide/*.md`                 | Guides (getting started, configuration, connectors, programmatic usage, ...) |
| `docs/reference/cli.md`           | CLI reference (generated option tables, hand-written examples)               |
| `docs/reference/mcp-tools.md`     | MCP tools (generated)                                                        |
| `docs/reference/rest-api.md`      | REST routes (generated) and conventions                                      |
| `docs/reference/configuration.md` | Config keys (generated), config files, other env vars                        |
| `docs/migration-v2.md`            | Every name removed or renamed in 2.0                                         |
| `agents.md`, `CLAUDE.md`          | Agent guides: architecture, conventions                                      |

Do not edit `CHANGELOG.md` or `docs/changelog.md`; release-please writes them.
