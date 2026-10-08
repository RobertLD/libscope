import { describe, it, expect, vi, beforeAll } from "vitest";
import { Command, CommanderError } from "commander";
import { readFileSync } from "node:fs";

import { program } from "../../src/cli/index.js";

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
    [["search"], ["query"]],
    [["docs", "list"], []],
    [["docs", "update"], ["doc-1"]],
  ])("%j accepts --lib-version", async (path, positional) => {
    const opts = await parseWithStubbedAction(path, [...positional, "--lib-version", "2.1.0"]);
    expect(opts.libVersion).toBe("2.1.0");
  });

  it.each([
    [
      ["pack", "create"],
      ["--name", "react-docs"],
    ],
    [
      ["registry", "publish"],
      ["pack.json", "--registry", "main"],
    ],
  ])("%j accepts --pack-version", async (path, rest) => {
    const opts = await parseWithStubbedAction(path, [...rest, "--pack-version", "3.0.0"]);
    expect(opts.packVersion).toBe("3.0.0");
  });
});
