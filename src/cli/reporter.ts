/**
 * Progress line for long-running operations. Written to stderr so `--json` output on stdout
 * stays clean, and only on a terminal (nothing is written when stderr is redirected).
 */
import type { ProgressEvent } from "../core/operations/index.js";

export interface ProgressLine {
  update(event: ProgressEvent): void;
  clear(): void;
}

function bar(done: number, total: number, width = 20): string {
  const filled = Math.min(width, Math.round((done / total) * width));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Text of one progress line, e.g. "[████░░…] 40% (4/10) docs/a.md". */
export function formatProgress(event: ProgressEvent): string {
  const label = event.message ?? "";
  const shortLabel = label.length > 50 ? `...${label.slice(-47)}` : label;
  if (event.total !== undefined && event.total > 0) {
    const pct = Math.round((event.done / event.total) * 100);
    return `[${bar(event.done, event.total)}] ${pct}% (${event.done}/${event.total}) ${shortLabel}`;
  }
  return `(${event.done}) ${shortLabel}`;
}

export function createProgressLine(stream: NodeJS.WriteStream = process.stderr): ProgressLine {
  let shown = false;
  const width = (): number => stream.columns ?? 80;
  return {
    update(event: ProgressEvent): void {
      if (!stream.isTTY) return;
      stream.write(
        `\r${formatProgress(event)
          .slice(0, width() - 1)
          .padEnd(width() - 1)}`,
      );
      shown = true;
    },
    clear(): void {
      if (!shown) return;
      stream.write(`\r${" ".repeat(width() - 1)}\r`);
      shown = false;
    },
  };
}
