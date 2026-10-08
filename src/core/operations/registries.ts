/**
 * Pack registries: git repositories of packs, cloned under ~/.libscope/registries/<name>/.
 * Only list-registries and search-registries are read-only and exposed over REST; the others
 * change local clones and config (CLI and Node.js API).
 */
import { rmSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { z } from "zod";
import { ValidationError } from "../../errors.js";
import {
  addRegistry,
  deriveRegistryName,
  loadRegistries,
  removeRegistry,
  requireRegistry,
} from "../../registry/config.js";
import { createRegistryRepo } from "../../registry/git.js";
import { publishPack, publishPackToBranch, unpublishPack } from "../../registry/publish.js";
import { parsePackSpecifier } from "../../registry/resolve.js";
import { searchRegistries } from "../../registry/search.js";
import { localPackCount, syncAllRegistries, syncRegistry } from "../../registry/sync.js";
import { getRegistryCacheDir, type PublishResult } from "../../registry/types.js";
import { assertLocalFilesAllowed, registryName } from "./packs.js";
import { defineOperation } from "./types.js";

const message = z.string().min(1).optional().describe("Git commit message");

export const listRegistriesOperation = defineOperation({
  name: "list-registries",
  group: "packs",
  summary: "List the configured pack registries",
  input: z.object({}),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/registries" },
  handler() {
    const items = loadRegistries().map((entry) => ({
      name: entry.name,
      url: entry.url,
      lastSyncedAt: entry.lastSyncedAt,
      packs: localPackCount(entry.name),
    }));
    return { items };
  },
});

export const addRegistryOperation = defineOperation({
  name: "add-registry",
  group: "packs",
  summary: "Add a git repository as a pack registry, and clone it",
  input: z.object({
    url: z
      .string()
      .min(1)
      .describe("Git URL: https://, ssh://, git@host:path, or file:/// for a local repository"),
    name: registryName.optional().describe("Registry name (default: from the URL)"),
    sync: z.boolean().default(true).describe("Clone the registry now"),
  }),
  async handler(_ctx, input) {
    const name = input.name ?? deriveRegistryName(input.url);
    const entry = addRegistry({ name, url: input.url, lastSyncedAt: null });
    return { name, url: entry.url, sync: input.sync ? await syncRegistry(entry) : null };
  },
});

export const removeRegistryOperation = defineOperation({
  name: "remove-registry",
  group: "packs",
  summary: "Remove a pack registry and delete its local clone",
  input: z.object({ name: registryName }),
  annotations: { destructive: true },
  handler(_ctx, input) {
    removeRegistry(input.name);
    rmSync(getRegistryCacheDir(input.name), { recursive: true, force: true });
    return { name: input.name, removed: true };
  },
});

export const syncRegistriesOperation = defineOperation({
  name: "sync-registries",
  group: "packs",
  summary: "Fetch the latest packs of one or all registries",
  description:
    "A registry that cannot be reached keeps its local copy (status offline); one that was never cloned reports status error.",
  input: z.object({
    name: registryName.optional().describe("Sync only this registry (default: all)"),
  }),
  annotations: { idempotent: true },
  async handler(_ctx, input) {
    const items =
      input.name === undefined
        ? await syncAllRegistries()
        : [await syncRegistry(requireRegistry(input.name))];
    return { items };
  },
});

export const searchRegistriesOperation = defineOperation({
  name: "search-registries",
  group: "packs",
  summary: "Search the packs in the configured registries by name, description, tags and author",
  input: z.object({
    query: z.string().min(1).describe("Search text"),
    registry: registryName.optional().describe("Search only this registry"),
  }),
  annotations: { readOnly: true },
  http: { method: "GET", path: "/registries/search" },
  handler(_ctx, input) {
    const { results, warnings } = searchRegistries(input.query, { registryName: input.registry });
    return { items: results, warnings };
  },
});

export const createRegistryOperation = defineOperation({
  name: "create-registry",
  group: "packs",
  summary: "Create an empty registry git repository (push it, then add it with add-registry)",
  input: z.object({ path: z.string().min(1).describe("Directory to create") }),
  async handler(ctx, input) {
    assertLocalFilesAllowed(ctx, "Creating a registry");
    const path = pathResolve(input.path);
    await createRegistryRepo(path);
    return { path };
  },
});

export const publishPackOperation = defineOperation({
  name: "publish-pack",
  group: "packs",
  summary: "Publish a pack file to a registry (commit and push)",
  input: z.object({
    file: z.string().min(1).describe("Pack file (.json or .json.gz)"),
    registry: registryName,
    version: z
      .string()
      .min(1)
      .optional()
      .describe("Version to publish (default: the next patch version, or the pack's version)"),
    message,
    submit: z
      .boolean()
      .default(false)
      .describe(
        "Push to a feature/add-<pack> branch for a pull request instead of the main branch",
      ),
  }),
  async handler(ctx, input): Promise<PublishResult & { branch: string | null }> {
    assertLocalFilesAllowed(ctx, "Publishing a pack");
    const options = {
      registryName: input.registry,
      packFilePath: pathResolve(input.file),
      version: input.version,
      commitMessage: input.message,
    };
    if (input.submit) return publishPackToBranch(options);
    return { ...(await publishPack(options)), branch: null };
  },
});

export const unpublishPackOperation = defineOperation({
  name: "unpublish-pack",
  group: "packs",
  summary: "Remove one version of a pack from a registry (commit and push)",
  input: z.object({
    pack: z.string().min(1).describe("name@version to remove"),
    registry: registryName,
    message,
  }),
  annotations: { destructive: true },
  async handler(_ctx, input) {
    const { name, version } = parsePackSpecifier(input.pack);
    if (!version) throw new ValidationError("Give the version to unpublish as name@version");
    await unpublishPack({
      registryName: input.registry,
      packName: name,
      version,
      commitMessage: input.message,
    });
    return { registry: input.registry, pack: name, version, removed: true };
  },
});

export const registryOperations = [
  listRegistriesOperation,
  addRegistryOperation,
  removeRegistryOperation,
  syncRegistriesOperation,
  searchRegistriesOperation,
  createRegistryOperation,
  publishPackOperation,
  unpublishPackOperation,
] as const;
