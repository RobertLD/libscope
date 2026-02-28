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
- Run `npm run typecheck && npm test && npm run lint` before considering work complete.
