import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { NotFoundError, ValidationError } from "../../../src/errors.js";
import { initLogger } from "../../../src/logger.js";
import { expectValidationError, makeContext, run, type TestContext } from "./helpers.js";

// Saved connections live under a temp HOME, never the real ~/.libscope.
let tempHome = join(tmpdir(), `libscope-ops-connectors-${process.pid}`);
vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: (): string => tempHome };
});

const ops = await import("../../../src/core/operations/index.js");
const { saveConnectorSettings } = await import("../../../src/connectors/saved-config.js");
const { hasNamedConnectorConfig } = await import("../../../src/connectors/index.js");

initLogger("silent");

describe("connector operations", () => {
  let t: TestContext;
  let vault: string;

  beforeEach(() => {
    tempHome = join(tmpdir(), `libscope-ops-connectors-${randomUUID()}`);
    vault = join(tempHome, "vault");
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, "note.md"), "# Note\n\nA note in the vault.");
    t = makeContext();
  });

  afterEach(() => {
    t.db.close();
    rmSync(tempHome, { recursive: true, force: true });
  });

  function saveVault(name: string): void {
    saveConnectorSettings("obsidian", name, {
      vaultPath: vault,
      topicMapping: "folder",
      excludePatterns: [],
    });
  }

  it("lists, syncs by name, syncs all and disconnects a saved connection", async () => {
    saveVault("notes");
    saveConnectorSettings("slack", "team-slack", {
      token: "xoxb-secret",
      channels: ["all"],
      threadMode: "aggregate",
    });

    const listed = await run(ops.listConnectionsOperation, t.ctx, {});
    expect(listed.items.map((c) => c.name)).toEqual(["notes", "team-slack"]);
    expect(listed.items[1]?.settings["token"]).toBe("***");

    const one = await run(ops.syncOperation, t.ctx, { name: "notes" });
    expect(one.items[0]).toMatchObject({
      name: "notes",
      type: "obsidian",
      status: "completed",
      summary: { added: 1 },
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    try {
      const all = await run(ops.syncOperation, t.ctx, { all: true });
      expect(all.items.map((i) => [i.name, i.status])).toEqual([
        ["notes", "completed"],
        ["team-slack", "failed"],
      ]);
    } finally {
      vi.unstubAllGlobals();
    }

    const afterSync = await run(ops.listConnectionsOperation, t.ctx, {});
    expect(afterSync.items[0]?.lastRun?.status).toBe("completed");

    const removed = await run(ops.disconnectOperation, t.ctx, { name: "notes" });
    expect(removed).toMatchObject({ type: "obsidian", documentsRemoved: 1, configRemoved: true });
    expect(hasNamedConnectorConfig("notes")).toBe(false);
  });

  it("needs exactly one of name and all, and a safe name", async () => {
    await expectValidationError(run(ops.syncOperation, t.ctx, {}));
    await expectValidationError(run(ops.syncOperation, t.ctx, { name: "a", all: true }));
    await expectValidationError(run(ops.disconnectOperation, t.ctx, { name: "../etc" }));
  });

  it("throws NotFoundError for an unknown connection", async () => {
    await expect(run(ops.syncOperation, t.ctx, { name: "nope" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("disconnects by type when nothing is saved, and checks the type", async () => {
    const result = await run(ops.disconnectOperation, t.ctx, { name: "slack" });
    expect(result).toMatchObject({ type: "slack", documentsRemoved: 0, configRemoved: false });
    await expect(run(ops.disconnectOperation, t.ctx, { name: "unknown" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    saveVault("notes");
    await expect(
      run(ops.disconnectOperation, t.ctx, { name: "notes", type: "slack" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
