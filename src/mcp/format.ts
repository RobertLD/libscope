/**
 * Compact text output for MCP tools. Every line that names a document, chunk or link carries
 * its ID, so the assistant can pass it straight to the next tool.
 */
import type { IngestResult } from "../core/ingest.js";
import type { DocumentLinks } from "../core/links.js";
import type { DocumentView } from "../core/document-view.js";
import type { DocumentSummary, ListResult } from "../core/operations/index.js";
import type { Overview } from "../core/overview.js";
import type { InstallResult, InstalledPack } from "../core/packs.js";
import type { RegistryPack } from "../registry/types.js";
import type { AnswerResult, RagSource } from "../core/rag.js";
import type { ReindexResult } from "../core/reindex.js";
import type { Rating } from "../core/ratings.js";
import type { SearchResult } from "../core/search.js";
import type { Task } from "../core/tasks.js";
import type { ConnectorSyncSummary } from "../connectors/registry.js";
import { describeEmbeddingIdentity } from "../db/index-meta.js";

/** Join the non-empty parts with " · ". */
function joinParts(parts: Array<string | null | undefined | false>): string {
  return parts.filter((p): p is string => typeof p === "string" && p !== "").join(" · ");
}

/** "library v1.2" / "library" / "". */
function libraryLabel(library: string | null, version: string | null): string {
  if (!library) return "";
  return version ? `${library} v${version}` : library;
}

/** "Showing 11-20 of 42" style header for a page of a list result. */
function pageHeader(what: string, page: ListResult<unknown>): string {
  if (page.items.length === 0) {
    return page.offset > 0 ? `No more ${what} (total ${page.total}).` : `No ${what} found.`;
  }
  const first = page.offset + 1;
  const last = page.offset + page.items.length;
  const more = last < page.total ? ` — next page: offset ${last}` : "";
  const title = what.charAt(0).toUpperCase() + what.slice(1);
  return `${title} ${first}-${last} of ${page.total}${more}`;
}

function formatContext(label: string, chunks: SearchResult["contextBefore"]): string {
  if (!chunks || chunks.length === 0) return "";
  return `[context ${label}]\n${chunks.map((c) => c.content).join("\n\n")}\n`;
}

function formatSearchResult(r: SearchResult, n: number): string {
  const header = joinParts([
    `[${n}] ${r.title}`,
    `score ${r.score.toFixed(2)}`,
    r.avgRating ? `rating ${r.avgRating.toFixed(1)}/5` : null,
  ]);
  const meta = joinParts([
    `documentId: ${r.documentId}`,
    `chunkId: ${r.chunkId}`,
    libraryLabel(r.library, r.version),
    r.url,
  ]);
  return (
    `${header}\n${meta}\n` +
    formatContext("before", r.contextBefore) +
    `${r.content}\n` +
    formatContext("after", r.contextAfter)
  );
}

/** Output of `search`. */
export function formatSearchResults(page: ListResult<SearchResult>): string {
  const header = pageHeader("results", page);
  if (page.items.length === 0) return header;
  const body = page.items.map((r, i) => formatSearchResult(r, page.offset + i + 1));
  return `${header}\n\n${body.join("\n---\n")}`;
}

function formatSources(sources: RagSource[]): string {
  if (sources.length === 0) return "";
  const lines = sources.map(
    (s) => `- ${s.title} (documentId: ${s.documentId}, score ${s.score.toFixed(2)})`,
  );
  return `\n\nSources:\n${lines.join("\n")}`;
}

/** Output of `ask`: the LLM answer, or (passthrough) the context to answer from. */
export function formatAnswer(result: AnswerResult): string {
  if (result.mode === "context") {
    return (
      "Passthrough mode: no LLM was called. Answer the question yourself from this context " +
      "and cite the documentIds.\n\n" +
      result.contextPrompt +
      formatSources(result.sources)
    );
  }
  const tokens = result.tokensUsed == null ? "" : `, ${result.tokensUsed} tokens`;
  return `${result.answer}${formatSources(result.sources)}\n\n(model: ${result.model}${tokens})`;
}

function formatLinks({ outgoing, incoming }: DocumentLinks): string[] {
  const label = (l: { label: string | null }): string => (l.label ? ` "${l.label}"` : "");
  return [
    ...outgoing.map(
      (l) =>
        `  -> ${l.linkType} ${l.targetTitle} (documentId: ${l.targetId}, linkId: ${l.id})${label(l)}`,
    ),
    ...incoming.map(
      (l) =>
        `  <- ${l.linkType} ${l.sourceTitle} (documentId: ${l.sourceId}, linkId: ${l.id})${label(l)}`,
    ),
  ];
}

/** Header lines of a document view: IDs, metadata, tags, rating, links. */
function formatDocumentHeader(view: DocumentView): string[] {
  const d = view.document;
  const { averageRating, totalRatings, corrections } = view.ratings;
  const lines = [
    `# ${d.title}`,
    joinParts([
      `documentId: ${d.documentId}`,
      d.sourceType,
      libraryLabel(d.library, d.version),
      d.topicId ? `topic: ${d.topicId}` : null,
    ]),
  ];
  if (d.url) lines.push(`url: ${d.url}`);
  if (view.tags.length > 0) lines.push(`tags: ${view.tags.join(", ")}`);
  if (totalRatings > 0) {
    const fixes = corrections > 0 ? `, ${corrections} suggested corrections` : "";
    lines.push(`rating: ${averageRating.toFixed(1)}/5 (${totalRatings} ratings${fixes})`);
  }
  const links = formatLinks(view.links);
  if (links.length > 0) lines.push("links:", ...links);
  lines.push(`updated: ${d.updatedAt}`);
  return lines;
}

/** Output of `get-document`: metadata, then the requested slice of the content. */
export function formatDocumentView(view: DocumentView): string {
  return `${formatDocumentHeader(view).join("\n")}${pageRange(view)}\n\n${view.content}`;
}

/** "[characters 0-500 of 1200; next page: offset 500]" for a paged view, else "". */
function pageRange(view: DocumentView): string {
  const paged = view.offset > 0 || view.nextOffset !== null;
  if (!paged) return "";
  const end = view.offset + view.content.length;
  const next = view.nextOffset === null ? "]" : `; next page: offset ${view.nextOffset}]`;
  return `\n\n[characters ${view.offset}-${end} of ${view.contentLength}${next}`;
}

/** Output of `update-document`: the document's new metadata (no content). */
export function formatDocumentUpdated(view: DocumentView): string {
  return `Updated.\n${formatDocumentHeader(view).join("\n")}`;
}

/** Output of `list-documents`. */
export function formatDocumentList(page: ListResult<DocumentSummary>): string {
  const header = pageHeader("documents", page);
  const lines = page.items.map(
    (d) =>
      `- ${d.title} (documentId: ${d.documentId}) ` +
      joinParts([d.sourceType, libraryLabel(d.library, d.version), d.url]),
  );
  return [header, ...lines].join("\n");
}

/** Output of `overview`. */
export function formatOverview(o: Overview): string {
  const { stats, health, index } = o;
  const lines = [
    `Documents: ${stats.totalDocuments} · chunks: ${stats.totalChunks} · topics: ${stats.totalTopics}`,
    `Health: database ${health.database} · keyword index ${health.fts} · vector search ${
      health.vectorSearch ? "ok" : "unavailable"
    }`,
    `Index embeddings: ${describeEmbeddingIdentity(index.stored)}` +
      (index.configured ? ` · configured: ${describeEmbeddingIdentity(index.configured)}` : ""),
  ];
  if (o.topics.length > 0) {
    lines.push(
      "Topics:",
      ...o.topics.map((t) => `- ${t.name} (topic: ${t.id}, ${t.documentCount} docs)`),
    );
  }
  if (o.packs.length > 0) {
    lines.push("Packs:", ...o.packs.map(formatInstalledPack));
  }
  return lines.join("\n");
}

/** Output of `submit-document`. */
export function formatIngestResult(result: IngestResult): string {
  const lines: string[] = [];
  if (result.planned) {
    lines.push(
      `Dry run: ${result.planned.length} source(s) would be added.`,
      ...result.planned.map((p) => `- ${p}`),
    );
  } else {
    lines.push(`Added ${result.documents.length} document(s).`);
  }
  lines.push(
    ...result.documents.map(
      (d) =>
        `- ${d.title} (documentId: ${d.documentId}, ${d.chunkCount} chunks)` +
        (d.source ? ` ${d.source}` : ""),
    ),
  );
  if (result.crawl) {
    const { pagesCrawled, pagesSkipped, abortReason } = result.crawl;
    lines.push(
      `Crawled ${pagesCrawled} page(s), skipped ${pagesSkipped}` +
        (abortReason ? `; stopped early: ${abortReason}` : ""),
    );
  }
  if (result.skipped.length > 0) {
    lines.push(
      `Skipped ${result.skipped.length}:`,
      ...result.skipped.map((s) => `- ${s.source}: ${s.reason}`),
    );
  }
  if (result.errors.length > 0) {
    lines.push(
      `Errors ${result.errors.length}:`,
      ...result.errors.map((e) => `- ${e.source}: ${e.error}`),
    );
  }
  return lines.join("\n");
}

/** Output of `delete-document`. */
export function formatDocumentDeleted(result: { documentId: string }): string {
  return `Deleted document ${result.documentId}.`;
}

/** Output of `rate-document`. */
export function formatRating(r: Rating): string {
  const chunk = r.chunkId ? `, chunkId: ${r.chunkId}` : "";
  return joinParts([
    `Rated ${r.rating}/5 (documentId: ${r.documentId}${chunk})`,
    r.feedback ? `feedback saved` : null,
    r.suggestedCorrection ? `correction saved` : null,
  ]);
}

/** Output of `link-documents` with action "create". */
export function formatLinkCreated(link: {
  linkId: string;
  sourceId: string;
  targetId: string;
  linkType: string;
  label: string | null;
}): string {
  const label = link.label ? ` "${link.label}"` : "";
  return (
    `Linked ${link.sourceId} -> ${link.targetId} (${link.linkType})${label}. ` +
    `linkId: ${link.linkId}`
  );
}

/** Output of `link-documents` with action "delete". */
export function formatLinkDeleted(result: { linkId: string }): string {
  return `Deleted link ${result.linkId}.`;
}

/** Output when a tool started a background task. */
export function formatTaskStarted(task: Task): string {
  return (
    `Started background task. taskId: ${task.id}\n` +
    `Poll with task {"action": "status", "taskId": "${task.id}"}.`
  );
}

/** Formats an operation's JSON result for a task, or returns undefined to show it raw. */
export type TaskResultFormatter = (operation: string, result: unknown) => string | undefined;

function formatTaskResult(task: Task, formatResult?: TaskResultFormatter): string {
  if (task.result === undefined) return "";
  let text: string | undefined;
  if (task.operation !== undefined && formatResult) {
    try {
      text = formatResult(task.operation, JSON.parse(task.result) as unknown);
    } catch {
      text = undefined;
    }
  }
  return `\nresult:\n${text ?? task.result}`;
}

function taskLine(task: Task): string {
  const progress = task.progress ? ` ${task.progress.current}/${task.progress.total || "?"}` : "";
  return joinParts([
    `taskId: ${task.id}`,
    task.operation ?? task.type,
    `${task.status}${progress}`,
    `created ${task.createdAt.toISOString()}`,
  ]);
}

/** Output of `task` with action "status". */
export function formatTask(task: Task, formatResult?: TaskResultFormatter): string {
  const error = task.error ? `\nerror: ${task.error}` : "";
  return `${taskLine(task)}${error}${formatTaskResult(task, formatResult)}`;
}

/** Output of `task` with action "cancel". */
export function formatTaskCancel(result: {
  taskId: string;
  cancelRequested: boolean;
  status: string;
}): string {
  return result.cancelRequested
    ? `Cancellation requested for task ${result.taskId} (status: ${result.status}).`
    : `Task ${result.taskId} is already ${result.status}; nothing to cancel.`;
}

/** Output of `task` with action "list". */
export function formatTaskList(result: { items: Task[] }): string {
  if (result.items.length === 0) return "No tasks in the last hour.";
  return result.items.map((t) => `- ${taskLine(t)}`).join("\n");
}

/** Output of `sync`. */
export function formatSyncResult(result: {
  items: Array<
    | { name: string; type: string; status: "completed"; summary: ConnectorSyncSummary }
    | { name: string; status: "failed"; error: string }
  >;
}): string {
  if (result.items.length === 0) return "No saved connections to sync.";
  return result.items
    .map((item) => {
      if (item.status === "failed") return `- ${item.name}: failed: ${item.error}`;
      const { added, updated, deleted, errors } = item.summary;
      const errorLines = errors.map((e) => `    ${e}`);
      return [
        `- ${item.name} (${item.type}): ${added} added, ${updated} updated, ${deleted} deleted` +
          (errors.length > 0 ? `, ${errors.length} errors:` : ""),
        ...errorLines,
      ].join("\n");
    })
    .join("\n");
}

function formatInstalledPack(p: InstalledPack): string {
  return `- ${p.name} v${p.version} (${p.docCount} docs, installed ${p.installedAt})`;
}

/** Output of `install-pack`. */
export function formatInstallPack(result: InstallResult): string {
  if (result.alreadyInstalled) return `Pack ${result.packName} is already installed.`;
  const errors = result.errors > 0 ? `, ${result.errors} failed` : "";
  return `Installed pack ${result.packName}: ${result.documentsInstalled} documents${errors}.`;
}

/** Output of `list-packs`. */
export function formatPackList(result: {
  items: Array<InstalledPack | RegistryPack>;
  warnings?: string[] | undefined;
}): string {
  const lines = result.items.map((p) =>
    "installedAt" in p
      ? formatInstalledPack(p)
      : `- ${p.name} v${p.latestVersion} (registry ${p.registry}): ${p.description}`,
  );
  if (lines.length === 0) lines.push("No packs found.");
  for (const warning of result.warnings ?? []) lines.push(`Warning: ${warning}`);
  return lines.join("\n");
}

/** Output of `reindex-documents`. */
export function formatReindex(result: ReindexResult & { rebuiltIndex?: string }): string {
  const lines = [
    `Re-embedded ${result.completed} of ${result.total} chunks` +
      (result.failed > 0 ? `; ${result.failed} failed` : "") +
      ".",
  ];
  if (result.rebuiltIndex) lines.push(`Rebuilt vector index: ${result.rebuiltIndex}`);
  if (result.failedChunkIds.length > 0) {
    lines.push(`Failed chunkIds: ${result.failedChunkIds.join(", ")}`);
  }
  return lines.join("\n");
}
