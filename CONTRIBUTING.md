# Contributing to LibScope

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
# Clone the repo
git clone https://github.com/RobertLD/libscope.git
cd libscope

# Install dependencies
npm install

# Build, then check the setup (creates the database)
npm run build && node dist/cli/index.js doctor --fix

# Run in development mode (watch)
npm run dev
```

## Scripts

| Command                 | Description                                                             |
| ----------------------- | ----------------------------------------------------------------------- |
| `npm run build`         | Compile TypeScript to `dist/`                                           |
| `npm run dev`           | Watch mode compilation                                                  |
| `npm run lint`          | Run ESLint                                                              |
| `npm run lint:fix`      | Run ESLint with auto-fix                                                |
| `npm run format`        | Format code with Prettier                                               |
| `npm run format:check`  | Check formatting without changes                                        |
| `npm run typecheck`     | Type-check without emitting                                             |
| `npm test`              | Run tests                                                               |
| `npm run test:watch`    | Run tests in watch mode                                                 |
| `npm run test:coverage` | Run tests with coverage report                                          |
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

See the [Architecture Guide](docs/guide/architecture.md) for the operation layer and how to add an operation. The CLI, MCP tool, configuration and REST references in `docs/reference` are partly generated from the code: after you change a command, tool, config key or route, run `npm run build && npm run docs:gen` and commit the result.

## Making Changes

1. **Create a branch** from `main`
2. **Make your changes** — keep them focused and minimal
3. **Add tests** for new functionality
4. **Run the full check suite:**
   ```bash
   npm run format:check && npm run lint && npm run typecheck && npm test
   npm run build && npm run docs:check
   ```
5. **Commit** with a descriptive message following [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: add bulk import from directory`
   - `fix: handle empty document content`
   - `test: add coverage for search filters`
   - `docs: update README with new CLI commands`
6. **Open a PR** against `main`

## Code Style

- TypeScript strict mode — no `any`, no unchecked index access
- ESLint + Prettier handle formatting (enforced by pre-commit hooks)
- Only add comments when the code needs clarification
- Custom errors should extend `LibScopeError`

## Testing

- **Unit tests** go in `tests/unit/` — use the mock embedding provider and in-memory DB
- **Integration tests** go in `tests/integration/` — test full workflows end-to-end
- Target **80%+ coverage** on `src/core/` and `src/db/`
- Run `npm run test:coverage` to check

## Reporting Issues

Open an issue on GitHub with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Your Node.js version and OS

## License

By contributing, you agree that your contributions will be licensed under the project's license (Business Source License 1.1, see `LICENSE`).
