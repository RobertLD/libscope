# Contributing to LibScope

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
# Clone the repo
git clone https://github.com/RobertLD/libscope.git
cd libscope

# Install dependencies
npm install

# Initialize the database
npm run build && node dist/cli/index.js init

# Run in development mode (watch)
npm run dev
```

## Scripts

| Command                 | Description                      |
| ----------------------- | -------------------------------- |
| `npm run build`         | Compile TypeScript to `dist/`    |
| `npm run dev`           | Watch mode compilation           |
| `npm run lint`          | Run ESLint                       |
| `npm run lint:fix`      | Run ESLint with auto-fix         |
| `npm run format`        | Format code with Prettier        |
| `npm run format:check`  | Check formatting without changes |
| `npm run typecheck`     | Type-check without emitting      |
| `npm test`              | Run tests                        |
| `npm run test:watch`    | Run tests in watch mode          |
| `npm run test:coverage` | Run tests with coverage report   |

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

By contributing, you agree that your contributions will be licensed under the MIT License.
