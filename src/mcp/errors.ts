import { LibScopeError } from "../errors.js";
import { getLogger } from "../logger.js";

/** Convert a thrown error into an MCP error response object. */
export function errorResponse(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  let message: string;
  if (err instanceof LibScopeError) {
    message = err.message;
  } else if (err instanceof Error) {
    message = `${err.name}: ${err.message}`;
  } else {
    message = `An unexpected error occurred: ${String(err)}`;
  }

  const log = getLogger();
  log.error({ err }, "MCP tool error");

  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Wraps a tool handler so that thrown errors are converted to MCP error responses. */
export function withErrorHandling<P>(
  handler: (params: P) => ToolResult | Promise<ToolResult>,
): (params: P) => Promise<ToolResult> {
  return async (params: P) => {
    try {
      return await handler(params);
    } catch (err) {
      return errorResponse(err);
    }
  };
}
