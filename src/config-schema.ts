/**
 * The configuration schema: the single source for config keys, defaults, validation,
 * environment variable names, secret flags, and descriptions.
 *
 * Every leaf key `section.field` can be set from the environment variable
 * `LIBSCOPE_<SECTION>_<FIELD>` (SCREAMING_SNAKE case), followed by any extra names in its
 * metadata. Secret keys are read only from env vars and ~/.libscope/secrets.json.
 */
import { z } from "zod";

/** Metadata attached to each leaf of ConfigSchema. */
export interface ConfigKeyMeta {
  /** Extra env var names, checked in order after the canonical LIBSCOPE_<SECTION>_<FIELD>. */
  env?: readonly string[];
  /** Secret values are masked on display and stored in secrets.json, never in config.json. */
  secret?: boolean;
  /** Default text for the docs table when the default depends on other keys. */
  defaultText?: string;
}

/** Registry that holds the metadata of every leaf schema. */
export const configKeyMeta = z.registry<ConfigKeyMeta>();

function leaf<T extends z.ZodType>(schema: T, meta: ConfigKeyMeta = {}): T {
  configKeyMeta.add(schema, meta);
  return schema;
}

export const EMBEDDING_PROVIDERS = ["local", "ollama", "openai"] as const;
export const LLM_PROVIDERS = ["auto", "openai", "anthropic", "ollama", "passthrough"] as const;
export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
/** Values of `mcp.toolsets`. "core" is always on; "all" enables every optional toolset. */
export const MCP_TOOLSET_SETTINGS = ["core", "admin", "all"] as const;

/** Ollama server URL used when embedding.url and llm.url are not set. */
export const DEFAULT_OLLAMA_URL = "http://localhost:11434";

/** Largest accepted `embedding.dimensions` value. */
const MAX_DIMENSIONS = 10000;

const nonEmpty = (): z.ZodString => z.string().trim().min(1);

export const ConfigSchema = z.object({
  embedding: z.object({
    provider: leaf(z.enum(EMBEDDING_PROVIDERS).default("local").describe("Embedding provider.")),
    model: leaf(
      nonEmpty()
        .optional()
        .describe(
          "Embedding model. Ignored by the local provider (always Xenova/all-MiniLM-L6-v2).",
        ),
      { defaultText: "ollama: nomic-embed-text; openai: text-embedding-3-small" },
    ),
    url: leaf(
      nonEmpty()
        .optional()
        .describe("Server URL of the embedding provider. Used by the ollama provider."),
      { defaultText: DEFAULT_OLLAMA_URL },
    ),
    dimensions: leaf(
      z
        .number()
        .int()
        .positive()
        .max(MAX_DIMENSIONS)
        .optional()
        .describe("Vector size, for models whose size is not built in."),
      { defaultText: "size of the model" },
    ),
  }),
  llm: z.object({
    provider: leaf(
      z
        .enum(LLM_PROVIDERS)
        .default("auto")
        .describe(
          'LLM for "ask". "auto": passthrough under MCP, else openai if an OpenAI key is set, ' +
            "else anthropic if an Anthropic key is set, else ollama if llm.url is set or " +
            "embedding.provider is ollama, else none.",
        ),
    ),
    model: leaf(nonEmpty().optional().describe("LLM model."), {
      defaultText: "openai: gpt-4o-mini; anthropic: claude-3-5-haiku-20241022; ollama: llama3.2",
    }),
    url: leaf(
      nonEmpty().optional().describe("Server URL of the LLM. Used by the ollama provider."),
      { defaultText: `embedding.url, then ${DEFAULT_OLLAMA_URL}` },
    ),
  }),
  openai: z.object({
    apiKey: leaf(nonEmpty().optional().describe("OpenAI API key (embeddings and LLM)."), {
      secret: true,
      env: ["OPENAI_API_KEY"],
    }),
  }),
  anthropic: z.object({
    apiKey: leaf(nonEmpty().optional().describe("Anthropic API key (LLM)."), {
      secret: true,
      env: ["ANTHROPIC_API_KEY"],
    }),
  }),
  database: z.object({
    path: leaf(
      nonEmpty()
        .optional()
        .describe("SQLite database file. A leading ~ is expanded. Unset: the workspace database."),
      { defaultText: "~/.libscope/workspaces/<workspace>/libscope.db" },
    ),
  }),
  indexing: z.object({
    maxDocumentSize: leaf(
      z
        .number()
        .int()
        .positive()
        .default(100 * 1024 * 1024)
        .describe("Largest document to index, in bytes."),
    ),
    allowPrivateUrls: leaf(
      z.boolean().default(false).describe("Allow fetching URLs on private or local networks."),
    ),
    allowSelfSignedCerts: leaf(
      z.boolean().default(false).describe("Accept self-signed TLS certificates when fetching."),
    ),
  }),
  logging: z.object({
    level: leaf(z.enum(LOG_LEVELS).default("info").describe("Log level.")),
  }),
  mcp: z.object({
    toolsets: leaf(
      z
        .array(z.enum(MCP_TOOLSET_SETTINGS))
        .default([])
        .describe(
          "Optional MCP toolsets (comma list). admin adds sync, install-pack, list-packs and " +
            "reindex-documents; all enables every optional toolset. The core tools are always on.",
        ),
    ),
  }),
});

type SchemaOutput = z.output<typeof ConfigSchema>;
type SectionName = keyof SchemaOutput;

/** Every settable key, as `section.field`, derived from ConfigSchema. */
export type ConfigKey = {
  [S in SectionName]: `${S}.${keyof SchemaOutput[S] & string}`;
}[SectionName];

/** One leaf of the schema, with everything needed to read, write, and document it. */
export interface ConfigKeySpec {
  key: ConfigKey;
  section: SectionName;
  field: string;
  schema: z.ZodType;
  /** Env var names in priority order (canonical name first). */
  env: readonly string[];
  secret: boolean;
  description: string;
  /** Default value, or undefined when the key has no fixed default. */
  defaultValue: unknown;
  defaultText: string | undefined;
  /** "string", "integer", "boolean", "list" (of `listValues`), or the enum values. */
  type: "string" | "integer" | "boolean" | "list" | readonly string[];
  /** Allowed items of a "list" key. */
  listValues?: readonly string[] | undefined;
}

/** `indexing.allowPrivateUrls` -> `LIBSCOPE_INDEXING_ALLOW_PRIVATE_URLS`. */
export function canonicalEnvName(section: string, field: string): string {
  const snake = field.replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  return `LIBSCOPE_${section.toUpperCase()}_${snake}`;
}

/** Strip optional/default wrappers to reach the base schema. */
function baseSchema(schema: z.ZodType): z.ZodType {
  let current: z.ZodType = schema;
  while (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
    current = current.unwrap() as z.ZodType;
  }
  return current;
}

function enumValues(schema: z.ZodType): string[] | undefined {
  return schema instanceof z.ZodEnum ? schema.options.map(String) : undefined;
}

function leafType(schema: z.ZodType): ConfigKeySpec["type"] {
  const base = baseSchema(schema);
  if (base instanceof z.ZodArray) return "list";
  const values = enumValues(base);
  if (values) return values;
  if (base instanceof z.ZodBoolean) return "boolean";
  if (base instanceof z.ZodNumber) return "integer";
  return "string";
}

function listItemValues(schema: z.ZodType): string[] | undefined {
  const base = baseSchema(schema);
  return base instanceof z.ZodArray ? enumValues(base.element as z.ZodType) : undefined;
}

function buildSpecs(): ConfigKeySpec[] {
  const specs: ConfigKeySpec[] = [];
  for (const [section, sectionSchema] of Object.entries(ConfigSchema.shape)) {
    for (const [field, schemaValue] of Object.entries(sectionSchema.shape)) {
      const schema = schemaValue as z.ZodType;
      const meta = configKeyMeta.get(schema) ?? {};
      const parsedDefault = schema.safeParse(undefined);
      specs.push({
        key: `${section}.${field}` as ConfigKey,
        section: section as SectionName,
        field,
        schema,
        env: [canonicalEnvName(section, field), ...(meta.env ?? [])],
        secret: meta.secret ?? false,
        description: schema.description ?? "",
        defaultValue: parsedDefault.success ? parsedDefault.data : undefined,
        defaultText: meta.defaultText,
        type: leafType(schema),
        listValues: listItemValues(schema),
      });
    }
  }
  return specs;
}

/** All leaf specs, in schema order. */
export const CONFIG_KEY_SPECS: readonly ConfigKeySpec[] = buildSpecs();

const SPECS_BY_KEY: ReadonlyMap<string, ConfigKeySpec> = new Map(
  CONFIG_KEY_SPECS.map((spec) => [spec.key, spec]),
);

/** All settable config keys. */
export const CONFIG_KEY_NAMES: readonly ConfigKey[] = CONFIG_KEY_SPECS.map((s) => s.key);

/** Spec for a key, or undefined. */
export function getConfigKeySpec(key: string): ConfigKeySpec | undefined {
  return SPECS_BY_KEY.get(key);
}

/** One row of the generated configuration reference. */
export interface ConfigKeyTableRow {
  key: ConfigKey;
  /** "string", "integer", "boolean", "list of a | b", or the allowed values joined with " | ". */
  type: string;
  /** Default value as text ("" when none). */
  default: string;
  /** Env var names in priority order. */
  env: string[];
  secret: boolean;
  description: string;
}

function defaultAsText(spec: ConfigKeySpec): string {
  if (spec.defaultText !== undefined) return spec.defaultText;
  const value = spec.defaultValue;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return value.length > 0 ? value.join(",") : "none";
  return "";
}

function typeAsText(spec: ConfigKeySpec): string {
  if (spec.type === "list") return `list of ${(spec.listValues ?? ["string"]).join(" | ")}`;
  return typeof spec.type === "string" ? spec.type : spec.type.join(" | ");
}

/** The key table (for docs and `config` help): key, type, default, env vars, secret, description. */
export function getConfigKeyTable(): ConfigKeyTableRow[] {
  return CONFIG_KEY_SPECS.map((spec) => ({
    key: spec.key,
    type: typeAsText(spec),
    default: defaultAsText(spec),
    env: [...spec.env],
    secret: spec.secret,
    description: spec.description,
  }));
}
