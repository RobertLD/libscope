/**
 * CLI output reporter — pretty human-readable output for interactive terminals.
 * In verbose/JSON mode, a SilentReporter is used so pino JSON logs handle output.
 */

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";

export interface CliReporter {
  log(msg: string): void;
  success(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  progress(current: number, total: number, label: string): void;
  clearProgress(): void;
}

function buildBar(pct: number, width = 20): string {
  const filled = Math.round((pct / 100) * width);
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}

/** Pretty human-readable reporter. Uses ANSI colors and \r progress lines. */
class PrettyReporter implements CliReporter {
  private hasProgress = false;

  log(msg: string): void {
    this.clearProgress();
    process.stdout.write(`${msg}\n`);
  }

  success(msg: string): void {
    this.clearProgress();
    process.stdout.write(`${GREEN}\u2713${RESET} ${msg}\n`);
  }

  warn(msg: string): void {
    this.clearProgress();
    process.stderr.write(`${YELLOW}\u26a0${RESET} ${msg}\n`);
  }

  error(msg: string): void {
    this.clearProgress();
    process.stderr.write(`${RED}\u2717${RESET} ${msg}\n`);
  }

  progress(current: number, total: number, label: string): void {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    const bar = buildBar(pct);
    const truncatedLabel = label.length > 40 ? `${label.slice(0, 37)}...` : label;
    const line = `${CYAN}[${bar}]${RESET} ${pct}% (${current}/${total}) ${DIM}${truncatedLabel}${RESET}`;
    process.stdout.write(`\r${line}`);
    this.hasProgress = true;
  }

  clearProgress(): void {
    if (this.hasProgress) {
      const width = process.stdout.columns ?? 80;
      process.stdout.write(`\r${" ".repeat(width - 1)}\r`);
      this.hasProgress = false;
    }
  }
}

/** No-op reporter: used in verbose/JSON mode where pino logs handle output. */
class SilentReporter implements CliReporter {
  log(_msg: string): void {}
  success(_msg: string): void {}
  warn(_msg: string): void {}
  error(_msg: string): void {}
  progress(_current: number, _total: number, _label: string): void {}
  clearProgress(): void {}
}

/** Returns true if verbose mode is active (flag or env var). */
export function isVerbose(verbose?: boolean): boolean {
  return verbose === true || process.env["LIBSCOPE_VERBOSE"] === "1";
}

/** Create a reporter appropriate for the current mode. */
export function createReporter(verbose?: boolean): CliReporter {
  return isVerbose(verbose) ? new SilentReporter() : new PrettyReporter();
}
