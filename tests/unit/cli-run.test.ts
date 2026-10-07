/**
 * CLI end-to-end over an in-memory database: add -> search -> docs show, --json output,
 * and the one error handler (message, hint, stack only with --verbose, exit code 1).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, DocumentNotFoundError, ValidationError } from "../../src/errors.js";
import { createTestDbWithVec } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { testConfig } from "./operations/helpers.js";

const db = createTestDbWithVec();

vi.mock("../../src/core/bootstrap.js", () => ({
  bootstrap: (): unknown => ({
    db,
    provider: new MockEmbeddingProvider(),
    config: testConfig(),
    dbPath: ":memory:",
    close: (): void => {},
  }),
}));

const { main } = await import("../../src/cli/index.js");
const { errorHint, formatError } = await import("../../src/cli/errors.js");

let dir: string;
let stdout: string[];
let stderr: string[];

async function cli(...args: string[]): Promise<{ out: string; err: string; code: number }> {
  stdout = [];
  stderr = [];
  process.exitCode = undefined;
  await main(["node", "libscope", ...args]);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { out: stdout.join("\n"), err: stderr.join(""), code };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "libscope-cli-run-"));
  writeFileSync(
    join(dir, "widgets.md"),
    "# Widget Guide\n\nWidgets are configured with widget.yaml. Set the color key to change the color.",
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CLI over a database", () => {
  let documentId = "";

  it("add prints the new document ID; --json prints the operation results", async () => {
    const human = await cli("add", join(dir, "widgets.md"), "--tags", "guide");
    expect(human.code).toBe(0);
    expect(human.out).toMatch(/✓ widgets \(1 chunk\) {2}[0-9a-f-]{36}/);

    // Adding the same file again updates the same document (the path is its URL).
    const json = await cli("--json", "add", join(dir, "widgets.md"));
    const results = JSON.parse(json.out) as Array<{ documents: Array<{ documentId: string }> }>;
    documentId = results[0]?.documents[0]?.documentId ?? "";
    expect(human.out).toContain(documentId);
  });

  it("search shows document and chunk IDs; --json returns the ListResult", async () => {
    const human = await cli("search", "widget color");
    expect(human.out).toContain(`document ${documentId}  chunk `);

    const json = await cli("--json", "search", "widget color", "-n", "1");
    const result = JSON.parse(json.out) as {
      items: Array<{ documentId: string; chunkId: string }>;
      total: number;
      limit: number;
    };
    expect(result.limit).toBe(1);
    expect(result.items[0]?.documentId).toBe(documentId);
    expect(result.items[0]?.chunkId).toBeTruthy();
  });

  it("docs show prints metadata, tags and content", async () => {
    const { out, code } = await cli("docs", "show", documentId);
    expect(code).toBe(0);
    expect(out).toContain(`ID:        ${documentId}`);
    expect(out).toContain("Tags:      guide");
    expect(out).toContain("Widgets are configured");
  });

  it("docs list shows IDs", async () => {
    const { out } = await cli("docs", "list");
    expect(out).toContain(`${documentId}  widgets`);
  });

  it("ask without an LLM fails with the configuration hint", async () => {
    const { err, code } = await cli("ask", "what configures widgets?");
    expect(code).toBe(1);
    expect(err).toContain("✗ No LLM provider configured");
    expect(err).toContain("libscope doctor");
  });

  it("not found: message, hint, no stack, exit code 1", async () => {
    const { err, code } = await cli("docs", "show", "nope");
    expect(code).toBe(1);
    expect(err).toContain("✗ Document not found: nope");
    expect(err).toContain("libscope docs list");
    expect(err).not.toContain("    at ");
  });

  it("--verbose adds the stack trace", async () => {
    const { err } = await cli("--verbose", "docs", "show", "nope");
    expect(err).toContain("DocumentNotFoundError");
    expect(err).toContain("    at ");
  });

  it("invalid input is a validation error with a --help hint", async () => {
    const { err, code } = await cli("docs", "rate", documentId, "9");
    expect(code).toBe(1);
    expect(err).toContain("✗ Invalid input for rate-document");
    expect(err).toContain("--help");
  });

  it("search without a query outside a terminal asks for one", async () => {
    const { err, code } = await cli("--json", "search");
    expect(code).toBe(1);
    expect(err).toContain("Give a search query");
  });
});

describe("error hints", () => {
  it("suggests a next step per error type", () => {
    expect(errorHint(new DocumentNotFoundError("x"))).toContain("docs list");
    expect(errorHint(new ConfigError("x"))).toContain("doctor");
    expect(errorHint(new ValidationError("x"))).toContain("--help");
    expect(errorHint(new Error("x"))).toBeUndefined();
  });

  it("formats the message first and the stack only when verbose", () => {
    const err = new Error("boom");
    expect(formatError(err, false)).toEqual(["✗ boom"]);
    expect(formatError(err, true).join("\n")).toContain("Error: boom");
  });
});
