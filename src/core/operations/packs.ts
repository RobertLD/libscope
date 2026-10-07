import { z } from "zod";
import { ValidationError } from "../../errors.js";
import {
  createPack,
  createPackFromSource,
  installPack,
  listAvailablePacks,
  listInstalledPacks,
  removePack,
  type KnowledgePack,
} from "../packs.js";
import { resolveTopicId } from "../topics.js";
import * as s from "./schemas.js";
import { defineOperation, type OperationContext } from "./types.js";

const pack = z.string().min(1).describe("Pack name");
const registryUrl = z.url().optional().describe("Registry URL (default: the public pack registry)");

function isPackFile(nameOrPath: string): boolean {
  return nameOrPath.endsWith(".json") || nameOrPath.endsWith(".json.gz");
}

/** REST callers must not read or write files on the server's disk. */
function assertLocalFilesAllowed(ctx: OperationContext, what: string): void {
  if (ctx.surface === "api") {
    throw new ValidationError(`${what} is not available over the REST API`);
  }
}

export const installPackOperation = defineOperation({
  name: "install-pack",
  group: "packs",
  summary: "Install a knowledge pack from the registry or a local .json/.json.gz file",
  input: z.object({
    pack: z.string().min(1).describe("Pack name from the registry, or a local .json/.json.gz file"),
    registryUrl,
    batchSize: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("Documents per batch (default 10)"),
    concurrency: z
      .number()
      .int()
      .min(1)
      .max(16)
      .optional()
      .describe("Batches embedded in parallel (default 4)"),
  }),
  annotations: { longRunning: true, idempotent: true },
  http: { method: "POST", path: "/packs" },
  handler(ctx, input) {
    if (isPackFile(input.pack)) assertLocalFilesAllowed(ctx, "Installing a pack from a file");
    return installPack(ctx.db, ctx.provider, input.pack, {
      registryUrl: input.registryUrl,
      batchSize: input.batchSize,
      concurrency: input.concurrency,
      signal: ctx.signal,
      onProgress: (done, total, message) => ctx.onProgress?.({ done, total, message }),
    });
  },
});

export const removePackOperation = defineOperation({
  name: "remove-pack",
  group: "packs",
  summary: "Remove an installed pack and its documents",
  input: z.object({ pack }),
  annotations: { destructive: true },
  http: { method: "DELETE", path: "/packs/:pack" },
  handler(ctx, input) {
    removePack(ctx.db, input.pack);
    return { pack: input.pack, removed: true };
  },
});

export const listPacksOperation = defineOperation({
  name: "list-packs",
  group: "packs",
  summary: "List installed packs, or packs available in the registry",
  input: z.object({
    available: z.boolean().default(false).describe("List registry packs instead of installed ones"),
    registryUrl,
  }),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/packs" },
  async handler(ctx, input) {
    if (input.available) return { items: await listAvailablePacks(input.registryUrl) };
    return { items: listInstalledPacks(ctx.db) };
  },
});

export const createPackOperation = defineOperation({
  name: "create-pack",
  group: "packs",
  summary: "Build a pack from indexed documents, or from local files, folders and URLs",
  input: z.object({
    name: z.string().min(1).describe("Pack name"),
    from: z
      .array(z.string().min(1))
      .optional()
      .describe("Files, folders or URLs to build from (default: documents in the database)"),
    topic: s.opt(s.topic).describe("Database mode: only this topic's documents"),
    version: z.string().min(1).optional().describe("Pack version (default 1.0.0)"),
    description: z.string().min(1).optional().describe("Pack description"),
    author: z.string().min(1).optional().describe("Pack author"),
    license: z.string().min(1).optional().describe("Pack license"),
    outputPath: z.string().min(1).optional().describe("Write the pack here (.json or .json.gz)"),
    extensions: z.array(z.string()).optional().describe("Source mode: file extensions to include"),
    exclude: z.array(z.string()).optional().describe("Source mode: globs to skip"),
    recursive: z.boolean().default(true).describe("Source mode: walk subdirectories"),
  }),
  async handler(ctx, input): Promise<KnowledgePack> {
    assertLocalFilesAllowed(ctx, "Creating a pack");
    const common = {
      name: input.name,
      version: input.version,
      description: input.description,
      author: input.author,
      license: input.license,
      outputPath: input.outputPath,
    };
    if (input.from) {
      return createPackFromSource({
        ...common,
        from: input.from,
        extensions: input.extensions,
        exclude: input.exclude,
        recursive: input.recursive,
        onProgress: ({ file, index, total }) =>
          ctx.onProgress?.({ done: index + 1, total, message: file }),
      });
    }
    return createPack(ctx.db, {
      ...common,
      topic: input.topic === undefined ? undefined : resolveTopicId(ctx.db, input.topic),
    });
  },
});

export const packOperations = [
  installPackOperation,
  removePackOperation,
  listPacksOperation,
  createPackOperation,
] as const;
