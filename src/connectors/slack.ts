import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { indexDocument } from "../core/indexing.js";
import { getLogger } from "../logger.js";
import { LibScopeError, ValidationError } from "../errors.js";
import { fetchWithRetry } from "./http-utils.js";
import { startSync, completeSync, failSync } from "./sync-tracker.js";

export interface SlackConfig {
  token: string;
  channels: string[];
  lastSync?: string | undefined;
  excludeChannels?: string[] | undefined;
  threadMode: "aggregate" | "separate";
}

export interface SlackSyncResult {
  channels: number;
  messagesIndexed: number;
  threadsIndexed: number;
  errors: Array<{ channel: string; error: string }>;
}

interface SlackChannel {
  id: string;
  name: string;
}

interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  thread_ts?: string;
  reply_count?: number;
  subtype?: string;
}

interface SlackUser {
  id: string;
  real_name?: string;
  name: string;
  profile?: { display_name?: string };
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  channels?: SlackChannel[];
  messages?: SlackMessage[];
  members?: SlackUser[];
  user?: SlackUser;
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

const SLACK_BASE_URL = "https://slack.com/api";
let rateLimitDelayMs = 1200;

/** Override rate limit delay (for testing). */
export function _setRateLimitDelay(ms: number): void {
  rateLimitDelayMs = ms;
}

const userCache = new Map<string, string>();

/** Clear the user resolution cache (for testing). */
export function _clearUserCache(): void {
  userCache.clear();
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function slackApi(
  method: string,
  token: string,
  params: Record<string, string> = {},
): Promise<SlackApiResponse> {
  const url = new URL(`${SLACK_BASE_URL}/${method}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetchWithRetry(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new LibScopeError(
      `Slack API HTTP error: ${response.status} ${response.statusText}`,
      "SLACK_API_ERROR",
    );
  }

  const data = (await response.json()) as SlackApiResponse;
  if (!data.ok) {
    throw new LibScopeError(`Slack API error: ${data.error ?? "unknown"}`, "SLACK_API_ERROR");
  }

  return data;
}

async function resolveUser(token: string, userId: string): Promise<string> {
  const cached = userCache.get(userId);
  if (cached) return cached;

  try {
    const data = await slackApi("users.info", token, { user: userId });
    await delay(rateLimitDelayMs);

    const user = data.user;
    const displayName = user?.profile?.display_name ?? user?.real_name ?? user?.name ?? userId;
    userCache.set(userId, displayName);
    return displayName;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const authErrors = ["invalid_auth", "token_revoked", "not_authed"];
    if (authErrors.some((e) => message.includes(e))) {
      throw err;
    }
    userCache.set(userId, userId);
    return userId;
  }
}

export function convertSlackMrkdwn(text: string): string {
  let result = text;

  // Preserve code blocks — replace with placeholders
  const codeBlocks: string[] = [];
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `__CODEBLOCK_${String(codeBlocks.length - 1)}__`;
  });

  const inlineCodes: string[] = [];
  result = result.replace(/`[^`]+`/g, (match) => {
    inlineCodes.push(match);
    return `__INLINECODE_${String(inlineCodes.length - 1)}__`;
  });

  // Channel links: <#C1234|channel> → #channel
  result = result.replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1");

  // URL links: <url|text> → [text](url)
  result = result.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)");

  // Plain URLs: <url> → url
  result = result.replace(/<(https?:\/\/[^>]+)>/g, "$1");

  // Bold: *text* → **text** (but not inside words)
  result = result.replace(/(^|[\s(])\*([^*\n]+)\*([\s).,!?]|$)/g, "$1**$2**$3");

  // Italic: _text_ → *text*
  result = result.replace(/(^|[\s(])_([^_\n]+)_([\s).,!?]|$)/g, "$1*$2*$3");

  // Strikethrough: ~text~ → ~~text~~
  result = result.replace(/(^|[\s(])~([^~\n]+)~([\s).,!?]|$)/g, "$1~~$2~~$3");

  // Restore code blocks
  result = result.replace(
    /__CODEBLOCK_(\d+)__/g,
    (_match, idx: string) => codeBlocks[Number(idx)] ?? "",
  );
  result = result.replace(
    /__INLINECODE_(\d+)__/g,
    (_match, idx: string) => inlineCodes[Number(idx)] ?? "",
  );

  return result;
}

export async function resolveUserMentions(text: string, token: string): Promise<string> {
  const mentionRegex = /<@(U[A-Z0-9]+)>/g;
  const mentions = [...text.matchAll(mentionRegex)];
  let result = text;

  for (const match of mentions) {
    const userId = match[1];
    if (userId) {
      const displayName = await resolveUser(token, userId);
      result = result.replace(match[0], `@${displayName}`);
    }
  }

  return result;
}

async function listChannels(token: string): Promise<SlackChannel[]> {
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;

  do {
    const params: Record<string, string> = {
      types: "public_channel,private_channel",
      limit: "200",
    };
    if (cursor) params["cursor"] = cursor;

    const data = await slackApi("conversations.list", token, params);
    await delay(rateLimitDelayMs);

    if (data.channels) {
      channels.push(...data.channels);
    }
    cursor = data.response_metadata?.next_cursor ?? undefined;
  } while (cursor);

  return channels;
}

function filterChannels(
  allChannels: SlackChannel[],
  include: string[],
  exclude: string[] = [],
): SlackChannel[] {
  const excludeSet = new Set(exclude.map((c) => c.toLowerCase()));
  let filtered: SlackChannel[];

  if (include.length === 1 && include[0] === "all") {
    filtered = allChannels;
  } else {
    const includeSet = new Set(include.map((c) => c.toLowerCase()));
    filtered = allChannels.filter(
      (ch) => includeSet.has(ch.name.toLowerCase()) || includeSet.has(ch.id),
    );
  }

  return filtered.filter((ch) => !excludeSet.has(ch.name.toLowerCase()) && !excludeSet.has(ch.id));
}

async function fetchMessages(
  token: string,
  channelId: string,
  oldest?: string,
): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;

  do {
    const params: Record<string, string> = {
      channel: channelId,
      limit: "200",
    };
    if (oldest) params["oldest"] = oldest;
    if (cursor) params["cursor"] = cursor;

    const data = await slackApi("conversations.history", token, params);
    await delay(rateLimitDelayMs);

    if (data.messages) {
      messages.push(...data.messages);
    }
    cursor = data.response_metadata?.next_cursor ?? undefined;
  } while (cursor);

  return messages;
}

async function fetchThreadReplies(
  token: string,
  channelId: string,
  threadTs: string,
): Promise<SlackMessage[]> {
  const params: Record<string, string> = {
    channel: channelId,
    ts: threadTs,
    limit: "200",
  };

  const data = await slackApi("conversations.replies", token, params);
  await delay(rateLimitDelayMs);

  return data.messages ?? [];
}

function formatTimestamp(ts: string): string {
  if (typeof ts !== "string" || ts.length === 0) {
    return new Date(0).toISOString();
  }

  const [secondsPart] = ts.split(".");
  const seconds = Number(secondsPart);
  if (Number.isNaN(seconds)) {
    return new Date(0).toISOString();
  }
  return new Date(seconds * 1000).toISOString();
}

function truncateTitle(text: string, maxLen: number = 80): string {
  const cleaned = text.replaceAll(/\n/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 3) + "...";
}

async function buildThreadDocument(
  token: string,
  channelName: string,
  replies: SlackMessage[],
): Promise<string> {
  const lines: string[] = [];
  for (const reply of replies) {
    const username = reply.user ? await resolveUser(token, reply.user) : "unknown";
    const timestamp = formatTimestamp(reply.ts);
    const text = reply.text ? convertSlackMrkdwn(await resolveUserMentions(reply.text, token)) : "";
    lines.push(`**${username}** (${timestamp}):\n${text}`);
  }
  return `# Thread in #${channelName}\n\n${lines.join("\n\n---\n\n")}`;
}

/** Collect user IDs from a message's user field and @-mentions in text. */
function collectUserIds(messages: SlackMessage[], out: Set<string>): void {
  for (const msg of messages) {
    if (msg.user) out.add(msg.user);
    if (!msg.text) continue;
    for (const match of msg.text.matchAll(/<@(U[A-Z0-9]+)>/g)) {
      if (match[1]) out.add(match[1]);
    }
  }
}

/** Fetch all thread replies for a list of thread parents and collect user IDs. */
async function fetchAllThreadReplies(
  token: string,
  channelId: string,
  threadParents: SlackMessage[],
  userIds: Set<string>,
): Promise<Map<string, SlackMessage[]>> {
  const threadRepliesMap = new Map<string, SlackMessage[]>();
  for (const threadParent of threadParents) {
    const replies = await fetchThreadReplies(token, channelId, threadParent.ts);
    threadRepliesMap.set(threadParent.ts, replies);
    collectUserIds(replies, userIds);
  }
  return threadRepliesMap;
}

/** Batch-resolve all user IDs that are not already cached. */
async function batchResolveUsers(token: string, userIds: Set<string>): Promise<void> {
  for (const userId of userIds) {
    if (!userCache.has(userId)) {
      await resolveUser(token, userId);
    }
  }
}

/** Index a single standalone message. Returns true if indexed. */
async function indexStandaloneMessage(
  db: Database.Database,
  provider: EmbeddingProvider,
  token: string,
  channelName: string,
  msg: SlackMessage,
): Promise<boolean> {
  if (!msg.text) return false;

  const username = msg.user ? await resolveUser(token, msg.user) : "unknown";
  const text = convertSlackMrkdwn(await resolveUserMentions(msg.text, token));
  const title = `#${channelName} — ${username}: ${truncateTitle(msg.text)}`;

  await indexDocument(db, provider, {
    title,
    content: `**${username}** (${formatTimestamp(msg.ts)}):\n${text}`,
    sourceType: "manual",
    url: `slack://${channelName}/${msg.ts}`,
    submittedBy: "crawler",
  });
  return true;
}

/** Index threads in aggregate mode: one document per thread. */
async function indexThreadsAggregate(
  db: Database.Database,
  provider: EmbeddingProvider,
  token: string,
  channelName: string,
  threadParents: SlackMessage[],
  threadRepliesMap: Map<string, SlackMessage[]>,
): Promise<number> {
  let threadsIndexed = 0;
  for (const threadParent of threadParents) {
    const replies = threadRepliesMap.get(threadParent.ts) ?? [];
    const content = await buildThreadDocument(token, channelName, replies);
    const parentText = threadParent.text ?? "";
    const title = `#${channelName} thread: ${truncateTitle(parentText)}`;

    await indexDocument(db, provider, {
      title,
      content,
      sourceType: "manual",
      url: `slack://${channelName}/thread/${threadParent.ts}`,
      submittedBy: "crawler",
    });
    threadsIndexed++;
  }
  return threadsIndexed;
}

/** Index threads in separate mode: one document per reply. Returns [messagesIndexed, threadsIndexed]. */
async function indexThreadsSeparate(
  db: Database.Database,
  provider: EmbeddingProvider,
  token: string,
  channelName: string,
  threadParents: SlackMessage[],
  threadRepliesMap: Map<string, SlackMessage[]>,
): Promise<[number, number]> {
  let messagesIndexed = 0;
  let threadsIndexed = 0;
  for (const threadParent of threadParents) {
    const replies = threadRepliesMap.get(threadParent.ts) ?? [];
    for (const reply of replies) {
      if (!reply.text) continue;

      const username = reply.user ? await resolveUser(token, reply.user) : "unknown";
      const text = convertSlackMrkdwn(await resolveUserMentions(reply.text, token));
      const title = `#${channelName} thread reply — ${username}: ${truncateTitle(reply.text)}`;

      await indexDocument(db, provider, {
        title,
        content: `**${username}** (${formatTimestamp(reply.ts)}):\n${text}`,
        sourceType: "manual",
        url: `slack://${channelName}/thread/${threadParent.ts}/${reply.ts}`,
        submittedBy: "crawler",
      });
      messagesIndexed++;
    }
    threadsIndexed++;
  }
  return [messagesIndexed, threadsIndexed];
}

/** Classify messages into thread parents and standalone messages. */
function classifyMessages(messages: SlackMessage[]): {
  threadParents: SlackMessage[];
  standaloneMessages: SlackMessage[];
} {
  const threadParents = messages.filter(
    (m) => m.reply_count != null && m.reply_count > 0 && !m.subtype,
  );
  const standaloneMessages = messages.filter(
    (m) => (m.reply_count == null || m.reply_count === 0) && !m.thread_ts && !m.subtype,
  );
  return { threadParents, standaloneMessages };
}

/** Process a single channel: fetch messages, resolve users, and index documents. */
async function syncChannel(
  db: Database.Database,
  provider: EmbeddingProvider,
  config: SlackConfig,
  channel: SlackChannel,
  result: SlackSyncResult,
): Promise<void> {
  const oldest = config.lastSync ?? undefined;
  const messages = await fetchMessages(config.token, channel.id, oldest);

  const { threadParents, standaloneMessages } = classifyMessages(messages);

  const allUserIds = new Set<string>();
  collectUserIds([...standaloneMessages, ...threadParents], allUserIds);

  const threadRepliesMap = await fetchAllThreadReplies(
    config.token,
    channel.id,
    threadParents,
    allUserIds,
  );

  await batchResolveUsers(config.token, allUserIds);

  for (const msg of standaloneMessages) {
    const indexed = await indexStandaloneMessage(db, provider, config.token, channel.name, msg);
    if (indexed) result.messagesIndexed++;
  }

  if (config.threadMode === "aggregate") {
    result.threadsIndexed += await indexThreadsAggregate(
      db,
      provider,
      config.token,
      channel.name,
      threadParents,
      threadRepliesMap,
    );
  } else {
    const [msgs, threads] = await indexThreadsSeparate(
      db,
      provider,
      config.token,
      channel.name,
      threadParents,
      threadRepliesMap,
    );
    result.messagesIndexed += msgs;
    result.threadsIndexed += threads;
  }
}

export async function syncSlack(
  db: Database.Database,
  provider: EmbeddingProvider,
  config: SlackConfig,
): Promise<SlackSyncResult> {
  const log = getLogger();

  if (!config.token) {
    throw new ValidationError("Slack token is required");
  }
  if (!config.channels || config.channels.length === 0) {
    throw new ValidationError("At least one channel must be specified");
  }

  const syncId = startSync(db, "slack", "slack");

  try {
    userCache.clear();

    const result: SlackSyncResult = {
      channels: 0,
      messagesIndexed: 0,
      threadsIndexed: 0,
      errors: [],
    };

    log.info("Fetching Slack channel list");
    const allChannels = await listChannels(config.token);
    const channels = filterChannels(allChannels, config.channels, config.excludeChannels);
    result.channels = channels.length;

    log.info({ channelCount: channels.length }, "Processing Slack channels");

    for (const channel of channels) {
      try {
        log.info({ channel: channel.name }, "Syncing channel");
        await syncChannel(db, provider, config, channel, result);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error({ channel: channel.name, err }, "Error syncing Slack channel");
        result.errors.push({ channel: channel.name, error: errMsg });
      }
    }

    log.info(
      {
        channels: result.channels,
        messages: result.messagesIndexed,
        threads: result.threadsIndexed,
      },
      "Slack sync complete",
    );

    completeSync(db, syncId, {
      added: result.messagesIndexed + result.threadsIndexed,
      updated: 0,
      deleted: 0,
      errored: result.errors.length,
    });

    return result;
  } catch (err) {
    failSync(db, syncId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export function disconnectSlack(db: Database.Database): number {
  const rows = db.prepare("SELECT id FROM documents WHERE url LIKE 'slack://%'").all() as Array<{
    id: string;
  }>;

  if (rows.length === 0) return 0;

  const deleteChunksFts = db.prepare(
    "DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?))",
  );
  const deleteEmbeddings = db.prepare(
    "DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)",
  );
  const deleteChunks = db.prepare("DELETE FROM chunks WHERE document_id = ?");
  const deleteDoc = db.prepare("DELETE FROM documents WHERE id = ?");

  const tx = db.transaction(() => {
    for (const row of rows) {
      try {
        deleteChunksFts.run(row.id);
      } catch (err) {
        getLogger().debug(
          { err, documentId: row.id },
          "FTS table cleanup skipped (table may not exist)",
        );
      }
      try {
        deleteEmbeddings.run(row.id);
      } catch (err) {
        getLogger().debug(
          { err, documentId: row.id },
          "chunk_embeddings cleanup skipped (table may not exist)",
        );
      }
      deleteChunks.run(row.id);
      deleteDoc.run(row.id);
    }
  });
  tx();

  return rows.length;
}
