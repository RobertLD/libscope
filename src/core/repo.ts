import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { FetchError, ValidationError } from "../errors.js";
import { getLogger } from "../logger.js";
import { isPrivateIP } from "./url-fetcher.js";
import { indexDocument } from "./indexing.js";
import { promises as dns } from "node:dns";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RepoOptions {
  url: string;
  branch?: string | undefined;
  paths?: string[] | undefined;
  extensions?: string[] | undefined;
  token?: string | undefined;
}

export interface RepoResult {
  indexed: number;
  skipped: number;
  errors: string[];
}

export interface ParsedRepoUrl {
  host: "github" | "gitlab";
  owner: string;
  repo: string;
  branch?: string | undefined;
  path?: string | undefined;
}

export interface RepoFile {
  path: string;
  content: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_EXTENSIONS = [".md", ".mdx", ".txt", ".rst"];
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const RATE_LIMIT_THRESHOLD = 10;

// ── URL Parsing ──────────────────────────────────────────────────────────────

/**
 * Parse a GitHub or GitLab URL to extract owner, repo, optional branch and path.
 *
 * Supported formats:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/branch
 *   https://github.com/owner/repo/tree/branch/path/to/dir
 *   https://gitlab.com/owner/repo/-/tree/branch/path
 */
export function parseRepoUrl(url: string): ParsedRepoUrl {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();

  let host: "github" | "gitlab";
  if (hostname === "github.com") {
    host = "github";
  } else if (hostname === "gitlab.com") {
    host = "gitlab";
  } else {
    throw new ValidationError(
      `Unsupported repository host: ${hostname}. Use github.com or gitlab.com`,
    );
  }

  const rawPath = parsed.pathname
    .replace(/^\//, "")
    .replace(/\/$/, "")
    .replace(/\.git$/, "");
  const segments = rawPath.split("/").filter(Boolean);

  if (segments.length < 2) {
    throw new ValidationError(`Invalid repository URL: expected at least owner/repo in path`);
  }

  const owner = segments[0]!;
  const repo = segments[1]!;
  let branch: string | undefined;
  let path: string | undefined;

  if (host === "github" && segments.length > 2 && segments[2] === "tree") {
    branch = segments[3];
    if (segments.length > 4) {
      path = segments.slice(4).join("/");
    }
  } else if (host === "gitlab") {
    const dashIdx = segments.indexOf("-");
    if (dashIdx !== -1 && segments[dashIdx + 1] === "tree") {
      branch = segments[dashIdx + 2];
      if (segments.length > dashIdx + 3) {
        path = segments.slice(dashIdx + 3).join("/");
      }
    }
  }

  return { host, owner, repo, branch, path };
}

// ── SSRF Protection ──────────────────────────────────────────────────────────

async function validateHost(hostname: string): Promise<void> {
  const stripped = hostname.replace(/^\[|\]$/g, "");
  const results = await Promise.allSettled([dns.resolve4(stripped), dns.resolve6(stripped)]);

  const addresses: string[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") addresses.push(...r.value);
  }

  if (addresses.length === 0) {
    throw new FetchError(`DNS resolution failed for hostname: ${stripped}`);
  }

  for (const addr of addresses) {
    if (isPrivateIP(addr)) {
      throw new FetchError(
        `Blocked request to private/internal IP ${addr} (resolved from ${stripped})`,
      );
    }
  }
}

// ── HTTP Helpers ─────────────────────────────────────────────────────────────

interface FetchWithRetryOptions {
  url: string;
  token?: string | undefined;
  accept?: string | undefined;
}

/** Build request headers for GitHub/GitLab API calls. */
function buildApiHeaders(
  token: string | undefined,
  accept: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "LibScope/0.1.0 (repository-indexer)",
    Accept: accept ?? "application/vnd.github+json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

/** Handle rate limit headers: back off if approaching the limit. Returns true if should retry (429). */
async function handleRateLimit(response: Response): Promise<boolean> {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const resetHeader = response.headers.get("x-ratelimit-reset");

  const isRateLimited = response.status === 429;
  const isApproaching = remaining !== null && parseInt(remaining, 10) < RATE_LIMIT_THRESHOLD;

  if (!isRateLimited && !isApproaching) return false;

  const resetTime = resetHeader ? parseInt(resetHeader, 10) * 1000 : Date.now() + 60_000;
  const waitMs = Math.max(resetTime - Date.now(), 1000);
  const log = getLogger();
  log.warn({ remaining, waitMs }, "Rate limit approaching, backing off");
  await sleep(Math.min(waitMs, 60_000));

  return isRateLimited;
}

/** Check response status and throw appropriate errors for non-OK responses. */
function checkResponseStatus(response: Response, url: string): void {
  const remaining = response.headers.get("x-ratelimit-remaining");
  if (response.status === 403 && remaining === "0") {
    throw new FetchError("GitHub API rate limit exceeded. Provide a token with --token.");
  }
  if (!response.ok) {
    throw new FetchError(`HTTP ${response.status}: ${response.statusText} for ${url}`);
  }
}

async function fetchWithRetry({ url, token, accept }: FetchWithRetryOptions): Promise<Response> {
  const parsed = new URL(url);
  await validateHost(parsed.hostname);

  const headers = buildApiHeaders(token, accept);
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      const shouldRetry = await handleRateLimit(response);
      if (shouldRetry) continue;

      checkResponseStatus(response, url);
      return response;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (err instanceof FetchError) throw err;
      if (attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_DELAY_MS * Math.pow(2, attempt));
      }
    }
  }

  throw new FetchError(
    `Failed to fetch ${url} after ${MAX_RETRIES} retries: ${lastError?.message ?? "unknown error"}`,
    lastError,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Tree Fetching ────────────────────────────────────────────────────────────

interface GitHubTreeItem {
  path: string;
  type: string;
  size?: number | undefined;
}

interface GitHubTreeResponse {
  tree: GitHubTreeItem[];
  truncated: boolean;
}

/** Determine whether a file should be included based on extension and path filters. */
export function shouldIncludeFile(
  filePath: string,
  extensions: string[],
  pathPrefixes?: string[],
): boolean {
  const dotIdx = filePath.lastIndexOf(".");
  const ext = dotIdx !== -1 ? filePath.slice(dotIdx).toLowerCase() : "";

  if (!extensions.some((e) => ext === e.toLowerCase())) {
    return false;
  }

  if (pathPrefixes && pathPrefixes.length > 0) {
    return pathPrefixes.some((prefix) => filePath.startsWith(prefix));
  }

  return true;
}

/** Fetch repository tree and file contents from the GitHub/GitLab API. */
export async function fetchRepoContents(
  options: RepoOptions,
  onProgress?: (message: string) => void,
): Promise<RepoFile[]> {
  const { host, owner, repo, branch: urlBranch, path: urlPath } = parseRepoUrl(options.url);
  const branch = options.branch ?? urlBranch ?? "main";
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const pathPrefixes = options.paths ?? (urlPath ? [urlPath] : undefined);

  if (host === "gitlab") {
    return fetchGitLabContents(
      owner,
      repo,
      branch,
      extensions,
      pathPrefixes,
      options.token,
      onProgress,
    );
  }

  return fetchGitHubContents(
    owner,
    repo,
    branch,
    extensions,
    pathPrefixes,
    options.token,
    onProgress,
  );
}

async function fetchGitHubContents(
  owner: string,
  repo: string,
  branch: string,
  extensions: string[],
  pathPrefixes: string[] | undefined,
  token: string | undefined,
  onProgress?: (message: string) => void,
): Promise<RepoFile[]> {
  const log = getLogger();

  onProgress?.("Fetching tree...");
  const treeUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const treeResponse = await fetchWithRetry({ url: treeUrl, token });
  const treeData = (await treeResponse.json()) as GitHubTreeResponse;

  if (treeData.truncated) {
    log.warn("Repository tree was truncated by GitHub API; some files may be missing");
  }

  const docFiles = treeData.tree.filter(
    (item) => item.type === "blob" && shouldIncludeFile(item.path, extensions, pathPrefixes),
  );

  onProgress?.(`Found ${docFiles.length} docs`);

  const files: RepoFile[] = [];
  for (let i = 0; i < docFiles.length; i++) {
    const item = docFiles[i]!;
    onProgress?.(`Fetching [${i + 1}/${docFiles.length}] ${item.path}`);

    try {
      const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${item.path}`;
      const contentResponse = await fetchWithRetry({ url: rawUrl, token, accept: "text/plain" });
      const content = await contentResponse.text();
      files.push({ path: item.path, content });
    } catch (err) {
      log.warn({ path: item.path, err }, "Failed to fetch file content, skipping");
    }
  }

  return files;
}

async function fetchGitLabContents(
  owner: string,
  repo: string,
  branch: string,
  extensions: string[],
  pathPrefixes: string[] | undefined,
  token: string | undefined,
  onProgress?: (message: string) => void,
): Promise<RepoFile[]> {
  const log = getLogger();
  const projectId = encodeURIComponent(`${owner}/${repo}`);

  onProgress?.("Fetching tree...");
  const treeUrl = `https://gitlab.com/api/v4/projects/${projectId}/repository/tree?ref=${encodeURIComponent(branch)}&recursive=true&per_page=100`;
  const treeResponse = await fetchWithRetry({ url: treeUrl, token });
  const treeData = (await treeResponse.json()) as Array<{ path: string; type: string }>;

  const docFiles = treeData.filter(
    (item) => item.type === "blob" && shouldIncludeFile(item.path, extensions, pathPrefixes),
  );

  onProgress?.(`Found ${docFiles.length} docs`);

  const files: RepoFile[] = [];
  for (let i = 0; i < docFiles.length; i++) {
    const item = docFiles[i]!;
    onProgress?.(`Fetching [${i + 1}/${docFiles.length}] ${item.path}`);

    try {
      const fileUrl = `https://gitlab.com/api/v4/projects/${projectId}/repository/files/${encodeURIComponent(item.path)}/raw?ref=${encodeURIComponent(branch)}`;
      const contentResponse = await fetchWithRetry({ url: fileUrl, token, accept: "text/plain" });
      const content = await contentResponse.text();
      files.push({ path: item.path, content });
    } catch (err) {
      log.warn({ path: item.path, err }, "Failed to fetch file content, skipping");
    }
  }

  return files;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Index documentation files from a GitHub or GitLab repository.
 *
 * Fetches the repository tree, filters by extensions/paths, downloads each
 * matching file, and indexes it into the database using content-hash dedup.
 */
export async function indexRepository(
  db: Database.Database,
  provider: EmbeddingProvider,
  options: RepoOptions,
  onProgress?: (message: string) => void,
): Promise<RepoResult> {
  const log = getLogger();
  const { owner, repo, branch: urlBranch } = parseRepoUrl(options.url);
  const branch = options.branch ?? urlBranch ?? "main";
  const library = `${owner}/${repo}`;

  log.info({ library, branch }, "Indexing repository");

  const files = await fetchRepoContents(options, onProgress);
  const result: RepoResult = { indexed: 0, skipped: 0, errors: [] };

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    onProgress?.(`Indexing [${i + 1}/${files.length}] ${file.path}`);

    try {
      const fileUrl = `${options.url.replace(/\/$/, "")}#${file.path}`;
      const contentHash = createHash("sha256").update(file.content).digest("hex");

      const existing = db
        .prepare("SELECT id, content_hash FROM documents WHERE url = ?")
        .get(fileUrl) as { id: string; content_hash: string | null } | undefined;

      if (existing?.content_hash === contentHash) {
        result.skipped++;
        continue;
      }

      const title =
        file.path
          .split("/")
          .pop()
          ?.replace(/\.[^.]+$/, "") ?? file.path;

      await indexDocument(db, provider, {
        title,
        content: file.content,
        sourceType: "library",
        library,
        url: fileUrl,
        submittedBy: "crawler",
      });

      result.indexed++;
    } catch (err) {
      const message = `${file.path}: ${err instanceof Error ? err.message : String(err)}`;
      result.errors.push(message);
      log.warn({ path: file.path, err }, "Failed to index file");
    }
  }

  log.info({ library, ...result }, "Repository indexing complete");
  return result;
}
