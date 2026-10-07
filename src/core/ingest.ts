/**
 * One entry point for "add this to the knowledge base": inline content, a local file, a
 * directory (with include/exclude globs), a single URL, a URL crawl (spider), or a GitHub /
 * GitLab repository. The CLI `add`, MCP `submit-document`, REST document routes and the SDK
 * all reach indexing through here (via the `add` operation), so they share one set of
 * defaults. The default source type comes from {@link resolveSourceType}.
 */
import type Database from "better-sqlite3";
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { ValidationError } from "../errors.js";
import { globToRegExp, toPosixPath } from "../utils/glob.js";
import {
  indexDocument,
  indexFile,
  resolveSourceType,
  type Chunker,
  type IndexDocumentInput,
  type IndexedDocument,
  type SourceType,
} from "./indexing.js";
import { getParserForFile } from "./parsers/index.js";
import { fetchAndConvert, type FetchOptions } from "./url-fetcher.js";
import { spiderUrl, type SpiderOptions } from "./spider.js";
import { indexRepository, isRepoUrl } from "./repo.js";
import { addTagsToDocument } from "./tags.js";

export type IngestKind = "content" | "file" | "directory" | "url" | "repo";

export interface IngestInput {
  /** Local file, directory, URL or repository URL. Omit when `content` is given. */
  source?: string | undefined;
  /** How to read `source`. Default "auto": see {@link detectIngestKind}. */
  kind?: IngestKind | "auto" | undefined;
  /** Inline document content (markdown). */
  content?: string | undefined;
  /** Title. Required with `content`; overrides the detected title for a file or single URL. */
  title?: string | undefined;
  /** Canonical URL stored with inline content. */
  url?: string | undefined;
  topic?: string | undefined;
  library?: string | undefined;
  version?: string | undefined;
  sourceType?: SourceType | undefined;
  /** Tags added to every indexed document. */
  tags?: string[] | undefined;
  /** ISO 8601 expiry timestamp; expired documents are removed by pruneExpiredDocuments(). */
  expiresAt?: string | undefined;
  dedup?: "skip" | "warn" | "force" | undefined;
  /** Force a file format (e.g. ".pdf") instead of using the extension. */
  format?: string | undefined;
  /** Directory: globs a file's relative path must match (default: every supported format). */
  include?: string[] | undefined;
  /** Directory: globs for files to skip. A glob without "/" also matches the file name. */
  exclude?: string[] | undefined;
  /** URL: crawl pages linked from the URL. */
  spider?: boolean | undefined;
  maxPages?: number | undefined;
  maxDepth?: number | undefined;
  sameDomain?: boolean | undefined;
  pathPrefix?: string | undefined;
  /** URL crawl: globs for URLs to skip. */
  excludePatterns?: string[] | undefined;
  /** Repository: branch (default: from the URL, else "main"). */
  branch?: string | undefined;
  /** Repository: only index files under these paths. */
  paths?: string[] | undefined;
  /** Repository: file extensions to index (default: .md, .mdx, .txt, .rst). */
  extensions?: string[] | undefined;
  /** Repository: access token for private repositories. */
  token?: string | undefined;
  /** List what would be indexed without indexing anything. */
  dryRun?: boolean | undefined;
}

export interface IngestContext {
  db: Database.Database;
  provider: EmbeddingProvider;
  /** URL fetch settings (from config.indexing). */
  fetchOptions?: Pick<FetchOptions, "allowPrivateUrls" | "allowSelfSignedCerts"> | undefined;
  submittedBy?: IndexDocumentInput["submittedBy"];
  /** Custom chunker for inline content and local files. */
  chunker?: Chunker | undefined;
  signal?: AbortSignal | undefined;
  onProgress?:
    | ((p: { done: number; total?: number | undefined; message?: string | undefined }) => void)
    | undefined;
}

export interface IngestedDocument {
  documentId: string;
  title: string;
  chunkCount: number;
  /** File path or URL the document came from ("" for inline content). */
  source: string;
}

export interface IngestResult {
  kind: IngestKind;
  documents: IngestedDocument[];
  errors: Array<{ source: string; error: string }>;
  /** Sources that were not indexed (unsupported format, unchanged content). */
  skipped: Array<{ source: string; reason: string }>;
  /** With `dryRun`: the sources that would be indexed. */
  planned?: string[] | undefined;
  /** URL crawl statistics (spider only). */
  crawl?:
    | { pagesCrawled: number; pagesSkipped: number; abortReason?: string | undefined }
    | undefined;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

/**
 * Decide how to read an ingest input:
 * inline `content` -> "content"; http(s) URL -> "repo" for a GitHub/GitLab repository URL
 * (unless `spider` is set), else "url"; an existing directory -> "directory"; else "file".
 */
export function detectIngestKind(input: IngestInput): IngestKind {
  if (input.kind && input.kind !== "auto") return input.kind;
  if (input.content !== undefined) return "content";
  const source = input.source;
  if (!source) throw new ValidationError("Provide content, or a file, directory or URL to add");
  if (isHttpUrl(source)) return !input.spider && isRepoUrl(source) ? "repo" : "url";
  let isDirectory = false;
  try {
    isDirectory = statSync(source).isDirectory();
  } catch {
    throw new ValidationError(`File or directory not found: ${source}`);
  }
  return isDirectory ? "directory" : "file";
}

/** Glob matcher for one include/exclude pattern; a pattern without "/" also matches the file name. */
function globMatcher(pattern: string): (relPath: string) => boolean {
  const re = globToRegExp(pattern);
  const nameOnly = !pattern.includes("/");
  return (relPath) => re.test(relPath) || (nameOnly && re.test(basename(relPath)));
}

/**
 * Files under `dir` (recursive, sorted, hidden files and directories skipped) that match
 * `include` (default: every file) and no `exclude` glob. Paths are joined to `dir`.
 */
export function listDirectoryFiles(
  dir: string,
  options: { include?: string[] | undefined; exclude?: string[] | undefined } = {},
): string[] {
  const include = options.include?.map(globMatcher);
  const exclude = options.exclude?.map(globMatcher) ?? [];
  const entries = readdirSync(dir, { recursive: true, encoding: "utf8" });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = toPosixPath(entry);
    if (rel.split("/").some((segment) => segment.startsWith("."))) continue;
    if (include && !include.some((m) => m(rel))) continue;
    if (exclude.some((m) => m(rel))) continue;
    const full = join(dir, entry);
    if (statSync(full).isFile()) files.push(full);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Shared per-document settings derived once from the input. */
function documentDefaults(
  input: IngestInput,
  ctx: IngestContext,
): Pick<
  IndexDocumentInput,
  "sourceType" | "library" | "version" | "topicId" | "dedup" | "expiresAt" | "submittedBy"
> {
  return {
    sourceType: resolveSourceType(input),
    library: input.library,
    version: input.version,
    topicId: input.topic,
    dedup: input.dedup,
    expiresAt: input.expiresAt,
    submittedBy: ctx.submittedBy,
  };
}

function emptyResult(kind: IngestKind): IngestResult {
  return { kind, documents: [], errors: [], skipped: [] };
}

function record(
  ctx: IngestContext,
  input: IngestInput,
  result: IngestResult,
  doc: IndexedDocument,
  title: string,
  source: string,
): void {
  if (input.tags && input.tags.length > 0) addTagsToDocument(ctx.db, doc.id, input.tags);
  result.documents.push({ documentId: doc.id, title, chunkCount: doc.chunkCount, source });
}

async function ingestContent(ctx: IngestContext, input: IngestInput): Promise<IngestResult> {
  const result = emptyResult("content");
  if (!input.title?.trim()) {
    throw new ValidationError("A title is required when adding content directly");
  }
  if (input.dryRun) return { ...result, planned: [input.title] };
  const content = input.content ?? "";
  const doc = await indexDocument(ctx.db, ctx.provider, {
    ...documentDefaults(input, ctx),
    title: input.title,
    content,
    url: input.url,
    preChunked: await ctx.chunker?.({ content, title: input.title, source: input.url ?? "" }),
  });
  record(ctx, input, result, doc, input.title, input.url ?? "");
  return result;
}

function fileTitle(filePath: string): string {
  return basename(filePath).replace(/\.[^.]+$/, "");
}

async function ingestFile(ctx: IngestContext, input: IngestInput): Promise<IngestResult> {
  const result = emptyResult("file");
  const path = input.source ?? "";
  if (input.dryRun) return { ...result, planned: [path] };
  const doc = await indexFile(ctx.db, ctx.provider, path, {
    title: input.title,
    topic: input.topic,
    library: input.library,
    version: input.version,
    format: input.format,
    dedup: input.dedup,
    sourceType: input.sourceType,
    expiresAt: input.expiresAt,
    chunker: ctx.chunker,
  });
  record(ctx, input, result, doc, input.title ?? fileTitle(path), path);
  return result;
}

async function ingestDirectory(ctx: IngestContext, input: IngestInput): Promise<IngestResult> {
  const result = emptyResult("directory");
  const files = listDirectoryFiles(input.source ?? "", input);
  const supported: string[] = [];
  for (const file of files) {
    if (input.format ?? getParserForFile(file)) supported.push(file);
    else result.skipped.push({ source: file, reason: "unsupported file format" });
  }
  if (input.dryRun) return { ...result, planned: supported };

  for (const [i, file] of supported.entries()) {
    ctx.signal?.throwIfAborted();
    try {
      const doc = await indexFile(ctx.db, ctx.provider, file, {
        topic: input.topic,
        library: input.library,
        version: input.version,
        format: input.format,
        dedup: input.dedup,
        sourceType: input.sourceType,
        expiresAt: input.expiresAt,
        chunker: ctx.chunker,
      });
      record(ctx, input, result, doc, fileTitle(file), file);
    } catch (err) {
      result.errors.push({ source: file, error: errorMessage(err) });
    }
    ctx.onProgress?.({ done: i + 1, total: supported.length, message: file });
  }
  return result;
}

async function ingestUrl(ctx: IngestContext, input: IngestInput): Promise<IngestResult> {
  const url = input.source ?? input.url ?? "";
  if (input.spider) return spiderAndIndex(ctx, url, input);
  const result = emptyResult("url");
  if (input.dryRun) return { ...result, planned: [url] };
  const fetched = await fetchAndConvert(url, ctx.fetchOptions);
  ctx.signal?.throwIfAborted();
  const title = input.title ?? fetched.title;
  const doc = await indexDocument(ctx.db, ctx.provider, {
    ...documentDefaults(input, ctx),
    title,
    content: fetched.content,
    url,
  });
  record(ctx, input, result, doc, title, url);
  return result;
}

/** Build SpiderOptions from ingest input, copying only the fields that are set. */
function spiderOptions(ctx: IngestContext, input: IngestInput): SpiderOptions {
  const options: SpiderOptions = { fetchOptions: ctx.fetchOptions ?? {} };
  if (input.maxPages !== undefined) options.maxPages = input.maxPages;
  if (input.maxDepth !== undefined) options.maxDepth = input.maxDepth;
  if (input.sameDomain !== undefined) options.sameDomain = input.sameDomain;
  if (input.pathPrefix !== undefined) options.pathPrefix = input.pathPrefix;
  if (input.excludePatterns !== undefined) options.excludePatterns = input.excludePatterns;
  if (ctx.signal) options.signal = ctx.signal;
  return options;
}

/**
 * Crawl `url` (see spiderUrl for limits and robots.txt handling) and index every page.
 * A page that fails to index is recorded in `errors`; the crawl continues.
 */
export async function spiderAndIndex(
  ctx: IngestContext,
  url: string,
  input: IngestInput = {},
): Promise<IngestResult> {
  const result = emptyResult("url");
  if (input.dryRun) return { ...result, planned: [url] };
  const defaults = documentDefaults(input, ctx);
  const gen = spiderUrl(url, spiderOptions(ctx, input));
  let next = await gen.next();
  while (!next.done) {
    const page = next.value;
    try {
      const doc = await indexDocument(ctx.db, ctx.provider, {
        ...defaults,
        title: page.title,
        content: page.content,
        url: page.url,
      });
      record(ctx, input, result, doc, page.title, page.url);
    } catch (err) {
      result.errors.push({ source: page.url, error: errorMessage(err) });
    }
    ctx.onProgress?.({ done: result.documents.length + result.errors.length, message: page.url });
    next = await gen.next();
  }
  const stats = next.value;
  result.crawl = {
    pagesCrawled: stats.pagesCrawled,
    pagesSkipped: stats.pagesSkipped,
    ...(stats.abortReason ? { abortReason: stats.abortReason } : {}),
  };
  return result;
}

async function ingestRepo(ctx: IngestContext, input: IngestInput): Promise<IngestResult> {
  const result = emptyResult("repo");
  const url = input.source ?? "";
  if (input.dryRun) return { ...result, planned: [url] };
  const repo = await indexRepository(
    ctx.db,
    ctx.provider,
    {
      url,
      branch: input.branch,
      paths: input.paths,
      extensions: input.extensions?.map((e) => (e.startsWith(".") ? e : `.${e}`)),
      token: input.token,
      library: input.library,
      version: input.version,
      topicId: input.topic,
      // Repository files are library docs unless the caller says otherwise.
      sourceType: input.sourceType ?? "library",
      signal: ctx.signal,
    },
    (message) => ctx.onProgress?.({ done: result.documents.length, message }),
  );
  for (const doc of repo.documents) {
    record(
      ctx,
      input,
      result,
      { id: doc.documentId, chunkCount: doc.chunkCount },
      doc.title,
      `${url}#${doc.path}`,
    );
  }
  for (const error of repo.errors) result.errors.push({ source: url, error });
  if (repo.skipped > 0) {
    result.skipped.push({ source: url, reason: `${repo.skipped} unchanged file(s)` });
  }
  return result;
}

const INGESTERS: Record<
  IngestKind,
  (ctx: IngestContext, input: IngestInput) => Promise<IngestResult>
> = {
  content: ingestContent,
  file: ingestFile,
  directory: ingestDirectory,
  url: ingestUrl,
  repo: ingestRepo,
};

/** Add content, a file, a directory, a URL (optionally crawled) or a repository. */
export async function ingest(ctx: IngestContext, input: IngestInput): Promise<IngestResult> {
  ctx.signal?.throwIfAborted();
  const kind = detectIngestKind(input);
  return INGESTERS[kind](ctx, input);
}
