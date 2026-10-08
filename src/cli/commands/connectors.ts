/** `libscope connect <type>`, `sync`, `disconnect`, `connections`. */
import type { Command } from "commander";
import { resolve } from "node:path";
import {
  disconnectOperation,
  listConnectionsOperation,
  syncOperation,
} from "../../core/operations/index.js";
import { hasNamedConnectorConfig } from "../../connectors/index.js";
import { getConnector, saveConnection } from "../../connectors/registry.js";
import {
  CONNECTOR_TYPES,
  findSavedOneNoteConfig,
  type ConnectorType,
} from "../../connectors/saved-config.js";
import { authenticateDeviceCode } from "../../connectors/onenote.js";
import { ValidationError } from "../../errors.js";
import { confirmOrCancel } from "../confirm.js";
import { defined, splitList } from "../options.js";
import { plural, printList, run } from "../run.js";

export interface ConnectFlags {
  name?: string;
  schedule?: string;
  sync: boolean;
  token?: string;
  exclude?: string;
  channels?: string;
  threadMode?: string;
  email?: string;
  server?: boolean;
  spaces?: string;
  topicMapping?: string;
  notebook?: string;
  clientId?: string;
  tenantId?: string;
  siteType?: string;
  library?: string;
  libVersion?: string;
  maxPages?: number;
  maxDepth?: number;
  pathPrefix?: string;
}

const list = (value: string | undefined): string[] | undefined =>
  value === undefined ? undefined : splitList(value);

function requireSource(type: string, source: string | undefined, what: string): string {
  if (!source) throw new ValidationError(`connect ${type} needs the ${what}`);
  return source;
}

/** Settings given on the command line for each connector type; undefined where not given. */
const FLAG_SETTINGS: Record<
  ConnectorType,
  (source: string | undefined, flags: ConnectFlags) => Record<string, unknown>
> = {
  notion: (_source, flags) => ({ token: flags.token, excludePages: list(flags.exclude) }),
  slack: (_source, flags) => ({
    token: flags.token,
    channels: list(flags.channels),
    excludeChannels: list(flags.exclude),
    threadMode: flags.threadMode,
  }),
  confluence: (source, flags) => ({
    baseUrl: source,
    type: flags.server ? "server" : undefined,
    email: flags.email,
    token: flags.token,
    spaces: list(flags.spaces),
    excludeSpaces: list(flags.exclude),
  }),
  obsidian: (source, flags) => ({
    vaultPath: source && resolve(source),
    topicMapping: flags.topicMapping,
    excludePatterns: list(flags.exclude),
  }),
  onenote: (_source, flags) => ({
    clientId: flags.clientId,
    tenantId: flags.tenantId,
    notebooks: flags.notebook === undefined ? undefined : [flags.notebook],
    excludeSections: undefined,
    // A token given by hand cannot be refreshed.
    ...(flags.token === undefined
      ? {}
      : { accessToken: flags.token, refreshToken: undefined, tokenExpiry: undefined }),
  }),
  docs: (source, flags) => ({
    url: source,
    type: flags.siteType,
    library: flags.library,
    version: flags.libVersion,
    maxPages: flags.maxPages,
    maxDepth: flags.maxDepth,
    pathPrefix: flags.pathPrefix,
  }),
};

/** What the source argument is, for connector types that need it for a new connection. */
const REQUIRED_SOURCE: Partial<Record<ConnectorType, string>> = {
  confluence: "base URL",
  obsidian: "vault path",
  docs: "site URL",
};

/** Values a new connection gets for the settings that no flag sets (fresh objects each call). */
const NEW_CONNECTION_DEFAULTS: Partial<Record<ConnectorType, () => Record<string, unknown>>> = {
  slack: () => ({ channels: ["all"], threadMode: "aggregate" }),
  confluence: () => ({ type: "cloud", spaces: ["all"] }),
  obsidian: () => ({ topicMapping: "folder", excludePatterns: [] }),
  onenote: () => ({ clientId: "", tenantId: "common", notebooks: ["all"], excludeSections: [] }),
};

/** `settings` of a new connection: checks the source and fills in the defaults. */
function newConnectionSettings(
  type: ConnectorType,
  source: string | undefined,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const what = REQUIRED_SOURCE[type];
  if (what) requireSource(type, source, what);
  const merged = { ...settings };
  for (const [key, value] of Object.entries(NEW_CONNECTION_DEFAULTS[type]?.() ?? {})) {
    merged[key] ??= value;
  }
  return merged;
}

/**
 * Settings for connector `type` from the command line. Unset values are undefined, so the
 * saved settings of the connection (if any) are kept; `defaults` apply to a new connection.
 */
export function connectSettings(
  type: ConnectorType,
  source: string | undefined,
  flags: ConnectFlags,
  isNew: boolean,
): Record<string, unknown> {
  const settings = FLAG_SETTINGS[type](source, flags);
  return isNew ? newConnectionSettings(type, source, settings) : settings;
}

/** OneNote without a usable token: sign in with a device code (interactive). */
async function oneNoteSignIn(
  name: string,
  settings: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const saved = findSavedOneNoteConfig(name);
  if (settings["accessToken"] !== undefined || saved?.refreshToken) return settings;
  const clientId = (settings["clientId"] as string | undefined) ?? saved?.clientId;
  if (!clientId) {
    throw new ValidationError("OneNote sign-in needs --client-id (an Azure app client ID)");
  }
  const tenantId = (settings["tenantId"] as string | undefined) ?? saved?.tenantId ?? "common";
  const auth = await authenticateDeviceCode(clientId, tenantId);
  return {
    ...settings,
    clientId,
    tenantId,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    tokenExpiry: auth.expiresAt,
  };
}

type SyncResult = Awaited<ReturnType<typeof syncOperation.handler>>;

function printSync(result: SyncResult): void {
  printList(result.items, "No saved connections. Add one with: libscope connect <type>", (item) => {
    if (item.status === "failed") {
      console.log(`✗ ${item.name}: ${item.error}`);
      return;
    }
    const s = item.summary;
    console.log(
      `✓ ${item.name}: ${s.added} added, ${s.updated} updated, ${s.deleted} deleted, ${plural(s.errors.length, "error")}`,
    );
    for (const e of s.errors) console.log(`    ${e}`);
  });
}

function registerConnect(program: Command): void {
  program
    .command("connect <type> [source]")
    .summary("Save a connection to an external service and sync it")
    .description(
      `Save a connection and sync it. Types: ${CONNECTOR_TYPES.join(", ")}. ` +
        "[source] is the vault path (obsidian) or the URL (confluence, docs). " +
        "Running it again for a saved connection changes only the given settings.",
    )
    .option("--name <name>", "Connection name (default: the type)")
    .option(
      "--schedule <cron>",
      'Sync on this cron schedule while `libscope serve api` runs ("off" removes it)',
    )
    .option("--no-sync", "Save the connection without syncing now")
    .option("--token <token>", "notion, slack, confluence: API token; onenote: access token")
    .option(
      "--exclude <list>",
      "Comma-separated: slack channels, notion page IDs, confluence spaces, obsidian globs",
    )
    .option("--channels <list>", "slack: channel names or IDs (default all)")
    .option("--thread-mode <mode>", "slack: aggregate (one document per thread) or separate")
    .option("--email <email>", "confluence: user email (Cloud)")
    .option("--server", "confluence: Server/Data Center instead of Cloud")
    .option("--spaces <keys>", "confluence: space keys (default all)")
    .option("--topic-mapping <mode>", "obsidian: topics from folder (default) or frontmatter")
    .option("--notebook <name>", "onenote: one notebook (default all)")
    .option("--client-id <id>", "onenote: Azure app client ID for device sign-in")
    .option("--tenant-id <id>", "onenote: Azure tenant ID (default common)")
    .option("--site-type <type>", "docs: auto, sphinx, vitepress, doxygen or generic")
    .option("--library <name>", "docs: library name for the pages")
    .option("--lib-version <version>", "docs: library version for the pages")
    .option("--max-pages <n>", "docs: page limit (default 500)", Number)
    .option("--max-depth <n>", "docs: link depth (default 10)", Number)
    .option("--path-prefix <path>", "docs: only pages under this path")
    .action(async (type: string, source: string | undefined, flags: ConnectFlags) => {
      const connector = getConnector(type);
      const name = flags.name ?? connector.type;
      const isNew = !hasNamedConnectorConfig(name);
      let settings = connectSettings(connector.type, source, flags, isNew);
      if (connector.type === "onenote") settings = await oneNoteSignIn(name, settings);
      const schedule = flags.schedule === "off" ? null : flags.schedule;
      saveConnection(name, connector.type, defined(settings), { schedule });
      console.error(`✓ Saved ${connector.label} connection "${name}"`);
      if (!flags.sync) return;
      await run(syncOperation, { name }, printSync, { embeddings: true });
    });
}

export function register(program: Command): void {
  registerConnect(program);

  program
    .command("sync [name]")
    .description("Sync a saved connection with its saved settings, or all with --all")
    .option("--all", "Sync every saved connection")
    .action(async (name: string | undefined, flags: { all?: boolean }) => {
      await run(syncOperation, defined({ name, all: flags.all }), printSync, { embeddings: true });
    });

  program
    .command("disconnect <name>")
    .description("Delete a connection's documents and its saved settings (including credentials)")
    .option("--type <type>", "Connector type, when no saved connection has this name")
    .option("--keep-documents", "Only delete the saved settings")
    .option("-y, --yes", "Do not ask for confirmation")
    .action(
      async (name: string, flags: { type?: string; keepDocuments?: boolean; yes?: boolean }) => {
        const what = flags.keepDocuments ? "its saved settings" : "its documents and settings";
        if (!(await confirmOrCancel(`Disconnect "${name}" and delete ${what}?`, flags.yes))) {
          return;
        }
        const input = defined({ name, type: flags.type, keepDocuments: flags.keepDocuments });
        await run(disconnectOperation, input, (r) =>
          console.log(
            `✓ Disconnected ${r.type} "${r.name}": ${plural(r.documentsRemoved, "document")} removed`,
          ),
        );
      },
    );

  program
    .command("connections")
    .description("List saved connections with their schedule and last sync")
    .action(async () => {
      await run(listConnectionsOperation, {}, (r) =>
        printList(r.items, "No saved connections. Add one with: libscope connect <type>", (c) => {
          console.log(`${c.name} (${c.type})`);
          if (c.schedule) console.log(`    schedule: ${c.schedule}`);
          if (c.lastSync) console.log(`    last sync: ${c.lastSync}`);
          if (c.lastRun) {
            const error = c.lastRun.error ? ` — ${c.lastRun.error}` : "";
            console.log(`    last run: ${c.lastRun.status} at ${c.lastRun.startedAt}${error}`);
          }
        }),
      );
    });
}
