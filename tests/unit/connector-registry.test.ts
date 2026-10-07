import { describe, it, expect } from "vitest";
import { CONNECTORS, getConnector, maskConnectorSecrets } from "../../src/connectors/registry.js";
import { CONNECTOR_TYPES } from "../../src/connectors/saved-config.js";
import { createTestDb } from "../fixtures/test-db.js";
import { ValidationError } from "../../src/errors.js";

describe("connector registry", () => {
  it("has one definition per connector type", () => {
    expect(Object.keys(CONNECTORS).sort()).toEqual([...CONNECTOR_TYPES].sort());
    for (const type of CONNECTOR_TYPES) {
      expect(getConnector(type).type).toBe(type);
      for (const field of getConnector(type).secretFields) {
        expect(getConnector(type).configSchema.shape).toHaveProperty(field);
      }
    }
  });

  it("rejects unknown connector types", () => {
    expect(() => getConnector("myspace")).toThrow(ValidationError);
  });

  it("masks secret fields and drops bookkeeping fields", () => {
    expect(
      maskConnectorSecrets("confluence", {
        baseUrl: "https://acme.atlassian.net",
        token: "secret",
        connectorType: "confluence",
        lastSync: "2026-01-01",
        schedule: { cronExpression: "0 * * * *" },
      }),
    ).toEqual({ baseUrl: "https://acme.atlassian.net", token: "***" });
    expect(maskConnectorSecrets("unknown", { token: "visible" })).toEqual({ token: "visible" });
  });

  it("maps each connector's result to the same summary shape", () => {
    expect(
      CONNECTORS.onenote.summarize({
        notebooks: 1,
        sections: 2,
        pagesAdded: 3,
        pagesUpdated: 4,
        pagesDeleted: 5,
        errors: [{ page: "p", error: "e" }],
      }),
    ).toEqual({ added: 3, updated: 4, deleted: 5, errors: ["p: e"] });
    expect(
      CONNECTORS.slack.summarize({
        channels: 1,
        messagesIndexed: 2,
        threadsIndexed: 3,
        errors: [{ channel: "c", error: "e" }],
      }),
    ).toEqual({ added: 5, updated: 0, deleted: 0, errors: ["#c: e"] });
  });

  it("needs the saved path to disconnect a vault or docs site", () => {
    const db = createTestDb();
    try {
      expect(() => CONNECTORS.obsidian.disconnect(db, undefined)).toThrow(ValidationError);
      expect(() => CONNECTORS.docs.disconnect(db, {})).toThrow(ValidationError);
      expect(CONNECTORS.docs.disconnect(db, { url: "https://docs.example.com/" })).toBe(0);
    } finally {
      db.close();
    }
  });
});
