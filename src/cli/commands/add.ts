/** `libscope add`: files, directories, URLs (optionally crawled) and repositories. */
import type { Command } from "commander";
import { statSync } from "node:fs";
import { addOperation } from "../../core/operations/index.js";
import type { IngestResult } from "../../core/ingest.js";
import { resolveTopicId } from "../../core/topics.js";
import { FileWatcher } from "../../core/watcher.js";
import type { SourceType } from "../../core/indexing.js";
import { ValidationError } from "../../errors.js";
import { getContext, untilInterrupted } from "../context.js";
import {
  addDocumentOptions,
  defined,
  documentInput,
  splitList,
  toNumber,
  type DocumentFlags,
} from "../options.js";
import { call, plural, print } from "../run.js";

interface AddFlags extends DocumentFlags {
  title?: string;
  format?: string;
  dedup?: string;
  expires?: string;
  include?: string;
  exclude?: string;
  watch?: boolean;
  spider?: boolean;
  maxPages?: number;
  maxDepth?: number;
  sameDomain: boolean;
  pathPrefix?: string;
  excludeUrls?: string;
  branch?: string;
  path?: string;
  extensions?: string;
  token?: string;
  dryRun?: boolean;
}

const list = (value: string | undefined): string[] | undefined =>
  value === undefined ? undefined : splitList(value);

/** add-operation input for one source. */
export function addInput(source: string, flags: AddFlags): Record<string, unknown> {
  return defined({
    source,
    ...documentInput(flags),
    title: flags.title,
    format: flags.format,
    dedup: flags.dedup,
    expiresAt: flags.expires,
    include: list(flags.include),
    exclude: list(flags.exclude),
    spider: flags.spider,
    maxPages: flags.maxPages,
    maxDepth: flags.maxDepth,
    sameDomain: flags.spider ? flags.sameDomain : undefined,
    pathPrefix: flags.pathPrefix,
    excludePatterns: list(flags.excludeUrls),
    branch: flags.branch,
    paths: list(flags.path),
    extensions: list(flags.extensions),
    token: flags.token,
    dryRun: flags.dryRun,
  });
}

function printResult(result: IngestResult): void {
  if (result.planned) {
    console.log(`Would add ${plural(result.planned.length, "item")}:`);
    for (const source of result.planned) console.log(`  ${source}`);
  }
  for (const doc of result.documents) {
    console.log(`✓ ${doc.title} (${plural(doc.chunkCount, "chunk")})  ${doc.documentId}`);
    if (doc.source) console.log(`    ${doc.source}`);
  }
  for (const s of result.skipped) console.log(`  skipped ${s.source}: ${s.reason}`);
  for (const e of result.errors) console.log(`✗ ${e.source}: ${e.error}`);
  if (result.crawl) {
    const stop = result.crawl.abortReason ? ` (stopped: ${result.crawl.abortReason})` : "";
    console.log(
      `Crawled ${plural(result.crawl.pagesCrawled, "page")}, skipped ${result.crawl.pagesSkipped}${stop}`,
    );
  }
  if (!result.planned && result.documents.length !== 1) {
    const errors = result.errors.length > 0 ? `, ${plural(result.errors.length, "error")}` : "";
    console.log(`Added ${plural(result.documents.length, "document")}${errors}`);
  }
}

/** Keep re-indexing changed files in `directories` until Ctrl+C. */
async function watchDirectories(directories: string[], flags: AddFlags): Promise<void> {
  const ctx = getContext({ embeddings: true });
  const document = {
    topicId: flags.topic === undefined ? undefined : resolveTopicId(ctx.db, flags.topic),
    library: flags.library,
    version: flags.libVersion,
    sourceType: flags.sourceType as SourceType | undefined,
  };
  const watchers = directories.map(
    (directory) =>
      new FileWatcher(ctx.db, ctx.provider, {
        directory,
        document,
        onIndex: (path): void => console.log(`✓ indexed ${path}`),
        onRemove: (path): void => console.log(`✗ removed ${path}`),
        onError: (err): void => console.error(`⚠ ${err.message}`),
      }),
  );
  for (const w of watchers) w.start();
  console.error(`Watching ${directories.join(", ")} for changes (Ctrl+C to stop)...`);
  await untilInterrupted();
  for (const w of watchers) w.stop();
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function register(program: Command): void {
  const cmd = program
    .command("add <sources...>")
    .description(
      "Add files, directories, URLs or GitHub/GitLab repository URLs to the knowledge base",
    );
  addDocumentOptions(cmd, { mode: "assign", limit: false })
    .option("--title <title>", "Title (one file or URL; default: detected)")
    .option("--format <ext>", "Read files as this format, e.g. .pdf")
    .option("--dedup <mode>", "Duplicate handling: skip, warn or force")
    .option("--expires <time>", "ISO 8601 time after which `admin prune` deletes the documents")
    .option("--include <globs>", "Directory: only files matching these globs (comma-separated)")
    .option("--exclude <globs>", "Directory: skip files matching these globs (comma-separated)")
    .option("--watch", "Directory: keep running and re-index files when they change")
    .option("--spider", "URL: also crawl linked pages")
    .option("--max-pages <n>", "Crawl: page limit (default 25, max 200)", toNumber)
    .option("--max-depth <n>", "Crawl: link depth (default 2, max 5)", toNumber)
    .option("--no-same-domain", "Crawl: also follow links to other domains")
    .option("--path-prefix <path>", "Crawl: only follow links under this path")
    .option("--exclude-urls <globs>", "Crawl: skip URLs matching these globs (comma-separated)")
    .option("--branch <name>", "Repository: branch (default: from the URL, else main)")
    .option("--path <dirs>", "Repository: only these subdirectories (comma-separated)")
    .option("--extensions <exts>", "Repository: file extensions (default .md,.mdx,.txt,.rst)")
    .option("--token <token>", "Repository: access token for a private repository")
    .option("--dry-run", "List what would be added without adding it")
    .action(async (sources: string[], flags: AddFlags) => {
      const directories = sources.filter(isDirectory);
      if (flags.watch && directories.length !== sources.length) {
        throw new ValidationError("--watch works with directories only");
      }
      const results: IngestResult[] = [];
      for (const source of sources) {
        results.push(
          await call(addOperation, addInput(source, flags), { embeddings: !flags.dryRun }),
        );
      }
      print(results, (all) => all.forEach(printResult));
      if (results.every((r) => r.documents.length === 0 && r.errors.length > 0)) {
        process.exitCode = 1;
      }
      if (flags.watch && !flags.dryRun) await watchDirectories(directories, flags);
    });
}
