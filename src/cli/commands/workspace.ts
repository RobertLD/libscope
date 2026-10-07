/** `libscope workspace create|list|use|delete`. */
import type { Command } from "commander";
import {
  createWorkspace,
  deleteWorkspace,
  getActiveWorkspace,
  listWorkspaces,
  setActiveWorkspace,
} from "../../core/workspace.js";
import { confirmOrCancel } from "../confirm.js";
import { print, printList } from "../run.js";

export function register(program: Command): void {
  const workspace = program.command("workspace").description("Separate knowledge bases");

  workspace
    .command("create <name>")
    .description("Create a workspace")
    .action((name: string) => {
      const ws = createWorkspace(name);
      console.log(`✓ Created workspace "${ws.name}" at ${ws.path}`);
    });

  workspace
    .command("list")
    .description("List workspaces")
    .action(() => {
      const active = getActiveWorkspace();
      const items = listWorkspaces().map((ws) => ({ ...ws, active: ws.name === active }));
      print({ items }, (r) =>
        printList(r.items, "No workspaces.", (ws) =>
          console.log(`${ws.active ? "* " : "  "}${ws.name}  ${ws.path}`),
        ),
      );
    });

  workspace
    .command("use <name>")
    .description("Make a workspace the active one")
    .action((name: string) => {
      setActiveWorkspace(name);
      console.log(`✓ Active workspace: ${name}`);
    });

  workspace
    .command("delete <name>")
    .description("Delete a workspace and its database")
    .option("-y, --yes", "Do not ask for confirmation")
    .action(async (name: string, flags: { yes?: boolean }) => {
      const question = `Delete workspace "${name}" and its database? This cannot be undone.`;
      if (!(await confirmOrCancel(question, flags.yes))) return;
      deleteWorkspace(name);
      console.log(`✓ Deleted workspace "${name}"`);
    });
}
