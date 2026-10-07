import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { createTestDbWithVec } from "../fixtures/test-db.js";
import { MockEmbeddingProvider } from "../fixtures/mock-provider.js";
import { initLogger } from "../../src/logger.js";
import { ConfigError } from "../../src/errors.js";

// Every config file lives under a temp HOME — never the real ~/.libscope.
let tempHome = join(tmpdir(), `libscope-saved-init-${process.pid}`);
vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: (): string => tempHome };
});

const cronCallbacks = new Map<string, () => void>();
vi.mock("node-cron", () => ({
  default: {
    validate: (): boolean => true,
    schedule: vi.fn((expr: string, callback: () => void) => {
      cronCallbacks.set(expr, callback);
      return { stop: vi.fn() };
    }),
  },
}));

const {
  saveConnectorSettings,
  loadSavedConnectorConfig,
  findSavedOneNoteConfig,
  resolveConnectorType,
  runSavedConnectorSync,
} = await import("../../src/connectors/saved-config.js");
const { saveConnectorConfig, getConnectorsDir } = await import("../../src/connectors/index.js");
const { ConnectorScheduler, loadScheduleEntries } = await import("../../src/core/scheduler.js");
const { _resetRateLimiter } = await import("../../src/connectors/onenote.js");

interface SyncRow {
  connector_type: string;
  connector_name: string;
  status: string;
  docs_added: number;
  docs_updated: number;
  docs_deleted: number;
  error_message: string | null;
}

function syncRows(db: Database.Database): SyncRow[] {
  return db.prepare("SELECT * FROM connector_syncs ORDER BY id").all() as SyncRow[];
}

function readSaved(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(getConnectorsDir(), `${name}.json`), "utf-8")) as Record<
    string,
    unknown
  >;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Notion API: one page with one paragraph. */
function mockNotionApi(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string) => {
    if (url.endsWith("/v1/search")) {
      return Promise.resolve(
        json({
          results: [
            {
              object: "page",
              id: "page-1",
              last_edited_time: "2026-01-01T00:00:00.000Z",
              properties: { Name: { type: "title", title: [{ plain_text: "Runbook" }] } },
            },
          ],
          has_more: false,
          next_cursor: null,
        }),
      );
    }
    return Promise.resolve(
      json({
        results: [
          {
            id: "b1",
            type: "paragraph",
            paragraph: { rich_text: [{ plain_text: "Restart the service." }] },
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("saved connector configs", () => {
  let db: Database.Database;
  const provider = new MockEmbeddingProvider();

  beforeEach(() => {
    initLogger("silent");
    tempHome = join(tmpdir(), `libscope-saved-${randomUUID()}`);
    mkdirSync(tempHome, { recursive: true });
    db = createTestDbWithVec();
    cronCallbacks.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
    rmSync(tempHome, { recursive: true, force: true });
  });

  describe("saveConnectorSettings", () => {
    it("tags the connector type, writes mode 0600 and keeps an existing schedule", () => {
      saveConnectorSettings("notion", "team", { token: "secret_a" });
      const path = join(getConnectorsDir(), "team.json");
      expect(statSync(path).mode & 0o777).toBe(0o600);

      const withSchedule = { ...readSaved("team"), schedule: { cronExpression: "0 * * * *" } };
      writeFileSync(path, JSON.stringify(withSchedule));
      saveConnectorSettings("notion", "team", { token: "secret_b" });

      expect(readSaved("team")).toEqual({
        token: "secret_b",
        connectorType: "notion",
        schedule: { cronExpression: "0 * * * *" },
      });
    });
  });

  describe("resolveConnectorType / loadSavedConnectorConfig", () => {
    it("prefers connectorType over Confluence's own cloud/server type field", () => {
      expect(resolveConnectorType("x", { connectorType: "confluence", type: "cloud" })).toBe(
        "confluence",
      );
      expect(resolveConnectorType("x", { type: "notion" })).toBe("notion");
      expect(resolveConnectorType("slack", { token: "t" })).toBe("slack");
    });

    it("rejects a config that declares a different connector type", () => {
      saveConnectorSettings("slack", "work", { token: "xoxb", channels: ["all"] });
      expect(() => loadSavedConnectorConfig("notion", "work")).toThrow(ConfigError);
      expect(loadSavedConnectorConfig("slack", "work")).toMatchObject({ token: "xoxb" });
    });

    it("schedules a saved Confluence config as confluence, not as its cloud type", () => {
      saveConnectorSettings("confluence", "wiki", {
        baseUrl: "https://acme.atlassian.net",
        type: "cloud",
        token: "t",
        spaces: ["all"],
      });
      const path = join(getConnectorsDir(), "wiki.json");
      writeFileSync(
        path,
        JSON.stringify({ ...readSaved("wiki"), schedule: { cronExpression: "0 0 * * *" } }),
      );
      expect(loadScheduleEntries()).toEqual([
        { connectorType: "confluence", connectorName: "wiki", cronExpression: "0 0 * * *" },
      ]);
    });
  });

  describe("runSavedConnectorSync", () => {
    it("writes exactly one sync row under the configured name and saves lastSync", async () => {
      mockNotionApi();
      saveConnectorSettings("notion", "team-notion", { token: "secret_abc" });

      const before = new Date().toISOString();
      await runSavedConnectorSync(db, provider, "notion", "team-notion");

      const rows = syncRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        connector_type: "notion",
        connector_name: "team-notion",
        status: "completed",
        docs_added: 1,
      });
      const saved = readSaved("team-notion");
      expect(saved["connectorType"]).toBe("notion");
      expect(String(saved["lastSync"]) >= before).toBe(true);
    });

    it("records one failed row when the connector rejects the saved config", async () => {
      saveConnectorSettings("notion", "bad", { token: "not-a-notion-token" });
      await expect(runSavedConnectorSync(db, provider, "notion", "bad")).rejects.toThrow(
        "Notion token must start with",
      );
      const rows = syncRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ connector_name: "bad", status: "failed" });
      expect(readSaved("bad")["lastSync"]).toBeUndefined();
    });

    it("records one failed row when the saved config is missing", async () => {
      await expect(runSavedConnectorSync(db, provider, "slack", "nope")).rejects.toThrow(
        ConfigError,
      );
      const rows = syncRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        connector_type: "slack",
        connector_name: "nope",
        status: "failed",
      });
    });

    it("refreshes an expired OneNote token, saves the new tokens and maps deletions", async () => {
      _resetRateLimiter();
      db.prepare(
        "INSERT INTO documents (id, source_type, title, content, url) VALUES ('old', 'topic', 'Old', 'Body', 'onenote://NB/Sec/Old')",
      ).run();
      saveConnectorSettings("onenote", "onenote", {
        clientId: "client-1",
        tenantId: "common",
        accessToken: "expired-access",
        refreshToken: "refresh-1",
        tokenExpiry: "2000-01-01T00:00:00.000Z",
        notebooks: ["all"],
        excludeSections: [],
      });

      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url.includes("/oauth2/v2.0/token")) {
          expect((init?.body as URLSearchParams).get("refresh_token")).toBe("refresh-1");
          return Promise.resolve(
            json({ access_token: "new-access", refresh_token: "refresh-2", expires_in: 3600 }),
          );
        }
        const auth = (init?.headers as Record<string, string>)["Authorization"];
        expect(auth).toBe("Bearer new-access");
        return Promise.resolve(json({ value: [] }));
      });
      vi.stubGlobal("fetch", fetchMock);

      await runSavedConnectorSync(db, provider, "onenote", "onenote");

      const saved = readSaved("onenote");
      expect(saved["accessToken"]).toBe("new-access");
      expect(saved["refreshToken"]).toBe("refresh-2");
      expect(Date.parse(String(saved["tokenExpiry"]))).toBeGreaterThan(Date.now());
      const rows = syncRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ connector_name: "onenote", docs_deleted: 1 });
    });
  });

  describe("findSavedOneNoteConfig", () => {
    it("falls back to credentials stored by older versions in connectors.json", () => {
      saveConnectorConfig({
        onenote: { clientId: "c", tenantId: "t", refreshToken: "r", lastSync: "2026-01-01" },
      });
      expect(findSavedOneNoteConfig()).toEqual({
        clientId: "c",
        tenantId: "t",
        accessToken: undefined,
        refreshToken: "r",
        tokenExpiry: undefined,
        lastSync: "2026-01-01",
        notebooks: ["all"],
        excludeSections: [],
      });
      expect(findSavedOneNoteConfig("other")).toBeUndefined();
    });
  });

  describe("scheduler end to end", () => {
    it("runs a scheduled Notion sync from a saved config and records one row", async () => {
      mockNotionApi();
      saveConnectorSettings("notion", "notion", { token: "secret_abc" });
      const path = join(getConnectorsDir(), "notion.json");
      writeFileSync(
        path,
        JSON.stringify({ ...readSaved("notion"), schedule: { cronExpression: "*/5 * * * *" } }),
      );

      const scheduler = new ConnectorScheduler(db, provider);
      scheduler.start(loadScheduleEntries());
      cronCallbacks.get("*/5 * * * *")!();
      await vi.waitFor(() => {
        expect(scheduler.getStatus().jobs[0]!.lastRun).toBeDefined();
      });
      await scheduler.stop();

      const rows = syncRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ connector_name: "notion", status: "completed" });
      expect(readSaved("notion")["schedule"]).toEqual({ cronExpression: "*/5 * * * *" });
    });
  });
});
