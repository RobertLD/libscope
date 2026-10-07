/**
 * The public Node.js API. Every method is a typed call to one operation from
 * src/core/operations, so the SDK has the same parameters, defaults and results as the CLI,
 * MCP server and REST API. Namespaces are generated from the NAMESPACES table below.
 */
import type Database from "better-sqlite3";
import type { z } from "zod";
import { ConfigSchema, type LibScopeConfig } from "./config.js";
import { bootstrap, type Bootstrapped, type ConfigOverrides } from "./core/bootstrap.js";
import type { Chunker } from "./core/indexing.js";
import {
  askQuestionStream,
  createLlmProvider,
  type LlmProvider,
  type RagStreamEvent,
} from "./core/rag.js";
import type { EmbeddingProvider } from "./providers/embedding.js";
import {
  backupOperation,
  bulkDeleteOperation,
  bulkMoveOperation,
  bulkRetagOperation,
  dedupeOperation,
  overviewOperation,
  pruneExpiredOperation,
  reindexOperation,
  restoreOperation,
} from "./core/operations/admin.js";
import {
  popularOperation,
  searchAnalyticsOperation,
  staleOperation,
  topQueriesOperation,
} from "./core/operations/analytics.js";
import {
  addOperation,
  deleteDocumentOperation,
  documentHistoryOperation,
  getDocumentOperation,
  listDocumentsOperation,
  rateDocumentOperation,
  rollbackDocumentOperation,
  updateDocumentOperation,
} from "./core/operations/documents.js";
import { graphOperation } from "./core/operations/graph.js";
import {
  linkDocumentsOperation,
  listLinksOperation,
  prerequisitesOperation,
  unlinkDocumentsOperation,
} from "./core/operations/links.js";
import {
  createPackOperation,
  installPackOperation,
  listPacksOperation,
  removePackOperation,
} from "./core/operations/packs.js";
import { askOperation, searchOperation, toRagOptions } from "./core/operations/search.js";
import {
  deleteSavedSearchOperation,
  listSavedSearchesOperation,
  runSavedSearchOperation,
  saveSearchOperation,
} from "./core/operations/searches.js";
import {
  addTagsOperation,
  listTagsOperation,
  removeTagsOperation,
  suggestTagsOperation,
} from "./core/operations/tags.js";
import {
  cancelTaskOperation,
  getTaskOperation,
  listTasksOperation,
} from "./core/operations/tasks.js";
import {
  createTopicOperation,
  deleteTopicOperation,
  listTopicsOperation,
} from "./core/operations/topics.js";
import {
  createOperationContext,
  parseOperationInput,
  runOperation,
  type Operation,
  type OperationContext,
  type ProgressEvent,
} from "./core/operations/types.js";
import {
  createWebhookOperation,
  deleteWebhookOperation,
  listWebhooksOperation,
  testWebhookOperation,
} from "./core/operations/webhooks.js";

type ConnectorOperations = typeof import("./core/operations/connectors.js");

export interface LibScopeOptions {
  /**
   * Workspace whose database to open. Default: the active workspace (LIBSCOPE_WORKSPACE,
   * `.libscope.json` `workspace`, or `libscope workspace use`), the same one the CLI and MCP
   * server use. Ignored when `dbPath`, `db` or `database.path` is set.
   */
  workspace?: string | undefined;
  /** Explicit SQLite database file (":memory:" for an in-memory database). */
  dbPath?: string | undefined;
  /** Use an already-open database. It is migrated, and `close()` leaves it open. */
  db?: Database.Database | undefined;
  /** Per-section config values merged over the loaded config, e.g. `{ llm: { model: "x" } }`. */
  config?: ConfigOverrides | undefined;
  /**
   * false: ignore config files, secrets.json and LIBSCOPE_* config variables; start from the
   * defaults plus `config`. Default true.
   */
  useConfigFile?: boolean | undefined;
  /** Embedding provider instance to use instead of the configured one. */
  provider?: EmbeddingProvider | undefined;
  /** LLM used by ask/askStream instead of the configured one. */
  llmProvider?: LlmProvider | undefined;
  /** Custom chunker used by `add` for inline content and local files. */
  chunker?: Chunker | undefined;
}

/** Per-call options for long-running methods. */
export interface RunOptions {
  signal?: AbortSignal | undefined;
  onProgress?: ((progress: ProgressEvent) => void) | undefined;
}

/** An operation whose module is loaded on first use (keeps connectors out of `libscope/lite`). */
interface LazyOperation<Op> {
  readonly name: string;
  load(): Promise<Op>;
}

function lazy<Op>(name: string, load: () => Promise<Op>): LazyOperation<Op> {
  return { name, load };
}

const loadConnectorOperations = (): Promise<ConnectorOperations> =>
  import("./core/operations/connectors.js");

/** Namespace -> method -> operation. Every operation appears here or as a top-level method. */
const NAMESPACES = {
  docs: {
    get: getDocumentOperation,
    list: listDocumentsOperation,
    update: updateDocumentOperation,
    delete: deleteDocumentOperation,
    rate: rateDocumentOperation,
    history: documentHistoryOperation,
    rollback: rollbackDocumentOperation,
  },
  topics: {
    list: listTopicsOperation,
    create: createTopicOperation,
    delete: deleteTopicOperation,
  },
  tags: {
    add: addTagsOperation,
    remove: removeTagsOperation,
    list: listTagsOperation,
    suggest: suggestTagsOperation,
  },
  links: {
    create: linkDocumentsOperation,
    delete: unlinkDocumentsOperation,
    list: listLinksOperation,
    prerequisites: prerequisitesOperation,
    graph: graphOperation,
  },
  searches: {
    save: saveSearchOperation,
    list: listSavedSearchesOperation,
    run: runSavedSearchOperation,
    delete: deleteSavedSearchOperation,
  },
  packs: {
    install: installPackOperation,
    remove: removePackOperation,
    list: listPacksOperation,
    create: createPackOperation,
  },
  connectors: {
    list: lazy(
      "list-connections",
      async () => (await loadConnectorOperations()).listConnectionsOperation,
    ),
    sync: lazy("sync", async () => (await loadConnectorOperations()).syncOperation),
    disconnect: lazy(
      "disconnect",
      async () => (await loadConnectorOperations()).disconnectOperation,
    ),
  },
  tasks: {
    get: getTaskOperation,
    cancel: cancelTaskOperation,
    list: listTasksOperation,
  },
  admin: {
    reindex: reindexOperation,
    dedupe: dedupeOperation,
    backup: backupOperation,
    restore: restoreOperation,
    pruneExpired: pruneExpiredOperation,
    bulkDelete: bulkDeleteOperation,
    bulkRetag: bulkRetagOperation,
    bulkMove: bulkMoveOperation,
  },
  analytics: {
    popular: popularOperation,
    stale: staleOperation,
    topQueries: topQueriesOperation,
    searches: searchAnalyticsOperation,
  },
  webhooks: {
    create: createWebhookOperation,
    list: listWebhooksOperation,
    delete: deleteWebhookOperation,
    test: testWebhookOperation,
  },
} as const;

/** Operations called by the top-level methods (add, search, ask, askStream, overview). */
const TOP_LEVEL = [addOperation, searchOperation, askOperation, overviewOperation] as const;

type AnyOperation = Operation<z.ZodObject, unknown>;
type OperationSource = AnyOperation | LazyOperation<AnyOperation>;
type Resolved<Src> = Src extends LazyOperation<infer Op> ? Op : Src;

/** Input accepted by an operation (before defaults are applied). */
export type OperationInput<Op> = Op extends Operation<infer S, unknown> ? z.input<S> : never;
/** Result of an operation. */
export type OperationOutput<Op> = Op extends Operation<z.ZodObject, infer O> ? Awaited<O> : never;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- "every field optional" test
type AllOptional<T> = {} extends T ? true : false;

type Method<Op> =
  AllOptional<OperationInput<Op>> extends true
    ? (input?: OperationInput<Op>, run?: RunOptions) => Promise<OperationOutput<Op>>
    : (input: OperationInput<Op>, run?: RunOptions) => Promise<OperationOutput<Op>>;

type Namespaces = typeof NAMESPACES;
export type NamespaceName = keyof Namespaces;
/** The methods of one namespace, e.g. `LibScopeNamespace<"docs">`. */
export type LibScopeNamespace<N extends NamespaceName> = NamespaceMethods<Namespaces[N]>;
type NamespaceMethods<T> = { readonly [M in keyof T]: Method<Resolved<T[M]>> };
/** Input of a namespace method, e.g. `LibScopeInput<"docs", "update">`. */
export type LibScopeInput<N extends NamespaceName, M extends keyof Namespaces[N]> = OperationInput<
  Resolved<Namespaces[N][M]>
>;
/** Result of a namespace method, e.g. `LibScopeOutput<"docs", "get">`. */
export type LibScopeOutput<
  N extends NamespaceName,
  M extends keyof Namespaces[N],
> = OperationOutput<Resolved<Namespaces[N][M]>>;

export type AddInput = OperationInput<typeof addOperation>;
export type AddResult = OperationOutput<typeof addOperation>;
export type SearchInput = OperationInput<typeof searchOperation>;
export type SearchOutput = OperationOutput<typeof searchOperation>;
export type AskInput = OperationInput<typeof askOperation>;
export type AskOutput = OperationOutput<typeof askOperation>;

/** Operation names reachable from the SDK (used by tests to keep the SDK complete). */
export function sdkOperationNames(): string[] {
  const nested = Object.values(NAMESPACES).flatMap((ns) =>
    Object.values(ns as Record<string, OperationSource>).map((src) => src.name),
  );
  return [...TOP_LEVEL.map((op) => op.name), ...nested];
}

/** Config built from the schema defaults only (no files, no environment). */
function defaultConfig(): LibScopeConfig {
  const sections = Object.fromEntries(Object.keys(ConfigSchema.shape).map((key) => [key, {}]));
  return ConfigSchema.parse(sections) as unknown as LibScopeConfig;
}

export class LibScope {
  readonly docs = this.bind(NAMESPACES.docs);
  readonly topics = this.bind(NAMESPACES.topics);
  readonly tags = this.bind(NAMESPACES.tags);
  readonly links = this.bind(NAMESPACES.links);
  readonly searches = this.bind(NAMESPACES.searches);
  readonly packs = this.bind(NAMESPACES.packs);
  readonly connectors = this.bind(NAMESPACES.connectors);
  readonly tasks = this.bind(NAMESPACES.tasks);
  readonly admin = this.bind(NAMESPACES.admin);
  readonly analytics = this.bind(NAMESPACES.analytics);
  readonly webhooks = this.bind(NAMESPACES.webhooks);

  private readonly ctx: OperationContext;

  private constructor(
    private readonly boot: Bootstrapped,
    private readonly llm: LlmProvider | undefined,
    chunker: Chunker | undefined,
  ) {
    this.ctx = createOperationContext({
      db: boot.db,
      provider: boot.provider,
      config: boot.config,
      surface: "sdk",
      llm,
      chunker,
    });
  }

  /** Open (and migrate) the database and create the providers. Call `close()` when done. */
  static create(options: LibScopeOptions = {}): LibScope {
    const boot = bootstrap({
      workspace: options.workspace,
      dbPath: options.dbPath,
      db: options.db,
      config: options.useConfigFile === false ? defaultConfig() : undefined,
      configOverrides: options.config,
      provider: options.provider,
    });
    return new LibScope(boot, options.llmProvider, options.chunker);
  }

  /** Add content, a file, a directory, a URL (optionally crawled) or a repository. */
  add(input: string | AddInput, run?: RunOptions): Promise<AddResult> {
    const raw = typeof input === "string" ? { source: input } : input;
    return runOperation(addOperation, this.context(run), raw);
  }

  /** Search by meaning and keywords, or find content related to a document or chunk. */
  search(input: string | SearchInput, run?: RunOptions): Promise<SearchOutput> {
    const raw = typeof input === "string" ? { query: input } : input;
    return runOperation(searchOperation, this.context(run), raw);
  }

  /** Answer a question with the LLM, or (llm.provider "passthrough") return the context. */
  ask(input: string | AskInput, run?: RunOptions): Promise<AskOutput> {
    const raw = typeof input === "string" ? { question: input } : input;
    return runOperation(askOperation, this.context(run), raw);
  }

  /** Like `ask`, but streams the answer tokens. Needs an LLM (no passthrough). */
  async *askStream(input: string | AskInput): AsyncGenerator<RagStreamEvent> {
    const raw = typeof input === "string" ? { question: input } : input;
    const parsed = parseOperationInput(askOperation, raw);
    const llm = this.llm ?? createLlmProvider(this.boot.config, { surface: "sdk" });
    yield* askQuestionStream(this.boot.db, this.boot.provider, llm, toRagOptions(this.ctx, parsed));
  }

  /** Counts, topics, installed packs, index identity and health. */
  overview(): Promise<OperationOutput<typeof overviewOperation>> {
    return runOperation(overviewOperation, this.ctx, {});
  }

  /** Close the database (unless it was passed in as `db`). Safe to call twice. */
  close(): void {
    this.boot.close();
  }

  private context(run: RunOptions | undefined): OperationContext {
    if (!run) return this.ctx;
    return { ...this.ctx, signal: run.signal, onProgress: run.onProgress };
  }

  private async call(src: OperationSource, input: unknown, run?: RunOptions): Promise<unknown> {
    const op = "load" in src ? await src.load() : src;
    return runOperation(op, this.context(run), input);
  }

  private bind<T extends object>(table: T): NamespaceMethods<T> {
    const methods: Record<string, (input?: unknown, run?: RunOptions) => Promise<unknown>> = {};
    for (const [key, src] of Object.entries(table)) {
      methods[key] = (input, run): Promise<unknown> =>
        this.call(src as OperationSource, input, run);
    }
    return Object.freeze(methods) as unknown as NamespaceMethods<T>;
  }
}
