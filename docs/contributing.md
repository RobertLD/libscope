# Contributing

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/RobertLD/libscope.git
cd libscope
npm install
npm run build && node dist/cli/index.js doctor --fix
npm run dev  # TypeScript watch mode
```

## Scripts

| Command                 | Description                                                             |
| ----------------------- | ----------------------------------------------------------------------- |
| `npm run build`         | Compile TypeScript to `dist/`                                           |
| `npm run dev`           | Watch mode compilation                                                  |
| `npm run lint`          | Run ESLint                                                              |
| `npm run lint:fix`      | ESLint with auto-fix                                                    |
| `npm run format`        | Format with Prettier                                                    |
| `npm run format:check`  | Check formatting                                                        |
| `npm run typecheck`     | Type-check without emitting                                             |
| `npm test`              | Run tests                                                               |
| `npm run test:watch`    | Tests in watch mode                                                     |
| `npm run test:coverage` | Tests with coverage report                                              |
| `npm run docs:gen`      | Update the generated blocks in `docs/reference` (after `npm run build`) |
| `npm run docs:check`    | Fail when a generated block is out of date (runs in CI)                 |
| `npm run docs:dev`      | Docs site dev server (VitePress)                                        |
| `npm run docs:build`    | Build the docs site                                                     |

## Project Structure

```
src/
├── core/
│   ├── operations/  # The operation layer: every command, tool, route and SDK method calls one
│   ├── parsers/     # File format parsers
│   └── ...          # Business logic (ingest, indexing, search, rag, documents, tasks, ...)
├── cli/         # CLI: index.ts and one file per command group in commands/
├── mcp/         # MCP server: tools generated from operations
├── api/         # REST API: routes generated from operations, OpenAPI
├── web/         # Web dashboard
├── lite/        # libscope/lite: createLite(), code chunker, normalizeRawInput()
├── db/          # SQLite schema, migrations, connection
├── providers/   # Embedding providers (local, Ollama, OpenAI)
├── connectors/  # Notion, Slack, Confluence, Obsidian, OneNote, doc sites
├── registry/    # Git pack registries
├── config-schema.ts  # Config schema (keys, defaults, env vars)
├── config.ts    # Config loading
├── LibScope.ts  # Node.js SDK class
├── logger.ts    # Structured logging (pino)
└── errors.ts    # Error hierarchy
scripts/
└── gen-docs.mjs # Fills the generated blocks of docs/reference
tests/
├── unit/        # Fast isolated tests with mocked dependencies
├── integration/ # Tests with a real SQLite database
└── fixtures/    # Test helpers, mock providers, sample data
```

For a full module-by-module breakdown and data flow diagrams, see the [Architecture Guide](/guide/architecture).

## Design Principles

**Operations first.** New functionality is an operation in `src/core/operations/` (a zod input schema and a handler). The CLI, MCP server, REST API and SDK are thin adapters over the operations: they parse input and format output. Business logic lives in `src/core/`. See [How to Add an Operation](/guide/architecture#how-to-add-an-operation).

**Errors are typed.** Use the appropriate `LibScopeError` subclass (`DatabaseError`, `ValidationError`, `FetchError`, etc.) rather than throwing plain `Error`. Each surface maps errors in one place (`src/cli/errors.ts`, `withErrorHandling()` in `src/mcp/errors.ts`, `describeError()` in `src/api/adapter.ts`).

**Core modules are testable.** They accept `db` and `provider` as parameters — never import them directly inside a function. This makes it easy to swap in `createTestDb()` and `MockEmbeddingProvider` in tests.

**Migrations are additive.** Never modify an existing migration. Add a new entry in `MIGRATIONS` and increment `SCHEMA_VERSION` in `src/db/schema.ts`.

**No `any`.** Use `unknown` and narrow with type guards. The ESLint rule `no-explicit-any: "error"` is enforced.

**Generated references.** The CLI, MCP tool, configuration and REST references are partly generated from the code. After you change a command, tool, config key or route, run `npm run build && npm run docs:gen` and commit the result.

## Making Changes

1. **Create a branch** from `main`
2. **Make your changes** — keep them focused and minimal
3. **Add tests** for new functionality
4. **Run the full check suite:**
   ```bash
   npm run format:check && npm run lint && npm run typecheck && npm test
   npm run build && npm run docs:check
   ```
5. **Commit** with [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: add bulk import from directory`
   - `fix: handle empty document content`
   - `test: add coverage for search filters`
   - `docs: update CLI reference`
6. **Open a PR** against `main`

## Code Style

- TypeScript strict mode — no `any`, no unchecked index access
- ESLint + Prettier handle formatting (enforced by pre-commit hooks)
- Only add comments when the code needs clarification
- Custom errors should extend `LibScopeError`

## Testing

- **Unit tests** in `tests/unit/` — use the mock embedding provider and in-memory DB
- **Integration tests** in `tests/integration/` — full end-to-end workflows
- Target **80%+ coverage** on `src/core/` and `src/db/`
- Run `npm run test:coverage` to check

## Reporting Issues

Open an issue on GitHub with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Node.js version and OS

## License

By contributing, you agree that your contributions will be licensed under the project's license (Business Source License 1.1, see `LICENSE`).
