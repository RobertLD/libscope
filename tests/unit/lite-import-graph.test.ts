import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * `libscope/lite` (and the package root) must stay embeddable: their static import graph may
 * not reach the CLI, MCP server, REST API, web UI or connectors. Connector operations are
 * loaded with a dynamic import() the first time `scope.connectors.*` is called.
 */
const SRC = resolve(__dirname, "../../src");
const FORBIDDEN_DIRS = ["cli/", "mcp/", "api/", "web/", "connectors/"];
const FORBIDDEN_PACKAGES = ["commander", "@modelcontextprotocol/sdk", "node-cron"];

const STATEMENT_STARTS = ["import ", "export {", "export *"];

/** The module specifier of one import/export statement, or undefined if it has none. */
function specifierOf(stmt: string): string | undefined {
  const FROM = ' from "';
  const at = stmt.lastIndexOf(FROM);
  let start: number;
  if (at !== -1) start = at + FROM.length;
  else if (stmt.startsWith('import "')) start = 'import "'.length;
  else return undefined;
  return stmt.slice(start, stmt.indexOf('"', start));
}

/** Module specifiers of value (not type-only) static imports and re-exports. */
function staticImports(source: string): string[] {
  const specs: string[] = [];
  let stmt: string | undefined;
  for (const line of source.split("\n")) {
    if (stmt === undefined) {
      if (!STATEMENT_STARTS.some((s) => line.startsWith(s))) continue;
      stmt = line;
    } else {
      stmt += ` ${line.trim()}`;
    }
    if (!line.trimEnd().endsWith(";")) continue;
    const typeOnly = stmt.startsWith("import type ") || stmt.startsWith("export type ");
    const spec = typeOnly ? undefined : specifierOf(stmt);
    if (spec !== undefined) specs.push(spec);
    stmt = undefined;
  }
  return specs;
}

function importGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of staticImports(readFileSync(file, "utf-8"))) {
      if (spec.startsWith(".")) {
        pending.push(join(dirname(file), spec).replace(/\.js$/, ".ts"));
      } else {
        packages.add(spec);
      }
    }
  }
  return { files, packages };
}

describe.each(["lite/index.ts", "core/index.ts"])("import graph of src/%s", (entry) => {
  const { files, packages } = importGraph(join(SRC, entry));
  const rel = [...files].map((f) => relative(SRC, f).replaceAll("\\", "/"));

  it("does not reach the CLI, MCP, REST, web or connector modules", () => {
    expect(rel.filter((f) => FORBIDDEN_DIRS.some((d) => f.startsWith(d)))).toEqual([]);
  });

  it("does not import commander, the MCP SDK or the scheduler", () => {
    expect([...packages].filter((p) => FORBIDDEN_PACKAGES.includes(p))).toEqual([]);
  });

  it("includes the operation layer (sanity check of the walker)", () => {
    expect(rel).toContain("core/operations/documents.ts");
  });
});

describe("import graph walker", () => {
  it("finds the connectors behind the full operation index", () => {
    const { files } = importGraph(join(SRC, "core/operations/index.ts"));
    expect(files).toContain(join(SRC, "connectors/registry.ts"));
  });
});
