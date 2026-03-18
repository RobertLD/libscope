import type Database from "better-sqlite3";
import { NodeHtmlMarkdown } from "node-html-markdown";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { getLogger } from "../logger.js";
import { LibScopeError } from "../errors.js";
import { indexDocument } from "../core/indexing.js";
import { deleteDocument } from "../core/documents.js";
import { createTopic, listTopics } from "../core/topics.js";
import { loadConnectorConfig, saveConnectorConfig } from "./index.js";
import { startSync, completeSync, failSync } from "./sync-tracker.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OneNoteConfig {
  clientId: string;
  tenantId: string;
  accessToken?: string | undefined;
  refreshToken?: string | undefined;
  tokenExpiry?: string | undefined;
  lastSync?: string | undefined;
  notebooks: string[];
  excludeSections: string[];
}

export interface OneNoteSyncResult {
  notebooks: number;
  sections: number;
  pagesAdded: number;
  pagesUpdated: number;
  pagesDeleted: number;
  errors: Array<{ page: string; error: string }>;
}

interface GraphNotebook {
  id: string;
  displayName: string;
}

interface GraphSection {
  id: string;
  displayName: string;
}

interface GraphPage {
  id: string;
  title: string;
  lastModifiedDateTime: string;
}

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const MAX_REQUESTS_PER_MINUTE = 50;

let requestTimestamps: number[] = [];
let rateLimitLock: Promise<void> = Promise.resolve();

async function rateLimitedFetch(url: string, options: RequestInit): Promise<Response> {
  // Serialize rate-limit checks to prevent concurrent async contexts from
  // exceeding the budget. Each call awaits the previous one's gate.
  let unlock: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const prev = rateLimitLock;
  rateLimitLock = gate;
  await prev;

  const log = getLogger();
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter((t) => now - t < 60_000);
  if (requestTimestamps.length >= MAX_REQUESTS_PER_MINUTE) {
    const waitMs = 60_000 - (now - (requestTimestamps[0] ?? now));
    log.debug({ waitMs }, "Rate limit reached, waiting");
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  unlock!();

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    requestTimestamps.push(Date.now());
    const timeoutSignal = AbortSignal.timeout(30_000);
    const combinedSignal =
      options?.signal != null ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(url, { ...options, signal: combinedSignal });

    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN;
      const delayMs = Number.isNaN(parsed) ? Math.pow(2, attempt) * 1000 : parsed * 1000;
      log.warn({ attempt, delayMs }, "Rate limited (429), backing off");
      lastError = new LibScopeError(
        `Rate limited by Graph API (attempt ${attempt + 1})`,
        "ONENOTE_RATE_LIMITED",
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    return response;
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new LibScopeError("Rate limit retries exhausted", "ONENOTE_RATE_LIMITED");
}

// ---------------------------------------------------------------------------
// Graph API helpers
// ---------------------------------------------------------------------------

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

function graphHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

async function graphGet<T>(token: string, path: string): Promise<T> {
  const url = `${GRAPH_BASE}${path}`;
  const res = await rateLimitedFetch(url, { headers: graphHeaders(token) });

  if (!res.ok) {
    const body = await res.text();
    throw new LibScopeError(`Graph API error ${res.status}: ${body}`, "ONENOTE_API_ERROR");
  }

  return (await res.json()) as T;
}

async function graphGetHtml(token: string, path: string): Promise<string> {
  const url = `${GRAPH_BASE}${path}`;
  const res = await rateLimitedFetch(url, {
    headers: { ...graphHeaders(token), Accept: "text/html" },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new LibScopeError(`Graph API error ${res.status}: ${body}`, "ONENOTE_API_ERROR");
  }

  return res.text();
}

interface GraphListResponse<T> {
  value: T[];
}

async function listNotebooks(token: string): Promise<GraphNotebook[]> {
  const data = await graphGet<GraphListResponse<GraphNotebook>>(token, "/me/onenote/notebooks");
  return data.value;
}

async function listSections(token: string, notebookId: string): Promise<GraphSection[]> {
  const data = await graphGet<GraphListResponse<GraphSection>>(
    token,
    `/me/onenote/notebooks/${notebookId}/sections`,
  );
  return data.value;
}

async function listPages(token: string, sectionId: string): Promise<GraphPage[]> {
  const data = await graphGet<GraphListResponse<GraphPage>>(
    token,
    `/me/onenote/sections/${sectionId}/pages`,
  );
  return data.value;
}

async function getPageContent(token: string, pageId: string): Promise<string> {
  return graphGetHtml(token, `/me/onenote/pages/${pageId}/content`);
}

// ---------------------------------------------------------------------------
// HTML → Markdown conversion
// ---------------------------------------------------------------------------

export function convertOneNoteHtml(html: string): string {
  let processed = html;

  // Remove style attributes
  processed = processed.replace(/ style="[^"]*"/gi, "");

  // Remove OneNote metadata divs
  processed = processed.replace(/<div[^>]*data-id="[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "");

  // cite → blockquote
  processed = processed.replace(/<cite>([\s\S]*?)<\/cite>/gi, "<blockquote>$1</blockquote>");

  // Completed checkboxes — replace with plain text marker before nhm
  processed = processed.replace(
    /<p[^>]*data-tag="to-do:completed"[^>]*>([\s\S]*?)<\/p>/gi,
    "CHECKDONE7X9Z $1\n",
  );

  // Uncompleted checkboxes
  processed = processed.replace(
    /<p[^>]*data-tag="to-do"[^>]*>([\s\S]*?)<\/p>/gi,
    "CHECKTODO7X9Z $1\n",
  );

  // Ink annotations → placeholder token
  processed = processed.replace(
    /<div[^>]*class="[^"]*InkNode[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
    "INKPLACEHOLDER7X9Z",
  );
  processed = processed.replace(/<ink[^>]*>[\s\S]*?<\/ink>/gi, "INKPLACEHOLDER7X9Z");

  // Embedded images → placeholder token
  processed = processed.replace(/<img[^>]*>/gi, "IMGPLACEHOLDER7X9Z");

  // Embedded files → [attached: filename] token
  processed = processed.replace(
    /<object[^>]*data-attachment="([^"]*)"[^>]*>[\s\S]*?<\/object>/gi,
    "FILEATTACH7X9Z$1ENDATTACH7X9Z",
  );

  const nhm = new NodeHtmlMarkdown();
  let md = nhm.translate(processed).trim();

  // Post-process: replace tokens with final markdown
  md = md.replace(/CHECKDONE7X9Z\s*/g, "- [x] ");
  md = md.replace(/CHECKTODO7X9Z\s*/g, "- [ ] ");
  md = md.replace(/INKPLACEHOLDER7X9Z/g, "[handwritten content]");
  md = md.replace(/IMGPLACEHOLDER7X9Z/g, "[image]");
  md = md.replace(/FILEATTACH7X9Z([^\s]+?)ENDATTACH7X9Z/g, "[attached: $1]");

  return md;
}

// ---------------------------------------------------------------------------
// Auth: Device Code Flow
// ---------------------------------------------------------------------------

export async function authenticateDeviceCode(
  clientId: string,
  tenantId?: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}> {
  const tenant = tenantId ?? "common";
  const deviceCodeUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/devicecode`;
  const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  const scope = "Notes.Read Notes.Read.All offline_access";

  const dcRes = await fetch(deviceCodeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!dcRes.ok) {
    const text = await dcRes.text();
    throw new LibScopeError(`Device code request failed: ${text}`, "ONENOTE_AUTH_ERROR");
  }

  const dcJson: unknown = await dcRes.json();
  if (
    dcJson == null ||
    typeof dcJson !== "object" ||
    typeof (dcJson as Record<string, unknown>)["device_code"] !== "string" ||
    typeof (dcJson as Record<string, unknown>)["user_code"] !== "string" ||
    typeof (dcJson as Record<string, unknown>)["verification_uri"] !== "string"
  ) {
    throw new LibScopeError(
      "Invalid device code response: missing device_code, user_code, or verification_uri",
      "ONENOTE_AUTH_ERROR",
    );
  }
  const dcData = dcJson as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };

  console.log(`\nTo sign in, open: ${dcData.verification_uri}`);
  console.log(`Enter code: ${dcData.user_code}\n`);

  const interval = (dcData.interval ?? 5) * 1000;
  const deadline = Date.now() + dcData.expires_in * 1000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));

    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: dcData.device_code,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (tokenRes.ok) {
      const tokenData = (await tokenRes.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };
      const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
      return {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt,
      };
    }

    const errData = (await tokenRes.json()) as { error: string };
    if (errData.error === "authorization_pending") {
      continue;
    }
    if (errData.error === "slow_down") {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }
    throw new LibScopeError(`Authentication failed: ${errData.error}`, "ONENOTE_AUTH_ERROR");
  }

  throw new LibScopeError("Device code authentication timed out", "ONENOTE_AUTH_ERROR");
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

export async function refreshAccessToken(
  clientId: string,
  refreshToken: string,
  tenantId?: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}> {
  const tenant = tenantId ?? "common";
  const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
      scope: "Notes.Read Notes.Read.All offline_access",
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new LibScopeError(`Token refresh failed: ${text}`, "ONENOTE_AUTH_ERROR");
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

function ensureOrCreateTopic(db: Database.Database, name: string, parentId?: string): string {
  const existing = listTopics(db, parentId).find((t) => t.name === name);
  if (existing) {
    return existing.id;
  }
  const topic = createTopic(db, { name, parentId });
  return topic.id;
}

function buildSourceUrl(notebook: string, section: string, pageTitle: string): string {
  return `onenote://${notebook}/${section}/${pageTitle}`;
}

/** Index a single OneNote page. Returns "added", "updated", or "skipped". */
async function indexOneNotePage(
  db: Database.Database,
  provider: EmbeddingProvider,
  token: string,
  page: GraphPage,
  sourceUrl: string,
  sectionTopicId: string,
  lastSync: string | undefined,
): Promise<"added" | "updated" | "skipped"> {
  if (lastSync && page.lastModifiedDateTime <= lastSync) {
    return "skipped";
  }

  const html = await getPageContent(token, page.id);
  const markdown = convertOneNoteHtml(html);

  const existing = db.prepare("SELECT id FROM documents WHERE url = ?").get(sourceUrl) as
    | { id: string }
    | undefined;

  let outcome: "added" | "updated";
  if (existing) {
    deleteDocument(db, existing.id);
    outcome = "updated";
  } else {
    outcome = "added";
  }

  await indexDocument(db, provider, {
    title: page.title,
    content: markdown,
    sourceType: "topic",
    topicId: sectionTopicId,
    url: sourceUrl,
    submittedBy: "crawler",
  });

  return outcome;
}

/** Sync all pages within a single section. */
async function syncOneNoteSection(
  db: Database.Database,
  provider: EmbeddingProvider,
  token: string,
  notebookName: string,
  section: GraphSection,
  notebookTopicId: string,
  config: OneNoteConfig,
  seenSourceUrls: Set<string>,
  result: OneNoteSyncResult,
): Promise<void> {
  const log = getLogger();
  const sectionTopicId = ensureOrCreateTopic(db, section.displayName, notebookTopicId);

  let pages: GraphPage[];
  try {
    pages = await listPages(token, section.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push({
      page: `${notebookName}/${section.displayName}/*`,
      error: msg,
    });
    return;
  }

  for (const page of pages) {
    const sourceUrl = buildSourceUrl(notebookName, section.displayName, page.title);
    seenSourceUrls.add(sourceUrl);

    try {
      const outcome = await indexOneNotePage(
        db,
        provider,
        token,
        page,
        sourceUrl,
        sectionTopicId,
        config.lastSync,
      );
      if (outcome === "added") result.pagesAdded++;
      if (outcome === "updated") result.pagesUpdated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ page: page.title, err }, "Failed to sync page");
      result.errors.push({ page: page.title, error: msg });
    }
  }
}

/** Sync all sections within a single notebook. */
async function syncOneNoteNotebook(
  db: Database.Database,
  provider: EmbeddingProvider,
  token: string,
  notebook: GraphNotebook,
  config: OneNoteConfig,
  seenSourceUrls: Set<string>,
  result: OneNoteSyncResult,
): Promise<void> {
  const notebookTopicId = ensureOrCreateTopic(db, notebook.displayName);

  let sections: GraphSection[];
  try {
    sections = await listSections(token, notebook.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push({ page: `${notebook.displayName}/*`, error: msg });
    return;
  }

  const filteredSections = sections.filter((s) => !config.excludeSections.includes(s.displayName));
  result.sections += filteredSections.length;

  for (const section of filteredSections) {
    await syncOneNoteSection(
      db,
      provider,
      token,
      notebook.displayName,
      section,
      notebookTopicId,
      config,
      seenSourceUrls,
      result,
    );
  }
}

/** Delete OneNote documents whose source URLs were not seen during sync. */
function deleteStaleOneNoteDocs(db: Database.Database, seenSourceUrls: Set<string>): number {
  const existingDocs = db
    .prepare("SELECT id, url FROM documents WHERE url LIKE 'onenote://%'")
    .all() as Array<{ id: string; url: string }>;

  let deleted = 0;
  for (const doc of existingDocs) {
    if (seenSourceUrls.has(doc.url)) continue;
    deleteDocument(db, doc.id);
    deleted++;
  }
  return deleted;
}

export async function syncOneNote(
  db: Database.Database,
  provider: EmbeddingProvider,
  config: OneNoteConfig,
): Promise<OneNoteSyncResult> {
  const log = getLogger();
  const token = config.accessToken;
  if (!token) {
    throw new LibScopeError("No access token provided", "ONENOTE_AUTH_ERROR");
  }

  const syncId = startSync(db, "onenote", "onenote");

  try {
    const result: OneNoteSyncResult = {
      notebooks: 0,
      sections: 0,
      pagesAdded: 0,
      pagesUpdated: 0,
      pagesDeleted: 0,
      errors: [],
    };

    log.info("Starting OneNote sync");

    const allNotebooks = await listNotebooks(token);
    const targetNotebooks =
      config.notebooks.length === 1 && config.notebooks[0] === "all"
        ? allNotebooks
        : allNotebooks.filter((nb) => config.notebooks.includes(nb.displayName));

    result.notebooks = targetNotebooks.length;
    const seenSourceUrls = new Set<string>();

    for (const notebook of targetNotebooks) {
      await syncOneNoteNotebook(db, provider, token, notebook, config, seenSourceUrls, result);
    }

    result.pagesDeleted = deleteStaleOneNoteDocs(db, seenSourceUrls);

    const connConfig = loadConnectorConfig();
    const onenoteConf = (connConfig.onenote ?? {}) as Record<string, unknown>;
    onenoteConf.lastSync = new Date().toISOString();
    connConfig.onenote = onenoteConf;
    saveConnectorConfig(connConfig);

    log.info(
      {
        notebooks: result.notebooks,
        sections: result.sections,
        pagesAdded: result.pagesAdded,
        pagesUpdated: result.pagesUpdated,
        pagesDeleted: result.pagesDeleted,
        errors: result.errors.length,
      },
      "OneNote sync complete",
    );

    completeSync(db, syncId, {
      added: result.pagesAdded,
      updated: result.pagesUpdated,
      deleted: result.pagesDeleted,
      errored: result.errors.length,
    });

    return result;
  } catch (err) {
    failSync(db, syncId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------

export function disconnectOneNote(db: Database.Database): number {
  const docs = db.prepare("SELECT id FROM documents WHERE url LIKE 'onenote://%'").all() as Array<{
    id: string;
  }>;

  for (const doc of docs) {
    deleteDocument(db, doc.id);
  }

  // Remove connector config
  const connConfig = loadConnectorConfig();
  delete connConfig.onenote;
  saveConnectorConfig(connConfig);

  return docs.length;
}

// Reset rate limiter timestamps (for testing)
export function _resetRateLimiter(): void {
  requestTimestamps = [];
}
