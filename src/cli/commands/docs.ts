/** `libscope docs ...`: one document at a time (show, update, links, tags, ratings, versions). */
import type { Command } from "commander";
import { readFileSync } from "node:fs";
import {
  addTagsOperation,
  deleteDocumentOperation,
  documentHistoryOperation,
  getDocumentOperation,
  linkDocumentsOperation,
  listDocumentsOperation,
  listLinksOperation,
  prerequisitesOperation,
  rateDocumentOperation,
  removeTagsOperation,
  rollbackDocumentOperation,
  suggestTagsOperation,
  unlinkDocumentsOperation,
  updateDocumentOperation,
  type DocumentSummary,
  type ListResult,
} from "../../core/operations/index.js";
import type { DocumentView } from "../../core/document-view.js";
import { LINK_TYPES } from "../../core/links.js";
import { confirmOrCancel } from "../confirm.js";
import {
  addDocumentOptions,
  defined,
  documentInput,
  splitList,
  toNumber,
  type DocumentFlags,
} from "../options.js";
import { call, plural, printList, run } from "../run.js";

/** Tags given as separate words and/or comma-separated. */
function tagList(tags: string[]): string[] {
  return tags.flatMap(splitList);
}

function printDocumentList(result: ListResult<DocumentSummary>): void {
  if (result.items.length === 0) {
    console.log("No documents.");
    return;
  }
  const last = result.offset + result.items.length;
  console.log(`Documents ${result.offset + 1}-${last} of ${result.total}:\n`);
  for (const d of result.items) {
    console.log(`${d.documentId}  ${d.title}`);
    const lib = d.library ? ` | ${d.library}${d.version ? ` ${d.version}` : ""}` : "";
    const url = d.url ? ` | ${d.url}` : "";
    console.log(`    ${d.sourceType}${lib}${url} | updated ${d.updatedAt}`);
  }
}

function printDocument(view: DocumentView): void {
  const d = view.document;
  console.log(`# ${d.title}\n`);
  console.log(`ID:        ${d.documentId}`);
  console.log(`Type:      ${d.sourceType}`);
  if (d.library) console.log(`Library:   ${d.library}${d.version ? ` ${d.version}` : ""}`);
  if (d.topicId) console.log(`Topic:     ${d.topicId}`);
  if (d.url) console.log(`URL:       ${d.url}`);
  console.log(`Added by:  ${d.submittedBy}  (${d.createdAt}, updated ${d.updatedAt})`);
  if (view.tags.length > 0) console.log(`Tags:      ${view.tags.join(", ")}`);
  const r = view.ratings;
  if (r.totalRatings > 0) {
    console.log(
      `Rating:    ${r.averageRating.toFixed(1)}/5 (${plural(r.totalRatings, "rating")}, ${plural(r.corrections, "correction")})`,
    );
  }
  for (const l of view.links.outgoing) {
    console.log(`Link:      → [${l.linkType}] ${l.targetTitle} (${l.targetId})  link ${l.id}`);
  }
  for (const l of view.links.incoming) {
    console.log(`Link:      ← [${l.linkType}] ${l.sourceTitle} (${l.sourceId})  link ${l.id}`);
  }
  console.log("\n---\n");
  console.log(view.content);
  if (view.nextOffset !== null) {
    console.log(
      `\n... ${view.contentLength - view.nextOffset} more characters (--offset ${view.nextOffset})`,
    );
  }
}

interface UpdateFlags {
  title?: string;
  content?: string;
  contentFile?: string;
  library?: string;
  libVersion?: string;
  url?: string;
  topic?: string;
  tags?: string;
}

export function updateInput(documentId: string, flags: UpdateFlags): Record<string, unknown> {
  const content =
    flags.contentFile === undefined ? flags.content : readFileSync(flags.contentFile, "utf-8");
  return defined({
    documentId,
    title: flags.title,
    content,
    library: flags.library,
    version: flags.libVersion,
    url: flags.url,
    topic: flags.topic,
    tags: flags.tags === undefined ? undefined : splitList(flags.tags),
  });
}

function registerViewCommands(docs: Command): void {
  addDocumentOptions(docs.command("list").description("List documents, newest first"))
    .option("--offset <n>", "Documents to skip (paging)", toNumber)
    .action(async (flags: DocumentFlags & { offset?: number }) => {
      await run(
        listDocumentsOperation,
        { ...documentInput(flags), ...defined({ offset: flags.offset }) },
        printDocumentList,
      );
    });

  docs
    .command("show <documentId>")
    .description("Show a document with its tags, links and ratings")
    .option("--offset <n>", "Start the content at this character", toNumber)
    .option("--max-length <n>", "Show at most this many characters of content", toNumber)
    .action(async (documentId: string, flags: { offset?: number; maxLength?: number }) => {
      await run(
        getDocumentOperation,
        defined({ documentId, offset: flags.offset, maxLength: flags.maxLength }),
        printDocument,
      );
    });

  docs
    .command("history <documentId>")
    .description("List saved versions of a document")
    .action(async (documentId: string) => {
      await run(documentHistoryOperation, { documentId }, (r) =>
        printList(r.items, "No saved versions.", (v) =>
          console.log(`v${v.version}  ${v.title}  (${v.createdAt})`),
        ),
      );
    });
}

function registerEditCommands(docs: Command): void {
  docs
    .command("update <documentId>")
    .description("Change a document's title, content, metadata or tags")
    .option("--title <title>", "New title")
    .option("--content <text>", "New content (re-chunked and re-embedded)")
    .option("--content-file <path>", "Read the new content from a file")
    .option("--library <name>", "New library name")
    .option("--lib-version <version>", "New library version")
    .option("--url <url>", "New URL")
    .option("--topic <topic>", "New topic (ID or name)")
    .option("--tags <tags>", "Replace the tags with these (comma-separated)")
    .action(async (documentId: string, flags: UpdateFlags) => {
      await run(
        updateDocumentOperation,
        updateInput(documentId, flags),
        (view) => console.log(`✓ Updated "${view.document.title}" (${documentId})`),
        { embeddings: true },
      );
    });

  docs
    .command("delete <documentId>")
    .description("Delete a document with its chunks, links and ratings")
    .option("-y, --yes", "Do not ask for confirmation")
    .action(async (documentId: string, flags: { yes?: boolean }) => {
      const view = await call(getDocumentOperation, { documentId, maxLength: 0 });
      const title = view.document.title;
      const question = `Delete "${title}" (${documentId})? This cannot be undone.`;
      if (!(await confirmOrCancel(question, flags.yes))) return;
      await run(deleteDocumentOperation, { documentId }, () =>
        console.log(`✓ Deleted "${title}" (${documentId})`),
      );
    });

  docs
    .command("rollback <documentId> <version>")
    .description("Restore a saved version (the current state is saved first)")
    .action(async (documentId: string, version: string) => {
      await run(
        rollbackDocumentOperation,
        { documentId, version: Number(version) },
        (v) => console.log(`✓ Restored version ${version}; the previous state is v${v.version}`),
        { embeddings: true },
      );
    });

  docs
    .command("rate <documentId> <rating>")
    .description("Rate a document from 1 (poor) to 5 (excellent)")
    .option("--feedback <text>", "What is good or wrong")
    .option("--correction <text>", "Suggested replacement text")
    .option("--chunk <chunkId>", "Rate one chunk of the document")
    .action(
      async (
        documentId: string,
        rating: string,
        flags: { feedback?: string; correction?: string; chunk?: string },
      ) => {
        const input = defined({
          documentId,
          rating: Number(rating),
          feedback: flags.feedback,
          suggestedCorrection: flags.correction,
          chunkId: flags.chunk,
        });
        await run(rateDocumentOperation, input, (r) =>
          console.log(`✓ Rated ${documentId} ${r.rating}/5  rating ${r.id}`),
        );
      },
    );
}

function registerLinkCommands(docs: Command): void {
  docs
    .command("link <documentId> <targetDocumentId>")
    .description("Link one document to another")
    .requiredOption("--type <type>", `Link type: ${LINK_TYPES.join(", ")}`)
    .option("--label <text>", "Short description of the relationship")
    .action(
      async (
        documentId: string,
        targetDocumentId: string,
        flags: { type: string; label?: string },
      ) => {
        const input = defined({
          documentId,
          targetDocumentId,
          linkType: flags.type,
          label: flags.label,
        });
        await run(linkDocumentsOperation, input, (l) =>
          console.log(
            `✓ Linked ${documentId} -[${l.linkType}]-> ${targetDocumentId}  link ${l.linkId}`,
          ),
        );
      },
    );

  docs
    .command("unlink <linkId>")
    .description("Delete a link (link IDs are shown by `docs links`)")
    .action(async (linkId: string) => {
      await run(unlinkDocumentsOperation, { linkId }, () =>
        console.log(`✓ Deleted link ${linkId}`),
      );
    });

  docs
    .command("links [documentId]")
    .description("List the links of a document, or every link")
    .option("--type <type>", `Only this link type: ${LINK_TYPES.join(", ")}`)
    .action(async (documentId: string | undefined, flags: { type?: string }) => {
      await run(listLinksOperation, defined({ documentId, linkType: flags.type }), (r) =>
        printList(r.items, "No links.", (l) => {
          const dir = "direction" in l && l.direction === "incoming" ? "←" : "→";
          const label = l.label ? ` — ${l.label}` : "";
          console.log(`${l.linkId}  ${l.sourceId} ${dir} [${l.linkType}] ${l.targetId}${label}`);
        }),
      );
    });

  docs
    .command("prereqs <documentId>")
    .description("List the documents to read first (following prerequisite links)")
    .action(async (documentId: string) => {
      await run(prerequisitesOperation, { documentId }, (r) => {
        let step = 0;
        printList(r.items, "No prerequisites.", (d) =>
          console.log(`${++step}. ${d.title}  ${d.documentId}`),
        );
      });
    });
}

function registerTagCommands(docs: Command): void {
  docs
    .command("tag <documentId> <tags...>")
    .description("Add tags to a document (space- or comma-separated)")
    .action(async (documentId: string, tags: string[]) => {
      await run(addTagsOperation, { documentId, tags: tagList(tags) }, (r) =>
        console.log(`✓ ${documentId} tags: ${r.tags.join(", ")}`),
      );
    });

  docs
    .command("untag <documentId> <tags...>")
    .description("Remove tags from a document")
    .action(async (documentId: string, tags: string[]) => {
      await run(removeTagsOperation, { documentId, tags: tagList(tags) }, (r) =>
        console.log(
          `✓ Removed ${plural(r.removed.length, "tag")}; ${documentId} tags: ${r.tags.join(", ") || "(none)"}`,
        ),
      );
    });

  docs
    .command("suggest-tags <documentId>")
    .description("Suggest tags from a document's content")
    .option("-n, --limit <n>", "Maximum suggestions", toNumber)
    .action(async (documentId: string, flags: { limit?: number }) => {
      await run(suggestTagsOperation, defined({ documentId, limit: flags.limit }), (r) =>
        printList(r.suggestions, "No suggestions.", (t) => console.log(`  ${t}`)),
      );
    });
}

export function register(program: Command): void {
  const docs = program.command("docs").description("Show and change documents");
  registerViewCommands(docs);
  registerEditCommands(docs);
  registerLinkCommands(docs);
  registerTagCommands(docs);
}
