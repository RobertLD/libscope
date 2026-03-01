import { describe, it, expect } from "vitest";
import {
  saveNamedConnectorConfig,
  loadNamedConnectorConfig,
  hasNamedConnectorConfig,
} from "../../src/connectors/index.js";

describe("connector name validation", () => {
  it("should reject path traversal in saveNamedConnectorConfig", () => {
    expect(() => saveNamedConnectorConfig("../evil", {})).toThrow(/Invalid connector name/);
  });

  it("should reject path traversal in loadNamedConnectorConfig", () => {
    expect(() => loadNamedConnectorConfig("../../etc/passwd")).toThrow(/Invalid connector name/);
  });

  it("should reject path traversal in hasNamedConnectorConfig", () => {
    expect(() => hasNamedConnectorConfig("foo/bar")).toThrow(/Invalid connector name/);
  });

  it("should allow valid connector names", () => {
    // These should not throw for the name validation (may throw for other reasons like file not found)
    expect(() => hasNamedConnectorConfig("my-connector")).not.toThrow();
    expect(() => hasNamedConnectorConfig("slack_v2")).not.toThrow();
  });
});
