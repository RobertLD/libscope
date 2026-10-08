import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { createTestDbWithVec } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { initLogger } from "../../src/logger.js";
import { ValidationError } from "../../src/errors.js";

// Connector state and saved configs live under a temp HOME — never the real ~/.libscope.
let tempHome = join(tmpdir(), `libscope-abort-init-${process.pid}`);
vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: (): string => tempHome };
});

const { syncNotion } = await import("../../src/connectors/notion.js");
const { syncSlack, _setRateLimitDelay } = await import("../../src/connectors/slack.js");
const { syncConfluence } = await import("../../src/connectors/confluence.js");
const { syncObsidianVault } = await import("../../src/connectors/obsidian.js");
const { syncOneNote, _resetRateLimiter } = await import("../../src/connectors/onenote.js");
const { resolveSyncConfig, saveConnectorSettings, saveRefreshedOneNoteTokens } =
  await import("../../src/connectors/saved-config.js");
const { getConnectorsDir } = await import("../../src/connectors/index.js");

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function onlySyncRow(db: Database.Database): { status: string; connector_name: string } {
  const rows = db.prepare("SELECT status, connector_name FROM connector_syncs").all() as Array<{
    status: string;
    connector_name: string;
  }>;
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe("connector abort signals", () => {
  let db: Database.Database;
  const provider = new MockEmbeddingProvider();

  beforeEach(() => {
    initLogger("silent");
    tempHome = join(tmpdir(), `libscope-abort-${randomUUID()}`);
    mkdirSync(tempHome, { recursive: true });
    db = createTestDbWithVec();
    _setRateLimitDelay(0);
    _resetRateLimiter();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("notion stops between items and records the run as failed", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith("/v1/search")) {
        return Promise.resolve(
          json({
            results: ["p1", "p2"].map((id) => ({
              object: "page",
              id,
              last_edited_time: "2026-01-01T00:00:00.000Z",
              properties: { Name: { type: "title", title: [{ plain_text: id }] } },
            })),
            has_more: false,
            next_cursor: null,
          }),
        );
      }
      controller.abort(); // cancelled while the first page is being fetched
      return Promise.resolve(
        json({
          results: [
            { id: "b", type: "paragraph", paragraph: { rich_text: [{ plain_text: "x" }] } },
          ],
          has_more: false,
          next_cursor: null,
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncNotion(db, provider, { token: "secret_t" }, { signal: controller.signal, syncName: "n" }),
    ).rejects.toThrow();

    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls.some((u) => u.includes("/blocks/p1/"))).toBe(true);
    expect(urls.some((u) => u.includes("/blocks/p2/"))).toBe(false);
    expect(onlySyncRow(db)).toEqual({ status: "failed", connector_name: "n" });
  });

  it("slack stops before the next channel", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("conversations.list")) {
        return Promise.resolve(
          json({
            ok: true,
            channels: [
              { id: "C1", name: "one" },
              { id: "C2", name: "two" },
            ],
          }),
        );
      }
      controller.abort();
      return Promise.resolve(json({ ok: true, messages: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncSlack(
        db,
        provider,
        { token: "xoxb", channels: ["all"], threadMode: "aggregate" },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();

    const historyCalls = fetchMock.mock.calls.filter((c) => c[0].includes("conversations.history"));
    expect(historyCalls).toHaveLength(1);
    expect(onlySyncRow(db).status).toBe("failed");
  });

  it("confluence does not call the API when already aborted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(
      syncConfluence(
        db,
        provider,
        { baseUrl: "https://acme.atlassian.net", email: "e", token: "t", spaces: ["all"] },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onlySyncRow(db).status).toBe("failed");
  });

  it("obsidian indexes nothing and keeps no vault state when aborted", async () => {
    const vault = join(tempHome, "vault");
    mkdirSync(vault);
    writeFileSync(join(vault, "a.md"), "# A\n\nAlpha note.");
    writeFileSync(join(vault, "b.md"), "# B\n\nBeta note.");
    const controller = new AbortController();
    controller.abort();

    await expect(
      syncObsidianVault(
        db,
        provider,
        { vaultPath: vault, topicMapping: "folder", excludePatterns: [] },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM documents").get()).toEqual({ n: 0 });
    expect(onlySyncRow(db).status).toBe("failed");
  });

  it("onenote does not delete unseen pages when aborted mid-sync", async () => {
    db.prepare(
      "INSERT INTO documents (id, source_type, title, content, url) VALUES ('keep', 'topic', 'K', 'Body', 'onenote://NB/S/K')",
    ).run();
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        controller.abort();
        return Promise.resolve(json({ value: [{ id: "nb1", displayName: "NB" }] }));
      }),
    );

    await expect(
      syncOneNote(
        db,
        provider,
        {
          clientId: "",
          tenantId: "common",
          accessToken: "a",
          tokenExpiry: "2999-01-01T00:00:00.000Z",
          notebooks: ["all"],
          excludeSections: [],
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(db.prepare("SELECT id FROM documents").all()).toEqual([{ id: "keep" }]);
    expect(onlySyncRow(db).status).toBe("failed");
  });
});

describe("resolveSyncConfig (MCP sync tools)", () => {
  beforeEach(() => {
    initLogger("silent");
    tempHome = join(tmpdir(), `libscope-resolve-${randomUUID()}`);
    mkdirSync(tempHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("fills omitted parameters from the saved config, then defaults", () => {
    saveConnectorSettings("slack", "slack", { token: "xoxb-saved", channels: ["eng"] });
    const { config, saved } = resolveSyncConfig<{
      token: string;
      channels: string[];
      threadMode: string;
    }>(
      "slack",
      "slack",
      { token: undefined, channels: undefined, threadMode: undefined },
      { defaults: { channels: ["all"], threadMode: "aggregate" }, required: ["token"] },
    );
    expect(config).toMatchObject({
      token: "xoxb-saved",
      channels: ["eng"],
      threadMode: "aggregate",
    });
    expect(saved).toBeDefined();
  });

  it("lets explicit parameters override the saved config", () => {
    saveConnectorSettings("notion", "team", { token: "secret_saved" });
    const { config } = resolveSyncConfig<{ token: string }>("notion", "team", {
      token: "secret_given",
    });
    expect(config.token).toBe("secret_given");
  });

  it("names the missing fields and the config name when nothing is saved", () => {
    expect(() =>
      resolveSyncConfig<{ baseUrl: string; token: string }>(
        "confluence",
        "wiki",
        { baseUrl: undefined, token: undefined },
        { required: ["baseUrl", "token"] },
      ),
    ).toThrow(ValidationError);
    expect(() =>
      resolveSyncConfig<{ token: string }>("notion", "absent", {}, { required: ["token"] }),
    ).toThrow(/token.*"absent"/);
  });

  it("saves refreshed OneNote tokens only when the connector refreshed them", () => {
    const saved = {
      clientId: "c",
      tenantId: "common",
      accessToken: "old",
      refreshToken: "r1",
      notebooks: ["all"],
      excludeSections: [],
    };
    saveConnectorSettings("onenote", "onenote", saved);
    const path = join(getConnectorsDir(), "onenote.json");

    saveRefreshedOneNoteTokens("onenote", saved, {
      ...saved,
      accessToken: "x",
      refreshToken: undefined,
    });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toMatchObject({ accessToken: "old" });

    saveRefreshedOneNoteTokens("onenote", saved, {
      ...saved,
      accessToken: "new",
      refreshToken: "r2",
      tokenExpiry: "2999-01-01T00:00:00.000Z",
    });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toMatchObject({
      accessToken: "new",
      refreshToken: "r2",
    });
  });
});
