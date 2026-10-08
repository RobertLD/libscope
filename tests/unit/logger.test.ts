import { describe, it, expect, beforeEach, vi } from "vitest";

// Record which file descriptor each logger writes to, while still building real pino loggers.
const destinationCalls = vi.hoisted(() => [] as unknown[]);

interface PinoModuleLike {
  default: ((...args: unknown[]) => unknown) & { destination: (opts: unknown) => unknown };
}

vi.mock("pino", async (importOriginal) => {
  const actual = await importOriginal<PinoModuleLike>();
  const realPino = actual.default;
  const destination = (opts: unknown): unknown => {
    destinationCalls.push(opts);
    return realPino.destination(opts);
  };
  const wrapped = Object.assign((...args: unknown[]) => realPino(...args), realPino, {
    destination,
  });
  return { ...actual, default: wrapped };
});

const { initLogger, getLogger, createChildLogger, withCorrelationId } =
  await import("../../src/logger.js");

function lastDestFd(): unknown {
  const last = destinationCalls.at(-1) as { dest?: unknown } | undefined;
  return last?.dest;
}

describe("logger", () => {
  beforeEach(() => {
    initLogger("silent");
  });

  it("should create a child logger with context", () => {
    const child = createChildLogger({ operation: "test", docId: "123" });
    expect(child).toBeDefined();
    expect(child.info).toBeTypeOf("function");
  });

  it("should create a logger with correlationId", () => {
    const child = withCorrelationId();
    expect(child).toBeDefined();
    expect(child.info).toBeTypeOf("function");
  });

  it("should merge additional context with correlationId", () => {
    const child = withCorrelationId({ operation: "indexDocument", docId: "abc" });
    expect(child).toBeDefined();
    expect(child.info).toBeTypeOf("function");
  });

  it("should return the current logger instance", () => {
    const logger = getLogger();
    expect(logger).toBeDefined();
    expect(logger.level).toBe("silent");
  });
});

describe("logger destination", () => {
  it("module-level logger (used before initLogger, e.g. config warnings) writes to stderr", () => {
    const first = destinationCalls[0] as { dest?: unknown } | undefined;
    expect(first?.dest).toBe(2);
  });

  it("writes to stderr (fd 2) by default so stdout stays clean", () => {
    initLogger("info");
    expect(lastDestFd()).toBe(2);
  });

  it("writes to stderr when explicitly requested (MCP stdio server)", () => {
    initLogger("info", { destination: "stderr" });
    expect(lastDestFd()).toBe(2);
    expect(getLogger().level).toBe("info");
  });

  it("can still target stdout when requested", () => {
    initLogger("warn", { destination: "stdout" });
    expect(lastDestFd()).toBe(1);
    expect(getLogger().level).toBe("warn");
  });
});
