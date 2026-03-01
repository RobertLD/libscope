import type { IncomingMessage, ServerResponse } from "node:http";

/** Set CORS headers and handle OPTIONS preflight. Returns true if request was handled (preflight). */
export function corsMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  origins: string[],
): boolean {
  const origin = req.headers["origin"] ?? "*";
  const allowedOrigin = origins.includes("*") ? "*" : origins.includes(origin) ? origin : "";

  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

/** Parse the request body as JSON. Returns the parsed object or null on failure. */
export async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** Send a JSON success response with consistent envelope. */
export function sendJson(res: ServerResponse, status: number, data: unknown, took?: number): void {
  const body: Record<string, unknown> = { data };
  if (took !== undefined) {
    body["meta"] = { took };
  }
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

/** Send a JSON error response with consistent envelope. */
export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  const json = JSON.stringify({ error: { code, message } });
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}
