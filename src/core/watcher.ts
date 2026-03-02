import { watch, readFileSync, statSync, type FSWatcher } from "node:fs";
import { extname, resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { indexDocument } from "./indexing.js";
import { createChildLogger } from "../logger.js";

export const DEFAULT_WATCH_EXTENSIONS = [".md", ".mdx", ".txt", ".rst"];

export interface WatchOptions {
  directory: string;
  extensions?: string[];
  debounceMs?: number;
  onIndex?: (path: string) => void;
  onRemove?: (path: string) => void;
  onError?: (err: Error) => void;
}

export class FileWatcher {
  private readonly db: Database.Database;
  private readonly provider: EmbeddingProvider;
  private readonly options: WatchOptions;
  private readonly extensions: Set<string>;
  private readonly debounceMs: number;
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly log = createChildLogger({ component: "FileWatcher" });
  private watcher: FSWatcher | null = null;

  constructor(db: Database.Database, provider: EmbeddingProvider, options: WatchOptions) {
    this.db = db;
    this.provider = provider;
    this.options = options;
    this.extensions = new Set(
      (options.extensions ?? DEFAULT_WATCH_EXTENSIONS).map((e) => e.toLowerCase()),
    );
    this.debounceMs = options.debounceMs ?? 300;
  }

  start(): void {
    const directory = resolve(this.options.directory);
    this.log.info({ directory, extensions: [...this.extensions] }, "Starting file watcher");

    this.watcher = watch(directory, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const fullPath = resolve(directory, filename);
      this.handleEvent(eventType, fullPath);
    });

    this.watcher.on("error", (err) => {
      this.log.error({ err }, "Watcher error");
      this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
    });
  }

  stop(): void {
    this.log.info("Stopping file watcher");
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.watcher?.close();
    this.watcher = null;
  }

  private handleEvent(_eventType: string, fullPath: string): void {
    const ext = extname(fullPath).toLowerCase();
    if (!this.extensions.has(ext)) return;

    const existing = this.debounceTimers.get(fullPath);
    if (existing) {
      clearTimeout(existing);
      this.debounceTimers.delete(fullPath);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(fullPath);
      this.processFile(fullPath).catch((err: unknown) => {
        this.log.error({ path: fullPath, err }, "Unhandled error processing file");
      });
    }, this.debounceMs);

    this.debounceTimers.set(fullPath, timer);
  }

  private async processFile(fullPath: string): Promise<void> {
    try {
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        this.removeDocument(fullPath);
        return;
      }

      if (!stat.isFile()) return;

      const content = readFileSync(fullPath, "utf-8");
      const contentHash = createHash("sha256").update(content).digest("hex");

      const existing = this.db
        .prepare("SELECT id, content_hash FROM documents WHERE url = ?")
        .get(fullPath) as { id: string; content_hash: string | null } | undefined;

      if (existing?.content_hash === contentHash) {
        this.log.debug({ path: fullPath }, "File unchanged, skipping");
        return;
      }

      const title = basename(fullPath).replace(/\.[^.]+$/, "");
      const result = await indexDocument(this.db, this.provider, {
        title,
        content,
        sourceType: "manual",
        url: fullPath,
      });

      this.log.info({ path: fullPath, chunkCount: result.chunkCount }, "File indexed");
      this.options.onIndex?.(fullPath);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error({ path: fullPath, err: error }, "Failed to process file");
      this.options.onError?.(error);
    }
  }

  private removeDocument(fullPath: string): void {
    try {
      const existing = this.db.prepare("SELECT id FROM documents WHERE url = ?").get(fullPath) as
        | { id: string }
        | undefined;

      if (!existing) return;

      try {
        this.db
          .prepare(
            "DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)",
          )
          .run(existing.id);
      } catch {
        // chunk_embeddings table may not exist
      }

      this.db.prepare("DELETE FROM documents WHERE id = ?").run(existing.id);
      this.log.info({ path: fullPath, docId: existing.id }, "Document removed");
      this.options.onRemove?.(fullPath);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error({ path: fullPath, err: error }, "Failed to remove document");
      this.options.onError?.(error);
    }
  }
}
