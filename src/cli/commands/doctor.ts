/**
 * `libscope doctor [--fix]`: config files, workspace and database, embedding model and index,
 * LLM resolution, and health checks. With --fix it creates the database and vector index.
 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import {
  getSecretsPath,
  getUserConfigPath,
  loadConfig,
  resolveLlmProviderName,
  type LibScopeConfig,
} from "../../config.js";
import { overviewOperation } from "../../core/operations/index.js";
import type { Overview } from "../../core/overview.js";
import { getActiveWorkspace } from "../../core/workspace.js";
import { resolveDatabasePath } from "../../db/connection.js";
import {
  describeEmbeddingIdentity,
  toEmbeddingIdentity,
  type EmbeddingIndexIdentity,
} from "../../db/index-meta.js";
import { createEmbeddingProvider } from "../../providers/index.js";
import { getGlobalOptions } from "../context.js";
import { call, print } from "../run.js";
import { printOverview } from "./admin.js";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "error";
  detail: string;
  /** What to run to fix a warning or error. */
  fix?: string | undefined;
}

export interface DoctorReport {
  configFile: { path: string; exists: boolean };
  secretsFile: { path: string; exists: boolean };
  workspace: string;
  database: { path: string; exists: boolean };
  embedding: EmbeddingIndexIdentity;
  llm: string;
  overview?: Overview | undefined;
  checks: DoctorCheck[];
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** True when a field is known on both sides and differs. */
function conflicts(a: EmbeddingIndexIdentity, b: EmbeddingIndexIdentity): boolean {
  return (["provider", "model", "dimensions"] as const).some(
    (k) => a[k] !== undefined && b[k] !== undefined && a[k] !== b[k],
  );
}

function embeddingCheck(config: LibScopeConfig): {
  identity: EmbeddingIndexIdentity;
  check: DoctorCheck;
} {
  try {
    const identity = toEmbeddingIdentity(createEmbeddingProvider(config));
    return {
      identity,
      check: { name: "embedding", status: "ok", detail: describeEmbeddingIdentity(identity) },
    };
  } catch (err) {
    return {
      identity: { provider: config.embedding.provider },
      check: {
        name: "embedding",
        status: "error",
        detail: message(err),
        fix: "libscope config show",
      },
    };
  }
}

function llmCheck(config: LibScopeConfig): { llm: string; check: DoctorCheck } {
  const name = resolveLlmProviderName(config, { surface: "cli" });
  if (name === null) {
    return {
      llm: "none",
      check: {
        name: "llm",
        status: "warn",
        detail: "No LLM configured: `ask` will not work (search does)",
        fix: "libscope config set openai.apiKey <key>   (or anthropic.apiKey, or llm.provider ollama)",
      },
    };
  }
  const model = name === "passthrough" ? "" : ` (${config.llm?.model ?? "default model"})`;
  return { llm: name, check: { name: "llm", status: "ok", detail: `${name}${model}` } };
}

function indexChecks(overview: Overview, configured: EmbeddingIndexIdentity): DoctorCheck[] {
  const checks: DoctorCheck[] = [
    { name: "database", status: overview.health.database, detail: "opens and is migrated" },
    { name: "keyword index", status: overview.health.fts, detail: "full-text index readable" },
  ];
  const stored: EmbeddingIndexIdentity = {
    ...overview.index.stored,
    dimensions: overview.index.vectorTableDimensions ?? overview.index.stored.dimensions,
  };
  if (overview.index.vectorTableDimensions === undefined) {
    checks.push({
      name: "vector index",
      status: "warn",
      detail: "not created yet (it is created when content is first added)",
      fix: "libscope doctor --fix",
    });
  } else if (conflicts(stored, configured)) {
    checks.push({
      name: "vector index",
      status: "error",
      detail: `built with ${describeEmbeddingIdentity(stored)}, but ${describeEmbeddingIdentity(configured)} is configured`,
      fix: "libscope admin reindex --rebuild",
    });
  } else {
    checks.push({ name: "vector index", status: "ok", detail: describeEmbeddingIdentity(stored) });
  }
  return checks;
}

export async function runDoctor(fix: boolean): Promise<DoctorReport> {
  const config = loadConfig();
  const workspace = getGlobalOptions().workspace ?? getActiveWorkspace();
  const dbPath = resolveDatabasePath({ explicitPath: config.database.path, workspace });
  const embedding = embeddingCheck(config);
  const llm = llmCheck(config);
  const checks: DoctorCheck[] = [embedding.check, llm.check];
  let overview: Overview | undefined;

  if (existsSync(dbPath) || fix) {
    try {
      overview = await call(overviewOperation, {}, { vectorTable: fix ? "best-effort" : "skip" });
      checks.push(...indexChecks(overview, embedding.identity));
    } catch (err) {
      checks.push({
        name: "database",
        status: "error",
        detail: message(err),
        fix: "libscope admin reindex --rebuild",
      });
    }
  } else {
    checks.push({
      name: "database",
      status: "warn",
      detail: "does not exist yet (it is created when content is first added)",
      fix: "libscope doctor --fix",
    });
  }

  return {
    configFile: { path: getUserConfigPath(), exists: existsSync(getUserConfigPath()) },
    secretsFile: { path: getSecretsPath(), exists: existsSync(getSecretsPath()) },
    workspace,
    database: { path: dbPath, exists: existsSync(dbPath) },
    embedding: embedding.identity,
    llm: llm.llm,
    overview,
    checks,
  };
}

const MARK = { ok: "✓", warn: "⚠", error: "✗" } as const;

function printReport(r: DoctorReport): void {
  const exists = (e: boolean): string => (e ? "" : " (not created)");
  console.log(`Config:    ${r.configFile.path}${exists(r.configFile.exists)}`);
  console.log(`Secrets:   ${r.secretsFile.path}${exists(r.secretsFile.exists)}`);
  console.log(`Workspace: ${r.workspace}`);
  console.log(`Database:  ${r.database.path}${exists(r.database.exists)}`);
  if (r.overview) printOverview(r.overview);
  console.log("");
  for (const c of r.checks) {
    console.log(`${MARK[c.status]} ${c.name}: ${c.detail}`);
    if (c.fix && c.status !== "ok") console.log(`    fix: ${c.fix}`);
  }
}

export function register(program: Command): void {
  program
    .command("doctor")
    .description("Check the setup: config, workspace, database, embedding model, index and LLM")
    .option("--fix", "Create what is missing (database and vector index)")
    .action(async (flags: { fix?: boolean }) => {
      const report = await runDoctor(flags.fix === true);
      print(report, printReport);
      if (report.checks.some((c) => c.status === "error")) process.exitCode = 1;
    });
}
