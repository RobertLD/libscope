/**
 * Executable entry point: `node dist/mcp/main.js` serves libscope over MCP stdio.
 * Everything else lives in server.ts, which has no side effects on import.
 */
import { runStdioServer } from "./server.js";

try {
  await runStdioServer();
} catch (err: unknown) {
  console.error(
    "libscope MCP server failed to start:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
}
