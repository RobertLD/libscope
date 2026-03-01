# Contributing

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/RobertLD/libscope.git
cd libscope
npm install
npm run build && node dist/cli/index.js init
npm run dev  # TypeScript watch mode
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | Watch mode compilation |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | ESLint with auto-fix |
| `npm run format` | Format with Prettier |
| `npm run format:check` | Check formatting |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run tests |
| `npm run test:watch` | Tests in watch mode |
| `npm run test:coverage` | Tests with coverage report |

## Project Structure

```
src/
├── core/        # Business logic (indexing, search, ratings, topics, documents)
├── db/          # SQLite schema, migrations, connection management
├── providers/   # Embedding providers (local, Ollama, OpenAI)
├── mcp/         # MCP server and tool definitions
├── cli/         # CLI entry point and commands
├── config.ts    # Configuration management
├── logger.ts    # Structured logging (pino)
└── errors.ts    # Custom error hierarchy
tests/
├── unit/        # Fast isolated tests with mocked dependencies
├── integration/ # Tests with real SQLite DB
└── fixtures/    # Test helpers, mock providers, sample data
```

## Making Changes

1. **Create a branch** from `main`
2. **Make your changes** — keep them focused and minimal
3. **Add tests** for new functionality
4. **Run the full check suite:**
   ```bash
   npm run lint && npm run typecheck && npm test
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

By contributing, you agree that your contributions will be licensed under the MIT License.
