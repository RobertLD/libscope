import { describe, it, expect, vi, afterEach } from "vitest";
import { isVerbose, createReporter } from "../../src/cli/reporter.js";

describe("reporter", () => {
  afterEach(() => {
    delete process.env["LIBSCOPE_VERBOSE"];
    vi.restoreAllMocks();
  });

  describe("isVerbose", () => {
    it("returns true when verbose flag is set", () => {
      expect(isVerbose(true)).toBe(true);
    });

    it("returns false when verbose flag is false", () => {
      expect(isVerbose(false)).toBe(false);
    });

    it("returns false when verbose flag is undefined", () => {
      expect(isVerbose(undefined)).toBe(false);
    });

    it("returns true when LIBSCOPE_VERBOSE=1 env var is set", () => {
      process.env["LIBSCOPE_VERBOSE"] = "1";
      expect(isVerbose(false)).toBe(true);
    });

    it("returns false when LIBSCOPE_VERBOSE=0", () => {
      process.env["LIBSCOPE_VERBOSE"] = "0";
      expect(isVerbose(false)).toBe(false);
    });
  });

  describe("createReporter", () => {
    it("returns a SilentReporter (no-op) in verbose mode", () => {
      const reporter = createReporter(true);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      reporter.log("hello");
      reporter.success("done");
      reporter.warn("careful");
      reporter.error("bad");
      reporter.progress(1, 10, "task");
      reporter.clearProgress();

      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    });

    it("returns a SilentReporter when LIBSCOPE_VERBOSE=1", () => {
      process.env["LIBSCOPE_VERBOSE"] = "1";
      const reporter = createReporter();
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      reporter.log("hello");
      expect(stdout).not.toHaveBeenCalled();
    });

    it("PrettyReporter.log writes to stdout", () => {
      const reporter = createReporter(false);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      reporter.log("test message");

      expect(stdout).toHaveBeenCalledOnce();
      expect(String(stdout.mock.calls[0]![0])).toContain("test message");
    });

    it("PrettyReporter.success writes green checkmark to stdout", () => {
      const reporter = createReporter(false);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      reporter.success("all done");

      const output = String(stdout.mock.calls[0]![0]);
      expect(output).toContain("all done");
      // Green ANSI code
      expect(output).toContain("\x1b[32m");
    });

    it("PrettyReporter.warn writes to stderr", () => {
      const reporter = createReporter(false);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      reporter.warn("watch out");

      expect(stderr).toHaveBeenCalledOnce();
      expect(String(stderr.mock.calls[0]![0])).toContain("watch out");
    });

    it("PrettyReporter.error writes to stderr", () => {
      const reporter = createReporter(false);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      reporter.error("something failed");

      expect(stderr).toHaveBeenCalledOnce();
      expect(String(stderr.mock.calls[0]![0])).toContain("something failed");
    });

    it(String.raw`PrettyReporter.progress writes \r-prefixed line to stdout`, () => {
      const reporter = createReporter(false);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      reporter.progress(3, 10, "indexing doc");

      const output = String(stdout.mock.calls[0]![0]);
      expect(output).toMatch(/^\r/);
      expect(output).toContain("3/10");
      expect(output).toContain("30%");
    });

    it("PrettyReporter.clearProgress clears the progress line", () => {
      const reporter = createReporter(false);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      reporter.progress(1, 5, "working");
      stdout.mockClear();

      reporter.clearProgress();

      // Should write spaces to clear the line
      const output = String(stdout.mock.calls[0]![0]);
      expect(output).toMatch(/^\r\s+\r$/);
    });

    it("PrettyReporter.clearProgress is a no-op when no progress shown", () => {
      const reporter = createReporter(false);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      reporter.clearProgress();

      expect(stdout).not.toHaveBeenCalled();
    });

    it("PrettyReporter.log clears progress before writing", () => {
      const reporter = createReporter(false);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      reporter.progress(1, 5, "working");
      stdout.mockClear();

      reporter.log("a message");

      // First call should be the clear, second the message
      expect(stdout.mock.calls.length).toBeGreaterThanOrEqual(2);
      const clearCall = String(stdout.mock.calls[0]![0]);
      expect(clearCall).toMatch(/^\r\s+\r$/);
    });

    it("PrettyReporter.progress truncates long labels", () => {
      const reporter = createReporter(false);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      reporter.progress(1, 1, "a".repeat(50));

      const output = String(stdout.mock.calls[0]![0]);
      expect(output).toContain("...");
    });

    it("PrettyReporter.progress handles zero total gracefully", () => {
      const reporter = createReporter(false);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      reporter.progress(0, 0, "starting");

      const output = String(stdout.mock.calls[0]![0]);
      expect(output).toContain("0%");
    });
  });
});
