/** `libscope topics ...` and `libscope tags list`. */
import type { Command } from "commander";
import {
  createTopicOperation,
  deleteTopicOperation,
  listTagsOperation,
  listTopicsOperation,
} from "../../core/operations/index.js";
import { confirmOrCancel } from "../confirm.js";
import { defined } from "../options.js";
import { plural, printList, run } from "../run.js";

export function register(program: Command): void {
  const topics = program.command("topics").description("Manage topics");

  topics
    .command("list")
    .description("List topics with their document counts")
    .option("--parent <topic>", "Only direct subtopics of this topic (ID or name)")
    .action(async (flags: { parent?: string }) => {
      await run(listTopicsOperation, defined({ parent: flags.parent }), (r) =>
        printList(r.items, "No topics. Create one with: libscope topics create <name>", (t) =>
          console.log(`${t.id}  ${t.name} (${plural(t.documentCount, "document")})`),
        ),
      );
    });

  topics
    .command("create <name>")
    .description("Create a topic")
    .option("--description <text>", "What the topic covers")
    .option("--parent <topic>", "Parent topic (ID or name)")
    .action(async (name: string, flags: { description?: string; parent?: string }) => {
      const input = defined({ name, description: flags.description, parent: flags.parent });
      await run(createTopicOperation, input, (t) =>
        console.log(`✓ Created topic ${t.name}  ${t.id}`),
      );
    });

  topics
    .command("delete <topic>")
    .description("Delete a topic (its documents are kept without a topic)")
    .option("--delete-documents", "Also delete the topic's documents")
    .option("-y, --yes", "Do not ask for confirmation")
    .action(async (topic: string, flags: { deleteDocuments?: boolean; yes?: boolean }) => {
      const what = flags.deleteDocuments
        ? `topic "${topic}" and its documents`
        : `topic "${topic}"`;
      if (!(await confirmOrCancel(`Delete ${what}?`, flags.yes))) return;
      await run(
        deleteTopicOperation,
        { topic, deleteDocuments: flags.deleteDocuments === true },
        (r) => console.log(`✓ Deleted topic ${r.topicId}`),
      );
    });

  program
    .command("tags")
    .description("List tags")
    .command("list")
    .description("List all tags with their document counts")
    .action(async () => {
      await run(listTagsOperation, {}, (r) =>
        printList(
          r.items,
          "No tags. Add some with: libscope docs tag <documentId> <tags...>",
          (t) => console.log(`${t.name} (${plural(t.documentCount, "document")})`),
        ),
      );
    });
}
