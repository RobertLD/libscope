import type Database from "better-sqlite3";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
// NOTE: @types/node-cron v3 is used with node-cron v4 — no v4 types are published yet.
// The schedule() and ScheduledTask.stop() APIs are compatible across versions.
import cron from "node-cron";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { ValidationError } from "../errors.js";
import { getLogger } from "../logger.js";
import {
  loadNamedConnectorConfig,
  saveNamedConnectorConfig,
  startSync,
  completeSync,
  failSync,
} from "../connectors/index.js";
import { syncNotion } from "../connectors/notion.js";
import type { NotionConfig } from "../connectors/notion.js";
import { syncSlack } from "../connectors/slack.js";
import type { SlackConfig } from "../connectors/slack.js";
import { syncConfluence } from "../connectors/confluence.js";
import type { ConfluenceConfig } from "../connectors/confluence.js";
import { syncObsidianVault } from "../connectors/obsidian.js";
import type { ObsidianConfig } from "../connectors/obsidian.js";
import { syncOneNote } from "../connectors/onenote.js";
import type { OneNoteConfig } from "../connectors/onenote.js";

export interface ScheduleConfig {
  cronExpression: string;
}

/** Configuration for a scheduled connector sync entry. */
export interface ConnectorScheduleEntry {
  /** Connector type (e.g. "notion", "slack", "confluence"). */
  connectorType: string;
  /** Named connector config identifier. */
  connectorName: string;
  /** Cron expression for scheduling (e.g. every 6 hours). */
  cronExpression: string;
}

interface ScheduledJob {
  task: cron.ScheduledTask;
  connectorType: string;
  connectorName: string;
  cronExpression: string;
  lastRun?: string | undefined;
  running: boolean;
  runPromise?: Promise<void> | undefined;
}

export interface SchedulerStatus {
  running: boolean;
  jobs: Array<{
    connectorType: string;
    connectorName: string;
    cronExpression: string;
    lastRun?: string | undefined;
    running: boolean;
  }>;
}

/**
 * Connector scheduler that runs syncs on cron schedules.
 * Reads schedule config from connector config files (~/.libscope/connectors/<name>.json).
 */
export class ConnectorScheduler {
  private jobs = new Map<string, ScheduledJob>();
  private started = false;

  constructor(
    private readonly db: Database.Database,
    private readonly provider: EmbeddingProvider,
  ) {}

  /** Start the scheduler with the given connector schedules. */
  start(entries: ConnectorScheduleEntry[]): void {
    const log = getLogger();

    if (this.started) {
      log.warn("Scheduler already started");
      return;
    }

    for (const entry of entries) {
      if (!cron.validate(entry.cronExpression)) {
        log.error(
          { connector: entry.connectorName, cron: entry.cronExpression },
          "Invalid cron expression, skipping",
        );
        continue;
      }

      const key = `${entry.connectorType}:${entry.connectorName}`;
      const task = cron.schedule(entry.cronExpression, () => {
        const promise = this.runSync(entry.connectorType, entry.connectorName);
        const job = this.jobs.get(key);
        if (job) {
          job.runPromise = promise;
        }
      });

      this.jobs.set(key, {
        task,
        connectorType: entry.connectorType,
        connectorName: entry.connectorName,
        cronExpression: entry.cronExpression,
        running: false,
      });

      log.info(
        { connector: entry.connectorName, type: entry.connectorType, cron: entry.cronExpression },
        "Scheduled connector sync",
      );
    }

    this.started = true;
    log.info({ jobCount: this.jobs.size }, "Connector scheduler started");
  }

  /** Stop all scheduled jobs and wait for in-flight syncs to finish. */
  async stop(): Promise<void> {
    const log = getLogger();
    const inFlight: Promise<void>[] = [];
    for (const [key, job] of this.jobs) {
      void job.task.stop();
      if (job.running && job.runPromise) {
        inFlight.push(job.runPromise);
      }
      log.debug({ job: key }, "Stopped scheduled job");
    }
    if (inFlight.length > 0) {
      log.info({ count: inFlight.length }, "Waiting for in-flight syncs to complete");
      await Promise.allSettled(inFlight);
    }
    this.jobs.clear();
    this.started = false;
    log.info("Connector scheduler stopped");
  }

  /** Get the current scheduler status. */
  getStatus(): SchedulerStatus {
    const jobs = [...this.jobs.values()].map((j) => ({
      connectorType: j.connectorType,
      connectorName: j.connectorName,
      cronExpression: j.cronExpression,
      lastRun: j.lastRun,
      running: j.running,
    }));

    return { running: this.started, jobs };
  }

  /** Run a sync for a specific connector. */
  private async runSync(connectorType: string, connectorName: string): Promise<void> {
    const log = getLogger();
    const key = `${connectorType}:${connectorName}`;
    const job = this.jobs.get(key);

    if (job?.running) {
      log.warn({ connector: connectorName }, "Sync already in progress, skipping scheduled run");
      return;
    }

    if (job) {
      job.running = true;
    }

    const syncId = startSync(this.db, connectorType, connectorName);
    log.info({ connector: connectorName, type: connectorType }, "Starting scheduled sync");

    try {
      const stats = await this.executeSync(connectorType, connectorName);
      completeSync(this.db, syncId, stats);
      log.info({ connector: connectorName, ...stats }, "Scheduled sync completed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failSync(this.db, syncId, message);
      log.error({ connector: connectorName, err }, "Scheduled sync failed");
    } finally {
      if (job) {
        job.running = false;
        job.lastRun = new Date().toISOString();
      }
    }
  }

  private async executeSync(
    connectorType: string,
    connectorName: string,
  ): Promise<{ added: number; updated: number; deleted: number; errored: number }> {
    switch (connectorType) {
      case "notion": {
        const config = loadNamedConnectorConfig<NotionConfig>(connectorName);
        const result = await syncNotion(this.db, this.provider, config);
        config.lastSync = new Date().toISOString();
        saveNamedConnectorConfig(connectorName, config);
        return {
          added: result.pagesIndexed,
          updated: 0,
          deleted: 0,
          errored: result.errors.length,
        };
      }
      case "slack": {
        const config = loadNamedConnectorConfig<SlackConfig>(connectorName);
        const result = await syncSlack(this.db, this.provider, config);
        config.lastSync = new Date().toISOString();
        saveNamedConnectorConfig(connectorName, config);
        return {
          added: result.messagesIndexed + result.threadsIndexed,
          updated: 0,
          deleted: 0,
          errored: result.errors.length,
        };
      }
      case "confluence": {
        const config = loadNamedConnectorConfig<ConfluenceConfig>(connectorName);
        const result = await syncConfluence(this.db, this.provider, config);
        config.lastSync = new Date().toISOString();
        saveNamedConnectorConfig(connectorName, config);
        return {
          added: result.pagesIndexed,
          updated: result.pagesUpdated,
          deleted: 0,
          errored: result.errors.length,
        };
      }
      case "obsidian": {
        const config = loadNamedConnectorConfig<ObsidianConfig>(connectorName);
        const result = await syncObsidianVault(this.db, this.provider, config);
        config.lastSync = new Date().toISOString();
        saveNamedConnectorConfig(connectorName, config);
        return {
          added: result.added,
          updated: result.updated,
          deleted: result.deleted,
          errored: result.errors.length,
        };
      }
      case "onenote": {
        const config = loadNamedConnectorConfig<OneNoteConfig>(connectorName);
        const result = await syncOneNote(this.db, this.provider, config);
        config.lastSync = new Date().toISOString();
        saveNamedConnectorConfig(connectorName, config);
        return {
          added: result.pagesAdded,
          updated: result.pagesUpdated,
          deleted: 0,
          errored: result.errors.length,
        };
      }
      default:
        throw new ValidationError(`Unknown connector type: ${connectorType}`);
    }
  }
}

/**
 * Load schedule entries from connector config files.
 * Each connector config can have a `schedule` field with a `cronExpression`.
 */
export function loadScheduleEntries(): ConnectorScheduleEntry[] {
  const log = getLogger();
  const entries: ConnectorScheduleEntry[] = [];

  const connectorsDir = join(homedir(), ".libscope", "connectors");
  if (!existsSync(connectorsDir)) {
    return entries;
  }

  const files = readdirSync(connectorsDir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    try {
      const raw = readFileSync(join(connectorsDir, file), "utf-8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      const schedule = config.schedule as { cronExpression?: string } | undefined;

      if (schedule?.cronExpression) {
        const connectorName = file.replace(/\.json$/, "");
        const connectorType = (config.type as string | undefined) ?? connectorName;
        entries.push({
          connectorType,
          connectorName,
          cronExpression: schedule.cronExpression,
        });
      }
    } catch (err) {
      log.warn({ file, err }, "Failed to read connector config for scheduling");
    }
  }

  return entries;
}
