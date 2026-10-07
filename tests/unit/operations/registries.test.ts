import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { NotFoundError, ValidationError } from "../../../src/errors.js";
import { initLogger } from "../../../src/logger.js";

// Registries live under ~/.libscope/registries: point homedir() at a temp directory.
let tempHome = tmpdir();
vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: (): string => tempHome };
});

const ops = await import("../../../src/core/operations/index.js");
const { getRegistryCacheDir } = await import("../../../src/registry/types.js");
const { makeContext, run, expectValidationError } = await import("./helpers.js");
type TestContext = ReturnType<typeof makeContext>;

initLogger("silent");

describe("registry operations", () => {
  let t: TestContext;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "libscope-registry-ops-"));
    tempHome = join(dir, "home");
    t = makeContext();
  });

  afterEach(() => {
    t.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeGzPack(name: string): string {
    const path = join(dir, `${name}.json.gz`);
    const pack = {
      name,
      version: "1.0.0",
      description: `The ${name} pack`,
      documents: [{ title: "Pack doc", content: "Content from a registry pack", source: "t" }],
      metadata: { author: "tests", license: "MIT", createdAt: "2026-01-01T00:00:00.000Z" },
    };
    writeFileSync(path, gzipSync(JSON.stringify(pack)));
    return path;
  }

  /** create-registry, then a bare clone to push to; returns its file:/// URL. */
  async function makeRemote(): Promise<string> {
    const created = await run(ops.createRegistryOperation, t.ctx, { path: join(dir, "src") });
    const bare = join(dir, "packs.git");
    execFileSync("git", ["clone", "--quiet", "--bare", created.path, bare]);
    return `file://${bare}`;
  }

  it("adds, publishes, lists, searches, installs, unpublishes and removes", async () => {
    const url = await makeRemote();
    const added = await run(ops.addRegistryOperation, t.ctx, { url });
    expect(added).toMatchObject({ name: "packs", sync: { status: "success", packs: 0 } });

    const published = await run(ops.publishPackOperation, t.ctx, {
      file: writeGzPack("demo"),
      registry: "packs",
    });
    expect(published).toMatchObject({ packName: "demo", version: "1.0.0", branch: null });

    const registries = await run(ops.listRegistriesOperation, t.ctx, {});
    expect(registries.items).toEqual([
      expect.objectContaining({ name: "packs", url, packs: 1 }) as unknown,
    ]);

    const found = await run(ops.searchRegistriesOperation, t.ctx, { query: "demo" });
    expect(found.items.map((p) => [p.registry, p.name])).toEqual([["packs", "demo"]]);

    const available = await run(ops.listPacksOperation, t.ctx, { available: true });
    expect(available).toMatchObject({ items: [{ name: "demo", registry: "packs" }] });

    const installed = await run(ops.installPackOperation, t.ctx, { pack: "demo@1.0.0" });
    expect(installed).toMatchObject({ packName: "demo", documentsInstalled: 1 });

    await expectValidationError(
      run(ops.unpublishPackOperation, t.ctx, { pack: "demo", registry: "packs" }),
    );
    expect(
      await run(ops.unpublishPackOperation, t.ctx, { pack: "demo@1.0.0", registry: "packs" }),
    ).toMatchObject({ removed: true });
    expect((await run(ops.searchRegistriesOperation, t.ctx, { query: "demo" })).items).toEqual([]);

    await run(ops.removeRegistryOperation, t.ctx, { name: "packs" });
    expect(existsSync(getRegistryCacheDir("packs"))).toBe(false);
    expect((await run(ops.listRegistriesOperation, t.ctx, {})).items).toEqual([]);
  });

  it("syncs one or all registries and reports registries that cannot be reached", async () => {
    const url = await makeRemote();
    await run(ops.addRegistryOperation, t.ctx, { url, name: "first", sync: false });
    await run(ops.addRegistryOperation, t.ctx, {
      url: `file://${join(dir, "missing.git")}`,
      name: "broken",
      sync: false,
    });
    expect((await run(ops.listPacksOperation, t.ctx, { available: true })).warnings).toHaveLength(
      2,
    );

    const one = await run(ops.syncRegistriesOperation, t.ctx, { name: "first" });
    expect(one.items).toMatchObject([{ registry: "first", status: "success", packs: 0 }]);
    const all = await run(ops.syncRegistriesOperation, t.ctx, {});
    expect(all.items.map((s) => s.status)).toEqual(["success", "error"]);
  });

  it("throws NotFoundError for unknown registries and packs", async () => {
    await expect(run(ops.installPackOperation, t.ctx, { pack: "demo" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    for (const [op, input] of [
      [ops.syncRegistriesOperation, { name: "nope" }],
      [ops.searchRegistriesOperation, { query: "x", registry: "nope" }],
      [ops.removeRegistryOperation, { name: "nope" }],
      [ops.listPacksOperation, { available: true, registry: "nope" }],
      [ops.installPackOperation, { pack: "demo", registry: "nope" }],
    ] as const) {
      await expect(run(op, t.ctx, input), op.name).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it("validates input", async () => {
    await expectValidationError(run(ops.listPacksOperation, t.ctx, { registry: "packs" }));
    await expectValidationError(
      run(ops.installPackOperation, t.ctx, { pack: "a.json", registry: "packs" }),
    );
    await expectValidationError(run(ops.addRegistryOperation, t.ctx, { url: "/srv/x.git" }));
    await expectValidationError(run(ops.searchRegistriesOperation, t.ctx, { query: "" }));
  });

  it("reads and writes local files only from the CLI and the Node.js API", async () => {
    for (const surface of ["api", "mcp"] as const) {
      const other = makeContext({ db: t.db, surface });
      await expect(
        run(ops.installPackOperation, other.ctx, { pack: writeGzPack("x") }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        run(ops.publishPackOperation, other.ctx, { file: "x.json", registry: "packs" }),
      ).rejects.toThrow(/only available from the CLI/);
      await expect(
        run(ops.createRegistryOperation, other.ctx, { path: join(dir, "r") }),
      ).rejects.toThrow(/only available from the CLI/);
    }
  });
});
