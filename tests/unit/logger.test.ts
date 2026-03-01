import { describe, it, expect, beforeEach } from "vitest";
import { initLogger, getLogger, createChildLogger, withCorrelationId } from "../../src/logger.js";

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
