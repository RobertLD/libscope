---
name: ts-code-quality-audit
description: >
  Systematic TypeScript code-quality and bug audit for the LibScope codebase.
  Invoke when asked to audit, review, scan, or check code quality across the project.
---

# TypeScript Code Quality & Bug Audit

You are performing a **read-only audit**. Do not modify any files. Your job is to find real bugs, security issues, and convention violations — then report them with evidence.

## Phase 1 — Run Automated Tooling

Run the project's own static analysis first. These are deterministic and authoritative.

```bash
npm run typecheck 2>&1 | head -100
npm run lint 2>&1 | head -100
npm run test:coverage 2>&1 | tail -50
```

Record every failure. These are **confirmed issues** — no judgment needed.

If the tooling cannot run (missing dependencies, broken config), report that as a Critical finding and proceed to Phase 2.

## Phase 2 — Systematic Manual Review

Work through each category below **in order**. For each category, use `grep` or `glob` to search systematically — do not spot-check.

### 2.1 Security

These are the highest-priority findings. Search for each pattern explicitly.

| What to find | How to search | Why it matters |
|---|---|---|
| String equality on secrets (`===` or `!==` comparing tokens/keys/passwords) | `grep` for comparisons near variables named `token`, `key`, `secret`, `password`, `apiKey` | Must use `crypto.timingSafeEqual` to prevent timing attacks. See `src/api/middleware.ts` for the correct pattern. |
| `process.env.NODE_TLS_REJECT_UNAUTHORIZED` mutation | `grep` for `NODE_TLS_REJECT_UNAUTHORIZED` | Process-global — creates race conditions. Must use per-request `undici.Agent` instead. See `src/connectors/http-utils.ts` for the correct pattern. |
| `fetch()` without status checking | `grep` for `fetch(` calls, then verify each checks `response.ok` or `response.status` before using the body | `fetch()` resolves on 4xx/5xx. Unchecked responses silently swallow server errors. |
| Secrets in API/MCP responses | Review response payloads in `src/api/routes.ts` and `src/mcp/server.ts` | Tokens, keys, and credentials must be redacted before sending to clients. |
| SQL injection | `grep` for string concatenation or template literals inside SQL queries | All queries must use parameterized placeholders (`?`). `better-sqlite3` supports this natively. |
| SSRF on user-supplied URLs | Check `src/core/url-fetcher.ts` and any code that passes user input to `fetch()` | User-controlled URLs can target internal services. Verify SSRF guards are in place. |
| Unvalidated input on public API boundaries | Review route handlers in `src/api/routes.ts` and MCP tool handlers in `src/mcp/server.ts` | Inputs from HTTP requests and MCP calls are untrusted. Check for missing type/range/length validation. |

### 2.2 Error Handling

| What to find | How to search | Why it matters |
|---|---|---|
| Raw `new Error()` throws | `grep -n 'new Error\('` in `src/` (exclude `src/errors.ts`) | All errors must use the typed hierarchy from `src/errors.ts` (`LibScopeError`, `DatabaseError`, `ValidationError`, etc.). Raw `Error` bypasses structured error handling. |
| Swallowed exceptions | `grep` for `catch` blocks, then check if the body is empty, comment-only, or ignores the error variable | Silent failures hide bugs. At minimum, errors should be logged via `getLogger()`. |
| Missing `await` on async calls | Look for async function calls whose return value is not awaited, assigned, or returned | Creates unhandled promise rejections that crash the process in Node.js. |
| Catch-and-rethrow without context | `catch` blocks that throw a new error but discard the original `cause` | Loses the stack trace. Pass the original error as `cause` to the new error constructor. |

### 2.3 TypeScript Strictness

The project uses maximally strict TypeScript. These violations may compile but indicate latent bugs.

| What to find | How to search | Why it matters |
|---|---|---|
| `any` type usage | `grep` for `: any`, `as any`, `<any>` | Forbidden by ESLint rule `no-explicit-any: error`. Use `unknown` and narrow. |
| Unchecked indexed access | Look for `array[i]` or `obj[key]` used without nullish checks | `noUncheckedIndexedAccess` means these return `T \| undefined`. Using them as `T` is a type hole. |
| `undefined` assigned to optional properties | Look for `prop = undefined` on types with `prop?: T` | `exactOptionalPropertyTypes` means `prop?: string` does NOT accept `undefined` — omit the property instead. |
| Missing `.js` extensions in imports | `grep` for `from '..` or `from "..` imports that don't end in `.js'` or `.js"` | ESM requires explicit extensions. Missing `.js` fails at runtime. |

### 2.4 Resource Management

| What to find | How to search | Why it matters |
|---|---|---|
| SSE streams without backpressure | `grep` for `res.write(` in streaming/SSE code | `res.write()` returns `false` when the buffer is full or client disconnects. Ignoring it wastes compute and leaks connections. Check for `if (!ok) break` pattern. |
| Unclosed resources | Look for `fs.open`, `createReadStream`, database connections, or timers that aren't cleaned up in error/finally paths | Leaks file descriptors or memory over time. |
| Missing `AbortSignal` / timeout on outbound requests | Check `fetch()` calls for timeout configuration | Hanging requests tie up resources indefinitely. |

### 2.5 Logging Conventions

| What to find | How to search | Why it matters |
|---|---|---|
| `console.log/warn/error/info` in library code | `grep` for `console.` in `src/` excluding `src/cli/` | Library code (`src/core/`, `src/db/`, `src/providers/`, `src/api/`, `src/connectors/`) must use `getLogger()` from `src/logger.ts`. `console.log` is only acceptable in `src/cli/` for direct user output. |
| Logging sensitive data | Check `log.info/debug/warn/error` calls for variables that may contain tokens, keys, or credentials | Structured logs may be shipped to external systems. Secrets in logs are a data leak. |

### 2.6 Database & Migrations

| What to find | How to search | Why it matters |
|---|---|---|
| Modified existing migrations | `git log` on `src/db/schema.ts` migration entries | Existing migrations must never be modified — only new versioned migrations can be added. Modifying old migrations breaks databases that already ran them. |
| Missing transactions for multi-statement operations | Look for sequences of `db.prepare().run()` that should be atomic | Without a transaction, partial failures leave the database in an inconsistent state. |

### 2.7 Architecture & Design

| What to find | How to search | Why it matters |
|---|---|---|
| Framework dependencies in `src/core/` | `grep` for imports from `node:http`, express, commander, or MCP SDK in `src/core/` | `src/core/` must be framework-agnostic — pure business logic with no transport dependencies. |
| Circular imports | Trace import chains that form cycles (A→B→A or A→B→C→A) | Circular imports cause initialization bugs in ESM (imports resolve to `undefined`). |
| Dead code | Look for exported functions/types with zero internal references | Dead exports increase surface area and maintenance burden. |

## Phase 3 — Cross-Reference & Validate

Before finalizing findings, validate each one:

1. **Check tests** — If a "bug" is exercised by a passing test that asserts the current behavior, it may be intentional. Note this in your finding.
2. **Check `agents.md`** — The project documents specific security patterns and conventions. Verify your finding isn't contradicted by documented design decisions.
3. **Check git blame** — Recent intentional changes to a pattern suggest it's deliberate. Very old untouched code is more likely to be a real issue.
4. **Eliminate false positives** — If you're less than 70% confident a finding is real, do not include it. Noisy audits destroy trust.

## Phase 4 — Report

Produce a structured report grouped by file. Use exactly these severity levels:

### Severity Levels

- **🔴 Critical** — Bugs that cause incorrect behavior, security vulnerabilities, data loss, or crashes. Must fix.
- **🟡 Warning** — Code quality issues that increase risk of future bugs, violate project conventions, or make the code harder to maintain. Should fix.
- **🟢 Info** — Minor improvements. Nice to have.

### Report Format

For each finding:

```
### [severity emoji] file/path.ts:line — Short description

**Category:** Security | Error Handling | TypeScript | Resource | Logging | Database | Architecture
**Confidence:** High | Medium

[1-3 sentence explanation of the issue and its impact]

**Evidence:**
\`\`\`typescript
// the problematic code
\`\`\`

**Fix:** [1-2 sentence description of the correct approach, referencing project patterns where applicable]
```

### Report Rules

- **Do NOT flag style or formatting issues.** Prettier and ESLint handle these.
- **Do NOT flag test code** unless it has a bug that makes the test silently pass when it shouldn't.
- **Group findings by file**, with the most critical file first.
- **End with a summary table**: count of Critical / Warning / Info findings.
- If the audit finds zero issues, say so explicitly — do not invent findings to fill the report.
