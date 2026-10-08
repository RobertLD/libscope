#!/usr/bin/env node
/**
 * Fill the generated blocks of the reference docs from the built code (dist/).
 *
 *   npm run build && npm run docs:gen     rewrite the blocks
 *   npm run build && npm run docs:check   exit 1 when a block is out of date
 *
 * A block is the text between `<!-- generated:start NAME -->` and `<!-- generated:end NAME -->`.
 * Everything outside the blocks is hand-written and kept. Block names:
 *
 *   cli:global              docs/reference/cli.md   global options of the `libscope` program
 *   cli:<cmd>[,<cmd>...]    docs/reference/cli.md   these top-level commands and their subcommands
 *   mcp:core, mcp:admin     docs/reference/mcp-tools.md   MCP tools with their parameters
 *   config:keys             docs/reference/configuration.md   every config key
 *   rest:routes             docs/reference/rest-api.md   every REST route
 *
 * The generator needs no network and no embedding model: it constructs the CLI program without
 * running it, and builds the MCP server over an in-memory database with a stub provider.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format, resolveConfig } from "prettier";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fromDist = (path) => import(pathToFileURL(join(ROOT, "dist", path)).href);

const DOCS = {
  cli: "docs/reference/cli.md",
  mcp: "docs/reference/mcp-tools.md",
  config: "docs/reference/configuration.md",
  rest: "docs/reference/rest-api.md",
};

// ---------------------------------------------------------------------------------------------
// Markdown helpers

/** A `|` escaped for a table cell, and the same between two alternatives. */
const PIPE = String.raw`\|`;
const OR = ` ${PIPE} `;

/** Text for a table cell or a paragraph: no HTML or Vue interpolation, no broken tables. */
function text(value) {
  return String(value ?? "")
    .replaceAll(homedir(), "~")
    .replaceAll("\n", " ")
    .replaceAll("|", PIPE)
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("{{", "{ {");
}

/** Inline code; the content keeps `<` and `|` (escaped for tables). */
function code(value) {
  return `\`${String(value).replaceAll(homedir(), "~").replaceAll("|", PIPE)}\``;
}

/** Text that ends with a period when `withPeriod` (when more text follows in the cell). */
function sentence(value, withPeriod = true) {
  const t = text(value).trim();
  if (t === "") return "";
  return withPeriod && !/[.!?]$/.test(t) ? `${t}.` : t;
}

function table(headers, rows) {
  const line = (cells) => `| ${cells.join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

// ---------------------------------------------------------------------------------------------
// CLI (commander program from dist/cli/index.js; importing it does not run it)

function commandUsage(cmd, parents) {
  const args = cmd.registeredArguments.map((a) => {
    const name = `${a.name()}${a.variadic ? "..." : ""}`;
    return a.required ? `<${name}>` : `[${name}]`;
  });
  return [...parents, cmd.name(), ...args].join(" ");
}

function optionDescription(opt) {
  const extras = [];
  if (opt.mandatory) extras.push("Required.");
  if (opt.argChoices) extras.push(`One of: ${opt.argChoices.map(code).join(", ")}.`);
  if (opt.defaultValue !== undefined && !opt.negate && !/\bdefault\b/i.test(opt.description)) {
    extras.push(
      `Default: ${code(opt.defaultValueDescription ?? JSON.stringify(opt.defaultValue))}.`,
    );
  }
  return [sentence(opt.description, extras.length > 0), ...extras].filter(Boolean).join(" ");
}

function optionsTable(cmd) {
  const options = cmd.options.filter((o) => !o.hidden);
  if (options.length === 0) return "";
  return table(
    ["Option", "Description"],
    options.map((o) => [code(o.flags), optionDescription(o)]),
  );
}

function renderLeafCommand(cmd, parents, heading) {
  const parts = [];
  const usage = `${code(commandUsage(cmd, parents))}`;
  if (heading) parts.push(`${heading} ${usage}`, sentence(cmd.description()));
  else parts.push(`Usage: ${usage}`, sentence(cmd.description()));
  const options = optionsTable(cmd);
  if (options) parts.push(options);
  return parts.join("\n\n");
}

/**
 * A top-level command. A command group renders each subcommand under an h3. A single command
 * renders under an h3 when the block covers several commands, else without a heading (the
 * hand-written h2 above the block names it).
 */
function renderCommand(cmd, alone) {
  const visible = cmd.commands.filter((c) => !c._hidden);
  if (visible.length === 0) return renderLeafCommand(cmd, ["libscope"], alone ? "" : "###");
  const parents = ["libscope", cmd.name()];
  return visible.map((sub) => renderLeafCommand(sub, parents, "###")).join("\n\n");
}

async function cliBlocks() {
  const { program } = await fromDist("cli/index.js");
  const byName = new Map(program.commands.map((c) => [c.name(), c]));
  const global = [
    "Usage: `libscope [options] <command>`",
    optionsTable(program),
    "`-h, --help` shows the help of the program or of any command.",
  ].join("\n\n");
  return {
    commands: program.commands.filter((c) => !c._hidden).map((c) => c.name()),
    render(name) {
      if (name === "cli:global") return global;
      const names = name.slice("cli:".length).split(",");
      return names
        .map((n) => {
          const cmd = byName.get(n);
          if (!cmd) throw new Error(`${name}: the CLI has no command "${n}"`);
          return renderCommand(cmd, names.length === 1);
        })
        .join("\n\n");
    },
  };
}

// ---------------------------------------------------------------------------------------------
// MCP tools (createMcpServer over an in-memory database; tools/list over an in-memory transport)

function schemaType(s) {
  if (!s || typeof s !== "object") return "any";
  if (s.enum) return s.enum.map((v) => code(v)).join(OR);
  if (s.anyOf) return s.anyOf.map(schemaType).join(OR);
  if (s.type === "array") return `${schemaType(s.items)}[]`;
  if (s.type === "string" && s.format) return `string (${s.format})`;
  return s.type ?? "any";
}

function annotationText(annotations = {}) {
  if (annotations.readOnlyHint) return "read-only";
  return [
    annotations.destructiveHint ? "destructive" : "not destructive",
    annotations.idempotentHint ? "idempotent" : null,
  ]
    .filter(Boolean)
    .join(", ");
}

function renderTool(tool) {
  const parts = [`### ${tool.name}`, text(tool.description)];
  parts.push(`Annotations: ${annotationText(tool.annotations)}.`);
  const props = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const rows = Object.entries(props).map(([key, s]) => {
    // Many descriptions already state the default in words.
    const statesDefault = /\bdefault\b/i.test(s.description ?? "");
    const def =
      s.default !== undefined && !statesDefault
        ? ` Default: ${code(JSON.stringify(s.default))}.`
        : "";
    const description = [sentence(s.description, def !== ""), def.trim()].filter(Boolean).join(" ");
    return [code(key), schemaType(s), required.has(key) ? "yes" : "", description];
  });
  parts.push(
    rows.length ? table(["Parameter", "Type", "Required", "Description"], rows) : "No parameters.",
  );
  return parts.join("\n\n");
}

async function listTools(ctx, createMcpServer, toolsets) {
  const mcp = createMcpServer({ ctx, toolsets });
  const client = new Client({ name: "gen-docs", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.server.connect(serverSide), client.connect(clientSide)]);
  const { tools } = await client.listTools();
  await client.close();
  await mcp.close();
  return tools;
}

async function mcpBlocks() {
  const { createMcpServer } = await fromDist("mcp/server.js");
  const { createOperationContext } = await fromDist("core/operations/index.js");
  const { runMigrations } = await fromDist("db/schema.js");
  const { ConfigSchema } = await fromDist("config-schema.js");
  const { initLogger } = await fromDist("logger.js");
  initLogger("silent");

  const db = new Database(":memory:");
  runMigrations(db);
  const config = ConfigSchema.parse(
    Object.fromEntries(Object.keys(ConfigSchema.shape).map((section) => [section, {}])),
  );
  const provider = {
    name: "docs",
    dimensions: 4,
    embed: async () => [0, 0, 0, 1],
    embedBatch: async (texts) => texts.map(() => [0, 0, 0, 1]),
  };
  // A stub LLM registers `ask` with its general description (the server registers it only
  // when an LLM or passthrough is available).
  const llm = { model: "docs", complete: async () => ({ text: "" }) };
  const ctx = createOperationContext({ db, provider, config, surface: "mcp", llm });

  const core = await listTools(ctx, createMcpServer, []);
  const all = await listTools(ctx, createMcpServer, ["admin"]);
  db.close();
  const coreNames = new Set(core.map((t) => t.name));
  const admin = all.filter((t) => !coreNames.has(t.name));
  return {
    render(name) {
      if (name === "mcp:core") return core.map(renderTool).join("\n\n");
      if (name === "mcp:admin") return admin.map(renderTool).join("\n\n");
      throw new Error(`unknown block ${name}`);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Config keys (getConfigKeyTable from dist/config-schema.js)

/** "a | b" -> `a` \| `b`; "list of a | b" -> list of `a` \| `b`; "string" stays. */
function configType(type) {
  const list = type.startsWith("list of ");
  const values = list ? type.slice("list of ".length) : type;
  if (!list && !values.includes(" | ")) return values;
  const choices = values.split(" | ").map(code).join(OR);
  return list ? `list of ${choices}` : choices;
}

/** A single value in code; in a sentence, only the URLs (a bare URL would become a link). */
function defaultCell(value) {
  if (value === "") return "—";
  if (!/\s/.test(value)) return code(value);
  return text(value).replaceAll(/https?:\/\/[^\s,;]+/g, (url) => `\`${url}\``);
}

async function configBlocks() {
  const { getConfigKeyTable } = await fromDist("config-schema.js");
  const rows = getConfigKeyTable().map((row) => [
    code(row.key),
    configType(row.type),
    defaultCell(row.default),
    row.env.map(code).join(", "),
    row.secret ? "yes" : "",
    sentence(row.description, false),
  ]);
  const keys = table(
    ["Key", "Type", "Default", "Environment variables", "Secret", "Description"],
    rows,
  );
  return {
    render(name) {
      if (name === "config:keys") return keys;
      throw new Error(`unknown block ${name}`);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// REST routes (API_ROUTES from dist/api/routes.js)

const ROUTE_GROUPS = [
  ["meta", "Meta"],
  ["documents", "Documents"],
  ["search", "Search and Q&A"],
  ["links", "Links and graph"],
  ["tags", "Tags"],
  ["topics", "Topics"],
  ["searches", "Saved searches"],
  ["packs", "Packs and registries"],
  ["connectors", "Connectors"],
  ["admin", "Admin and bulk"],
  ["analytics", "Analytics"],
  ["webhooks", "Webhooks"],
  ["tasks", "Tasks"],
];

async function restBlocks() {
  const { API_ROUTES } = await fromDist("api/routes.js");
  const groups = new Map(ROUTE_GROUPS.map(([key]) => [key, []]));
  for (const route of API_ROUTES) {
    const group = route.operation?.group ?? "meta";
    if (!groups.has(group))
      throw new Error(`REST route group "${group}" has no heading in gen-docs`);
    groups.get(group).push(route);
  }
  const sections = ROUTE_GROUPS.filter(([key]) => groups.get(key).length > 0).map(
    ([key, title]) => {
      const rows = groups
        .get(key)
        .map((r) => [
          code(r.method),
          code(r.path),
          r.operation ? code(r.operation.name) : "—",
          r.operation?.annotations?.longRunning ? "`202` (task)" : "`200`",
          sentence(r.summary, false),
        ]);
      return `### ${title}\n\n${table(["Method", "Path", "Operation", "Status", "Description"], rows)}`;
    },
  );
  const routes = sections.join("\n\n");
  return {
    render(name) {
      if (name === "rest:routes") return routes;
      throw new Error(`unknown block ${name}`);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Blocks in files

const BLOCK = /<!-- generated:start ([\w:,-]+) -->\n([\s\S]*?)<!-- generated:end \1 -->/g;

async function formatBlock(content, file) {
  const options = (await resolveConfig(file)) ?? {};
  return format(content, { ...options, parser: "markdown", filepath: file });
}

const REQUIRED_BLOCKS = {
  cli: ["cli:global"],
  mcp: ["mcp:core", "mcp:admin"],
  config: ["config:keys"],
  rest: ["rest:routes"],
};

/** The generated text of a block, with blank lines around it as prettier writes them. */
async function blockBody(generator, name, file) {
  return `\n${await formatBlock(generator.render(name), file)}\n`;
}

/** Each top-level command needs a `cli:<cmd>` block. */
function uncoveredCommands(relPath, seen, commands) {
  const covered = new Set(
    [...seen].filter((n) => n !== "cli:global").flatMap((n) => n.slice(4).split(",")),
  );
  return commands
    .filter((command) => !covered.has(command))
    .map((command) => `${relPath}: no block documents "libscope ${command}"`);
}

/** Regenerate the blocks of one doc file: its original and updated text, and its problems. */
async function updateFile(kind, relPath, generator, check) {
  const file = join(ROOT, relPath);
  const original = readFileSync(file, "utf8");
  const matches = [...original.matchAll(BLOCK)];
  const bodies = await Promise.all(
    matches.map(([, name]) =>
      name.split(":")[0] === kind ? blockBody(generator, name, file) : null,
    ),
  );
  const problems = [];
  const seen = new Set();
  let updated = original;
  matches.forEach(([whole, name, current], i) => {
    const body = bodies[i];
    if (body === null) {
      problems.push(`${relPath}: block "${name}" does not belong in this file`);
      return;
    }
    seen.add(name);
    if (current === body) return;
    if (check) problems.push(`${relPath}: block "${name}" is out of date`);
    const block = `<!-- generated:start ${name} -->\n${body}<!-- generated:end ${name} -->`;
    updated = updated.replace(whole, () => block);
  });
  for (const name of REQUIRED_BLOCKS[kind]) {
    if (!seen.has(name)) problems.push(`${relPath}: missing block "${name}"`);
  }
  if (kind === "cli") problems.push(...uncoveredCommands(relPath, seen, generator.commands));
  return { file, original, updated, problems };
}

async function main() {
  const check = process.argv.includes("--check");
  const generators = {
    cli: await cliBlocks(),
    mcp: await mcpBlocks(),
    config: await configBlocks(),
    rest: await restBlocks(),
  };
  const results = await Promise.all(
    Object.entries(DOCS).map(([kind, relPath]) =>
      updateFile(kind, relPath, generators[kind], check),
    ),
  );
  if (!check) {
    for (const { file, original, updated } of results) {
      if (updated === original) continue;
      writeFileSync(file, updated);
      console.log(`updated ${relative(ROOT, file)}`);
    }
  }

  const problems = results.flatMap((r) => r.problems);
  if (problems.length > 0) {
    for (const p of problems) console.error(`✗ ${p}`);
    if (check) console.error("Run `npm run build && npm run docs:gen` and commit the result.");
    process.exitCode = 1;
  } else if (check) {
    console.log("Generated docs are up to date.");
  }
}

await main();
