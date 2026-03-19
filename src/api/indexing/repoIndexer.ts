import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { LibScopeLite } from "../../lite/core.js";
import { TreeSitterChunker } from "../../lite/chunker-treesitter.js";
import type { LiteDoc } from "../../lite/types.js";
import type { RepoEntry } from "./repoConfig.js";

const chunker = new TreeSitterChunker();

/**
 * Absolute path to the git executable, resolved once at module load time.
 * Using an absolute path means the OS never consults PATH, eliminating the
 * risk of a tampered environment redirecting "git" to a malicious binary.
 */
const GIT_EXECUTABLE = ((): string => {
  const candidates = ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("git executable not found at any known path");
})();

export interface IndexJobStats {
  filesIndexed: number;
  chunksCreated: number;
  filesSkipped: number;
  errors: string[];
  durationMs: number;
}

/** Map file extension to language string understood by TreeSitterChunker. */
function detectLanguage(filePath: string): string | undefined {
  const ext = extname(filePath).toLowerCase().replace(/^\./, "");
  const EXTENSION_MAP: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    cs: "csharp",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    h: "cpp",
    c: "c",
    go: "go",
  };
  return EXTENSION_MAP[ext];
}

/** Convert a glob-style pattern to a RegExp. Handles ** and * wildcards. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`)
    .replaceAll("**", "§DOUBLESTAR§")
    .replaceAll("*", "[^/]*")
    .replaceAll("§DOUBLESTAR§", ".*");
  return new RegExp(`^${escaped}$`);
}

/** Recursively list all files under dir, returning paths relative to dir. */
function walkFiles(dir: string, include?: string[], exclude?: string[]): string[] {
  const includeRegexes = include?.map(globToRegex);
  const excludeRegexes = exclude?.map(globToRegex);
  const results: string[] = [];

  function recurse(current: string): void {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      const rel = relative(dir, full);
      if (entry.isDirectory()) {
        // Skip hidden directories
        if (entry.name.startsWith(".")) continue;
        recurse(full);
      } else if (entry.isFile()) {
        if (excludeRegexes?.some((rx) => rx.test(rel))) continue;
        if (includeRegexes && !includeRegexes.some((rx) => rx.test(rel))) continue;
        results.push(rel);
      }
    }
  }

  recurse(dir);
  return results;
}

/**
 * Validate a git branch name against the git-check-ref-format allowlist.
 * Rejects anything outside [a-zA-Z0-9._\-/] to prevent argument injection.
 */
function validateBranchName(branch: string): void {
  if (!/^[a-zA-Z0-9._\-/]+$/.test(branch)) {
    throw new Error(
      `Invalid branch name "${branch}": only alphanumerics, '.', '_', '-', and '/' are allowed`,
    );
  }
}

/** Clone a repo at branch into a temp directory. Returns the temp dir path. */
function cloneToTemp(cloneUrl: string, branch?: string): string {
  const tempDir = join(tmpdir(), `libscope-repo-${randomUUID()}`);
  const args = ["clone", "--depth=1"];
  if (branch) {
    validateBranchName(branch);
    args.push("--branch", branch);
  }
  // Use the absolute path resolved at startup — PATH is never consulted.
  // execFileSync with an array bypasses the shell entirely.
  // The "--" separator prevents git from interpreting the URL as a flag.
  args.push("--", cloneUrl, tempDir);
  execFileSync(GIT_EXECUTABLE, args, { stdio: "ignore" });
  return tempDir;
}

/** Chunk a source file with tree-sitter and append resulting LiteDocs. */
async function chunkAndIndex(
  relPath: string,
  source: string,
  lang: string,
  repoSlug: string,
  allDocs: LiteDoc[],
  stats: IndexJobStats,
): Promise<void> {
  try {
    const chunks = await chunker.chunk(source, lang);
    for (const chunk of chunks) {
      allDocs.push({
        title: `${relPath}:L${String(chunk.startLine)}-L${String(chunk.endLine)} [${chunk.nodeType}]`,
        content: chunk.content,
        library: repoSlug,
        url: `repo://${repoSlug}/${relPath}#L${String(chunk.startLine)}`,
      });
      stats.chunksCreated++;
    }
    stats.filesIndexed++;
  } catch (err) {
    stats.errors.push(`${relPath} (chunking): ${err instanceof Error ? err.message : String(err)}`);
    stats.filesSkipped++;
  }
}

/** Read one file from the cloned repo and append its docs to allDocs. */
async function processFile(
  relPath: string,
  tempDir: string,
  repoSlug: string,
  allDocs: LiteDoc[],
  stats: IndexJobStats,
): Promise<void> {
  const fullPath = join(tempDir, relPath);
  let source: string;
  try {
    const stat = statSync(fullPath);
    if (!stat.isFile()) {
      stats.filesSkipped++;
      return;
    }
    source = readFileSync(fullPath, "utf8");
  } catch (err) {
    stats.filesSkipped++;
    stats.errors.push(`${relPath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const lang = detectLanguage(relPath);
  if (lang && chunker.supports(lang)) {
    await chunkAndIndex(relPath, source, lang, repoSlug, allDocs, stats);
  } else {
    // Non-code file or unsupported language — index as raw text
    allDocs.push({
      title: relPath,
      content: source,
      library: repoSlug,
      url: `repo://${repoSlug}/${relPath}`,
    });
    stats.chunksCreated++;
    stats.filesIndexed++;
  }
}

export async function indexRepo(
  libscope: LibScopeLite,
  repoSlug: string,
  entry: RepoEntry,
  opts: { branch?: string; files?: string[] },
): Promise<IndexJobStats> {
  const start = Date.now();
  const stats: IndexJobStats = {
    filesIndexed: 0,
    chunksCreated: 0,
    filesSkipped: 0,
    errors: [],
    durationMs: 0,
  };

  const branch = opts.branch ?? entry.branch;
  const tempDir = cloneToTemp(entry.cloneUrl, branch);

  try {
    const isIncremental = opts.files !== undefined && opts.files.length > 0;
    if (!isIncremental) {
      libscope.deleteByLibrary(repoSlug);
    }

    const filesToIndex = isIncremental
      ? opts.files!
      : walkFiles(tempDir, entry.include, entry.exclude);

    const allDocs: LiteDoc[] = [];
    for (const relPath of filesToIndex) {
      await processFile(relPath, tempDir, repoSlug, allDocs, stats);
    }

    await libscope.indexBatch(allDocs, { concurrency: 4 });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    stats.durationMs = Date.now() - start;
  }

  return stats;
}
