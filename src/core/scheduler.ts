import type Database from "better-sqlite3";
// NOTE: @types/node-cron v3 is used with node-cron v4 — no v4 types are published yet.
// The schedule() and ScheduledTask.stop() APIs are compatible across versions.
import cron from "node-cron";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { ValidationError } from "../errors.js";
import { getLogger } from "../logger.js";
import { listNamedConnectorConfigs } from "../connectors/index.js";
import {
  isConnectorType,
  recordFailedSync,
  resolveConnectorType,
} from "../connectors/saved-config.js";
import { runSavedConnectorSync } from "../connectors/registry.js";

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
  private readonly jobs = new Map<string, ScheduledJob>();
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

  /** Stop all scheduled jobs and wait for in-flight syncs to finish (with timeout). */
  async stop(): Promise<void> {
    const log = getLogger();
    const inFlight: Promise<void>[] = [];
    for (const [key, job] of this.jobs) {
      void job.task.stop(); // NOSONAR — ESLint no-floating-promises requires void for fire-and-forget
      if (job.running && job.runPromise) {
        inFlight.push(job.runPromise);
      }
      log.debug({ job: key }, "Stopped scheduled job");
    }
    if (inFlight.length > 0) {
      log.info({ count: inFlight.length }, "Waiting for in-flight syncs to complete");
      const SHUTDOWN_TIMEOUT_MS = 30_000;
      const timeout = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          log.warn("Shutdown timeout reached, proceeding without waiting for in-flight syncs");
          resolve();
        }, SHUTDOWN_TIMEOUT_MS);
        timer.unref();
      });
      await Promise.race([Promise.allSettled(inFlight), timeout]);
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

    log.info({ connector: connectorName, type: connectorType }, "Starting scheduled sync");

    try {
      // The connector records the run (one connector_syncs row, under connectorName).
      if (!isConnectorType(connectorType)) {
        const err = new ValidationError(`Unknown connector type: ${connectorType}`);
        recordFailedSync(this.db, connectorType, connectorName, err);
        throw err;
      }
      await runSavedConnectorSync(this.db, this.provider, connectorType, connectorName);
      log.info({ connector: connectorName }, "Scheduled sync completed");
    } catch (err) {
      log.error({ connector: connectorName, err }, "Scheduled sync failed");
    } finally {
      if (job) {
        job.running = false;
        job.lastRun = new Date().toISOString();
      }
    }
  }
}

/**
 * Load schedule entries from connector config files.
 * Each connector config can have a `schedule` field with a `cronExpression`.
 */
export function loadScheduleEntries(): ConnectorScheduleEntry[] {
  const entries: ConnectorScheduleEntry[] = [];
  for (const { name, config } of listNamedConnectorConfigs()) {
    const schedule = config["schedule"] as { cronExpression?: string } | undefined;
    if (schedule?.cronExpression) {
      entries.push({
        connectorType: resolveConnectorType(name, config),
        connectorName: name,
        cronExpression: schedule.cronExpression,
      });
    }
  }
  return entries;
}
