import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  convertSlackMrkdwn,
  syncSlack,
  disconnectSlack,
  _setRateLimitDelay,
  _clearUserCache,
} from "../../src/connectors/slack.js";
import type { SlackConfig } from "../../src/connectors/slack.js";
import { createTestDbWithVec } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import type Database from "better-sqlite3";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function slackOk(data: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ok: true, ...data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function slackError(error: string): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("convertSlackMrkdwn", () => {
  it("converts bold", () => {
    expect(convertSlackMrkdwn("this is *bold* text")).toBe("this is **bold** text");
  });

  it("converts italic", () => {
    expect(convertSlackMrkdwn("this is _italic_ text")).toBe("this is *italic* text");
  });

  it("converts strikethrough", () => {
    expect(convertSlackMrkdwn("this is ~strike~ text")).toBe("this is ~~strike~~ text");
  });

  it("converts channel links", () => {
    expect(convertSlackMrkdwn("see <#C1234|general>")).toBe("see #general");
  });

  it("converts URL with text", () => {
    expect(convertSlackMrkdwn("check <https://example.com|Example>")).toBe(
      "check [Example](https://example.com)",
    );
  });

  it("converts plain URLs", () => {
    expect(convertSlackMrkdwn("visit <https://example.com>")).toBe("visit https://example.com");
  });

  it("preserves code blocks", () => {
    const input = "before ```const x = 1;``` after";
    const result = convertSlackMrkdwn(input);
    expect(result).toContain("```const x = 1;```");
  });

  it("preserves inline code", () => {
    const input = "use `*bold*` for emphasis";
    const result = convertSlackMrkdwn(input);
    expect(result).toContain("`*bold*`");
    expect(result).not.toContain("**bold**");
  });

  it("preserves emoji", () => {
    expect(convertSlackMrkdwn("hello :wave: world")).toBe("hello :wave: world");
  });

  it("handles multiple conversions together", () => {
    const input = "*bold* and _italic_ and ~strike~";
    const result = convertSlackMrkdwn(input);
    expect(result).toContain("**bold**");
    expect(result).toContain("*italic*");
    expect(result).toContain("~~strike~~");
  });
});

function setupChannelList(channels: Array<{ id: string; name: string }> = []): void {
  mockFetch.mockImplementationOnce(() =>
    Promise.resolve(slackOk({ channels, response_metadata: {} })),
  );
}

function setupMessages(messages: Array<Record<string, unknown>> = []): void {
  mockFetch.mockImplementationOnce(() =>
    Promise.resolve(slackOk({ messages, response_metadata: {} })),
  );
}

function setupUserInfo(user: Record<string, unknown>): void {
  mockFetch.mockImplementationOnce(() => Promise.resolve(slackOk({ user })));
}

function setupThreadReplies(messages: Array<Record<string, unknown>> = []): void {
  mockFetch.mockImplementationOnce(() => Promise.resolve(slackOk({ messages })));
}

describe("syncSlack", () => {
  let db: Database.Database;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    db = createTestDbWithVec();
    provider = new MockEmbeddingProvider();
    mockFetch.mockReset();
    _setRateLimitDelay(0);
    _clearUserCache();
  });

  afterEach(() => {
    db.close();
  });

  const baseConfig: SlackConfig = {
    token: "xoxb-test-token",
    channels: ["general"],
    threadMode: "aggregate",
  };

  it("lists and filters channels", async () => {
    setupChannelList([
      { id: "C001", name: "general" },
      { id: "C002", name: "random" },
    ]);
    setupMessages([]);

    const result = await syncSlack(db, provider, baseConfig);
    expect(result.channels).toBe(1);
    expect(result.messagesIndexed).toBe(0);
  });

  it("fetches and indexes standalone messages", async () => {
    setupChannelList([{ id: "C001", name: "general" }]);
    setupMessages([{ ts: "1700000000.000000", text: "Hello world", user: "U001" }]);
    setupUserInfo({ id: "U001", name: "alice", real_name: "Alice Smith" });

    const result = await syncSlack(db, provider, baseConfig);
    expect(result.messagesIndexed).toBe(1);

    const docs = db.prepare("SELECT * FROM documents WHERE url LIKE 'slack://%'").all() as Array<{
      title: string;
    }>;
    expect(docs).toHaveLength(1);
    expect(docs[0]?.title).toContain("general");
  });

  it("handles pagination in channel listing", async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        slackOk({
          channels: [{ id: "C001", name: "general" }],
          response_metadata: { next_cursor: "cursor123" },
        }),
      ),
    );
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        slackOk({
          channels: [{ id: "C002", name: "random" }],
          response_metadata: {},
        }),
      ),
    );
    // Two channels need messages fetched
    setupMessages([]);
    setupMessages([]);

    const config: SlackConfig = { ...baseConfig, channels: ["all"] };
    const result = await syncSlack(db, provider, config);
    expect(result.channels).toBe(2);
  });

  it("aggregates threads into a single document", async () => {
    setupChannelList([{ id: "C001", name: "general" }]);
    setupMessages([
      {
        ts: "1700000000.000000",
        text: "Thread parent message",
        user: "U001",
        reply_count: 2,
        thread_ts: "1700000000.000000",
      },
    ]);
    setupThreadReplies([
      { ts: "1700000000.000000", text: "Thread parent message", user: "U001" },
      { ts: "1700000001.000000", text: "First reply", user: "U002" },
    ]);
    setupUserInfo({ id: "U001", name: "alice", real_name: "Alice" });
    setupUserInfo({ id: "U002", name: "bob", real_name: "Bob" });

    const result = await syncSlack(db, provider, baseConfig);
    expect(result.threadsIndexed).toBe(1);
    expect(result.messagesIndexed).toBe(0);

    const docs = db
      .prepare("SELECT * FROM documents WHERE url LIKE 'slack://%/thread/%'")
      .all() as Array<{ content: string }>;
    expect(docs).toHaveLength(1);
    expect(docs[0]?.content).toContain("Thread parent message");
    expect(docs[0]?.content).toContain("First reply");
  });

  it("handles separate thread mode", async () => {
    setupChannelList([{ id: "C001", name: "general" }]);
    setupMessages([
      {
        ts: "1700000000.000000",
        text: "Thread parent",
        user: "U001",
        reply_count: 1,
        thread_ts: "1700000000.000000",
      },
    ]);
    setupThreadReplies([
      { ts: "1700000000.000000", text: "Thread parent", user: "U001" },
      { ts: "1700000001.000000", text: "Reply", user: "U001" },
    ]);
    setupUserInfo({ id: "U001", name: "alice", real_name: "Alice" });

    const config: SlackConfig = { ...baseConfig, threadMode: "separate" };
    const result = await syncSlack(db, provider, config);
    expect(result.threadsIndexed).toBe(1);
    expect(result.messagesIndexed).toBe(2);
  });

  it("uses oldest param for incremental sync", async () => {
    const syncTime = "2024-01-01T00:00:00.000Z";
    setupChannelList([{ id: "C001", name: "general" }]);
    setupMessages([]);

    const config: SlackConfig = { ...baseConfig, lastSync: syncTime };
    await syncSlack(db, provider, config);

    const historyCall = mockFetch.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("conversations.history"),
    );
    expect(historyCall).toBeDefined();
    expect(String(historyCall?.[0])).toContain("oldest=" + encodeURIComponent(syncTime));
  });

  it("resolves user mentions in message text", async () => {
    setupChannelList([{ id: "C001", name: "general" }]);
    setupMessages([{ ts: "1700000000.000000", text: "Hello <@U001>!", user: "U002" }]);
    setupUserInfo({ id: "U002", name: "bob", real_name: "Bob" });
    setupUserInfo({ id: "U001", name: "alice", real_name: "Alice" });

    const result = await syncSlack(db, provider, baseConfig);
    expect(result.messagesIndexed).toBe(1);

    const docs = db
      .prepare("SELECT content FROM documents WHERE url LIKE 'slack://%'")
      .all() as Array<{ content: string }>;
    expect(docs[0]?.content).toContain("@Alice");
  });

  it("handles rate limiting with delays between requests", async () => {
    setupChannelList([{ id: "C001", name: "general" }]);
    setupMessages([]);

    await syncSlack(db, provider, baseConfig);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("handles channel errors gracefully", async () => {
    setupChannelList([
      { id: "C001", name: "general" },
      { id: "C002", name: "random" },
    ]);
    mockFetch.mockImplementationOnce(() => Promise.resolve(slackError("channel_not_found")));
    setupMessages([]);

    const config: SlackConfig = { ...baseConfig, channels: ["all"] };
    const result = await syncSlack(db, provider, config);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.channel).toBe("general");
    expect(result.channels).toBe(2);
  });

  it("excludes specified channels", async () => {
    setupChannelList([
      { id: "C001", name: "general" },
      { id: "C002", name: "random" },
    ]);
    setupMessages([]);

    const config: SlackConfig = {
      ...baseConfig,
      channels: ["all"],
      excludeChannels: ["random"],
    };
    const result = await syncSlack(db, provider, config);
    expect(result.channels).toBe(1);
  });

  it("throws on missing token", async () => {
    const config: SlackConfig = { ...baseConfig, token: "" };
    await expect(syncSlack(db, provider, config)).rejects.toThrow("Slack token is required");
  });

  it("throws on empty channels", async () => {
    const config: SlackConfig = { ...baseConfig, channels: [] };
    await expect(syncSlack(db, provider, config)).rejects.toThrow(
      "At least one channel must be specified",
    );
  });
});

describe("disconnectSlack", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDbWithVec();
  });

  afterEach(() => {
    db.close();
  });

  it("removes Slack documents from the database", () => {
    db.prepare(
      "INSERT INTO documents (id, source_type, title, content, url, submitted_by) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("slack-1", "manual", "Slack msg", "content", "slack://general/123", "crawler");
    db.prepare(
      "INSERT INTO documents (id, source_type, title, content, url, submitted_by) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("other-1", "manual", "Other doc", "content", "https://example.com", "manual");

    db.prepare(
      "INSERT INTO chunks (id, document_id, content, chunk_index) VALUES (?, ?, ?, ?)",
    ).run("chunk-1", "slack-1", "chunk content", 0);

    const count = disconnectSlack(db);
    expect(count).toBe(1);

    const slackDocs = db.prepare("SELECT * FROM documents WHERE url LIKE 'slack://%'").all();
    expect(slackDocs).toHaveLength(0);

    const otherDocs = db.prepare("SELECT * FROM documents WHERE id = 'other-1'").all();
    expect(otherDocs).toHaveLength(1);

    const chunks = db.prepare("SELECT * FROM chunks WHERE document_id = 'slack-1'").all();
    expect(chunks).toHaveLength(0);
  });

  it("returns 0 when no Slack documents exist", () => {
    const count = disconnectSlack(db);
    expect(count).toBe(0);
  });
});
