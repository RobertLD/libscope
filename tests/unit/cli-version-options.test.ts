import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { Command, CommanderError } from "commander";
import { readFileSync } from "node:fs";

vi.mock("../../src/registry/git.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/registry/git.js")>();
  return { ...original, checkGitAvailable: vi.fn().mockResolvedValue(true) };
});

vi.mock("../../src/registry/publish.js", () => ({
  publishPack: vi.fn(),
  publishPackToBranch: vi.fn(),
  unpublishPack: vi.fn().mockResolvedValue(undefined),
}));

import { program } from "../../src/cli/index.js";
import { registerRegistryCommands } from "../../src/cli/commands/registry.js";
import { unpublishPack } from "../../src/registry/publish.js";

const pkgVersion = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as {
    version: string;
  }
).version;

/** Make every command throw instead of exiting, and swallow help/version output. */
function makeTestable(cmd: Command, output: string[]): void {
  cmd.exitOverride();
  cmd.configureOutput({
    writeOut: (str) => output.push(str),
    writeErr: (str) => output.push(str),
  });
  for (const sub of cmd.commands) makeTestable(sub, output);
}

function findCommand(root: Command, path: string[]): Command {
  let cmd = root;
  for (const name of path) {
    const next = cmd.commands.find((c) => c.name() === name);
    if (!next) throw new Error(`Command not found: ${path.join(" ")}`);
    cmd = next;
  }
  return cmd;
}

/** Parse argv against the real CLI program with the target command's action stubbed out. */
async function parseWithStubbedAction(
  path: string[],
  args: string[],
): Promise<Record<string, unknown>> {
  const cmd = findCommand(program, path);
  const action = vi.fn();
  cmd.action(action);
  await program.parseAsync([...path, ...args], { from: "user" });
  expect(action).toHaveBeenCalledTimes(1);
  return cmd.opts();
}

describe("CLI subcommand version flags", () => {
  const output: string[] = [];

  beforeAll(() => {
    makeTestable(program, output);
  });

  it("keeps the root --version flag printing the CLI version", async () => {
    output.length = 0;
    await expect(program.parseAsync(["--version"], { from: "user" })).rejects.toBeInstanceOf(
      CommanderError,
    );
    expect(output.join("")).toContain(pkgVersion);
  });

  it.each([
    [["add"], ["doc.md"]],
    [["import"], ["./docs"]],
    [["import-batch"], ["./docs"]],
    [["docs", "update"], ["doc-1"]],
  ])("%j accepts --lib-version", async (path, positional) => {
    const opts = await parseWithStubbedAction(path, [...positional, "--lib-version", "2.1.0"]);
    expect(opts.libVersion).toBe("2.1.0");
  });

  it.each([
    [["pack", "install"], ["react-docs"]],
    [
      ["pack", "create"],
      ["--name", "react-docs"],
    ],
    [
      ["registry", "publish"],
      ["pack.json", "-r", "main"],
    ],
    [
      ["registry", "unpublish"],
      ["react-docs", "-r", "main"],
    ],
  ])("%j accepts --pack-version", async (path, rest) => {
    const opts = await parseWithStubbedAction(path, [...rest, "--pack-version", "3.0.0"]);
    expect(opts.packVersion).toBe("3.0.0");
  });
});

describe("registry unpublish version resolution", () => {
  function buildProgram(): Command {
    const root = new Command();
    root.exitOverride();
    registerRegistryCommands(root);
    return root;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(unpublishPack).mockClear();
  });

  function stubExit(): void {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`);
    });
  }

  it("accepts name@version", async () => {
    stubExit();
    await buildProgram().parseAsync(
      ["registry", "unpublish", "react-docs@1.2.0", "-r", "main", "-y"],
      {
        from: "user",
      },
    );
    expect(unpublishPack).toHaveBeenCalledWith(
      expect.objectContaining({ registryName: "main", packName: "react-docs", version: "1.2.0" }),
    );
  });

  it("prefers --pack-version over the name@version suffix", async () => {
    stubExit();
    await buildProgram().parseAsync(
      ["registry", "unpublish", "react-docs@1.2.0", "-r", "main", "-y", "--pack-version", "1.3.0"],
      { from: "user" },
    );
    expect(unpublishPack).toHaveBeenCalledWith(
      expect.objectContaining({ packName: "react-docs", version: "1.3.0" }),
    );
  });

  it("exits with an error when no version is given", async () => {
    stubExit();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      buildProgram().parseAsync(["registry", "unpublish", "react-docs", "-r", "main", "-y"], {
        from: "user",
      }),
    ).rejects.toThrow("process.exit(1)");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("--pack-version"));
    expect(unpublishPack).not.toHaveBeenCalled();
  });
});
