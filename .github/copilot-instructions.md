# Copilot Instructions for LibScope

Refer to [agents.md](../agents.md) at the repository root for full architecture, conventions, and development guide.

## Key Rules

- This is an **ESM-only TypeScript** project. All imports must use `.js` extensions.
- TypeScript is **maximally strict** (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, etc.).
- Never use `any` — use `unknown` and narrow the type.
- Throw typed errors from `src/errors.ts`, never raw `Error`.
- Use `getLogger()` from `src/logger.ts` for logging in library code (not `console.log`).
- sqlite-vec is loaded via `createRequire` — do not change this to an ESM import.
- Database migrations are versioned — never modify existing migrations, only add new ones.
- Tests use `MockEmbeddingProvider` and in-memory SQLite (no sqlite-vec in tests).
- Run `npm run typecheck && npm run test:coverage && npm run lint` before considering work complete. Use `test:coverage` (not `test`) — CI enforces coverage thresholds (statements ≥ 75%, branches ≥ 74%, functions ≥ 75%, lines ≥ 75%) and will reject PRs that drop below them.
- Before creating a PR, use a `code-review` sub-agent to self-review your diff. Fix any issues it finds before opening the PR.
- **PR lifecycle is mandatory.** After pushing a PR, always: (1) wait for CI/CD to complete, (2) check if it passed, (3) fix failures and re-push if needed, (4) read and address all review comments, (5) verify CI is green again. A PR is not done until all checks pass and all review comments are resolved. See the "Pull Request Lifecycle" section in `agents.md` for the full workflow.
