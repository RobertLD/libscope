import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { indexFile } from "./indexing.js";
import { getParserForFile } from "./parsers/index.js";
import { basename, extname } from "node:path";
import { getLogger } from "../logger.js";

export interface BatchImportOptions {
  sourceType?: "library" | "topic" | "manual" | "model-generated" | undefined;
  library?: string | undefined;
  version?: string | undefined;
  topicId?: string | undefined;
  concurrency?: number | undefined;
  onProgress?: ((progress: BatchProgress) => void) | undefined;
}

export interface BatchProgress {
  total: number;
  completed: number;
  failed: number;
  /** Files skipped because no parser handles their extension. */
  skipped: number;
  currentFile?: string;
}

export interface BatchFileResult {
  file: string;
  success: boolean;
  /** True when the file was not imported because its extension is unsupported. */
  skipped?: boolean;
  chunkCount?: number;
  documentId?: string;
  error?: string;
}

export interface BatchImportResult {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  results: BatchFileResult[];
}

/**
 * Import multiple files in parallel with configurable concurrency.
 * Uses a semaphore pattern to limit concurrent operations.
 */
export async function batchImport(
  db: Database.Database,
  provider: EmbeddingProvider,
  files: string[],
  options: BatchImportOptions = {},
): Promise<BatchImportResult> {
  const logger = getLogger();
  const concurrency = options.concurrency ?? 5;
  const progress: BatchProgress = { total: files.length, completed: 0, failed: 0, skipped: 0 };
  const results: BatchFileResult[] = [];

  logger.debug(`Starting batch import: ${files.length} files, concurrency ${concurrency}`);

  // Semaphore-based parallel processing
  let activeCount = 0;
  let fileIndex = 0;

  await new Promise<void>((resolve) => {
    if (files.length === 0) {
      resolve();
      return;
    }

    function runNext(): void {
      while (activeCount < concurrency && fileIndex < files.length) {
        const currentIndex = fileIndex++;
        const file = files[currentIndex]!;
        activeCount++;
        progress.currentFile = file;

        processFile(db, provider, file, options)
          .then((result) => {
            results[currentIndex] = result;
            if (result.success) {
              progress.completed++;
            } else if (result.skipped) {
              progress.skipped++;
            } else {
              progress.failed++;
            }
            options.onProgress?.({ ...progress });
          })
          .catch((err) => {
            results[currentIndex] = {
              file,
              success: false,
              error: err instanceof Error ? err.message : String(err),
            };
            progress.failed++;
            options.onProgress?.({ ...progress });
          })
          .finally(() => {
            activeCount--;
            if (progress.completed + progress.failed + progress.skipped === files.length) {
              resolve();
            } else {
              runNext();
            }
          });
      }
    }

    runNext();
  });

  return {
    total: files.length,
    completed: progress.completed,
    failed: progress.failed,
    skipped: progress.skipped,
    results,
  };
}

async function processFile(
  db: Database.Database,
  provider: EmbeddingProvider,
  file: string,
  options: BatchImportOptions,
): Promise<BatchFileResult> {
  if (!getParserForFile(file)) {
    const error = `Unsupported file type "${extname(file) || basename(file)}"`;
    getLogger().warn({ file }, `Skipping ${file}: ${error}`);
    return { file, success: false, skipped: true, error };
  }

  const result = await indexFile(db, provider, file, {
    sourceType: options.sourceType,
    library: options.library,
    version: options.version,
    topic: options.topicId,
  });

  return {
    file,
    success: true,
    chunkCount: result.chunkCount,
    documentId: result.id,
  };
}
