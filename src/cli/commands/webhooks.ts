/** `libscope webhooks list|create|delete|test`. */
import type { Command } from "commander";
import {
  createWebhookOperation,
  deleteWebhookOperation,
  listWebhooksOperation,
  testWebhookOperation,
} from "../../core/operations/index.js";
import { WEBHOOK_EVENTS } from "../../core/webhooks.js";
import { defined, splitList } from "../options.js";
import { printList, run } from "../run.js";

export function register(program: Command): void {
  const webhooks = program.command("webhooks").description("Send signed POSTs on document events");

  webhooks
    .command("list")
    .description("List webhooks (secrets are never shown)")
    .action(async () => {
      await run(listWebhooksOperation, {}, (r) =>
        printList(r.items, "No webhooks.", (h) => {
          console.log(`${h.id}  ${h.url}`);
          console.log(`    events: ${h.events.join(", ")} | active: ${h.active ? "yes" : "no"}`);
          if (h.lastTriggeredAt) console.log(`    last triggered: ${h.lastTriggeredAt}`);
          if (h.failureCount > 0) console.log(`    failures: ${h.failureCount}`);
        }),
      );
    });

  webhooks
    .command("create <url>")
    .description("Register a webhook")
    .requiredOption("--events <events>", `Comma-separated: ${WEBHOOK_EVENTS.join(", ")}`)
    .option("--secret <secret>", "HMAC-SHA256 signing secret (needs LIBSCOPE_SECRET_KEY)")
    .action(async (url: string, flags: { events: string; secret?: string }) => {
      const input = defined({ url, events: splitList(flags.events), secret: flags.secret });
      await run(createWebhookOperation, input, (h) =>
        console.log(`✓ Created webhook ${h.id} for ${h.events.join(", ")}`),
      );
    });

  webhooks
    .command("delete <webhookId>")
    .description("Delete a webhook")
    .action(async (webhookId: string) => {
      await run(deleteWebhookOperation, { webhookId }, () =>
        console.log(`✓ Deleted webhook ${webhookId}`),
      );
    });

  webhooks
    .command("test <webhookId>")
    .description("Send a test event and show the HTTP status")
    .action(async (webhookId: string) => {
      await run(testWebhookOperation, { webhookId }, (r) =>
        console.log(`Response: ${r.status} ${r.statusText}`),
      );
    });
}
